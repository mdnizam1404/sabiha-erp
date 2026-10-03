// ============================================================================
// routes/importExport.js — bulk data import/export via Excel templates.
// Lets an admin migrating from another system download a blank template for
// each data type (with the exact columns this app expects), fill it in
// Excel, and upload it back — rows land straight in the matching module
// (Customers, Suppliers, Raw Materials, Products, Purchases, Sales) exactly
// as if they'd been entered one at a time through the normal forms.
//
// Column matching is POSITIONAL (by column order), not by header text — the
// header row is just for the person filling it in to read; what actually
// gets imported is column 1 → field 1, column 2 → field 2, and so on, in
// the order defined below. This is far more robust than trying to guess
// intent from slightly-reworded headers, at the cost of asking people not
// to reorder the columns — which "fill in this template" already implies.
// ============================================================================
const express = require('express');
const XLSX = require('xlsx');
const { db, nextNo, addStockTxn, stockOutForSale, audit } = require('../db');
const { requireRole } = require('../auth');
const router = express.Router();
// Bulk import can create/overwrite a large amount of data in one go, so —
// same tier as Backup/Restore and Users & Roles — it's restricted to
// Administrators and Managers, not every logged-in role.
// IMPORTANT: scope this guard to /import only. A bare router.use(requireRole(..))
// is mounted at '/' in server.js and would block EVERY route registered after
// this router (future-orders, investor, incentives, reports, admin...) for
// SALES / ACCOUNTANT / custom roles.
router.use('/import', requireRole('ADMIN', 'MANAGER'));

function cell(row, idx, type) {
  const v = row[idx];
  if (v === undefined || v === null || v === '') return type === 'number' ? 0 : '';
  if (type === 'number') { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  if (type === 'date') return normalizeDate(v);
  return String(v).trim();
}
// Excel stores dates as serial numbers when the cell is formatted as a
// date, but as plain text if the person just typed "2026-09-19" into a
// General-formatted cell — this accepts either.
function normalizeDate(v) {
  if (typeof v === 'number') { const d = XLSX.SSF.parse_date_code(v); if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`; }
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const m2 = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/); // DD-MM-YYYY / DD/MM/YYYY, common in Indian-locale Excel
  if (m2) return `${m2[3]}-${m2[2].padStart(2, '0')}-${m2[1].padStart(2, '0')}`;
  return s;
}
function findOrCreateByName(table, name, defaults) {
  if (!name) return null;
  const existing = db.prepare(`SELECT id FROM ${table} WHERE lower(name) = lower(?)`).get(name);
  if (existing) return existing.id;
  const cols = ['name', ...Object.keys(defaults)];
  const vals = [name, ...Object.values(defaults)];
  const info = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
  return info.lastInsertRowid;
}
function readRows(file_base64) {
  const base64 = String(file_base64 || '').split(',').pop(); // strip a data: URL prefix if the frontend sent one
  const buf = Buffer.from(base64, 'base64');
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });
  return rows.slice(1); // drop the header row
}
function templateBuffer(fields) {
  const ws = XLSX.utils.aoa_to_sheet([fields.map((f) => f.header), fields.map((f) => f.sample)]);
  ws['!cols'] = fields.map((f) => ({ wch: Math.max(14, f.header.length) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Template');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ---------------------------------------------------------------------------
// Entity definitions — field order here IS the column order in the
// template. Keep header text human-friendly; keep field `key` matching the
// real database column name so the generic master-data importer below can
// build its INSERT straight off it.
// ---------------------------------------------------------------------------
const ENTITIES = {
  customers: { label: 'Customers', table: 'customers', fields: [
    { key: 'name', header: 'Name*', type: 'text', sample: 'Kidz World' },
    { key: 'contact_person', header: 'Contact Person', type: 'text', sample: 'Rahul Sharma' },
    { key: 'phone', header: 'Phone', type: 'text', sample: '9876543210' },
    { key: 'email', header: 'Email', type: 'text', sample: 'orders@kidzworld.example' },
    { key: 'address', header: 'Address', type: 'text', sample: '12 MG Road, Jammu' },
    { key: 'gst_no', header: 'GST No', type: 'text', sample: '' },
    { key: 'credit_limit', header: 'Credit Limit', type: 'number', sample: 50000 },
    { key: 'payment_terms_days', header: 'Payment Terms (Days)', type: 'number', sample: 30 },
  ] },
  suppliers: { label: 'Suppliers', table: 'suppliers', fields: [
    { key: 'name', header: 'Name*', type: 'text', sample: 'Plasto Raw Materials' },
    { key: 'contact_person', header: 'Contact Person', type: 'text', sample: 'Anil Kumar' },
    { key: 'phone', header: 'Phone', type: 'text', sample: '9876500000' },
    { key: 'email', header: 'Email', type: 'text', sample: '' },
    { key: 'address', header: 'Address', type: 'text', sample: '' },
    { key: 'gst_no', header: 'GST No', type: 'text', sample: '' },
    { key: 'supplies', header: 'Supplies (what they sell you)', type: 'text', sample: 'Plastic granules' },
  ] },
  employees: { label: 'Employees', table: 'employees', fields: [
    { key: 'name', header: 'Name*', type: 'text', sample: 'Sunita Devi' },
    { key: 'department', header: 'Department', type: 'text', sample: 'Production' },
    { key: 'designation', header: 'Designation', type: 'text', sample: 'Machine Operator' },
    { key: 'join_date', header: 'Join Date (YYYY-MM-DD)', type: 'date', sample: '2026-01-15' },
    { key: 'phone', header: 'Phone', type: 'text', sample: '9876511111' },
    { key: 'email', header: 'Email', type: 'text', sample: '' },
    { key: 'address', header: 'Address', type: 'text', sample: '' },
    { key: 'salary_type', header: 'Salary Type (Monthly / On Production)', type: 'text', sample: 'Monthly' },
  ] },
  'raw-materials': { label: 'Raw Materials', table: 'raw_materials', fields: [
    { key: 'name', header: 'Name*', type: 'text', sample: 'ABS Plastic Granules' },
    { key: 'unit', header: 'Unit', type: 'text', sample: 'Kg' },
    { key: 'rate', header: 'Rate (₹ per unit)', type: 'number', sample: 120 },
    { key: 'min_stock', header: 'Min Stock (reorder alert level)', type: 'number', sample: 50 },
    { key: 'opening_stock', header: 'Opening Stock', type: 'number', sample: 200 },
  ] },
  products: { label: 'Products (Finished Goods)', table: 'products', fields: [
    { key: 'name', header: 'Name*', type: 'text', sample: 'Toy Truck – Large' },
    { key: 'sku', header: 'SKU / Barcode', type: 'text', sample: '' },
    { key: 'category', header: 'Category', type: 'text', sample: 'Vehicles' },
    { key: 'hsn_code', header: 'HSN Code', type: 'text', sample: '9503' },
    { key: 'unit', header: 'Unit', type: 'text', sample: 'Pcs' },
    { key: 'sale_rate', header: 'Sale Rate (₹)', type: 'number', sample: 250 },
    { key: 'gst_rate', header: 'GST Rate %', type: 'number', sample: 18 },
    { key: 'min_stock', header: 'Min Stock (reorder alert level)', type: 'number', sample: 20 },
    { key: 'opening_stock', header: 'Opening Stock', type: 'number', sample: 100 },
  ] },
  purchases: { label: 'Purchases', fields: [
    { key: 'purchase_date', header: 'Purchase Date (YYYY-MM-DD)*', type: 'date', sample: '2026-09-01' },
    { key: 'supplier_name', header: 'Supplier Name*', type: 'text', sample: 'Plasto Raw Materials' },
    { key: 'raw_material_name', header: 'Raw Material Name*', type: 'text', sample: 'ABS Plastic Granules' },
    { key: 'qty', header: 'Qty*', type: 'number', sample: 100 },
    { key: 'rate', header: 'Rate*', type: 'number', sample: 120 },
    { key: 'gst_pct', header: 'GST %', type: 'number', sample: 18 },
    { key: 'invoice_no', header: 'Supplier Invoice No', type: 'text', sample: '' },
    { key: 'remarks', header: 'Remarks', type: 'text', sample: '' },
  ] },
  sales: { label: 'Sales Invoices', fields: [
    { key: 'invoice_no', header: 'Invoice No (same no. on multiple rows = one invoice with multiple items; leave blank for one row = one invoice)', type: 'text', sample: '' },
    { key: 'invoice_date', header: 'Invoice Date (YYYY-MM-DD)*', type: 'date', sample: '2026-09-01' },
    { key: 'due_date', header: 'Due Date (YYYY-MM-DD)', type: 'date', sample: '2026-09-15' },
    { key: 'customer_name', header: 'Customer Name*', type: 'text', sample: 'Kidz World' },
    { key: 'product_name', header: 'Product Name*', type: 'text', sample: 'Toy Truck – Large' },
    { key: 'qty', header: 'Qty*', type: 'number', sample: 10 },
    { key: 'rate', header: 'Rate*', type: 'number', sample: 250 },
    { key: 'discount_pct', header: 'Discount %', type: 'number', sample: 0 },
    { key: 'gst_pct', header: 'GST %', type: 'number', sample: 18 },
    { key: 'gst_type', header: 'Tax Type (CGST_SGST / IGST)', type: 'text', sample: 'CGST_SGST' },
    { key: 'paid_now', header: 'Paid Now', type: 'number', sample: 0 },
    { key: 'paid_mode', header: 'Paid Via', type: 'text', sample: 'Cash' },
  ] },
};

router.get('/import/entities', (req, res) => {
  res.json(Object.entries(ENTITIES).map(([key, e]) => ({ key, label: e.label })));
});

router.get('/import/template/:entity', (req, res) => {
  const entity = ENTITIES[req.params.entity];
  if (!entity) return res.status(404).json({ error: 'Unknown import type' });
  const buf = templateBuffer(entity.fields);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.entity}-import-template.xlsx"`);
  res.send(buf);
});

router.post('/import/:entity', (req, res) => {
  const entity = ENTITIES[req.params.entity];
  if (!entity) return res.status(404).json({ error: 'Unknown import type' });
  if (!req.body.file_base64) return res.status(400).json({ error: 'No file uploaded' });
  let rows;
  try { rows = readRows(req.body.file_base64); }
  catch (e) { return res.status(400).json({ error: 'Could not read that file — please upload the .xlsx template, filled in without changing its columns.' }); }
  if (!rows.length) return res.status(400).json({ error: 'That sheet has no data rows below the header.' });

  let result;
  try {
    if (entity.table) result = importMasterData(entity, rows);
    else if (req.params.entity === 'purchases') result = importPurchases(entity, rows);
    else if (req.params.entity === 'sales') result = importSales(entity, rows);
    else result = { created: 0, skipped: 0, errors: ['Import for this type is not implemented'] };
  } catch (e) {
    return res.status(400).json({ error: `Import failed: ${e.message}` });
  }
  audit(req, 'IMPORT', req.params.entity, null, { rows: rows.length, created: result.created, skipped: result.skipped, errorCount: result.errors.length });
  res.json(result);
});

// Simple master-data tables — one row = one record. Skips a row whose
// "name" already exists (case-insensitive) rather than overwriting it, so
// re-running an import (e.g. after fixing a few rows) never clobbers data
// already entered by hand in the meantime.
function importMasterData(entity, rows) {
  let created = 0, skipped = 0; const errors = [];
  rows.forEach((row, i) => {
    const values = {};
    entity.fields.forEach((f, idx) => { values[f.key] = cell(row, idx, f.type); });
    if (!values.name) { errors.push(`Row ${i + 2}: missing Name — skipped`); return; }
    const existing = db.prepare(`SELECT id FROM ${entity.table} WHERE lower(name) = lower(?)`).get(values.name);
    if (existing) { skipped++; return; }
    // A 0 is a meaningful value for numeric fields (e.g. Rate 0), so only
    // text fields get dropped when blank (letting the table's own DEFAULT
    // apply); numeric fields are always included even when the row says 0.
    const finalCols = entity.fields.filter((f) => f.type === 'number' || values[f.key] !== '').map((f) => f.key);
    const vals = finalCols.map((k) => values[k]);
    try {
      const info = db.prepare(`INSERT INTO ${entity.table} (${finalCols.join(',')}) VALUES (${finalCols.map(() => '?').join(',')})`).run(...vals);
      created++;
    } catch (e) {
      errors.push(`Row ${i + 2} (${values.name}): ${e.message}`);
    }
  });
  return { created, skipped, errors };
}

function importPurchases(entity, rows) {
  let created = 0, skipped = 0; const errors = [];
  rows.forEach((row, i) => {
    const v = {}; entity.fields.forEach((f, idx) => { v[f.key] = cell(row, idx, f.type); });
    if (!v.purchase_date || !v.supplier_name || !v.raw_material_name || !v.qty || !v.rate) {
      errors.push(`Row ${i + 2}: missing a required field (date, supplier, raw material, qty, or rate) — skipped`); return;
    }
    try {
      const tx = db.transaction(() => {
        const supplierId = findOrCreateByName('suppliers', v.supplier_name, {});
        const rawId = findOrCreateByName('raw_materials', v.raw_material_name, { rate: v.rate });
        const no = nextNo('PUR-', 'purchases', 'purchase_no');
        const amount = v.qty * v.rate;
        const gstAmt = amount * (v.gst_pct || 0) / 100;
        const info = db.prepare(`
          INSERT INTO purchases (purchase_no,purchase_date,supplier_id,raw_material_id,qty,rate,amount,gst_pct,gst_amt,invoice_no,remarks)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(no, v.purchase_date, supplierId, rawId, v.qty, v.rate, amount, v.gst_pct || 0, gstAmt, v.invoice_no || '', v.remarks || `Imported from Excel (row ${i + 2})`);
        addStockTxn(v.purchase_date, 'RAW', rawId, v.qty, 'IN', 'PURCHASE', info.lastInsertRowid, no);
        db.prepare(`UPDATE raw_materials SET rate = ? WHERE id = ?`).run(v.rate, rawId);
      });
      tx();
      created++;
    } catch (e) {
      errors.push(`Row ${i + 2}: ${e.message}`);
    }
  });
  return { created, skipped, errors };
}

function importSales(entity, rows) {
  let created = 0, skipped = 0; const errors = [];
  // Group rows into invoices — same Invoice No (non-blank) becomes one
  // invoice with multiple line items; a blank Invoice No means that row is
  // its own single-item invoice.
  const groups = [];
  rows.forEach((row, i) => {
    const v = {}; entity.fields.forEach((f, idx) => { v[f.key] = cell(row, idx, f.type); });
    v.__row = i + 2;
    if (v.invoice_no) {
      let g = groups.find((g) => g.invoice_no === v.invoice_no);
      if (!g) { g = { invoice_no: v.invoice_no, rows: [] }; groups.push(g); }
      g.rows.push(v);
    } else {
      groups.push({ invoice_no: null, rows: [v] });
    }
  });
  groups.forEach((g) => {
    const first = g.rows[0];
    if (!first.invoice_date || !first.customer_name || g.rows.some((r) => !r.product_name || !r.qty || !r.rate)) {
      errors.push(`Invoice at row ${first.__row}${g.invoice_no ? ` (${g.invoice_no})` : ''}: missing a required field (date, customer, product, qty, or rate) — skipped`);
      return;
    }
    try {
      const tx = db.transaction(() => {
        const customerId = findOrCreateByName('customers', first.customer_name, {});
        const no = g.invoice_no || nextNo('INV-', 'sales_invoices', 'invoice_no');
        let subtotal = 0;
        const itemRows = g.rows.map((r) => {
          const productId = findOrCreateByName('products', r.product_name, { sale_rate: r.rate, gst_rate: first.gst_pct || 18 });
          const amount = r.qty * r.rate * (1 - (r.discount_pct || 0) / 100);
          subtotal += amount;
          return { productId, qty: r.qty, rate: r.rate, discount_pct: r.discount_pct || 0, amount };
        });
        const gstPct = Number(first.gst_pct || 18);
        const gstType = first.gst_type === 'IGST' ? 'IGST' : 'CGST_SGST';
        const gstAmt = subtotal * gstPct / 100;
        const grand = subtotal + gstAmt;
        const paidNow = Math.min(Number(first.paid_now || 0), grand);
        const status = paidNow >= grand ? 'Paid' : paidNow > 0 ? 'Partial' : 'Unpaid';
        const info = db.prepare(`
          INSERT INTO sales_invoices (invoice_no,invoice_date,customer_id,due_date,discount_pct,gst_pct,gst_type,subtotal,gst_amt,grand_total,status)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(no, first.invoice_date, customerId, first.due_date || first.invoice_date, 0, gstPct, gstType, subtotal, gstAmt, grand, status);
        itemRows.forEach((it) => {
          db.prepare(`INSERT INTO sales_items (invoice_id,product_id,qty,rate,discount_pct,amount) VALUES (?,?,?,?,?,?)`)
            .run(info.lastInsertRowid, it.productId, it.qty, it.rate, it.discount_pct, it.amount);
          stockOutForSale(first.invoice_date, it.productId, it.qty, info.lastInsertRowid, no);
        });
        if (paidNow > 0) {
          const rno = nextNo('RCPT-', 'receipts', 'receipt_no');
          db.prepare(`INSERT INTO receipts (receipt_no,date,customer_id,invoice_id,amount,mode,reference_no,remarks) VALUES (?,?,?,?,?,?,?,?)`)
            .run(rno, first.invoice_date, customerId, info.lastInsertRowid, paidNow, first.paid_mode || 'Cash', '', `Imported from Excel (row ${first.__row})`);
        }
      });
      tx();
      created++;
    } catch (e) {
      errors.push(`Invoice at row ${first.__row}${g.invoice_no ? ` (${g.invoice_no})` : ''}: ${e.message}`);
    }
  });
  return { created, skipped, errors };
}

module.exports = { router };
