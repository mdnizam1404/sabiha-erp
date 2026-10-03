// ============================================================================
// routes/investorReport.js — one-click investor/shareholder-style .pptx:
// business overview, monthly/quarterly/yearly comparisons, sales &
// production reports, balance sheet, future order pipeline, and a growth
// vision slide. Pulls from the exact same computation functions the app's
// own live reports use (computePnl, computeAccounts — attached to the
// reports router in routes/reports.js) so the numbers in the deck always
// match what's on screen elsewhere in the app.
// ============================================================================
const express = require('express');
const PptxGenJS = require('pptxgenjs');
const { db, stockBalance } = require('../db');
const { requireRole } = require('../auth');
const reportsRouter = require('./reports');
const router = express.Router();

const { computePnl, computeAccounts } = reportsRouter;

const BRAND = '1F3B73'; // deep navy — used for headings/accents throughout the deck
const ACCENT = '2E9E6C'; // green — used for positive/growth figures
const CORAL = 'D64545'; // used for negative figures / declines
const GOLD = 'B8894A'; // warm accent for eyebrow labels / highlight bars — mirrors the tan/gold accent MNC decks use against navy
const LIGHT_BG = 'F3F5FB'; // card fill
const LINE = 'E5E9F2'; // hairlines / card borders / table borders
const MUTED = '6E7791'; // secondary text
const FAINT = '9AA6C0'; // footnotes

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function addMonths(dateStr, months) {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}
function inr(n) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}
// April-March financial year, standard for an India-based business (matches
// the GST/UPI-specific parts of the rest of this app) — returns e.g.
// "2026-27" for any date from Apr 2026 through Mar 2027.
function fyLabelOf(dateStr) {
  const d = new Date(dateStr);
  const y = d.getFullYear();
  const startYear = d.getMonth() >= 3 ? y : y - 1; // getMonth() is 0-based; 3 = April
  return { label: `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`, start: `${startYear}-04-01`, end: `${startYear + 1}-03-31`, startYear };
}
function quarterBounds(dateStr) {
  const d = new Date(dateStr);
  const qStartMonth = Math.floor(d.getMonth() / 3) * 3;
  const start = new Date(d.getFullYear(), qStartMonth, 1);
  const end = new Date(d.getFullYear(), qStartMonth + 3, 0);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

// ---------------------------------------------------------------------------
// Data gathering — all read-only, all reusing the app's existing report logic
// ---------------------------------------------------------------------------
function gatherReportData() {
  const today = todayISO();
  const company = db.prepare(`SELECT * FROM company_settings WHERE id = 1`).get() || {};

  const thisFy = fyLabelOf(today);
  const lastFyStart = `${thisFy.startYear - 1}-04-01`;
  const lastFyEnd = `${thisFy.startYear}-03-31`;
  const fyThis = computePnl(thisFy.start, today);
  const fyLast = computePnl(lastFyStart, lastFyEnd);

  const thisQ = quarterBounds(today);
  const lastQEnd = addDays(thisQ.start, -1);
  const lastQ = quarterBounds(lastQEnd);
  const qThis = computePnl(thisQ.start, today);
  const qLast = computePnl(lastQ.start, lastQ.end);

  const monthStart = `${today.slice(0, 7)}-01`;
  const lastMonthEnd = addDays(monthStart, -1);
  const lastMonthStart = `${lastMonthEnd.slice(0, 7)}-01`;
  const mThis = computePnl(monthStart, today);
  const mLast = computePnl(lastMonthStart, lastMonthEnd);

  // Last 12 months trend, for the monthly chart
  const monthlyTrend = [];
  for (let i = 11; i >= 0; i--) {
    const mStart = addMonths(monthStart, -i);
    const mEndExclusive = addMonths(mStart, 1);
    const mEnd = addDays(mEndExclusive, -1);
    const p = computePnl(mStart, mEnd > today ? today : mEnd);
    monthlyTrend.push({ label: mStart.slice(0, 7), revenue: p.sales, profit: p.pat });
  }
  // Last 4 quarters trend — includes Gross Profit and Operating Profit too,
  // not just Revenue/PAT, so the deck can show a proper multi-metric
  // scaling view (the way an MNC earnings deck shows Revenue/EBITDA/PBT/PAT
  // side by side) rather than a single trend line.
  const quarterlyTrend = [];
  for (let i = 3; i >= 0; i--) {
    let qEnd = thisQ.start;
    for (let k = 0; k < i; k++) qEnd = addDays(quarterBounds(qEnd).start, -1);
    const qb = quarterBounds(qEnd);
    const p = computePnl(qb.start, qb.end > today ? today : qb.end);
    quarterlyTrend.push({ label: `${qb.start.slice(0, 7)}`, revenue: p.sales, grossProfit: p.grossProfit, operatingProfit: p.operatingProfit, profit: p.pat });
  }

  // Top products / customers by revenue over the trailing 12 months
  const yearAgo = addMonths(today, -12);
  const topProducts = db.prepare(`
    SELECT p.name, SUM(x.amount) revenue, SUM(x.qty) qty FROM (
      SELECT si.product_id, si.amount, si.qty, inv.invoice_date d FROM sales_items si JOIN sales_invoices inv ON inv.id = si.invoice_id
      UNION ALL
      SELECT ri.product_id, -ri.amount, -ri.qty, r.return_date FROM sales_return_items ri JOIN sales_returns r ON r.id = ri.return_id WHERE r.status = 'Accepted'
    ) x JOIN products p ON p.id = x.product_id
    WHERE x.d BETWEEN ? AND ? GROUP BY x.product_id, p.name ORDER BY revenue DESC LIMIT 5`).all(yearAgo, today);
  const topCustomers = db.prepare(`
    SELECT c.name, SUM(inv.grand_total) revenue FROM sales_net inv
    JOIN customers c ON c.id = inv.customer_id WHERE inv.invoice_date BETWEEN ? AND ? GROUP BY inv.customer_id, c.name ORDER BY revenue DESC LIMIT 5`).all(yearAgo, today);
  const topProductsRevenue = topProducts.reduce((s, p) => s + p.revenue, 0);
  const totalSalesRevenue = db.prepare(`SELECT COALESCE(SUM(grand_total),0) n FROM sales_net WHERE invoice_date BETWEEN ? AND ?`).get(yearAgo, today).n;

  // Production — units produced per month (last 6 months) and defect rate
  const productionTrend = [];
  for (let i = 5; i >= 0; i--) {
    const mStart = addMonths(monthStart, -i);
    const mEnd = addDays(addMonths(mStart, 1), -1);
    const row = db.prepare(`SELECT COALESCE(SUM(produced_qty),0) produced, COALESCE(SUM(defective_qty),0) defective FROM production WHERE date BETWEEN ? AND ?`).get(mStart, mEnd > today ? today : mEnd);
    productionTrend.push({ label: mStart.slice(0, 7), produced: row.produced, defective: row.defective });
  }
  const productionTotals = productionTrend.reduce((s, r) => ({ produced: s.produced + r.produced, defective: s.defective + r.defective }), { produced: 0, defective: 0 });
  const defectRatePct = productionTotals.produced > 0 ? (productionTotals.defective / (productionTotals.produced + productionTotals.defective)) * 100 : 0;
  const topProducedProducts = db.prepare(`
    SELECT p.name, SUM(pr.produced_qty) produced FROM production pr JOIN products p ON p.id = pr.product_id
    WHERE pr.date BETWEEN ? AND ? GROUP BY pr.product_id, p.name ORDER BY produced DESC LIMIT 5`).all(addMonths(today, -6), today);

  const accounts = computeAccounts();

  // Future order pipeline — grouped by status, plus a probability-weighted total
  const futureOrders = db.prepare(`SELECT * FROM future_orders`).all();
  const pipelineByStatus = {};
  futureOrders.forEach((o) => {
    pipelineByStatus[o.status] = pipelineByStatus[o.status] || { count: 0, value: 0, weighted: 0 };
    pipelineByStatus[o.status].count += 1;
    pipelineByStatus[o.status].value += o.expected_value;
    pipelineByStatus[o.status].weighted += o.expected_value * (o.probability_pct || 100) / 100;
  });
  const openPipelineValue = (pipelineByStatus['Open']?.weighted || 0) + (pipelineByStatus['Completed']?.weighted || 0);

  const activeCustomers = db.prepare(`SELECT COUNT(*) n FROM customers WHERE active = 1`).get().n;
  const activeProducts = db.prepare(`SELECT COUNT(*) n FROM products WHERE active = 1`).get().n;
  const activeSuppliers = db.prepare(`SELECT COUNT(*) n FROM suppliers WHERE active = 1`).get().n;
  const activeEmployees = db.prepare(`SELECT COUNT(*) n FROM employees WHERE active = 1`).get().n;
  const invoicesYtd = db.prepare(`SELECT COUNT(*) n FROM sales_invoices WHERE invoice_date BETWEEN ? AND ?`).get(thisFy.start, today).n;

  return {
    company, today, thisFy,
    fyThis, fyLast, qThis, qLast, mThis, mLast,
    monthlyTrend, quarterlyTrend, topProducts, topCustomers, topProductsRevenue, totalSalesRevenue,
    productionTrend, productionTotals, defectRatePct, topProducedProducts,
    accounts, futureOrders, pipelineByStatus, openPipelineValue,
    activeCustomers, activeProducts, activeSuppliers, activeEmployees, invoicesYtd,
  };
}

function growthPct(current, previous) {
  if (!previous) return current > 0 ? null : 0;
  return ((current - previous) / Math.abs(previous)) * 100;
}
function growthLabel(pct) {
  if (pct === null) return 'New';
  return `${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}% YoY`;
}
function growthColor(pct) {
  return pct === null || pct >= 0 ? ACCENT : CORAL;
}

// ---------------------------------------------------------------------------
// Layout helpers — a small shared "slide master" so every content slide gets
// the same eyebrow-label + title + rule header, and the same footnote +
// page-number footer, the way a real corporate deck repeats its header
// treatment page after page instead of improvising a new layout each time.
// ---------------------------------------------------------------------------
const PAGE_W = 13.33, PAGE_H = 7.5, MARGIN = 0.55;
let pageCounter = 0;

function addHeader(slide, companyName, eyebrow, title) {
  slide.addShape('rect', { x: 0, y: 0, w: PAGE_W, h: 0.14, fill: { color: BRAND } }); // top accent rule
  slide.addText(eyebrow.toUpperCase(), { x: MARGIN, y: 0.32, w: 9, h: 0.3, fontSize: 11, bold: true, color: GOLD, charSpacing: 2 });
  slide.addText(title, { x: MARGIN, y: 0.58, w: 10.6, h: 0.62, fontSize: 23, bold: true, color: BRAND });
  slide.addText(companyName || '', { x: 9.8, y: 0.4, w: 3, h: 0.3, fontSize: 10, bold: true, color: MUTED, align: 'right' });
  slide.addShape('line', { x: MARGIN, y: 1.22, w: PAGE_W - 2 * MARGIN, h: 0, line: { color: LINE, width: 1 } });
}
function addFooter(slide, note) {
  pageCounter += 1;
  if (note) slide.addText(note, { x: MARGIN, y: 7.16, w: 10.5, h: 0.3, fontSize: 8, italic: true, color: FAINT });
  slide.addText(String(pageCounter), { x: PAGE_W - MARGIN - 0.4, y: 7.16, w: 0.4, h: 0.3, fontSize: 9, color: FAINT, align: 'right' });
}
// A small pill showing "▲ 12.3% YoY" in green/coral — the same growth-badge
// language the reference decks use everywhere (HUL's arrows, HFL's % chips).
function addGrowthChip(slide, x, y, pct, w = 1.55) {
  const color = growthColor(pct);
  slide.addShape('roundRect', { x, y, w, h: 0.32, fill: { color }, rectRadius: 0.16, line: { type: 'none' } });
  slide.addText(growthLabel(pct), { x, y, w, h: 0.32, fontSize: 10.5, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle' });
}
// A stat card: big bold value, label underneath, optional growth chip in the
// corner and a one-line justification in small italic — this is the unit
// every KPI grid in the deck is built from.
function addKpiCard(slide, x, y, w, h, value, label, opts = {}) {
  slide.addShape('roundRect', { x, y, w, h, fill: { color: opts.fill || LIGHT_BG }, line: { color: LINE, width: 1 }, rectRadius: 0.07 });
  slide.addText(value, { x: x + 0.14, y: y + 0.12, w: w - 0.28, h: 0.5, fontSize: opts.valueSize || 19, bold: true, color: opts.valueColor || BRAND });
  slide.addText(label, { x: x + 0.14, y: y + 0.62, w: w - 0.28, h: 0.32, fontSize: 10, color: MUTED });
  if (opts.pct !== undefined) addGrowthChip(slide, x + 0.14, y + h - 0.44, opts.pct, w - 0.28);
  else if (opts.note) slide.addText(opts.note, { x: x + 0.14, y: y + h - 0.42, w: w - 0.28, h: 0.36, fontSize: 8.5, italic: true, color: FAINT });
}
// A dark full-width section divider bar, mimicking the "WINNING IN NEW
// INDIA" / green highlight bars the reference decks use to break up a dense
// slide into named sub-sections.
function addSectionBar(slide, x, y, w, text, color = BRAND) {
  slide.addShape('rect', { x, y, w, h: 0.34, fill: { color }, line: { type: 'none' } });
  slide.addText(text.toUpperCase(), { x: x + 0.12, y, w: w - 0.24, h: 0.34, fontSize: 11, bold: true, color: 'FFFFFF', valign: 'middle', charSpacing: 1 });
}
function fmtShortMonth(ym) {
  const [y, m] = ym.split('-');
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
}

// ---------------------------------------------------------------------------
// Slide builders
// ---------------------------------------------------------------------------
function buildDeck(data) {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'WIDE', width: PAGE_W, height: PAGE_H });
  pptx.layout = 'WIDE';
  pageCounter = 0;
  const co = data.company;
  const companyName = co.company_name || 'Company';

  // --- Cover slide -----------------------------------------------------------
  let s = pptx.addSlide();
  s.background = { color: BRAND };
  s.addShape('rect', { x: 0, y: 0, w: PAGE_W, h: 0.12, fill: { color: GOLD } });
  s.addShape('ellipse', { x: 10.6, y: -2.2, w: 6, h: 6, fill: { color: '25407A' }, line: { type: 'none' } }); // soft decorative accent, echoes the abstract circular motifs in the reference covers
  s.addShape('ellipse', { x: -2, y: 5, w: 5, h: 5, fill: { color: '25407A' }, line: { type: 'none' } });
  if (co.logo_data_url) {
    try { s.addImage({ data: co.logo_data_url, x: 0.7, y: 0.6, w: 0.9, h: 0.9 }); } catch (e) { /* skip a malformed/unsupported image rather than fail the whole deck */ }
  }
  s.addText(`Financial Year ${data.thisFy.label}`, { x: 0.7, y: 4.3, w: 11.9, h: 0.4, fontSize: 14, color: '9FB0D8' });
  s.addText(companyName, { x: 0.7, y: 2.5, w: 11.9, h: 1.1, fontSize: 42, bold: true, color: 'FFFFFF' });
  s.addShape('rect', { x: 0.75, y: 3.55, w: 1.4, h: 0.05, fill: { color: GOLD } });
  s.addText('Business Review & Growth Outlook', { x: 0.7, y: 3.75, w: 11.9, h: 0.5, fontSize: 19, color: 'DCE4F5' });
  s.addText(`${companyName}  ·  Generated ${new Date(data.today).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}`, { x: 0.7, y: 6.9, w: 10, h: 0.3, fontSize: 10.5, color: '8FA0CC' });

  // --- Company at a Glance -----------------------------------------------------
  s = pptx.addSlide();
  addHeader(s, companyName, 'Business Overview', 'Company at a Glance');
  const glance = [
    { value: String(data.activeCustomers), label: 'Active Customers' },
    { value: String(data.activeProducts), label: 'Active Products' },
    { value: String(data.activeSuppliers), label: 'Active Suppliers' },
    { value: String(data.activeEmployees), label: 'Employees' },
    { value: String(data.invoicesYtd), label: `Invoices Raised, FY${data.thisFy.label}` },
    { value: Math.round(data.productionTotals.produced).toLocaleString('en-IN'), label: 'Units Produced (6 mo)' },
  ];
  const gCols = 3, gW = 3.9, gH = 1.35, gGX = 0.18, gGY = 0.2, gX0 = MARGIN, gY0 = 1.5;
  glance.forEach((k, i) => {
    const cx = gX0 + (i % gCols) * (gW + gGX);
    const cy = gY0 + Math.floor(i / gCols) * (gH + gGY);
    addKpiCard(s, cx, cy, gW, gH, k.value, k.label, { valueSize: 26 });
  });
  const glanceBottom = gY0 + 2 * (gH + gGY) - gGY; // bottom edge of the second card row
  addSectionBar(s, MARGIN, glanceBottom + 0.3, PAGE_W - 2 * MARGIN, 'A Manufacturing Business Built for Scale');
  s.addText(co.address ? `Registered address: ${co.address}` : 'A growing manufacturing operation tracked end-to-end — from raw material purchase through production, sales, and collections — on a single integrated platform.',
    { x: MARGIN, y: glanceBottom + 0.8, w: PAGE_W - 2 * MARGIN, h: 1.4, fontSize: 12.5, color: MUTED, valign: 'top', lineSpacingMultiple: 1.35 });
  addFooter(s, 'Source: Live company data as of the generation date, above.');

  // --- Executive Summary --------------------------------------------------------
  s = pptx.addSlide();
  addHeader(s, companyName, 'Financial Highlights', 'Executive Summary');
  const kpis = [
    { label: `FY${data.thisFy.label} Revenue`, value: inr(data.fyThis.sales), pct: growthPct(data.fyThis.sales, data.fyLast.sales) },
    { label: `FY${data.thisFy.label} Net Profit (PAT)`, value: inr(data.fyThis.pat), pct: growthPct(data.fyThis.pat, data.fyLast.pat) },
    { label: 'This Quarter Revenue', value: inr(data.qThis.sales), pct: growthPct(data.qThis.sales, data.qLast.sales) },
    { label: 'This Month Revenue', value: inr(data.mThis.sales), pct: growthPct(data.mThis.sales, data.mLast.sales) },
    { label: `FY${data.thisFy.label} Operating Margin`, value: `${data.fyThis.opm.toFixed(1)}%`, note: 'Operating profit ÷ revenue' },
    { label: 'Production Defect Rate (6 mo)', value: `${data.defectRatePct.toFixed(2)}%`, valueColor: data.defectRatePct > 5 ? CORAL : ACCENT, note: 'Lower is better' },
    { label: 'Open Sales Pipeline', value: inr(data.openPipelineValue), note: 'Probability-weighted future orders' },
    { label: 'Net Worth', value: inr((data.accounts.balanceSheet.assets.cashAndBank + data.accounts.balanceSheet.assets.receivables + data.accounts.balanceSheet.assets.rawMaterialAtCost + data.accounts.balanceSheet.assets.inputTaxCredit + data.accounts.balanceSheet.assets.fixedAssetsNetBookValue + data.accounts.balanceSheet.assets.deferredTaxAsset) - (data.accounts.balanceSheet.liabilities.payables + data.accounts.balanceSheet.liabilities.outstandingAdvances + data.accounts.balanceSheet.liabilities.loansPayable + data.accounts.balanceSheet.liabilities.deferredTaxLiability)), note: 'Total assets less total liabilities' },
  ];
  const eCols = 4, eW = 2.85, eH = 1.55, eGX = 0.16, eGY = 0.2, eX0 = MARGIN, eY0 = 1.5;
  kpis.forEach((k, i) => {
    const cx = eX0 + (i % eCols) * (eW + eGX);
    const cy = eY0 + Math.floor(i / eCols) * (eH + eGY);
    addKpiCard(s, cx, cy, eW, eH, k.value, k.label, k);
  });
  addFooter(s, `Figures include the current, in-progress ${data.thisFy.label.split('-')[0]} financial year to date. YoY comparisons are against the prior financial year's full-year and same-period figures.`);

  // --- Quarterly scaling (4-metric quadrant, HFL "Relentless Growth" style) ------
  s = pptx.addSlide();
  addHeader(s, companyName, 'Financial Performance', 'Scaling Consistently — Last 4 Quarters');
  const quadMetrics = [
    { key: 'revenue', label: 'REVENUE', color: BRAND },
    { key: 'grossProfit', label: 'GROSS PROFIT', color: ACCENT },
    { key: 'operatingProfit', label: 'OPERATING PROFIT', color: GOLD },
    { key: 'profit', label: 'NET PROFIT (PAT)', color: CORAL },
  ];
  const qW = 5.95, qH = 2.55, qGX = 0.3, qGY = 0.25, qX0 = MARGIN, qY0 = 1.45;
  quadMetrics.forEach((metric, i) => {
    const cx = qX0 + (i % 2) * (qW + qGX);
    const cy = qY0 + Math.floor(i / 2) * (qH + qGY);
    const first = data.quarterlyTrend[0][metric.key], last = data.quarterlyTrend[data.quarterlyTrend.length - 1][metric.key];
    s.addShape('roundRect', { x: cx, y: cy, w: qW, h: qH, fill: { color: LIGHT_BG }, line: { color: LINE, width: 1 }, rectRadius: 0.06 });
    s.addText(metric.label, { x: cx + 0.2, y: cy + 0.12, w: qW - 1.8, h: 0.3, fontSize: 11, bold: true, color: metric.color, charSpacing: 1 });
    addGrowthChip(s, cx + qW - 1.65, cy + 0.1, growthPct(last, first), 1.45);
    s.addChart(pptx.ChartType.bar, [{ name: metric.label, labels: data.quarterlyTrend.map((q) => fmtShortMonth(q.label)), values: data.quarterlyTrend.map((q) => Math.round(q[metric.key])) }],
      { x: cx + 0.15, y: cy + 0.5, w: qW - 0.3, h: qH - 0.65, chartColors: [metric.color], showLegend: false, showValue: false, catAxisLabelFontSize: 9, valAxisHidden: true, barGapWidthPct: 35 });
  });
  addFooter(s, 'Each panel shows the trailing four quarters, oldest to most recent. Growth badge compares the most recent quarter to the oldest shown.');

  // --- Monthly trend chart -----------------------------------------------------
  s = pptx.addSlide();
  addHeader(s, companyName, 'Financial Performance', 'Monthly Trend — Last 12 Months');
  s.addChart(pptx.ChartType.bar, [
    { name: 'Revenue', labels: data.monthlyTrend.map((m) => fmtShortMonth(m.label)), values: data.monthlyTrend.map((m) => Math.round(m.revenue)) },
    { name: 'Net Profit', labels: data.monthlyTrend.map((m) => fmtShortMonth(m.label)), values: data.monthlyTrend.map((m) => Math.round(m.profit)) },
  ], { x: MARGIN, y: 1.4, w: 8.6, h: 5.3, barGrouping: 'clustered', showLegend: true, legendPos: 'b', chartColors: [BRAND, ACCENT], showValue: false, catAxisLabelFontSize: 8.5 });
  const avgRev = data.monthlyTrend.reduce((s2, m) => s2 + m.revenue, 0) / data.monthlyTrend.length;
  const bestMonth = data.monthlyTrend.reduce((best, m) => (m.revenue > best.revenue ? m : best), data.monthlyTrend[0]);
  addSectionBar(s, 9.65, 1.4, 3.15, 'Key Takeaways');
  s.addShape('roundRect', { x: 9.65, y: 1.9, w: 3.15, h: 4.8, fill: { color: LIGHT_BG }, line: { color: LINE, width: 1 }, rectRadius: 0.06 });
  s.addText([
    { text: 'Average monthly revenue\n', options: { bold: true, color: BRAND, fontSize: 12 } },
    { text: `${inr(avgRev)}\n\n`, options: { fontSize: 15, bold: true, color: ACCENT } },
    { text: 'Strongest month\n', options: { bold: true, color: BRAND, fontSize: 12 } },
    { text: `${fmtShortMonth(bestMonth.label)} — ${inr(bestMonth.revenue)}\n\n`, options: { fontSize: 13 } },
    { text: 'Trend\n', options: { bold: true, color: BRAND, fontSize: 12 } },
    { text: growthPct(data.monthlyTrend[data.monthlyTrend.length - 1].revenue, data.monthlyTrend[0].revenue) >= 0 ? 'Revenue has grown across the trailing 12 months, consistent with the quarterly and yearly trends elsewhere in this deck.' : 'Revenue has softened across the trailing 12 months — worth cross-checking against the pipeline and production trends alongside this.', options: { fontSize: 11, color: MUTED } },
  ], { x: 9.85, y: 2.1, w: 2.75, h: 4.4, valign: 'top', lineSpacingMultiple: 1.2 });
  addFooter(s, 'Revenue and Net Profit computed from live invoice and cost data for each calendar month.');

  // --- Yearly comparison ---------------------------------------------------------
  s = pptx.addSlide();
  addHeader(s, companyName, 'Financial Performance', `Yearly Comparison — FY${data.thisFy.label} vs Previous FY`);
  const yMetrics = [
    { label: 'Revenue', a: data.fyLast.sales, b: data.fyThis.sales },
    { label: 'Operating Profit', a: data.fyLast.operatingProfit, b: data.fyThis.operatingProfit },
    { label: 'Net Profit (PAT)', a: data.fyLast.pat, b: data.fyThis.pat },
  ];
  const yW = 3.9, yGX = 0.25, yX0 = MARGIN, yY0 = 1.5, yH = 4.2;
  yMetrics.forEach((m, i) => {
    const cx = yX0 + i * (yW + yGX);
    s.addShape('roundRect', { x: cx, y: yY0, w: yW, h: yH, fill: { color: LIGHT_BG }, line: { color: LINE, width: 1 }, rectRadius: 0.06 });
    s.addText(m.label.toUpperCase(), { x: cx + 0.2, y: yY0 + 0.18, w: yW - 0.4, h: 0.3, fontSize: 11.5, bold: true, color: BRAND, charSpacing: 1 });
    s.addChart(pptx.ChartType.bar, [{ name: m.label, labels: ['Previous FY', `FY${data.thisFy.label}`], values: [Math.round(m.a), Math.round(m.b)] }],
      { x: cx + 0.2, y: yY0 + 0.55, w: yW - 0.4, h: 2.5, chartColors: [BRAND], showLegend: false, showValue: false, catAxisLabelFontSize: 10 });
    addGrowthChip(s, cx + (yW - 1.7) / 2, yY0 + yH - 0.55, growthPct(m.b, m.a), 1.7);
  });
  addFooter(s, `Current FY figures are to-date (FY runs 1 April – 31 March); previous FY is the full completed year.`);

  // --- Sales report -----------------------------------------------------------
  s = pptx.addSlide();
  addHeader(s, companyName, 'Commercial Performance', 'Sales Report — Top Performers (Last 12 Months)');
  const concentrationPct = data.totalSalesRevenue > 0 ? (data.topProductsRevenue / data.totalSalesRevenue) * 100 : 0;
  addKpiCard(s, MARGIN, 1.45, 3.9, 1.15, inr(data.totalSalesRevenue), 'Total Sales Revenue (12 mo)', { valueSize: 18 });
  addKpiCard(s, MARGIN + 4.05, 1.45, 3.9, 1.15, `${concentrationPct.toFixed(0)}%`, 'Revenue from Top 5 Products', { valueSize: 18 });
  addKpiCard(s, MARGIN + 8.1, 1.45, 3.9, 1.15, String(data.topCustomers.length), 'Customers Driving Top Revenue', { valueSize: 18 });
  s.addText('Top 5 Products', { x: MARGIN, y: 2.85, w: 6, h: 0.35, fontSize: 14, bold: true, color: BRAND });
  s.addTable([
    [{ text: 'Product', options: { bold: true, fill: { color: BRAND }, color: 'FFFFFF' } }, { text: 'Qty Sold', options: { bold: true, fill: { color: BRAND }, color: 'FFFFFF' } }, { text: 'Revenue', options: { bold: true, fill: { color: BRAND }, color: 'FFFFFF' } }],
    ...(data.topProducts.length ? data.topProducts.map((p) => [p.name, String(Math.round(p.qty)), inr(p.revenue)]) : [['No sales yet', '', '']]),
  ], { x: MARGIN, y: 3.25, w: 5.9, fontSize: 11, border: { type: 'solid', color: LINE, pt: 1 }, autoPage: false });
  s.addText('Top 5 Customers', { x: 6.9, y: 2.85, w: 6, h: 0.35, fontSize: 14, bold: true, color: BRAND });
  s.addTable([
    [{ text: 'Customer', options: { bold: true, fill: { color: BRAND }, color: 'FFFFFF' } }, { text: 'Revenue', options: { bold: true, fill: { color: BRAND }, color: 'FFFFFF' } }],
    ...(data.topCustomers.length ? data.topCustomers.map((c) => [c.name, inr(c.revenue)]) : [['No sales yet', '']]),
  ], { x: 6.9, y: 3.25, w: 5.9, fontSize: 11, border: { type: 'solid', color: LINE, pt: 1 }, autoPage: false });
  addFooter(s, 'Ranked by total invoiced revenue over the trailing 12 months.');

  // --- Production report --------------------------------------------------------
  s = pptx.addSlide();
  addHeader(s, companyName, 'Operational Performance', 'Production Report — Last 6 Months');
  s.addChart(pptx.ChartType.bar, [
    { name: 'Produced', labels: data.productionTrend.map((p) => fmtShortMonth(p.label)), values: data.productionTrend.map((p) => Math.round(p.produced)) },
    { name: 'Defective', labels: data.productionTrend.map((p) => fmtShortMonth(p.label)), values: data.productionTrend.map((p) => Math.round(p.defective)) },
  ], { x: MARGIN, y: 1.4, w: 7.4, h: 3.0, barGrouping: 'stacked', showLegend: true, legendPos: 'b', chartColors: [BRAND, CORAL], catAxisLabelFontSize: 9 });
  addKpiCard(s, 8.2, 1.4, 4.6, 1.05, Math.round(data.productionTotals.produced).toLocaleString('en-IN'), 'Total Units Produced', { valueSize: 20 });
  addKpiCard(s, 8.2, 2.6, 4.6, 1.05, `${data.defectRatePct.toFixed(2)}%`, 'Defect Rate', { valueSize: 20, valueColor: data.defectRatePct > 5 ? CORAL : ACCENT });
  addSectionBar(s, MARGIN, 4.65, PAGE_W - 2 * MARGIN, 'Top Products by Production Volume (6 mo)');
  s.addTable([
    [{ text: 'Product', options: { bold: true, fill: { color: LIGHT_BG } } }, { text: 'Units Produced', options: { bold: true, fill: { color: LIGHT_BG } } }],
    ...(data.topProducedProducts.length ? data.topProducedProducts.map((p) => [p.name, Math.round(p.produced).toLocaleString('en-IN')]) : [['No production logged yet', '']]),
  ], { x: MARGIN, y: 5.05, w: PAGE_W - 2 * MARGIN, h: 1.9, fontSize: 10.5, border: { type: 'solid', color: LINE, pt: 1 }, autoPage: false, rowH: 0.32 });
  addFooter(s, 'Defect rate = defective units ÷ (produced + defective units) over the same 6-month window.');

  // --- Balance sheet -----------------------------------------------------------
  s = pptx.addSlide();
  addHeader(s, companyName, 'Financial Position', 'Balance Sheet Snapshot');
  const a = data.accounts.balanceSheet.assets, l = data.accounts.balanceSheet.liabilities;
  const totalAssets = a.cashAndBank + a.receivables + a.rawMaterialAtCost + a.inputTaxCredit + a.fixedAssetsNetBookValue + a.deferredTaxAsset;
  const totalLiabilities = l.payables + l.outstandingAdvances + l.loansPayable + l.deferredTaxLiability;
  addSectionBar(s, MARGIN, 1.4, 5.95, 'Assets', BRAND);
  s.addTable([
    ['Cash & Bank', inr(a.cashAndBank)], ['Accounts Receivable', inr(a.receivables)], ['Raw Material at Cost', inr(a.rawMaterialAtCost)],
    ['Input GST Credit (recoverable)', inr(a.inputTaxCredit)],
    ['Fixed Assets (Net Book Value)', inr(a.fixedAssetsNetBookValue)], ['Deferred Tax Asset', inr(a.deferredTaxAsset)],
    [{ text: 'Total Assets', options: { bold: true, fill: { color: LIGHT_BG } } }, { text: inr(totalAssets), options: { bold: true, fill: { color: LIGHT_BG } } }],
  ], { x: MARGIN, y: 1.8, w: 5.95, fontSize: 11, border: { type: 'solid', color: LINE, pt: 1 }, autoPage: false });
  addSectionBar(s, 6.85, 1.4, 5.95, 'Liabilities', GOLD);
  s.addTable([
    ['Accounts Payable (incl. GST)', inr(l.payables)], ['Outstanding Advances', inr(l.outstandingAdvances)], ['Loans Payable', inr(l.loansPayable)], ['Deferred Tax Liability', inr(l.deferredTaxLiability)],
    [{ text: 'Total Liabilities', options: { bold: true, fill: { color: LIGHT_BG } } }, { text: inr(totalLiabilities), options: { bold: true, fill: { color: LIGHT_BG } } }],
  ], { x: 6.85, y: 1.8, w: 5.95, fontSize: 11, border: { type: 'solid', color: LINE, pt: 1 }, autoPage: false });
  s.addShape('roundRect', { x: 6.85, y: 4.55, w: 5.95, h: 1, fill: { color: BRAND }, rectRadius: 0.06 });
  s.addText('NET WORTH', { x: 7.05, y: 4.68, w: 3, h: 0.4, fontSize: 12, bold: true, color: 'DCE4F5', charSpacing: 1 });
  s.addText(inr(totalAssets - totalLiabilities), { x: 7.05, y: 4.95, w: 5.6, h: 0.5, fontSize: 20, bold: true, color: 'FFFFFF' });
  addFooter(s, 'A management-accounting snapshot to support internal review — not a substitute for a statutory audited balance sheet.');

  // --- Future orders pipeline ---------------------------------------------------
  s = pptx.addSlide();
  addHeader(s, companyName, 'Commercial Performance', 'Future Order Pipeline & Sales Bid Conversion');
  const statuses = [
    { key: 'Open', color: GOLD }, { key: 'Completed', color: BRAND }, { key: 'Converted', color: ACCENT }, { key: 'Lost', color: CORAL },
  ];
  const funnelW = 2.85, funnelGX = 0.2, funnelY = 1.45, funnelH = 1.5;
  statuses.forEach((st, i) => {
    const cx = MARGIN + i * (funnelW + funnelGX);
    const d = data.pipelineByStatus[st.key] || { count: 0, value: 0 };
    s.addShape('roundRect', { x: cx, y: funnelY, w: funnelW, h: funnelH, fill: { color: st.color }, rectRadius: 0.06 });
    s.addText(String(d.count), { x: cx + 0.15, y: funnelY + 0.12, w: funnelW - 0.3, h: 0.55, fontSize: 26, bold: true, color: 'FFFFFF' });
    s.addText(st.key.toUpperCase(), { x: cx + 0.15, y: funnelY + 0.68, w: funnelW - 0.3, h: 0.3, fontSize: 10.5, bold: true, color: 'FFFFFF', charSpacing: 1 });
    s.addText(inr(d.value), { x: cx + 0.15, y: funnelY + 1.0, w: funnelW - 0.3, h: 0.35, fontSize: 11, color: 'FFFFFF' });
  });
  addKpiCard(s, MARGIN, 3.3, 3.9, 1.05, inr(data.openPipelineValue), 'Open + Completed Pipeline (weighted)', { valueSize: 16 });
  addSectionBar(s, MARGIN, 4.6, PAGE_W - 2 * MARGIN, 'Salesperson-wise Bid Confirmation');
  const spMap = {};
  data.futureOrders.forEach((o) => {
    const name = o.salesperson || '(unassigned)';
    spMap[name] = spMap[name] || { total: 0, converted: 0, lost: 0 };
    spMap[name].total += 1;
    if (o.status === 'Converted') spMap[name].converted += 1;
    if (o.status === 'Lost') spMap[name].lost += 1;
  });
  const spRows = Object.entries(spMap).map(([name, v]) => [name, String(v.total), String(v.converted), String(v.lost), (v.converted + v.lost) > 0 ? `${((v.converted / (v.converted + v.lost)) * 100).toFixed(0)}%` : '—']);
  s.addTable([
    [{ text: 'Salesperson', options: { bold: true, fill: { color: LIGHT_BG } } }, { text: 'Total Bids', options: { bold: true, fill: { color: LIGHT_BG } } }, { text: 'Converted', options: { bold: true, fill: { color: LIGHT_BG } } }, { text: 'Lost', options: { bold: true, fill: { color: LIGHT_BG } } }, { text: 'Win Rate', options: { bold: true, fill: { color: LIGHT_BG } } }],
    ...(spRows.length ? spRows : [['No bids recorded yet', '', '', '', '']]),
  ], { x: MARGIN, y: 5.05, w: PAGE_W - 2 * MARGIN, fontSize: 10.5, border: { type: 'solid', color: LINE, pt: 1 }, autoPage: false });
  addFooter(s, 'Win Rate = Converted ÷ (Converted + Lost); orders still Open or Completed are excluded from the rate until resolved.');

  // --- Vision / growth planning --------------------------------------------------
  s = pptx.addSlide();
  s.background = { color: BRAND };
  s.addShape('rect', { x: 0, y: 0, w: PAGE_W, h: 0.12, fill: { color: GOLD } });
  s.addShape('ellipse', { x: -2.5, y: 4.5, w: 6, h: 6, fill: { color: '25407A' }, line: { type: 'none' } });
  s.addText('GROWTH VISION', { x: 0.75, y: 0.7, w: 8, h: 0.35, fontSize: 12, bold: true, color: GOLD, charSpacing: 2 });
  s.addText('Future Planning & Growth Outlook', { x: 0.75, y: 1.05, w: 11.8, h: 0.7, fontSize: 28, bold: true, color: 'FFFFFF' });
  s.addShape('rect', { x: 0.8, y: 1.85, w: 1.4, h: 0.05, fill: { color: GOLD } });
  s.addText(co.vision_statement || 'Add a growth vision and future planning statement in Company Settings — it will appear here on every presentation generated.',
    { x: 0.8, y: 2.3, w: 11.7, h: 4.4, fontSize: 17, color: 'DCE4F5', valign: 'top', lineSpacingMultiple: 1.4 });

  // --- Closing --------------------------------------------------------------------
  s = pptx.addSlide();
  s.addShape('rect', { x: 0, y: 0, w: PAGE_W, h: 0.14, fill: { color: BRAND } });
  if (co.logo_data_url) { try { s.addImage({ data: co.logo_data_url, x: PAGE_W / 2 - 0.5, y: 1.3, w: 1, h: 1 }); } catch (e) {} }
  s.addText('Thank You', { x: 0.5, y: 2.6, w: 12.3, h: 1, fontSize: 38, bold: true, align: 'center', color: BRAND });
  s.addShape('rect', { x: PAGE_W / 2 - 0.7, y: 3.55, w: 1.4, h: 0.04, fill: { color: GOLD } });
  s.addText(companyName, { x: 0.5, y: 3.8, w: 12.3, h: 0.5, fontSize: 16, align: 'center', color: MUTED });
  if (co.email || co.phone) s.addText([co.email, co.phone].filter(Boolean).join('  ·  '), { x: 0.5, y: 4.3, w: 12.3, h: 0.4, fontSize: 11, align: 'center', color: FAINT });

  return pptx;
}

router.get('/investor-presentation', requireRole('ADMIN', 'MANAGER'), async (req, res) => {
  try {
    const data = gatherReportData();
    const pptx = buildDeck(data);
    const buf = await pptx.write({ outputType: 'nodebuffer' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('Content-Disposition', `attachment; filename="${(data.company.company_name || 'Company').replace(/[^a-z0-9]+/gi, '-')}-Investor-Presentation-${data.today}.pptx"`);
    res.send(buf);
  } catch (e) {
    console.error('[investor-presentation]', e);
    res.status(500).json({ error: `Could not generate the presentation: ${e.message}` });
  }
});

module.exports = { router };
