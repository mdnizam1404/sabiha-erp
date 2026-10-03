# v12.1 — SALES / role-based access fix

## Problem
Approved SALES user opened Customers & Sales and saw:
"You do not have permission to do this. Your role is SALES. Required role: ADMIN, MANAGER."

## Root cause
routes/importExport.js had `router.use(requireRole('ADMIN','MANAGER'))`. The router is
mounted at '/' in server.js, so that guard ran for EVERY request that reached it —
i.e. all routes mounted after it (future-orders, incentives, customer-loyalty,
reports, admin/me, invoices...). The Customers page calls some of these, so SALES was blocked
even though Users & Roles -> Roles & Permissions allowed "Customers & Sales".

## Changes
1. routes/importExport.js — guard scoped to `/import` only.
2. auth.js (requireAuth) — role/status/active are re-read from the users table on every
   request, so approving, rejecting or changing a role in Users & Roles takes effect
   immediately (no re-login needed; stale 12h token roles no longer matter).
3. routes/admin.js (approve) — on approval, the user's role is normalized (SALES_PERSON -> SALES)
   and any missing role_permissions rows are created (built-in SALES gets Dashboard,
   Customers & Sales, SMS/WhatsApp, Outsourcing; existing admin choices are kept).

## Still admin/manager only (unchanged, by design)
Import/Export, Users & Roles, Settings writes, Backup/Restore, Investor presentation,
creating/editing incentive rules.

## Apply
Replace the three files above in your toybox-server folder, restart the server
(no DB migration needed). Users may need one refresh of the browser.
