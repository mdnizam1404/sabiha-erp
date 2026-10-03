// ============================================================================
// auth.js — JWT verification and role-based guards
// ============================================================================
const jwt = require('jsonwebtoken');
const { db } = require('./db');
const { getCompanyByCode, getCompanyById, withCompany, defaultCompanyCode } = require('./lib/multitenant');
const SECRET = process.env.JWT_SECRET || 'CHANGE_ME_IN_PRODUCTION';
const sub = require('./lib/subscription');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
  try {
    const decoded = jwt.verify(header.slice(7), SECRET);
    // Platform-owner (super admin) tokens must never be usable as a company session
    if (decoded.scope === 'platform') return res.status(401).json({ error: 'Invalid or expired session — please log in again' });
    const company = decoded.company_id ? getCompanyById(decoded.company_id) : getCompanyByCode(decoded.company_code || defaultCompanyCode);
    if (!company) return res.status(401).json({ error: 'Company account could not be found.' });
    if (company.status !== 'ACTIVE') return res.status(403).json({ error: `Company ${company.company_code} is currently ${company.status.toLowerCase()}.` });
    return withCompany(company, () => {
      try {
        const u = db.prepare(`SELECT id, role, status, active, full_name, employee_id, branch_id, must_change_password FROM users WHERE id = ?`).get(decoded.id);
        if (u) {
          if (u.status && u.status !== 'Approved') return res.status(401).json({ error: 'Your account is not approved. Please contact the Administrator.' });
          if (u.active !== undefined && Number(u.active) === 0) return res.status(401).json({ error: 'Your account is inactive. Please contact the Administrator.' });
          decoded.role = normalizeRole(u.role);
          decoded.full_name = u.full_name || decoded.full_name;
          decoded.employee_id = u.employee_id || decoded.employee_id || null;
          decoded.branch_id = u.branch_id || decoded.branch_id || null;
        }
        decoded.company_id = company.id;
        decoded.company_code = company.company_code;
        decoded.database_name = company.database_name;
        req.user = decoded;
        req.company = company;
        // plan / expiry: an expired company (past its grace period) can still view and export, never add or change
        const snap = sub.snapshot(company, { withUsage: false });
        req.subscription = snap;
        if (sub.readOnlyBlocks(snap, req)) return res.status(403).json(sub.readOnlyError(snap));
        // a password handed out by the platform owner / company admin must be replaced before anything else
        if (u && Number(u.must_change_password) === 1 && !/^\/(me|auth\/change-password)$/.test(req.path)) {
          return res.status(403).json({ error: 'You must change your password before continuing.', must_change_password: true });
        }
        next();
      } catch (e) {
        return res.status(401).json({ error: 'Unable to validate the company account.' });
      }
    });
  } catch (e) {
    res.status(401).json({ error: 'Invalid or expired session — please log in again' });
  }
}

function normalizeRole(role) {
  const raw = String(role || '').trim().toUpperCase().replace(/[-\s]+/g, '_');
  if (raw === 'SALES_PERSON' || raw === 'SALESPERSON' || raw === 'SALES_EXECUTIVE') return 'SALES';
  if (raw === 'ACCOUNTS' || raw === 'ACCOUNT') return 'ACCOUNTANT';
  if (raw === 'ADMINISTRATOR') return 'ADMIN';
  if (raw === 'MANAGEMENT') return 'MANAGER';
  return raw || 'STAFF';
}


const MODULE_LABELS = {
  dashboard: 'Dashboard', employeesPayroll: 'Employees & Payroll', inventory: 'Inventory & BOM',
  purchasesModule: 'Purchases', productionModule: 'Production', customersSales: 'Customers & Sales',
  outsourcing: 'Outsourcing', accountingReports: 'Accounting & Reports', expenses: 'Expenses',
  assets: 'Fixed Assets', loans: 'Loans', reminders: 'SMS / WhatsApp', auditBackup: 'Audit & Backup',
  users: 'Users & Roles', settings: 'Settings',
};

/**
 * Role-based module guard. Unlike requireRole(), this checks the permission
 * selected by the Administrator in Users & Roles -> Roles & Permissions.
 * ADMIN always has access. All other roles must have an explicit allowed=1
 * row in role_permissions. This keeps the UI and API authorization aligned.
 */
function requireModule(moduleKey) {
  return (req, res, next) => {
    const role = normalizeRole(req.user && req.user.role);
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (req.subscription && !sub.moduleAllowed(req.subscription, moduleKey)) return res.status(403).json(sub.moduleError(req.subscription, moduleKey)); // not in the company's plan — applies to ADMIN too
    if (role === 'ADMIN') return next();
    const row = db.prepare(`SELECT allowed FROM role_permissions WHERE role_name = ? AND module_key = ?`).get(role, moduleKey);
    if (!row || Number(row.allowed) !== 1) {
      const label = MODULE_LABELS[moduleKey] || moduleKey;
      return res.status(403).json({
        error: `You do not have access to ${label}. Your role is ${role}. Ask the Administrator to enable ${label} in Users & Roles → Roles & Permissions.`,
        permission: true,
        role,
        module_key: moduleKey,
        module_label: label,
      });
    }
    next();
  };
}

function requireRole(...roles) {
  const allowed = new Set(roles.map(normalizeRole));
  return (req, res, next) => {
    const role = normalizeRole(req.user && req.user.role);
    if (!req.user || !allowed.has(role)) {
      return res.status(403).json({
        error: `You do not have permission to do this. Your role is ${role}. Required role: ${roles.join(', ')}.`,
        permission: true,
        role,
        required_roles: roles.map(normalizeRole),
      });
    }
    next();
  };
}

// Plan gate for whole areas of the API that have no per-route module guard of their own.
const PLAN_PATHS = [
  [/^\/(loans|loans\/.*)$/, 'loans'],
  [/^\/(assets|asset-categories|tax-blocks|deferred-tax)(\/|$)/, 'assets'],
  [/^\/outsourcing(\/|$)/, 'outsourcing'],
  [/^\/(reminders|whatsapp)(\/|$)/, 'reminders'],
  [/^\/(payroll|attendance)(\/|$)/, 'employeesPayroll'],
  [/^\/purchases(\/|$)/, 'purchasesModule'],
  [/^\/(production|production-stages)(\/|$)/, 'productionModule'],
  [/^\/expenses(\/|$)/, 'expenses'],
];
function planGate(req, res, next) {
  const snap = req.subscription;
  if (!snap || snap.legacy || !snap.modules) return next();
  if (req.path === '/loans-due') { if (!sub.moduleAllowed(snap, 'loans')) return res.json([]); return next(); } // the notification bell polls this
  for (const [re, key] of PLAN_PATHS) if (re.test(req.path) && !sub.moduleAllowed(snap, key)) return res.status(403).json(sub.moduleError(snap, key));
  next();
}

module.exports = { SECRET, requireAuth, requireRole, requireModule, normalizeRole, planGate };
