// ============================================================================
// routes/assets.js — Fixed Asset Register, dual depreciation, deferred tax
//
// Two independent depreciation calculations are maintained for every asset,
// because Indian law genuinely requires two different numbers:
//
//   BOOKS (Companies Act 2013, Schedule II):
//     Straight-line, per INDIVIDUAL asset, over its useful life, pro-rated
//     by the number of days it has actually been in use. This drives the
//     asset's net book value on the balance sheet.
//
//   TAX (Income Tax Act 1961, Section 32):
//     Written-down value, computed per BLOCK of assets — all assets that
//     share a tax rate are pooled into one block and depreciated together;
//     individual assets are NOT tracked separately for tax purposes once
//     they're in a block. Additions used less than 180 days in the year
//     they're bought only get half the normal rate for that year (Section
//     32's "180-day rule").
//
// The two numbers diverge (book depreciation and tax depreciation almost
// never match in any given year), and that gap is a timing difference that
// reverses over the asset's life — it's recognised as Deferred Tax.
//
// This module computes both correctly, but it is not a substitute for a
// qualified Chartered Accountant. Useful lives, residual values, block
// classification, and tax rates are all editable per category — nothing
// here should be treated as a fixed statutory answer for every asset type,
// and current Income Tax rates should be confirmed against the applicable
// Finance Act before relying on this for a tax return.
// ============================================================================
const express = require('express');
const { db, nextNo, audit } = require('../db');
const router = express.Router();

// ---------------------------------------------------------------------------
// Financial year helpers (India: 1 April – 31 March)
// ---------------------------------------------------------------------------
function fyOfDate(dateStr) {
  const d = new Date(dateStr);
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; // month 3 = April
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}
function fyBounds(fyLabel) {
  const startYear = Number(fyLabel.split('-')[0]);
  return { start: `${startYear}-04-01`, end: `${startYear + 1}-03-31`, startYear };
}
function daysBetween(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// ---------------------------------------------------------------------------
// BOOKS — Companies Act, Schedule II straight-line, per asset, pro-rated by
// days actually in use (not a flat half-year convention).
// ---------------------------------------------------------------------------
function assetWithCategory(assetId) {
  return db.prepare(`
    SELECT a.*, c.name category_name, c.companies_act_useful_life_years cat_life,
      c.residual_value_pct cat_residual, c.income_tax_block, c.income_tax_rate_pct,
      c.depreciation_method cat_depreciation_method
    FROM assets a JOIN asset_categories c ON c.id = a.category_id WHERE a.id = ?`).get(assetId);
}
function bookValueAsOf(asset, asOfDate) {
  const usefulLife = Number(asset.useful_life_years ?? asset.cat_life);
  const residualPct = Number(asset.residual_value_pct ?? asset.cat_residual);
  const method = asset.depreciation_method || asset.cat_depreciation_method || 'SLM';
  const cost = Number(asset.original_cost);
  const residualValue = cost * residualPct / 100;
  const depreciableValue = cost - residualValue;
  const endDate = asset.status === 'Disposed' && asset.disposal_date && asset.disposal_date < asOfDate ? asset.disposal_date : asOfDate;
  const daysUsed = Math.max(0, daysBetween(asset.purchase_date, endDate));
  const yearsUsed = daysUsed / 365;

  let bookValue, accumulatedDep, annualDep;
  if (method === 'WDV') {
    // Written Down Value: a fixed % of the REDUCING balance every year,
    // instead of an equal amount every year. The rate is solved so the
    // asset still reaches the same residual value by the end of the same
    // useful life as SLM would — same inputs, a different depreciation
    // curve (front-loaded rather than even), which is the standard way to
    // offer a WDV option without needing a separate "rate" input.
    // A 0% residual has no finite WDV solution (value never hits exactly
    // zero), so that case falls back to the SLM-equivalent straight rate.
    const rate = usefulLife > 0 && residualPct > 0 ? 1 - Math.pow(residualPct / 100, 1 / usefulLife) : (usefulLife > 0 ? 1 / usefulLife : 0);
    bookValue = Math.max(cost * Math.pow(1 - rate, Math.min(yearsUsed, usefulLife)), residualValue);
    accumulatedDep = cost - bookValue;
    annualDep = cost * rate; // first-year figure for display — WDV's ₹ amount shrinks every year, unlike SLM
  } else {
    const annualDepSLM = usefulLife > 0 ? depreciableValue / usefulLife : 0;
    accumulatedDep = clamp(annualDepSLM * yearsUsed, 0, depreciableValue);
    bookValue = cost - accumulatedDep;
    annualDep = annualDepSLM;
  }
  return {
    cost, residualValue, usefulLife, annualDep, method,
    accumulatedDep, bookValue, fullyDepreciated: accumulatedDep >= depreciableValue - 0.01,
  };
}
// Depreciation schedule broken out financial-year by financial year, for
// display — the live bookValueAsOf() above is what's actually used for the
// balance sheet; this just shows how it built up over time.
function bookScheduleFor(asset) {
  const rows = [];
  let fy = fyOfDate(asset.purchase_date);
  const lastFy = fyOfDate(asset.status === 'Disposed' && asset.disposal_date ? asset.disposal_date : todayStr());
  let prevAccum = 0;
  while (true) {
    const { end } = fyBounds(fy);
    const asOf = end < todayStr() ? end : todayStr();
    const snap = bookValueAsOf(asset, asOf > (asset.disposal_date || '9999-99-99') ? asset.disposal_date : asOf);
    rows.push({ fy, openingValue: asset.original_cost - prevAccum, depreciation: snap.accumulatedDep - prevAccum, closingValue: snap.bookValue });
    prevAccum = snap.accumulatedDep;
    if (fy === lastFy || snap.fullyDepreciated) break;
    const [y] = fy.split('-'); fy = `${Number(y) + 1}-${String((Number(y) + 2) % 100).padStart(2, '0')}`;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// TAX — Income Tax Act, written-down value per BLOCK, with the 180-day rule
// applied to additions. Computed sequentially FY by FY from the block's
// first asset up to the requested FY, since WDV carries forward.
// ---------------------------------------------------------------------------
function taxBlockNames() {
  return db.prepare(`SELECT DISTINCT income_tax_block FROM asset_categories WHERE active = 1 ORDER BY income_tax_block`).all().map((r) => r.income_tax_block);
}
function blockRate(blockName) {
  const row = db.prepare(`SELECT income_tax_rate_pct FROM asset_categories WHERE income_tax_block = ? AND active = 1 LIMIT 1`).get(blockName);
  return row ? Number(row.income_tax_rate_pct) : 0;
}
function blockAssets(blockName) {
  return db.prepare(`
    SELECT a.* FROM assets a JOIN asset_categories c ON c.id = a.category_id
    WHERE c.income_tax_block = ? ORDER BY a.purchase_date`).all(blockName);
}
// Returns the FY-by-FY WDV movement for one block, up to and including
// `uptoFy`. Tax depreciation is an annual, year-end computation — there is
// no "provisional" mid-year figure the way book depreciation can be shown
// continuously, so the schedule only has one row per completed year.
function taxBlockSchedule(blockName, uptoFy) {
  const rate = blockRate(blockName);
  const assets = blockAssets(blockName);
  if (!assets.length) return { rate, rows: [], closingWDV: 0 };
  let fy = fyOfDate(assets[0].purchase_date);
  const rows = [];
  let openingWDV = 0;
  while (true) {
    const { start, end } = fyBounds(fy);
    let additionsFull = 0, additionsHalf = 0, deletions = 0;
    for (const a of assets) {
      if (a.purchase_date >= start && a.purchase_date <= end) {
        const daysUsedInFy = daysBetween(a.purchase_date, end) + 1;
        if (daysUsedInFy >= 180) additionsFull += Number(a.original_cost);
        else additionsHalf += Number(a.original_cost);
      }
      if (a.status === 'Disposed' && a.disposal_date >= start && a.disposal_date <= end) {
        deletions += Number(a.disposal_value || 0);
      }
    }
    const depreciationBase = Math.max(0, openingWDV + additionsFull - deletions);
    const depreciation = (rate / 100) * depreciationBase + (rate / 200) * additionsHalf;
    const closingWDV = Math.max(0, openingWDV + additionsFull + additionsHalf - deletions - depreciation);
    rows.push({ fy, openingWDV, additionsFull, additionsHalf, deletions, depreciation, closingWDV });
    openingWDV = closingWDV;
    if (fy === uptoFy) break;
    const [y] = fy.split('-'); fy = `${Number(y) + 1}-${String((Number(y) + 2) % 100).padStart(2, '0')}`;
    if (Number(fy.split('-')[0]) > Number(uptoFy.split('-')[0]) + 1) break; // safety stop
  }
  return { rate, rows, closingWDV: rows.length ? rows[rows.length - 1].closingWDV : 0 };
}
function lastCompletedFy() {
  const t = todayStr();
  const cur = fyOfDate(t);
  const { start } = fyBounds(cur);
  // If we're within the current FY (which we always are, "today" is always
  // mid-year-or-later relative to itself), the last COMPLETED FY is the
  // previous one — tax WDV as of "now" is only final as of that year-end.
  const [y] = cur.split('-');
  return `${Number(y) - 1}-${String(Number(y) % 100).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Asset Categories (simple master, generic-style CRUD kept explicit here so
// the income-tax-block / rate fields stay clearly documented)
// ---------------------------------------------------------------------------
router.get('/asset-categories', (req, res) => {
  res.json(db.prepare(`SELECT * FROM asset_categories WHERE active = 1 ORDER BY name`).all());
});
router.post('/asset-categories', (req, res) => {
  const b = req.body;
  const info = db.prepare(`INSERT INTO asset_categories (name, companies_act_useful_life_years, residual_value_pct, income_tax_block, income_tax_rate_pct, depreciation_method) VALUES (?,?,?,?,?,?)`)
    .run(b.name, Number(b.companies_act_useful_life_years) || 10, Number(b.residual_value_pct ?? 5), b.income_tax_block, Number(b.income_tax_rate_pct) || 15, b.depreciation_method === 'WDV' ? 'WDV' : 'SLM');
  audit(req, 'CREATE', 'asset_categories', info.lastInsertRowid, b);
  res.json(db.prepare(`SELECT * FROM asset_categories WHERE id = ?`).get(info.lastInsertRowid));
});
router.put('/asset-categories/:id', (req, res) => {
  const b = req.body;
  db.prepare(`UPDATE asset_categories SET name=?, companies_act_useful_life_years=?, residual_value_pct=?, income_tax_block=?, income_tax_rate_pct=?, depreciation_method=? WHERE id=?`)
    .run(b.name, Number(b.companies_act_useful_life_years) || 10, Number(b.residual_value_pct ?? 5), b.income_tax_block, Number(b.income_tax_rate_pct) || 15, b.depreciation_method === 'WDV' ? 'WDV' : 'SLM', req.params.id);
  audit(req, 'UPDATE', 'asset_categories', req.params.id, b);
  res.json(db.prepare(`SELECT * FROM asset_categories WHERE id = ?`).get(req.params.id));
});
router.delete('/asset-categories/:id', (req, res) => {
  const inUse = db.prepare(`SELECT COUNT(*) n FROM assets WHERE category_id = ?`).get(req.params.id).n;
  if (inUse > 0) return res.status(400).json({ error: `${inUse} asset(s) use this category — reassign them first.` });
  db.prepare(`UPDATE asset_categories SET active = 0 WHERE id = ?`).run(req.params.id);
  audit(req, 'DELETE', 'asset_categories', req.params.id, {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------
router.get('/assets', (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, c.name category_name FROM assets a JOIN asset_categories c ON c.id = a.category_id
    ORDER BY a.purchase_date DESC`).all();
  const asOf = (req.query.as_of && /^\d{4}-\d{2}-\d{2}$/.test(req.query.as_of)) ? req.query.as_of : todayStr();
  const withValues = rows.map((a) => {
    const full = assetWithCategory(a.id);
    const snap = bookValueAsOf(full, asOf);
    return { ...a, bookValue: snap.bookValue, accumulatedDep: snap.accumulatedDep, fullyDepreciated: snap.fullyDepreciated, depMethod: snap.method };
  });
  // Total Asset Value as on the chosen date — original cost of everything
  // ever bought, and the net book value of assets still active as of asOf
  // (an asset purchased after asOf, or already disposed of by asOf, is
  // naturally excluded from the "as on date" totals but not from the list).
  const totalOriginalCost = rows.reduce((s, a) => s + Number(a.original_cost), 0);
  const totalBookValueAsOf = withValues
    .filter((a) => a.purchase_date <= asOf && (a.status !== 'Disposed' || !a.disposal_date || a.disposal_date > asOf))
    .reduce((s, a) => s + a.bookValue, 0);
  res.json({ asOf, totalOriginalCost, totalBookValueAsOf, rows: withValues });
});
router.get('/assets/:id', (req, res) => {
  const full = assetWithCategory(req.params.id);
  if (!full) return res.status(404).json({ error: 'Asset not found' });
  const today = todayStr();
  const snap = bookValueAsOf(full, today);
  const schedule = bookScheduleFor(full);
  res.json({ ...full, ...snap, schedule });
});
router.post('/assets', (req, res) => {
  const b = req.body;
  const no = nextNo('AST-', 'assets', 'asset_no');
  const info = db.prepare(`
    INSERT INTO assets (asset_no, name, category_id, purchase_date, original_cost, useful_life_years, residual_value_pct, depreciation_method, location, remarks)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(no, b.name, b.category_id, b.purchase_date, Number(b.original_cost) || 0,
    b.useful_life_years ? Number(b.useful_life_years) : null, b.residual_value_pct !== '' && b.residual_value_pct != null ? Number(b.residual_value_pct) : null,
    (b.depreciation_method === 'SLM' || b.depreciation_method === 'WDV') ? b.depreciation_method : null,
    b.location || '', b.remarks || '');
  audit(req, 'CREATE', 'assets', info.lastInsertRowid, b);
  res.json(db.prepare(`SELECT * FROM assets WHERE id = ?`).get(info.lastInsertRowid));
});
router.put('/assets/:id', (req, res) => {
  const b = req.body;
  db.prepare(`
    UPDATE assets SET name=?, category_id=?, purchase_date=?, original_cost=?, useful_life_years=?, residual_value_pct=?, depreciation_method=?, location=?, remarks=? WHERE id=?`)
    .run(b.name, b.category_id, b.purchase_date, Number(b.original_cost) || 0,
      b.useful_life_years ? Number(b.useful_life_years) : null, b.residual_value_pct !== '' && b.residual_value_pct != null ? Number(b.residual_value_pct) : null,
      (b.depreciation_method === 'SLM' || b.depreciation_method === 'WDV') ? b.depreciation_method : null,
      b.location || '', b.remarks || '', req.params.id);
  audit(req, 'UPDATE', 'assets', req.params.id, b);
  res.json(db.prepare(`SELECT * FROM assets WHERE id = ?`).get(req.params.id));
});
router.post('/assets/:id/dispose', (req, res) => {
  db.prepare(`UPDATE assets SET status='Disposed', disposal_date=?, disposal_value=? WHERE id=?`)
    .run(req.body.disposal_date, Number(req.body.disposal_value) || 0, req.params.id);
  audit(req, 'UPDATE', 'assets', req.params.id, { action: 'dispose', ...req.body });
  res.json(db.prepare(`SELECT * FROM assets WHERE id = ?`).get(req.params.id));
});
router.delete('/assets/:id', (req, res) => {
  db.prepare(`DELETE FROM assets WHERE id = ?`).run(req.params.id);
  audit(req, 'DELETE', 'assets', req.params.id, {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Tax WDV — per block, FY by FY
// ---------------------------------------------------------------------------
router.get('/tax-blocks', (req, res) => {
  const uptoFy = req.query.fy || lastCompletedFy();
  const blocks = taxBlockNames().map((name) => {
    const { rate, rows, closingWDV } = taxBlockSchedule(name, uptoFy);
    return { name, rate, rows, closingWDV, assetCount: blockAssets(name).length };
  }).filter((b) => b.assetCount > 0);
  res.json({ uptoFy, blocks });
});

// ---------------------------------------------------------------------------
// Deferred Tax — book value vs tax WDV, both as of the same financial
// year-end, since that's the only point at which the tax figure is final.
// ---------------------------------------------------------------------------
router.get('/deferred-tax', (req, res) => {
  const fy = req.query.fy || lastCompletedFy();
  const { end } = fyBounds(fy);
  const company = db.prepare(`SELECT corporate_tax_rate_pct FROM company_settings WHERE id = 1`).get();
  const taxRate = Number(company?.corporate_tax_rate_pct || 25);

  const assets = db.prepare(`SELECT id FROM assets`).all();
  let totalBookValue = 0;
  for (const a of assets) {
    const full = assetWithCategory(a.id);
    totalBookValue += bookValueAsOf(full, end).bookValue;
  }
  const blocks = taxBlockNames().map((name) => taxBlockSchedule(name, fy));
  const totalTaxWDV = blocks.reduce((s, b) => s + b.closingWDV, 0);

  const timingDifference = totalBookValue - totalTaxWDV;
  const deferredTaxLiability = Math.max(0, timingDifference) * taxRate / 100;
  const deferredTaxAsset = Math.max(0, -timingDifference) * taxRate / 100;

  res.json({ fy, asOf: end, taxRate, totalBookValue, totalTaxWDV, timingDifference, deferredTaxLiability, deferredTaxAsset });
});

module.exports = {
  router,
  bookValueAsOf, assetWithCategory, taxBlockNames, taxBlockSchedule, lastCompletedFy, todayStr, fyBounds,
};
