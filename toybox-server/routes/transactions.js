// ============================================================================
// routes/transactions.js — business-logic-heavy modules (stock, billing, payroll)
// ============================================================================
const express = require('express');
const { db, nextNo, stockBalance, addStockTxn, stockOutForSale, avgPurchaseRate, audit } = require('../db');
const { evaluateIncentive, refreshCustomerLoyalty, getCustomerLoyalty } = require('./incentives');
const { z, validateBody } = require('../lib/validate');
const { requireModule } = require('../auth');
const sub = require('../lib/subscription');
const RET = require('./returns').helpers;
const { productSchema, productionSchema, salesSchema, receiptSchema, payrollSchema, payrollPaymentSchema, attendanceSchema, advanceSchema, supplierPaymentSchema, outsourcingPersonSchema, outsourcingJobSchema, outsourcingPaymentSchema } = require('../lib/schemas');

const router = express.Router();
function todayDefault() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Production pipeline stage order — items flow through whatever stages are
// configured in Settings → Job Work & Pipeline Stages (default: Molding →
// Cutting → Finishing → Sticker → Packing). A later stage can never claim
// more units than the previous stage has actually finished; this is checked
// before any new job or stage-movement is allowed to save.
// ---------------------------------------------------------------------------
function pipelineStageNames() {
  return db.prepare(`SELECT name FROM pipeline_stages WHERE active = 1 ORDER BY sort_order ASC, id ASC`).all().map((r) => r.name);
}
// The last configured pipeline stage (e.g. "Packing") — once a product
// finishes this stage, it has completed its whole internal/outsourced
// pipeline and is ready to be shifted into Finished Goods automatically.
function lastStageName() {
  const stages = pipelineStageNames();
  return stages.length ? stages[stages.length - 1] : null;
}
// Consume the raw materials that are tagged (in BOM) to be used at this
// specific stage, proportional to the quantity that just completed the
// stage — this is separate from the legacy "consume full BOM at final
// Production entry" flow, which only applies to BOM lines with no stage set.
function consumeStageMaterials(date, productId, stage, qtyCompleted, refType, refId) {
  if (!productId || !stage || !(qtyCompleted > 0)) return;
  const lines = db.prepare(`SELECT raw_material_id, qty_per_unit FROM bom WHERE product_id = ? AND stage = ?`).all(productId, stage);
  for (const line of lines) {
    const consumed = Number(line.qty_per_unit) * qtyCompleted;
    if (consumed > 0) addStockTxn(date, 'RAW', line.raw_material_id, consumed, 'OUT', refType, refId, `Stage: ${stage}`);
  }
}
// Applies both effects of a stage being completed for some quantity of a
// product: (1) consumes any BOM raw materials tagged to that stage, and
// (2) if this was the LAST pipeline stage, the product has now finished its
// entire internal/outsourced pipeline — shift that quantity straight into
// Finished Goods stock automatically, and tell the caller so the frontend
// can show the "shifted to Finished Goods" message box.
// Applies the effects of a stage being completed for some quantity of a
// product: consumes any BOM raw materials tagged to that stage. If this was
// the LAST pipeline stage, the product has finished its entire
// internal/outsourced pipeline — but rather than silently pushing stock into
// Finished Goods here, we hand off to a proper Production entry (so batch
// no., shift, defective qty and operator get recorded, just like an
// in-house production run). The caller uses the returned info to open that
// Production Entry form pre-filled and locked to this quantity.
function applyStageEffects(date, productId, stage, qtyCompleted, kind, refId) {
  const consumeRef = kind === 'JOB' ? 'STAGE_CONSUME_JOB' : 'STAGE_CONSUME_PS';
  if (!productId || !stage || !(qtyCompleted > 0)) return { stageCompleted: false };
  consumeStageMaterials(date, productId, stage, qtyCompleted, consumeRef, refId);
  if (stage === lastStageName()) {
    const product = db.prepare(`SELECT name FROM products WHERE id = ?`).get(productId);
    return { stageCompleted: true, shiftedQty: qtyCompleted, productId, productName: product?.name || '' };
  }
  return { stageCompleted: false };
}
// Removes the raw-material consumption effect above — used before
// re-applying on an edit, and on delete. Also clears any legacy
// STAGE_COMPLETE_* finished-goods entries from before this flow changed to
// go through a proper Production entry instead.
function clearStageEffects(kind, refId) {
  const consumeRef = kind === 'JOB' ? 'STAGE_CONSUME_JOB' : 'STAGE_CONSUME_PS';
  const legacyCompleteRef = kind === 'JOB' ? 'STAGE_COMPLETE_JOB' : 'STAGE_COMPLETE_PS';
  db.prepare(`DELETE FROM stock_txn WHERE ref_type IN (?,?) AND ref_id = ?`).run(consumeRef, legacyCompleteRef, refId);
}
function previousStage(stage) {
  const stages = pipelineStageNames();
  const i = stages.indexOf(stage);
  return i > 0 ? stages[i - 1] : null;
}
// How much output a stage has actually finished and not yet claimed by the next stage.
function stageAvailable(stage, excludeJobId, excludeStageMoveId) {
  const stages = pipelineStageNames();
  const inhouse = db.prepare(`SELECT COALESCE(SUM(qty_out),0) o FROM production_stages WHERE stage = ? AND id != ?`).get(stage, excludeStageMoveId || 0);
  const outsourced = db.prepare(`SELECT COALESCE(SUM(qty_received),0) r FROM outsourcing_jobs WHERE stage = ? AND id != ?`).get(stage, excludeJobId || 0);
  const completed = inhouse.o + outsourced.r;
  const next = stages[stages.indexOf(stage) + 1];
  if (!next) return completed; // last stage has no "next" stage to have claimed its output
  const claimedByNextInhouse = db.prepare(`SELECT COALESCE(SUM(qty_in),0) i FROM production_stages WHERE stage = ? AND id != ?`).get(next, excludeStageMoveId || 0);
  const claimedByNextOutsourced = db.prepare(`SELECT COALESCE(SUM(qty_sent),0) s FROM outsourcing_jobs WHERE stage = ? AND id != ?`).get(next, excludeJobId || 0);
  return completed - claimedByNextInhouse.i - claimedByNextOutsourced.s;
}

// ---------------------------------------------------------------------------
// Products — custom routes (not generic CRUD) so BOM can be saved in one step
// ---------------------------------------------------------------------------
router.get('/products', (req, res) => {
  const rows = db.prepare(`SELECT * FROM products WHERE active = 1 ORDER BY name`).all().map((p) => {
    const bom = db.prepare(`SELECT b.*, r.name material_name, r.unit material_unit, r.rate material_rate FROM bom b JOIN raw_materials r ON r.id = b.raw_material_id WHERE b.product_id = ?`).all(p.id)
      .map((b) => ({ ...b, avg_rate: avgPurchaseRate(b.raw_material_id) }));
    // Cost of Production uses the AVERAGE purchase rate of each raw material
    // (not just its most recent purchase price), so a one-off cheap/expensive
    // purchase doesn't swing the costing figure.
    const materialCost = bom.reduce((s, b) => s + Number(b.qty_per_unit) * Number(b.avg_rate), 0);
    // Processing cost per unit — the average rate actually paid per stage
    // (Molding, Cutting, Finishing, Sticker, Packing) for jobwork on this
    // product, taken automatically from completed Outsourcing job entries.
    const stageRates = db.prepare(`
      SELECT stage, AVG(rate) avg_rate FROM outsourcing_jobs
      WHERE product_id = ? AND qty_received > 0 GROUP BY stage`).all(p.id);
    const processingCost = stageRates.reduce((s, r) => s + Number(r.avg_rate || 0), 0);
    const overhead = Number(p.overhead_per_unit || 0);
    let bundle_components = [], bundle_available = null;
    if (p.is_bundle) {
      bundle_components = db.prepare(`
        SELECT pb.*, pr.name component_name, pr.sku component_sku FROM product_bundles pb
        JOIN products pr ON pr.id = pb.component_product_id WHERE pb.bundle_product_id = ?`).all(p.id);
      // How many complete bundles could be sold right now, limited by
      // whichever component is shortest — e.g. a "Set of 3 (Red/Blue/
      // Green)" bundle can only make as many sets as its scarcest colour.
      bundle_available = bundle_components.length
        ? Math.max(0, Math.min(...bundle_components.map((c) => Math.floor(stockBalance('PRODUCT', c.component_product_id) / Number(c.qty_per_bundle)))))
        : 0;
    }
    return {
      ...p,
      stock: p.is_bundle ? bundle_available : stockBalance('PRODUCT', p.id),
      bom, bundle_components, bundle_available,
      cost_breakdown: { materialCost, processingCost, overhead, stages: stageRates },
      cost_of_production: materialCost + processingCost + overhead,
    };
  });
  res.json(rows);
});
// Barcode-scan lookup for the quick Barcode Sale screen — matches the
// product's barcode field, falling back to SKU (since barcode defaults to
// SKU when not set separately).
router.get('/products/barcode/:code', (req, res) => {
  const code = req.params.code.trim();
  const p = db.prepare(`SELECT * FROM products WHERE active = 1 AND (barcode = ? OR sku = ?)`).get(code, code);
  if (!p) return res.status(404).json({ error: `No product found for barcode "${code}"` });
  const stock = p.is_bundle
    ? (() => {
        const parts = db.prepare(`SELECT component_product_id, qty_per_bundle FROM product_bundles WHERE bundle_product_id = ?`).all(p.id);
        return parts.length ? Math.max(0, Math.min(...parts.map((c) => Math.floor(stockBalance('PRODUCT', c.component_product_id) / Number(c.qty_per_bundle))))) : 0;
      })()
    : stockBalance('PRODUCT', p.id);
  res.json({ ...p, stock });
});
function saveProductBundle(productId, components) {
  db.prepare(`DELETE FROM product_bundles WHERE bundle_product_id = ?`).run(productId);
  for (const c of components || []) {
    if (c.component_product_id && Number(c.qty_per_bundle) > 0 && Number(c.component_product_id) !== Number(productId)) {
      db.prepare(`INSERT INTO product_bundles (bundle_product_id, component_product_id, qty_per_bundle) VALUES (?,?,?)`)
        .run(productId, c.component_product_id, Number(c.qty_per_bundle));
    }
  }
}
router.post('/products', validateBody(productSchema), (req, res) => {
  const b = req.body;
  const tx = db.transaction(() => {
    // A blank SKU used to stay blank — which meant the product could never
    // be found by the barcode scanner at the point of sale (Barcode Sale
    // looks products up by exactly this field). Auto-filling it the same
    // way invoice numbers already are means every product is scannable
    // from the moment it's created, whether or not someone typed a SKU.
    const sku = (b.sku || '').trim() || nextNo('SKU-', 'products', 'sku');
    const isBundle = b.is_bundle ? 1 : 0;
    const info = db.prepare(`
      INSERT INTO products (sku,name,category,unit,sale_rate,gst_rate,hsn_code,min_stock,opening_stock,overhead_per_unit,barcode,image_data_url,size,weight,color,is_bundle,bundle_label)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(sku, b.name, b.category || '', b.unit || 'Pcs',
      Number(b.sale_rate) || 0, Number(b.gst_rate ?? 18), (b.hsn_code || '').trim() || null, Number(b.min_stock) || 0,
      // A bundle has no stock of its own — it's entirely made of its
      // components — so opening_stock is forced to 0 for one regardless of
      // what was typed, rather than silently double-counting inventory.
      isBundle ? 0 : Number(b.opening_stock) || 0,
      Number(b.overhead_per_unit) || 0, (b.barcode || '').trim() || sku,
      b.image_data_url || null, b.size || null, b.weight || null, b.color || null, isBundle, b.bundle_label || null);
    const pid = info.lastInsertRowid;
    for (const m of b.bom || []) {
      if (m.raw_material_id && Number(m.qty_per_unit) > 0) {
        db.prepare(`INSERT INTO bom (product_id, raw_material_id, qty_per_unit, stage) VALUES (?,?,?,?)`).run(pid, m.raw_material_id, Number(m.qty_per_unit), m.stage || null);
      }
    }
    if (isBundle) saveProductBundle(pid, b.bundle_components);
    audit(req, 'CREATE', 'products', pid, b);
    return pid;
  });
  const id = tx();
  res.json(db.prepare(`SELECT * FROM products WHERE id = ?`).get(id));
});
router.put('/products/:id', validateBody(productSchema), (req, res) => {
  const b = req.body;
  const tx = db.transaction(() => {
    // overhead_per_unit is now managed exclusively via PUT /products/:id/overhead
    // (from the BOM page) — preserve the existing value when this general
    // product-edit route doesn't send one, instead of resetting it to 0.
    const existing = db.prepare(`SELECT overhead_per_unit FROM products WHERE id = ?`).get(req.params.id);
    const overhead = b.overhead_per_unit !== undefined ? Number(b.overhead_per_unit) || 0 : (existing?.overhead_per_unit || 0);
    const sku = (b.sku || '').trim() || nextNo('SKU-', 'products', 'sku');
    const isBundle = b.is_bundle ? 1 : 0;
    db.prepare(`UPDATE products SET sku=?,name=?,category=?,unit=?,sale_rate=?,gst_rate=?,hsn_code=?,min_stock=?,opening_stock=?,overhead_per_unit=?,barcode=?,image_data_url=?,size=?,weight=?,color=?,is_bundle=?,bundle_label=? WHERE id=?`)
      .run(sku, b.name, b.category || '', b.unit || 'Pcs', Number(b.sale_rate) || 0,
        Number(b.gst_rate ?? 18), (b.hsn_code || '').trim() || null, Number(b.min_stock) || 0, isBundle ? 0 : Number(b.opening_stock) || 0, overhead, (b.barcode || '').trim() || sku,
        b.image_data_url || null, b.size || null, b.weight || null, b.color || null, isBundle, b.bundle_label || null, req.params.id);
    if (b.bom) {
      db.prepare(`DELETE FROM bom WHERE product_id = ?`).run(req.params.id);
      for (const m of b.bom) {
        if (m.raw_material_id && Number(m.qty_per_unit) > 0) {
          db.prepare(`INSERT INTO bom (product_id, raw_material_id, qty_per_unit, stage) VALUES (?,?,?,?)`).run(req.params.id, m.raw_material_id, Number(m.qty_per_unit), m.stage || null);
        }
      }
    }
    if (isBundle) saveProductBundle(req.params.id, b.bundle_components);
    else db.prepare(`DELETE FROM product_bundles WHERE bundle_product_id = ?`).run(req.params.id); // un-checking "combo pack" clears any leftover components
    audit(req, 'UPDATE', 'products', req.params.id, b);
  });
  tx();
  res.json(db.prepare(`SELECT * FROM products WHERE id = ?`).get(req.params.id));
});
router.put('/products/:id/overhead', (req, res) => {
  db.prepare(`UPDATE products SET overhead_per_unit = ? WHERE id = ?`).run(Number(req.body.overhead_per_unit) || 0, req.params.id);
  audit(req, 'UPDATE', 'products', req.params.id, { overhead_per_unit: req.body.overhead_per_unit });
  res.json({ ok: true });
});
router.delete('/products/:id', (req, res) => {
  db.prepare(`UPDATE products SET active = 0 WHERE id = ?`).run(req.params.id);
  audit(req, 'DELETE', 'products', req.params.id, {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// BOM — raw materials required per unit of a product (standalone add/edit too)
// ---------------------------------------------------------------------------
router.get('/bom', (req, res) => {
  const rows = db.prepare(`
    SELECT b.*, p.name product_name, r.name material_name, r.unit material_unit, r.rate material_rate
    FROM bom b JOIN products p ON p.id = b.product_id JOIN raw_materials r ON r.id = b.raw_material_id
    ORDER BY p.name`).all().map((b) => ({ ...b, avg_rate: avgPurchaseRate(b.raw_material_id) }));
  res.json(rows);
});
router.post('/bom', (req, res) => {
  const { product_id, raw_material_id, qty_per_unit, stage } = req.body;
  const info = db.prepare(`INSERT INTO bom (product_id, raw_material_id, qty_per_unit, stage) VALUES (?,?,?,?)`)
    .run(product_id, raw_material_id, qty_per_unit, stage || null);
  audit(req, 'CREATE', 'bom', info.lastInsertRowid, req.body);
  res.json({ id: info.lastInsertRowid });
});
router.put('/bom/:id', (req, res) => {
  const { qty_per_unit, stage } = req.body;
  db.prepare(`UPDATE bom SET qty_per_unit = ?, stage = ? WHERE id = ?`).run(qty_per_unit, stage || null, req.params.id);
  audit(req, 'UPDATE', 'bom', req.params.id, req.body);
  res.json({ ok: true });
});
router.delete('/bom/:id', (req, res) => {
  db.prepare(`DELETE FROM bom WHERE id = ?`).run(req.params.id);
  audit(req, 'DELETE', 'bom', req.params.id, {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Stock balances (live)
// ---------------------------------------------------------------------------
router.get('/stock/products', (req, res) => {
  const rows = db.prepare(`SELECT * FROM products WHERE active = 1 ORDER BY name`).all()
    .map((p) => ({ ...p, stock: stockBalance('PRODUCT', p.id) }));
  res.json(rows);
});
router.get('/stock/raw-materials', (req, res) => {
  const rows = db.prepare(`SELECT * FROM raw_materials WHERE active = 1 ORDER BY name`).all()
    .map((m) => ({ ...m, stock: stockBalance('RAW', m.id), avg_rate: avgPurchaseRate(m.id) }));
  res.json(rows);
});

// ---------------------------------------------------------------------------
// Production — adds finished-goods stock IN (good qty = produced - defective)
// ---------------------------------------------------------------------------
router.get('/production', (req, res) => {
  const rows = db.prepare(`
    SELECT pr.*, p.name product_name, p.unit, e.name operator_name
    FROM production pr JOIN products p ON p.id = pr.product_id
    LEFT JOIN employees e ON e.id = pr.operator_id ORDER BY pr.date DESC, pr.id DESC`).all();
  res.json(rows);
});
router.post('/production', validateBody(productionSchema), (req, res) => {
  const b = req.body;
  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO production (batch_no,date,product_id,shift,planned_qty,produced_qty,defective_qty,operator_id,remarks)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(b.batch_no || '', b.date, b.product_id, b.shift || 'Morning',
      Number(b.planned_qty) || 0, Number(b.produced_qty) || 0, Number(b.defective_qty) || 0,
      b.operator_id || null, b.remarks || '');
    const goodQty = Number(b.produced_qty || 0) - Number(b.defective_qty || 0);
    if (goodQty > 0) {
      addStockTxn(b.date, 'PRODUCT', b.product_id, goodQty, 'IN', 'PRODUCTION', info.lastInsertRowid, `Batch ${b.batch_no || ''}`);
      // Consume raw materials per the product's Bill of Materials — this is
      // what makes "Raw Material Used During Period" reporting meaningful.
      // Only BOM lines with no stage assigned are consumed here — lines
      // tagged to a specific pipeline stage are consumed automatically when
      // that stage is actually completed (Production Pipeline / Outsourcing).
      const bom = db.prepare(`SELECT raw_material_id, qty_per_unit FROM bom WHERE product_id = ? AND stage IS NULL`).all(b.product_id);
      for (const line of bom) {
        const consumed = Number(line.qty_per_unit) * goodQty;
        if (consumed > 0) addStockTxn(b.date, 'RAW', line.raw_material_id, consumed, 'OUT', 'PRODUCTION', info.lastInsertRowid, `Batch ${b.batch_no || ''}`);
      }
    }
    audit(req, 'CREATE', 'production', info.lastInsertRowid, b);
    return info.lastInsertRowid;
  });
  const id = tx();
  const row = db.prepare(`SELECT * FROM production WHERE id = ?`).get(id);
  const unlocked = row.operator_id ? evaluateIncentive(req, row.operator_id, 'PRODUCTION', row.date) : [];
  res.json({ ...row, unlockedIncentives: unlocked });
});
router.put('/production/:id', validateBody(productionSchema), (req, res) => {
  const b = req.body;
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM stock_txn WHERE ref_type = 'PRODUCTION' AND ref_id = ?`).run(req.params.id);
    db.prepare(`UPDATE production SET batch_no=?, date=?, product_id=?, shift=?, planned_qty=?, produced_qty=?, defective_qty=?, operator_id=?, remarks=? WHERE id=?`)
      .run(b.batch_no || '', b.date, b.product_id, b.shift || 'Morning', Number(b.planned_qty) || 0, Number(b.produced_qty) || 0,
        Number(b.defective_qty) || 0, b.operator_id || null, b.remarks || '', req.params.id);
    const goodQty = Number(b.produced_qty || 0) - Number(b.defective_qty || 0);
    if (goodQty > 0) {
      addStockTxn(b.date, 'PRODUCT', b.product_id, goodQty, 'IN', 'PRODUCTION', req.params.id, `Batch ${b.batch_no || ''}`);
      const bom = db.prepare(`SELECT raw_material_id, qty_per_unit FROM bom WHERE product_id = ? AND stage IS NULL`).all(b.product_id);
      for (const line of bom) {
        const consumed = Number(line.qty_per_unit) * goodQty;
        if (consumed > 0) addStockTxn(b.date, 'RAW', line.raw_material_id, consumed, 'OUT', 'PRODUCTION', req.params.id, `Batch ${b.batch_no || ''}`);
      }
    }
    audit(req, 'UPDATE', 'production', req.params.id, b);
  });
  tx();
  const editedProduction = db.prepare(`SELECT * FROM production WHERE id = ?`).get(req.params.id);
  const unlocked = editedProduction?.operator_id ? evaluateIncentive(req, editedProduction.operator_id, 'PRODUCTION', editedProduction.date) : [];
  res.json({ ...editedProduction, unlockedIncentives: unlocked });
});
router.delete('/production/:id', (req, res) => {
  db.prepare(`DELETE FROM stock_txn WHERE ref_type = 'PRODUCTION' AND ref_id = ?`).run(req.params.id);
  db.prepare(`DELETE FROM production WHERE id = ?`).run(req.params.id);
  audit(req, 'DELETE', 'production', req.params.id, {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Purchases — raw material IN
// ---------------------------------------------------------------------------
const purchaseSchema = z.object({
  purchase_date: z.string().min(1),
  supplier_id: z.coerce.number().int().positive(),
  item_type: z.enum(['RAW_MATERIAL', 'FINISHED_PRODUCT', 'ASSET']).default('RAW_MATERIAL'),
  raw_material_id: z.coerce.number().int().positive().nullish(),
  product_id: z.coerce.number().int().positive().nullish(),
  qty: z.coerce.number().positive(),
  rate: z.coerce.number().nonnegative(),
  gst_pct: z.coerce.number().min(0).max(100).default(0),
  status: z.enum(['Ordered', 'Received']).default('Received'),
  invoice_no: z.string().optional().default(''),
  remarks: z.string().optional().default(''),
  paid_amount: z.coerce.number().nonnegative().default(0),
  paid_mode: z.string().optional().default('Cash'),
}).refine((b) => b.item_type !== 'RAW_MATERIAL' || !!b.raw_material_id, { message: 'A raw material must be selected for a Raw Material purchase order', path: ['raw_material_id'] })
  .refine((b) => b.item_type !== 'FINISHED_PRODUCT' || !!b.product_id, { message: 'A product must be selected for a Finished Product purchase order', path: ['product_id'] });

// Moves stock for a Received purchase order — routes to raw_materials or
// products depending on item_type; an ASSET purchase moves no stock at
// all (assets are tracked separately in the Fixed Assets module).
function routePurchaseStock(purchase, refNo) {
  if (purchase.item_type === 'RAW_MATERIAL' && purchase.raw_material_id) {
    addStockTxn(purchase.purchase_date, 'RAW', purchase.raw_material_id, Number(purchase.qty), 'IN', 'PURCHASE', purchase.id, refNo);
    // Keep the raw material's costing rate current — Cost of Production for
    // finished goods is calculated from this rate, so it always reflects the
    // most recent purchase price automatically.
    db.prepare(`UPDATE raw_materials SET rate = ? WHERE id = ?`).run(Number(purchase.rate), purchase.raw_material_id);
  } else if (purchase.item_type === 'FINISHED_PRODUCT' && purchase.product_id) {
    addStockTxn(purchase.purchase_date, 'PRODUCT', purchase.product_id, Number(purchase.qty), 'IN', 'PURCHASE', purchase.id, refNo);
  }
}

router.get('/purchases', (req, res) => {
  const rows = db.prepare(`
    SELECT pu.*, s.name supplier_name,
      COALESCE(r.name, p.name) material_name, COALESCE(r.unit, p.unit) unit, COALESCE(r.hsn_code, p.hsn_code) hsn_code
    FROM purchases pu JOIN suppliers s ON s.id = pu.supplier_id
    LEFT JOIN raw_materials r ON r.id = pu.raw_material_id
    LEFT JOIN products p ON p.id = pu.product_id
    ORDER BY pu.purchase_date DESC, pu.id DESC`).all()
    .map((pu) => {
      const paid = Number(db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM supplier_payments WHERE purchase_id = ?`).get(pu.id).v || 0);
      const initialPayment = db.prepare(`SELECT mode FROM supplier_payments WHERE purchase_id=? AND source='PURCHASE_FORM' ORDER BY id LIMIT 1`).get(pu.id);
      const returned = RET.purchaseReturned(pu.id); const refunded = RET.purchaseRefunded(pu.id);
      const payable = Number(pu.amount || 0) + Number(pu.gst_amt || 0) - returned; // what is still owed for goods we kept
      const paidNet = paid - refunded;
      return { ...pu, payable, returned, paid: paidNet, paid_mode: initialPayment?.mode || 'Cash', balance: Math.max(0, payable - paidNet) };
    });
  res.json(rows);
});
router.post('/purchases', validateBody(purchaseSchema), (req, res) => {
  const b = req.body;
  const tx = db.transaction(() => {
    const no = nextNo('PUR-', 'purchases', 'purchase_no');
    const amount = b.qty * b.rate;
    const gstAmt = amount * b.gst_pct / 100;
    const info = db.prepare(`
      INSERT INTO purchases (purchase_no,purchase_date,supplier_id,item_type,raw_material_id,product_id,qty,rate,amount,gst_pct,gst_amt,status,invoice_no,remarks)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(no, b.purchase_date, b.supplier_id, b.item_type,
      b.item_type === 'RAW_MATERIAL' ? b.raw_material_id : null, b.item_type === 'FINISHED_PRODUCT' ? b.product_id : null,
      b.qty, b.rate, amount, b.gst_pct, gstAmt, b.status, b.invoice_no, b.remarks);
    const purchase = db.prepare(`SELECT * FROM purchases WHERE id = ?`).get(info.lastInsertRowid);
    if (Number(b.paid_amount || 0) > 0) {
      const payable = Number(amount) + Number(gstAmt);
      if (Number(b.paid_amount) > payable) throw new Error('Amount Paid cannot exceed the total purchase payable amount');
      db.prepare(`INSERT INTO supplier_payments (date,supplier_id,purchase_id,amount,mode,reference_no,remarks,source) VALUES (?,?,?,?,?,?,?, 'PURCHASE_FORM')`)
        .run(b.purchase_date, b.supplier_id, info.lastInsertRowid, Number(b.paid_amount), b.paid_mode || 'Cash', '', 'Initial payment entered in Purchase Form');
    }
    if (b.status === 'Received') routePurchaseStock(purchase, no); // an 'Ordered' PO moves no stock until explicitly received — see POST /purchases/:id/receive
    audit(req, 'CREATE', 'purchases', info.lastInsertRowid, b);
    return info.lastInsertRowid;
  });
  const id = tx();
  res.json(db.prepare(`SELECT * FROM purchases WHERE id = ?`).get(id));
});
router.put('/purchases/:id', validateBody(purchaseSchema), (req, res) => {
  if (Number(db.prepare(`SELECT COUNT(*) n FROM purchase_returns WHERE purchase_id = ? AND status <> 'Rejected'`).get(req.params.id).n)) return res.status(409).json({ error: 'Goods from this purchase have been (or are being) returned to the supplier, so it can no longer be edited. Reverse or reject the return first (Purchases → Returns).' });
  const b = req.body;
  const existing = db.prepare(`SELECT * FROM purchases WHERE id = ?`).get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Purchase order not found' });
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM stock_txn WHERE ref_type = 'PURCHASE' AND ref_id = ?`).run(req.params.id); // reversed and re-applied below, so an edit never double-counts stock
    const amount = b.qty * b.rate;
    const gstAmt = amount * b.gst_pct / 100;
    db.prepare(`UPDATE purchases SET purchase_date=?, supplier_id=?, item_type=?, raw_material_id=?, product_id=?, qty=?, rate=?, amount=?, gst_pct=?, gst_amt=?, status=?, invoice_no=?, remarks=? WHERE id=?`)
      .run(b.purchase_date, b.supplier_id, b.item_type, b.item_type === 'RAW_MATERIAL' ? b.raw_material_id : null,
        b.item_type === 'FINISHED_PRODUCT' ? b.product_id : null, b.qty, b.rate, amount, b.gst_pct, gstAmt, b.status, b.invoice_no, b.remarks, req.params.id);
    const purchase = db.prepare(`SELECT * FROM purchases WHERE id = ?`).get(req.params.id);
    const payable = Number(amount) + Number(gstAmt);
    const otherPaid = Number(db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM supplier_payments WHERE purchase_id = ? AND source <> 'PURCHASE_FORM'`).get(req.params.id).v || 0);
    if (Number(b.paid_amount || 0) < otherPaid) throw new Error(`Amount Paid cannot be less than later payments already recorded (${otherPaid})`);
    if (Number(b.paid_amount || 0) > payable) throw new Error('Amount Paid cannot exceed the total purchase payable amount');
    const sourcePayment = db.prepare(`SELECT id FROM supplier_payments WHERE purchase_id = ? AND source = 'PURCHASE_FORM' ORDER BY id LIMIT 1`).get(req.params.id);
    const sourceAmount = Math.max(0, Number(b.paid_amount || 0) - otherPaid);
    if (sourcePayment) {
      if (sourceAmount > 0) db.prepare(`UPDATE supplier_payments SET date=?, supplier_id=?, amount=?, mode=?, remarks=? WHERE id=?`).run(b.purchase_date, b.supplier_id, sourceAmount, b.paid_mode || 'Cash', 'Initial payment entered in Purchase Form', sourcePayment.id);
      else db.prepare(`DELETE FROM supplier_payments WHERE id=?`).run(sourcePayment.id);
    } else if (sourceAmount > 0) {
      db.prepare(`INSERT INTO supplier_payments (date,supplier_id,purchase_id,amount,mode,reference_no,remarks,source) VALUES (?,?,?,?,?,?,?, 'PURCHASE_FORM')`)
        .run(b.purchase_date, b.supplier_id, req.params.id, sourceAmount, b.paid_mode || 'Cash', '', 'Initial payment entered in Purchase Form');
    }
    if (b.status === 'Received') routePurchaseStock(purchase, purchase.purchase_no);
    audit(req, 'UPDATE', 'purchases', req.params.id, b);
  });
  tx();
  res.json(db.prepare(`SELECT * FROM purchases WHERE id = ?`).get(req.params.id));
});
// Marks an 'Ordered' purchase order as 'Received' and, in the same
// transaction, routes its stock — the moment a PO actually turns into
// inventory on hand. Re-receiving an already-Received order is a no-op
// (the stock would otherwise be double-counted).
router.post('/purchases/:id/receive', (req, res) => {
  const purchase = db.prepare(`SELECT * FROM purchases WHERE id = ?`).get(req.params.id);
  if (!purchase) return res.status(404).json({ error: 'Purchase order not found' });
  if (purchase.status === 'Received') return res.status(400).json({ error: 'This purchase order has already been received' });
  const tx = db.transaction(() => {
    db.prepare(`UPDATE purchases SET status = 'Received' WHERE id = ?`).run(req.params.id);
    routePurchaseStock(purchase, purchase.purchase_no);
    audit(req, 'UPDATE', 'purchases', req.params.id, { status: 'Received' });
  });
  tx();
  res.json(db.prepare(`SELECT * FROM purchases WHERE id = ?`).get(req.params.id));
});
router.delete('/purchases/:id', (req, res) => {
  if (Number(db.prepare(`SELECT COUNT(*) n FROM purchase_returns WHERE purchase_id = ?`).get(req.params.id).n)) return res.status(409).json({ error: 'This purchase has supplier returns recorded against it, so it cannot be deleted. The return history must stay for your accounts.' });
  db.prepare(`DELETE FROM stock_txn WHERE ref_type = 'PURCHASE' AND ref_id = ?`).run(req.params.id);
  db.prepare(`DELETE FROM purchases WHERE id = ?`).run(req.params.id);
  audit(req, 'DELETE', 'purchases', req.params.id, {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Sales invoices — multi-item, GST, finished-goods stock OUT
// ---------------------------------------------------------------------------
function invoiceWithBalance(inv) {
  const receivedGross = Number(db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM receipts WHERE invoice_id = ?`).get(inv.id).v);
  const returned = RET.invoiceReturned(inv.id); const refunded = RET.invoiceRefunded(inv.id);
  const received = receivedGross - refunded; // money refunded back to the customer is not "received"
  return { ...inv, received, returned, refunded, net_total: inv.grand_total - returned, balance: Math.max(0, inv.grand_total - returned - received) };
}

router.get('/sales', requireModule('customersSales'), (req, res) => {
  const rows = db.prepare(`
    SELECT si.*, c.name customer_name, e.name salesperson_name FROM sales_invoices si
    JOIN customers c ON c.id = si.customer_id
    LEFT JOIN employees e ON e.id = si.salesperson_id
    ORDER BY si.invoice_date DESC, si.id DESC`).all().map(invoiceWithBalance);
  res.json(rows);
});
router.get('/sales/:id', requireModule('customersSales'), (req, res) => {
  const inv = db.prepare(`SELECT si.*, c.name customer_name, c.address customer_address, c.phone customer_phone, c.email customer_email, e.name salesperson_name
    FROM sales_invoices si JOIN customers c ON c.id = si.customer_id LEFT JOIN employees e ON e.id = si.salesperson_id WHERE si.id = ?`).get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  const items = db.prepare(`SELECT sit.*, p.name product_name, p.unit, COALESCE(sit.hsn_code,p.hsn_code) hsn_code FROM sales_items sit JOIN products p ON p.id = sit.product_id WHERE sit.invoice_id = ?`).all(inv.id);
  res.json({ ...invoiceWithBalance(inv), items });
});
router.post('/sales', requireModule('customersSales'), sub.checkLimit('invoices'), validateBody(salesSchema), (req, res) => {
  const b = req.body;
  // Tamper protection: salesperson attribution is looked up fresh from the
  // logged-in user's own account, never taken from the request body — a
  // salesperson can't attribute their invoice to someone else, and this
  // also means changing an employee link takes effect immediately without
  // needing the user to log in again.
  const salespersonId = db.prepare(`SELECT employee_id FROM users WHERE id = ?`).get(req.user.id)?.employee_id || null;
  const tx = db.transaction(() => {
    const no = b.invoice_no || nextNo(req.app.locals.invoicePrefix || 'INV-', 'sales_invoices', 'invoice_no');
    let subtotal = 0;
    for (const it of b.items) subtotal += Number(it.qty) * Number(it.rate) * (1 - Number(it.discount_pct || 0) / 100);
    const gstPct = Number(b.gst_pct ?? 18);
    const gstType = b.gst_type === 'IGST' ? 'IGST' : 'CGST_SGST';
    // Loyalty reward is a one-time next-sale adjustment. It is calculated
    // server-side from the customer's pending eligibility and the central
    // Company/HR setting, never trusted from the browser.
    const loyalty = getCustomerLoyalty(Number(b.customer_id));
    let loyaltyDiscount = 0;
    let loyaltyType = null;
    let loyaltyValue = 0;
    if (loyalty?.eligible) {
      loyaltyType = loyalty.reward_type;
      loyaltyValue = Number(loyalty.reward_value || 0);
      loyaltyDiscount = loyaltyType === 'FIXED' ? Math.min(loyaltyValue, subtotal) : Math.min(subtotal, subtotal * loyaltyValue / 100);
    }
    const taxableAfterLoyalty = Math.max(0, subtotal - loyaltyDiscount);
    const gstAmt = taxableAfterLoyalty * gstPct / 100;
    const grand = taxableAfterLoyalty + gstAmt;
    const paidNow = Math.min(Number(b.paid_now || 0), grand);
    const status = paidNow >= grand ? 'Paid' : paidNow > 0 ? 'Partial' : 'Unpaid';
    const info = db.prepare(`
      INSERT INTO sales_invoices (invoice_no,invoice_date,customer_id,due_date,discount_pct,gst_pct,gst_type,subtotal,gst_amt,grand_total,status,salesperson_id,loyalty_discount_amount,loyalty_reward_type,loyalty_reward_value)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(no, b.invoice_date, b.customer_id, b.due_date || b.invoice_date,
      0, gstPct, gstType, taxableAfterLoyalty, gstAmt, grand, status, salespersonId, loyaltyDiscount, loyaltyType, loyaltyValue);
    for (const it of b.items) {
      const amount = Number(it.qty) * Number(it.rate) * (1 - Number(it.discount_pct || 0) / 100);
      const productRow = db.prepare(`SELECT hsn_code FROM products WHERE id = ?`).get(it.product_id);
      db.prepare(`INSERT INTO sales_items (invoice_id,product_id,qty,rate,discount_pct,amount,hsn_code) VALUES (?,?,?,?,?,?,?)`)
        .run(info.lastInsertRowid, it.product_id, Number(it.qty), Number(it.rate), Number(it.discount_pct || 0), amount, productRow?.hsn_code || null);
      // Uses stockOutForSale rather than addStockTxn directly — if
      // it.product_id is a combo pack/bundle, this correctly deducts each
      // component's stock instead of the bundle "product", which carries
      // no stock of its own.
      stockOutForSale(b.invoice_date, it.product_id, Number(it.qty), info.lastInsertRowid, no);
    }
    if (paidNow > 0) {
      const rno = nextNo('RCPT-', 'receipts', 'receipt_no');
      db.prepare(`INSERT INTO receipts (receipt_no,date,customer_id,invoice_id,amount,mode,reference_no,remarks) VALUES (?,?,?,?,?,?,?,?)`)
        .run(rno, b.invoice_date, b.customer_id, info.lastInsertRowid, paidNow, b.paid_mode || 'Cash', '', 'Paid at time of invoicing');
    }
    if (loyaltyDiscount > 0 && loyalty?.eligible) {
      db.prepare(`UPDATE customers SET loyalty_reward_pending=0, reward_eligible=0, loyalty_earned_amount=COALESCE(loyalty_earned_amount,0)+?, loyalty_reward_redeemed_at=? WHERE id=?`)
        .run(loyaltyDiscount, b.invoice_date || new Date().toISOString().slice(0,10), b.customer_id);
    }
    audit(req, 'CREATE', 'sales_invoices', info.lastInsertRowid, { ...no ? { invoice_no: no } : {}, loyaltyDiscount });
    return info.lastInsertRowid;
  });
  const id = tx();
  const invoiceRow = db.prepare(`SELECT * FROM sales_invoices WHERE id = ?`).get(id);
  const unlocked = invoiceRow.salesperson_id ? evaluateIncentive(req, invoiceRow.salesperson_id, 'SALES', invoiceRow.invoice_date) : [];
  try { refreshCustomerLoyalty(invoiceRow.customer_id); } catch (e) { console.warn('[customer loyalty]', e.message); }
  res.json({ ...invoiceRow, unlockedIncentives: unlocked, customerLoyalty: getCustomerLoyalty(invoiceRow.customer_id) });
});
router.put('/sales/:id', requireModule('customersSales'), validateBody(salesSchema), (req, res) => {
  const b = req.body;
  if (Number(db.prepare(`SELECT COUNT(*) n FROM sales_returns WHERE invoice_id = ? AND status <> 'Rejected'`).get(req.params.id).n)) return res.status(409).json({ error: 'This invoice has a customer return against it, so its items can no longer be edited. Reverse or reject the return first (Customers & Sales → Returns).' });
  const tx = db.transaction(() => {
    let subtotal = 0;
    for (const it of b.items) subtotal += Number(it.qty) * Number(it.rate) * (1 - Number(it.discount_pct || 0) / 100);
    const gstPct = Number(b.gst_pct ?? 18);
    const gstType = b.gst_type === 'IGST' ? 'IGST' : 'CGST_SGST';
    const gstAmt = subtotal * gstPct / 100;
    const grand = subtotal + gstAmt;
    db.prepare(`UPDATE sales_invoices SET invoice_date=?, customer_id=?, due_date=?, gst_pct=?, gst_type=?, subtotal=?, gst_amt=?, grand_total=? WHERE id=?`)
      .run(b.invoice_date, b.customer_id, b.due_date, gstPct, gstType, subtotal, gstAmt, grand, req.params.id);
    db.prepare(`DELETE FROM stock_txn WHERE ref_type='SALE' AND ref_id=?`).run(req.params.id);
    db.prepare(`DELETE FROM sales_items WHERE invoice_id=?`).run(req.params.id);
    for (const it of b.items) {
      const amount = Number(it.qty) * Number(it.rate) * (1 - Number(it.discount_pct || 0) / 100);
      const productRow = db.prepare(`SELECT hsn_code FROM products WHERE id = ?`).get(it.product_id);
      db.prepare(`INSERT INTO sales_items (invoice_id,product_id,qty,rate,discount_pct,amount,hsn_code) VALUES (?,?,?,?,?,?,?)`)
        .run(req.params.id, it.product_id, Number(it.qty), Number(it.rate), Number(it.discount_pct || 0), amount, productRow?.hsn_code || null);
      stockOutForSale(b.invoice_date, it.product_id, Number(it.qty), req.params.id, b.invoice_no || '');
    }
    const paidNow = Number(b.paid_now || 0);
    if (paidNow > 0) {
      const rno = nextNo('RCPT-', 'receipts', 'receipt_no');
      db.prepare(`INSERT INTO receipts (receipt_no,date,customer_id,invoice_id,amount,mode,reference_no,remarks) VALUES (?,?,?,?,?,?,?,?)`)
        .run(rno, b.invoice_date, b.customer_id, req.params.id, paidNow, b.paid_mode || 'Cash', '', 'Additional payment recorded on edit');
    }
    RET.refreshInvoiceStatus(req.params.id);
      audit(req, 'UPDATE', 'sales_invoices', req.params.id, b);
  });
  tx();
  const editedInvoice = db.prepare(`SELECT * FROM sales_invoices WHERE id = ?`).get(req.params.id);
  const unlocked = editedInvoice?.salesperson_id ? evaluateIncentive(req, editedInvoice.salesperson_id, 'SALES', editedInvoice.invoice_date) : [];
  try { refreshCustomerLoyalty(editedInvoice.customer_id); } catch (e) {}
  res.json({ ...editedInvoice, unlockedIncentives: unlocked, customerLoyalty: getCustomerLoyalty(editedInvoice.customer_id) });
});
router.put('/sales/:id/status', requireModule('customersSales'), validateBody(z.object({ status: z.string().trim().min(1).max(30) }).passthrough()), (req, res) => {
  db.prepare(`UPDATE sales_invoices SET status = ? WHERE id = ?`).run(req.body.status, req.params.id);
  audit(req, 'UPDATE', 'sales_invoices', req.params.id, req.body);
  res.json({ ok: true });
});
router.delete('/sales/:id', requireModule('customersSales'), (req, res) => {
  if (Number(db.prepare(`SELECT COUNT(*) n FROM sales_returns WHERE invoice_id = ?`).get(req.params.id).n)) return res.status(409).json({ error: 'This invoice has customer returns recorded against it, so it cannot be deleted. The return history must stay for your accounts.' });
  const oldInvoice = db.prepare(`SELECT customer_id FROM sales_invoices WHERE id = ?`).get(req.params.id);
  db.prepare(`DELETE FROM stock_txn WHERE ref_type = 'SALE' AND ref_id = ?`).run(req.params.id);
  db.prepare(`DELETE FROM sales_invoices WHERE id = ?`).run(req.params.id); // cascades sales_items
  if (oldInvoice?.customer_id) { try { refreshCustomerLoyalty(oldInvoice.customer_id); } catch (e) {} }
  audit(req, 'DELETE', 'sales_invoices', req.params.id, {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Receipts — customer payments against invoices
// ---------------------------------------------------------------------------
router.get('/receipts', requireModule('customersSales'), (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, c.name customer_name FROM receipts r JOIN customers c ON c.id = r.customer_id
    ORDER BY r.date DESC, r.id DESC`).all();
  res.json(rows);
});
router.post('/receipts', requireModule('customersSales'), validateBody(receiptSchema), (req, res) => {
  const b = req.body;
  // Tamper protection, same pattern as sales_invoices.salesperson_id — who
  // actually collected this payment is derived from the logged-in user,
  // not the request body, so the Payment Recovery incentive can't be gamed.
  const collectedBy = db.prepare(`SELECT employee_id FROM users WHERE id = ?`).get(req.user.id)?.employee_id || null;
  const tx = db.transaction(() => {
    const no = b.receipt_no || nextNo('RCPT-', 'receipts', 'receipt_no');
    const info = db.prepare(`
      INSERT INTO receipts (receipt_no,date,customer_id,invoice_id,amount,mode,reference_no,remarks,collected_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(no, b.date, b.customer_id, b.invoice_id || null,
      Number(b.amount), b.mode || 'Cash', b.reference_no || '', b.remarks || '', collectedBy);
    if (b.invoice_id) {
      RET.refreshInvoiceStatus(b.invoice_id);
    }
    audit(req, 'CREATE', 'receipts', info.lastInsertRowid, no);
    return info.lastInsertRowid;
  });
  const id = tx();
  const unlocked = collectedBy ? evaluateIncentive(req, collectedBy, 'RECOVERY', b.date) : [];
  res.json({ ...db.prepare(`SELECT * FROM receipts WHERE id = ?`).get(id), unlockedIncentives: unlocked });
});
router.put('/receipts/:id', requireModule('customersSales'), validateBody(receiptSchema), (req, res) => {
  const b = req.body;
  const old = db.prepare(`SELECT invoice_id FROM receipts WHERE id = ?`).get(req.params.id);
  db.prepare(`UPDATE receipts SET date=?, customer_id=?, invoice_id=?, amount=?, mode=?, reference_no=?, remarks=? WHERE id=?`)
    .run(b.date, b.customer_id, b.invoice_id || null, Number(b.amount), b.mode || 'Cash', b.reference_no || '', b.remarks || '', req.params.id);
  for (const invId of new Set([old?.invoice_id, b.invoice_id].filter(Boolean))) {
    RET.refreshInvoiceStatus(invId);
  }
  audit(req, 'UPDATE', 'receipts', req.params.id, b);
  const receiptRow = db.prepare(`SELECT * FROM receipts WHERE id = ?`).get(req.params.id);
  const collectedBy = db.prepare(`SELECT collected_by FROM receipts WHERE id = ?`).get(req.params.id)?.collected_by;
  const unlocked = collectedBy ? evaluateIncentive(req, collectedBy, 'RECOVERY', receiptRow.date) : [];
  res.json({ ...receiptRow, unlockedIncentives: unlocked });
});
router.delete('/receipts/:id', requireModule('customersSales'), (req, res) => {
  const r = db.prepare(`SELECT * FROM receipts WHERE id = ?`).get(req.params.id);
  db.prepare(`DELETE FROM receipts WHERE id = ?`).run(req.params.id);
  if (r && r.invoice_id) {
    RET.refreshInvoiceStatus(r.invoice_id);
  }
  audit(req, 'DELETE', 'receipts', req.params.id, {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Attendance — upsert per employee per day, auto working/overtime hours
// ---------------------------------------------------------------------------
router.get('/attendance', (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, e.name employee_name FROM attendance a JOIN employees e ON e.id = a.employee_id
    ORDER BY a.work_date DESC, a.id DESC LIMIT 500`).all();
  res.json(rows);
});
router.post('/attendance/bulk', validateBody(z.object({ work_date: z.string().trim().min(1), employee_ids: z.array(z.coerce.number().int().positive()).min(1), status: z.string().max(30).optional(), in_time: z.string().max(20).optional(), out_time: z.string().max(20).optional(), remarks: z.string().max(1000).optional() }).passthrough()), (req, res) => {
  const { work_date, employee_ids, status, in_time, out_time, remarks } = req.body;
  if (!work_date || !Array.isArray(employee_ids) || !employee_ids.length) {
    return res.status(400).json({ error: 'Pick a date and at least one employee' });
  }
  let workingHours = 0;
  if (in_time && out_time) {
    const [ih, im] = in_time.split(':').map(Number);
    const [oh, om] = out_time.split(':').map(Number);
    workingHours = Math.max(0, (oh + om / 60) - (ih + im / 60));
  }
  const overtimeHours = Math.max(0, workingHours - 8);
  const stmt = db.prepare(`
    INSERT INTO attendance (work_date,employee_id,in_time,out_time,working_hours,overtime_hours,status,remarks)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(work_date,employee_id) DO UPDATE SET in_time=excluded.in_time,out_time=excluded.out_time,
      working_hours=excluded.working_hours,overtime_hours=excluded.overtime_hours,status=excluded.status,remarks=excluded.remarks
  `);
  let unlocked = [];
  const tx = db.transaction(() => {
    for (const empId of employee_ids) {
      stmt.run(work_date, empId, in_time || '', out_time || '', workingHours, overtimeHours, status || 'Present', remarks || '');
      if (overtimeHours > 0) unlocked.push(...evaluateIncentive(req, empId, 'OVERTIME', work_date));
    }
  });
  tx();
  audit(req, 'CREATE', 'attendance', null, { bulk: true, work_date, count: employee_ids.length, status });
  res.json({ ok: true, marked: employee_ids.length, unlockedIncentives: unlocked });
});
router.post('/attendance', validateBody(attendanceSchema), (req, res) => {
  const b = req.body;
  let workingHours = 0;
  if (b.in_time && b.out_time) {
    const [ih, im] = b.in_time.split(':').map(Number);
    const [oh, om] = b.out_time.split(':').map(Number);
    workingHours = Math.max(0, (oh + om / 60) - (ih + im / 60));
  }
  const overtimeHours = Math.max(0, workingHours - 8);
  const info = db.prepare(`
    INSERT INTO attendance (work_date,employee_id,in_time,out_time,working_hours,overtime_hours,status,remarks)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(work_date,employee_id) DO UPDATE SET in_time=excluded.in_time,out_time=excluded.out_time,
      working_hours=excluded.working_hours,overtime_hours=excluded.overtime_hours,status=excluded.status,remarks=excluded.remarks
  `).run(b.work_date, b.employee_id, b.in_time || '', b.out_time || '', workingHours, overtimeHours, b.status || 'Present', b.remarks || '');
  audit(req, 'CREATE', 'attendance', info.lastInsertRowid, b);
  const unlocked = overtimeHours > 0 ? evaluateIncentive(req, b.employee_id, 'OVERTIME', b.work_date) : [];
  res.json({ ok: true, working_hours: workingHours, overtime_hours: overtimeHours, unlockedIncentives: unlocked });
});
router.put('/attendance/:id', validateBody(attendanceSchema), (req, res) => {
  const b = req.body;
  let workingHours = 0;
  if (b.in_time && b.out_time) {
    const [ih, im] = b.in_time.split(':').map(Number);
    const [oh, om] = b.out_time.split(':').map(Number);
    workingHours = Math.max(0, (oh + om / 60) - (ih + im / 60));
  }
  const overtimeHours = Math.max(0, workingHours - 8);
  db.prepare(`UPDATE attendance SET work_date=?, employee_id=?, in_time=?, out_time=?, working_hours=?, overtime_hours=?, status=?, remarks=? WHERE id=?`)
    .run(b.work_date, b.employee_id, b.in_time || '', b.out_time || '', workingHours, overtimeHours, b.status || 'Present', b.remarks || '', req.params.id);
  audit(req, 'UPDATE', 'attendance', req.params.id, b);
  const unlocked = overtimeHours > 0 ? evaluateIncentive(req, b.employee_id, 'OVERTIME', b.work_date) : [];
  res.json({ ok: true, working_hours: workingHours, overtime_hours: overtimeHours, unlockedIncentives: unlocked });
});
router.delete('/attendance/:id', (req, res) => {
  db.prepare(`DELETE FROM attendance WHERE id = ?`).run(req.params.id);
  audit(req, 'DELETE', 'attendance', req.params.id, {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Advances — salary advances, adjusted against a future payroll run
// ---------------------------------------------------------------------------
router.get('/advances', (req, res) => {
  const rows = db.prepare(`
    SELECT ad.*, e.name employee_name FROM advances ad JOIN employees e ON e.id = ad.employee_id
    ORDER BY ad.date DESC, ad.id DESC`).all();
  res.json(rows);
});
router.post('/advances', validateBody(advanceSchema), (req, res) => {
  const b = req.body;
  const info = db.prepare(`INSERT INTO advances (employee_id,date,amount,reason) VALUES (?,?,?,?)`)
    .run(b.employee_id, b.date, Number(b.amount), b.reason || '');
  audit(req, 'CREATE', 'advances', info.lastInsertRowid, b);
  res.json(db.prepare(`SELECT * FROM advances WHERE id = ?`).get(info.lastInsertRowid));
});
router.put('/advances/:id', validateBody(advanceSchema), (req, res) => {
  const b = req.body;
  db.prepare(`UPDATE advances SET employee_id=?, date=?, amount=?, reason=? WHERE id=?`)
    .run(b.employee_id, b.date, Number(b.amount), b.reason || '', req.params.id);
  audit(req, 'UPDATE', 'advances', req.params.id, b);
  res.json(db.prepare(`SELECT * FROM advances WHERE id = ?`).get(req.params.id));
});
router.delete('/advances/:id', (req, res) => {
  db.prepare(`DELETE FROM advances WHERE id = ?`).run(req.params.id);
  audit(req, 'DELETE', 'advances', req.params.id, {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Payroll — computes gross/net, optionally deducts a chosen advance in full
// ---------------------------------------------------------------------------
router.get('/payroll', (req, res) => {
  const rows = db.prepare(`
    SELECT pr.*, e.name employee_name, e.phone employee_phone FROM payroll pr JOIN employees e ON e.id = pr.employee_id
    ORDER BY pr.pay_month DESC, pr.id DESC`).all().map((r) => ({ ...r, balance: r.net - r.paid_amount }));
  res.json(rows);
});
router.get('/payroll/:id/payments', (req, res) => {
  res.json(db.prepare(`SELECT * FROM payroll_payments WHERE payroll_id = ? ORDER BY date DESC, id DESC`).all(req.params.id));
});
router.post('/payroll/:id/pay', validateBody(payrollPaymentSchema), (req, res) => {
  const row = db.prepare(`SELECT * FROM payroll WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Payroll record not found' });
  const amount = Number(req.body.amount || 0);
  if (amount <= 0) return res.status(400).json({ error: 'Enter an amount greater than zero' });
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO payroll_payments (payroll_id, employee_id, date, amount, mode, remarks) VALUES (?,?,?,?,?,?)`)
      .run(req.params.id, row.employee_id, req.body.date || todayDefault(), amount, req.body.mode || 'Cash', req.body.remarks || '');
    const totalPaid = db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM payroll_payments WHERE payroll_id = ?`).get(req.params.id).v;
    db.prepare(`UPDATE payroll SET paid_amount = ? WHERE id = ?`).run(totalPaid, req.params.id);
    // If total paid exceeds this payroll's net salary, the excess becomes a
    // salary advance for this employee, ready to be deducted automatically
    // from their NEXT month's payroll via the existing advance-deduction flow.
    const excess = Math.max(0, totalPaid - row.net);
    const existingAdvance = db.prepare(`SELECT * FROM advances WHERE source_payroll_id = ?`).get(req.params.id);
    if (excess > 0) {
      if (existingAdvance && !existingAdvance.adjusted) {
        db.prepare(`UPDATE advances SET amount = ? WHERE id = ?`).run(excess, existingAdvance.id);
      } else if (!existingAdvance) {
        db.prepare(`INSERT INTO advances (employee_id, date, amount, reason, source_payroll_id) VALUES (?,?,?,?,?)`)
          .run(row.employee_id, req.body.date || todayDefault(), excess, `Excess payment on payroll ${row.payroll_no} — carried forward`, req.params.id);
      }
      // if existingAdvance is already adjusted (used in a later payroll), leave it alone
    } else if (existingAdvance && !existingAdvance.adjusted) {
      db.prepare(`DELETE FROM advances WHERE id = ?`).run(existingAdvance.id);
    }
    audit(req, 'UPDATE', 'payroll', req.params.id, { paid: amount, mode: req.body.mode, date: req.body.date });
  });
  tx();
  res.json(db.prepare(`SELECT * FROM payroll WHERE id = ?`).get(req.params.id));
});
router.post('/payroll', validateBody(payrollSchema), (req, res) => {
  const b = req.body;
  const tx = db.transaction(() => {
    const incentiveAmount = Number(db.prepare(`SELECT COALESCE(SUM(reward_amount),0) v
      FROM employee_incentives WHERE employee_id = ? AND period = ? AND status = 'Pending'`)
      .get(b.employee_id, b.pay_month).v);
    const gross = Number(b.basic || 0) + Number(b.hra || 0) + Number(b.conveyance || 0) + Number(b.other_allow || 0) + incentiveAmount;
    const advanceDed = Number(b.advance_deduction || 0);
    const net = gross - Number(b.pf || 0) - Number(b.esi || 0) - Number(b.other_deduction || 0) - advanceDed;
    const no = nextNo('PAY-', 'payroll', 'payroll_no');
    const info = db.prepare(`
      INSERT INTO payroll (payroll_no,employee_id,pay_month,basic,hra,conveyance,other_allow,incentive_amount,advance_deduction,pf,esi,other_deduction,gross,net,paid_amount)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(no, b.employee_id, b.pay_month, Number(b.basic || 0), Number(b.hra || 0),
      Number(b.conveyance || 0), Number(b.other_allow || 0), incentiveAmount, advanceDed, Number(b.pf || 0), Number(b.esi || 0),
      Number(b.other_deduction || 0), gross, net, Number(b.paid_now || 0));
    if (incentiveAmount > 0) {
      db.prepare(`UPDATE employee_incentives SET status='Paid', payroll_id=? WHERE employee_id=? AND period=? AND status='Pending'`)
        .run(info.lastInsertRowid, b.employee_id, b.pay_month);
    }
    if (b.advance_id) db.prepare(`UPDATE advances SET adjusted = 1 WHERE id = ?`).run(b.advance_id);
    audit(req, 'CREATE', 'payroll', info.lastInsertRowid, { ...b, incentiveAmount });
    return info.lastInsertRowid;
  });
  const id = tx();
  res.json(db.prepare(`SELECT * FROM payroll WHERE id = ?`).get(id));
});
router.delete('/payroll/:id', (req, res) => {
  db.prepare(`UPDATE employee_incentives SET status='Pending', payroll_id=NULL WHERE payroll_id = ?`).run(req.params.id);
  db.prepare(`DELETE FROM payroll WHERE id = ?`).run(req.params.id);
  audit(req, 'DELETE', 'payroll', req.params.id, {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Outsourcing — jobwork persons, jobs (Molding/Cutting/Finishing/Sticker/Packing), payments
// ---------------------------------------------------------------------------
// Jobworkers are kept here rather than in the generic master CRUD because the
// outsourcing module needs a detail endpoint at /persons/:id/detail.  Keeping
// all person routes together also prevents the generic /persons/:id route from
// swallowing that detail URL before it reaches this module.
const outsourcingGuard = requireModule('outsourcing');

router.get('/outsourcing/persons', outsourcingGuard, (req, res) => {
  const rows = db.prepare(`SELECT * FROM outsourcing_persons WHERE active = 1 ORDER BY name`).all();
  res.json(rows);
});
router.get('/outsourcing/persons/:id', outsourcingGuard, (req, res) => {
  const row = db.prepare(`SELECT * FROM outsourcing_persons WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Jobworker not found' });
  res.json(row);
});
router.post('/outsourcing/persons', outsourcingGuard, validateBody(outsourcingPersonSchema), (req, res) => {
  try {
    const b = req.body;
    const info = db.prepare(`
      INSERT INTO outsourcing_persons (name,phone,email,stage,default_rate,active)
      VALUES (?,?,?,?,?,1)
    `).run(b.name, b.phone || '', b.email || '', b.stage || 'Molding', Number(b.default_rate || 0));
    const row = db.prepare(`SELECT * FROM outsourcing_persons WHERE id = ?`).get(info.lastInsertRowid);
    audit(req, 'CREATE', 'outsourcing_persons', info.lastInsertRowid, b);
    res.status(201).json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
router.put('/outsourcing/persons/:id', outsourcingGuard, validateBody(outsourcingPersonSchema), (req, res) => {
  try {
    const existing = db.prepare(`SELECT id FROM outsourcing_persons WHERE id = ?`).get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Jobworker not found' });
    const b = req.body;
    db.prepare(`
      UPDATE outsourcing_persons
      SET name=?, phone=?, email=?, stage=?, default_rate=?
      WHERE id=?
    `).run(b.name, b.phone || '', b.email || '', b.stage || 'Molding', Number(b.default_rate || 0), req.params.id);
    const row = db.prepare(`SELECT * FROM outsourcing_persons WHERE id = ?`).get(req.params.id);
    audit(req, 'UPDATE', 'outsourcing_persons', req.params.id, b);
    res.json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
router.delete('/outsourcing/persons/:id', outsourcingGuard, (req, res) => {
  const existing = db.prepare(`SELECT id FROM outsourcing_persons WHERE id = ?`).get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Jobworker not found' });
  db.prepare(`UPDATE outsourcing_persons SET active = 0 WHERE id = ?`).run(req.params.id);
  audit(req, 'DELETE', 'outsourcing_persons', req.params.id, {});
  res.json({ ok: true });
});

router.get('/outsourcing/persons/:id/detail', (req, res) => {
  const person = db.prepare(`SELECT * FROM outsourcing_persons WHERE id = ?`).get(req.params.id);
  if (!person) return res.status(404).json({ error: 'Jobworker not found' });
  const jobs = db.prepare(`
    SELECT j.*, p.name product_name FROM outsourcing_jobs j LEFT JOIN products p ON p.id = j.product_id
    WHERE j.person_id = ? ORDER BY j.date DESC, j.id DESC`).all(req.params.id);
  const payments = db.prepare(`SELECT * FROM outsourcing_payments WHERE person_id = ? ORDER BY date DESC, id DESC`).all(req.params.id);
  const totalQty = jobs.reduce((s, j) => s + Number(j.qty_received), 0);
  const totalAmount = jobs.reduce((s, j) => s + Number(j.amount), 0);
  const totalPaid = payments.reduce((s, p) => s + Number(p.amount), 0);
  res.json({ person, jobs, payments, totals: { totalQty, totalAmount, totalPaid, balance: totalAmount - totalPaid } });
});
router.get('/outsourcing/persons-summary', (req, res) => {
  const { from, to } = req.query;
  const persons = db.prepare(`SELECT * FROM outsourcing_persons WHERE active = 1 ORDER BY name`).all();
  const rows = persons.map((p) => {
    let jobSql = `SELECT COALESCE(SUM(qty_received),0) qty, COALESCE(SUM(amount),0) amt FROM outsourcing_jobs WHERE person_id = ?`;
    const jobParams = [p.id];
    if (from) { jobSql += ` AND date >= ?`; jobParams.push(from); }
    if (to) { jobSql += ` AND date <= ?`; jobParams.push(to); }
    const job = db.prepare(jobSql).get(...jobParams);
    // Payment total is always all-time (a payment settles the running balance,
    // not just what fell inside this particular period's jobs).
    const paid = db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM outsourcing_payments WHERE person_id = ?`).get(p.id).v;
    const allTimeAmt = db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM outsourcing_jobs WHERE person_id = ?`).get(p.id).v;
    return { ...p, qtyDone: job.qty, amountDone: job.amt, paid, balance: allTimeAmt - paid };
  });
  res.json(rows);
});
router.get('/outsourcing/jobs', (req, res) => {
  const rows = db.prepare(`
    SELECT j.*, op.name person_name, op.phone person_phone, op.email person_email, p.name product_name
    FROM outsourcing_jobs j JOIN outsourcing_persons op ON op.id = j.person_id
    LEFT JOIN products p ON p.id = j.product_id ORDER BY j.date DESC, j.id DESC`).all();
  res.json(rows);
});
router.post('/outsourcing/jobs', validateBody(outsourcingJobSchema), (req, res) => {
  const b = req.body;
  const stage = b.stage || 'Molding';
  const prev = previousStage(stage);
  if (prev) {
    const available = stageAvailable(prev);
    if (Number(b.qty_sent || 0) > available) {
      return res.status(400).json({ error: `Only ${available} unit(s) have finished ${prev} and are ready for ${stage} — you're trying to send ${b.qty_sent}. Check the Production Pipeline for details.` });
    }
  }
  const no = nextNo('OUT-', 'outsourcing_jobs', 'job_no');
  const amount = Number(b.qty_received || 0) * Number(b.rate || 0);
  const info = db.prepare(`
    INSERT INTO outsourcing_jobs (job_no,date,person_id,product_id,stage,qty_sent,qty_received,rate,amount,status,remarks)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(no, b.date, b.person_id, b.product_id || null, stage,
    Number(b.qty_sent || 0), Number(b.qty_received || 0), Number(b.rate || 0), amount, b.status || 'Pending', b.remarks || '');
  const stageResult = applyStageEffects(b.date, b.product_id || null, stage, Number(b.qty_received || 0), 'JOB', info.lastInsertRowid);
  audit(req, 'CREATE', 'outsourcing_jobs', info.lastInsertRowid, b);
  res.json({ ...db.prepare(`SELECT * FROM outsourcing_jobs WHERE id = ?`).get(info.lastInsertRowid), ...stageResult });
});
router.put('/outsourcing/jobs/:id', validateBody(outsourcingJobSchema), (req, res) => {
  const b = req.body;
  const job = db.prepare(`SELECT stage FROM outsourcing_jobs WHERE id = ?`).get(req.params.id);
  const stage = b.stage || job?.stage || 'Molding';
  const prev = previousStage(stage);
  if (prev) {
    const available = stageAvailable(prev, req.params.id);
    if (Number(b.qty_sent || 0) > available) {
      return res.status(400).json({ error: `Only ${available} unit(s) have finished ${prev} and are ready for ${stage} — you're trying to send ${b.qty_sent}. Check the Production Pipeline for details.` });
    }
  }
  const amount = Number(b.qty_received || 0) * Number(b.rate || 0);
  clearStageEffects('JOB', req.params.id);
  db.prepare(`UPDATE outsourcing_jobs SET date=?, person_id=?, product_id=?, stage=?, qty_sent=?, qty_received=?, rate=?, amount=?, status=?, remarks=? WHERE id=?`)
    .run(b.date, b.person_id, b.product_id || null, stage, Number(b.qty_sent || 0), Number(b.qty_received || 0),
      Number(b.rate || 0), amount, b.status || 'Pending', b.remarks || '', req.params.id);
  const stageResult = applyStageEffects(b.date, b.product_id || null, stage, Number(b.qty_received || 0), 'JOB', req.params.id);
  audit(req, 'UPDATE', 'outsourcing_jobs', req.params.id, b);
  res.json({ ...db.prepare(`SELECT * FROM outsourcing_jobs WHERE id = ?`).get(req.params.id), ...stageResult });
});
router.delete('/outsourcing/jobs/:id', (req, res) => {
  clearStageEffects('JOB', req.params.id);
  db.prepare(`DELETE FROM outsourcing_jobs WHERE id = ?`).run(req.params.id);
  audit(req, 'DELETE', 'outsourcing_jobs', req.params.id, {});
  res.json({ ok: true });
});

router.get('/outsourcing/payments', (req, res) => {
  const rows = db.prepare(`
    SELECT pay.*, op.name person_name FROM outsourcing_payments pay JOIN outsourcing_persons op ON op.id = pay.person_id
    ORDER BY pay.date DESC, pay.id DESC`).all();
  res.json(rows);
});
router.post('/outsourcing/payments', validateBody(outsourcingPaymentSchema), (req, res) => {
  const b = req.body;
  const info = db.prepare(`
    INSERT INTO outsourcing_payments (date,person_id,job_id,amount,mode,reference_no,remarks)
    VALUES (?,?,?,?,?,?,?)`).run(b.date, b.person_id, b.job_id || null, Number(b.amount), b.mode || 'Cash', b.reference_no || '', b.remarks || '');
  audit(req, 'CREATE', 'outsourcing_payments', info.lastInsertRowid, b);
  res.json(db.prepare(`SELECT * FROM outsourcing_payments WHERE id = ?`).get(info.lastInsertRowid));
});
router.put('/outsourcing/payments/:id', validateBody(outsourcingPaymentSchema), (req, res) => {
  const b = req.body;
  db.prepare(`UPDATE outsourcing_payments SET date=?, person_id=?, job_id=?, amount=?, mode=?, reference_no=?, remarks=? WHERE id=?`)
    .run(b.date, b.person_id, b.job_id || null, Number(b.amount), b.mode || 'Cash', b.reference_no || '', b.remarks || '', req.params.id);
  audit(req, 'UPDATE', 'outsourcing_payments', req.params.id, b);
  res.json(db.prepare(`SELECT * FROM outsourcing_payments WHERE id = ?`).get(req.params.id));
});
router.delete('/outsourcing/payments/:id', (req, res) => {
  db.prepare(`DELETE FROM outsourcing_payments WHERE id = ?`).run(req.params.id);
  audit(req, 'DELETE', 'outsourcing_payments', req.params.id, {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Production Stages — in-house pipeline tracking (Molding/Cutting/Finishing/Sticker/Packing)
// ---------------------------------------------------------------------------
router.get('/production-stages', (req, res) => {
  const rows = db.prepare(`
    SELECT ps.*, p.name product_name, p.unit FROM production_stages ps JOIN products p ON p.id = ps.product_id
    ORDER BY ps.date DESC, ps.id DESC LIMIT 500`).all();
  res.json(rows);
});
router.post('/production-stages', (req, res) => {
  const b = req.body;
  const prev = previousStage(b.stage);
  if (prev) {
    const available = stageAvailable(prev);
    if (Number(b.qty_in || 0) > available) {
      return res.status(400).json({ error: `Only ${available} unit(s) have finished ${prev} and are ready for ${b.stage} — you're trying to move in ${b.qty_in}. Check the Production Pipeline for details.` });
    }
  }
  const info = db.prepare(`
    INSERT INTO production_stages (date,product_id,stage,qty_in,qty_out,remarks) VALUES (?,?,?,?,?,?)`)
    .run(b.date, b.product_id, b.stage, Number(b.qty_in || 0), Number(b.qty_out || 0), b.remarks || '');
  const stageResult = applyStageEffects(b.date, b.product_id, b.stage, Number(b.qty_out || 0), 'PS', info.lastInsertRowid);
  audit(req, 'CREATE', 'production_stages', info.lastInsertRowid, b);
  res.json({ ...db.prepare(`SELECT * FROM production_stages WHERE id = ?`).get(info.lastInsertRowid), ...stageResult });
});
router.put('/production-stages/:id', (req, res) => {
  const b = req.body;
  const prev = previousStage(b.stage);
  if (prev) {
    const available = stageAvailable(prev, null, req.params.id);
    if (Number(b.qty_in || 0) > available) {
      return res.status(400).json({ error: `Only ${available} unit(s) have finished ${prev} and are ready for ${b.stage} — you're trying to move in ${b.qty_in}. Check the Production Pipeline for details.` });
    }
  }
  clearStageEffects('PS', req.params.id);
  db.prepare(`UPDATE production_stages SET date=?, product_id=?, stage=?, qty_in=?, qty_out=?, remarks=? WHERE id=?`)
    .run(b.date, b.product_id, b.stage, Number(b.qty_in || 0), Number(b.qty_out || 0), b.remarks || '', req.params.id);
  const stageResult = applyStageEffects(b.date, b.product_id, b.stage, Number(b.qty_out || 0), 'PS', req.params.id);
  audit(req, 'UPDATE', 'production_stages', req.params.id, b);
  res.json({ ...db.prepare(`SELECT * FROM production_stages WHERE id = ?`).get(req.params.id), ...stageResult });
});
router.delete('/production-stages/:id', (req, res) => {
  clearStageEffects('PS', req.params.id);
  db.prepare(`DELETE FROM production_stages WHERE id = ?`).run(req.params.id);
  audit(req, 'DELETE', 'production_stages', req.params.id, {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Reminders log — queued/sent WhatsApp, Email & SMS reminders
// ---------------------------------------------------------------------------
router.get('/reminders', (req, res) => {
  res.json(db.prepare(`SELECT * FROM reminders_log ORDER BY id DESC LIMIT 300`).all());
});
router.post('/reminders', (req, res) => {
  const b = req.body;
  const info = db.prepare(`
    INSERT INTO reminders_log (date,channel,target_type,target_id,target_name,subject,message,status,ref_type,ref_id,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(b.date, b.channel, b.target_type || '', b.target_id || null,
    b.target_name || '', b.subject || '', b.message || '', b.status || 'Sent', b.ref_type || '', b.ref_id || null,
    req.user?.username || 'system');
  res.json(db.prepare(`SELECT * FROM reminders_log WHERE id = ?`).get(info.lastInsertRowid));
});

// ---------------------------------------------------------------------------
// Supplier payments — payments made against raw material purchases
// ---------------------------------------------------------------------------
router.get('/supplier-payments', (req, res) => {
  const rows = db.prepare(`
    SELECT sp.*, s.name supplier_name FROM supplier_payments sp JOIN suppliers s ON s.id = sp.supplier_id
    ORDER BY sp.date DESC, sp.id DESC`).all();
  res.json(rows);
});
router.post('/supplier-payments', validateBody(supplierPaymentSchema), (req, res) => {
  const b = req.body;
  if (!(Number(b.amount) > 0)) return res.status(400).json({ error: 'Payment amount must be greater than zero' });
  if (b.purchase_id) {
    const purchase = db.prepare(`SELECT amount,gst_amt,supplier_id FROM purchases WHERE id=?`).get(b.purchase_id);
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
    if (Number(purchase.supplier_id) !== Number(b.supplier_id)) return res.status(400).json({ error: 'Selected purchase does not belong to this supplier' });
    const paid = Number(db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM supplier_payments WHERE purchase_id=?`).get(b.purchase_id).v || 0) - RET.purchaseRefunded(b.purchase_id);
    const balance = Number(purchase.amount || 0) + Number(purchase.gst_amt || 0) - RET.purchaseReturned(b.purchase_id) - paid;
    if (Number(b.amount) > balance + 0.005) return res.status(400).json({ error: `Payment exceeds purchase balance of ₹${balance.toFixed(2)}` });
  }
  const info = db.prepare(`
    INSERT INTO supplier_payments (date,supplier_id,purchase_id,amount,mode,reference_no,remarks,source)
    VALUES (?,?,?,?,?,?,?, 'MANUAL')`).run(b.date, b.supplier_id, b.purchase_id || null, Number(b.amount), b.mode || 'Cash', b.reference_no || '', b.remarks || '');
  audit(req, 'CREATE', 'supplier_payments', info.lastInsertRowid, b);
  res.json(db.prepare(`SELECT * FROM supplier_payments WHERE id = ?`).get(info.lastInsertRowid));
});
router.put('/supplier-payments/:id', validateBody(supplierPaymentSchema), (req, res) => {
  const b = req.body;
  const existing = db.prepare(`SELECT source FROM supplier_payments WHERE id=?`).get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Payment not found' });
  if (existing.source === 'PURCHASE_FORM') return res.status(400).json({ error: 'This payment is managed from the Purchase Form' });
  if (!(Number(b.amount) > 0)) return res.status(400).json({ error: 'Payment amount must be greater than zero' });
  if (b.purchase_id) {
    const purchase = db.prepare(`SELECT amount,gst_amt,supplier_id FROM purchases WHERE id=?`).get(b.purchase_id);
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
    if (Number(purchase.supplier_id) !== Number(b.supplier_id)) return res.status(400).json({ error: 'Selected purchase does not belong to this supplier' });
    const paid = Number(db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM supplier_payments WHERE purchase_id=? AND id<>?`).get(b.purchase_id, req.params.id).v || 0) - RET.purchaseRefunded(b.purchase_id);
    const balance = Number(purchase.amount || 0) + Number(purchase.gst_amt || 0) - RET.purchaseReturned(b.purchase_id) - paid;
    if (Number(b.amount) > balance + 0.005) return res.status(400).json({ error: `Payment exceeds purchase balance of ₹${balance.toFixed(2)}` });
  }
  db.prepare(`UPDATE supplier_payments SET date=?, supplier_id=?, purchase_id=?, amount=?, mode=?, reference_no=?, remarks=? WHERE id=?`)
    .run(b.date, b.supplier_id, b.purchase_id || null, Number(b.amount), b.mode || 'Cash', b.reference_no || '', b.remarks || '', req.params.id);
  audit(req, 'UPDATE', 'supplier_payments', req.params.id, b);
  res.json(db.prepare(`SELECT * FROM supplier_payments WHERE id = ?`).get(req.params.id));
});
router.delete('/supplier-payments/:id', (req, res) => {
  db.prepare(`DELETE FROM supplier_payments WHERE id = ?`).run(req.params.id);
  audit(req, 'DELETE', 'supplier_payments', req.params.id, {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Expenses — rent, utilities, travel, and other overhead not tied to a
// purchase, payroll, or outsourcing job.
// ---------------------------------------------------------------------------
const EXPENSE_CATEGORIES = ['Rent', 'Warehouse', 'Electricity Bill', 'Water Bill', 'Food / Staff Welfare', 'Travelling', 'Repairs & Maintenance', 'Office Supplies', 'Other'];
// Expense categories are now a user-editable list (expense_categories table,
// seeded once from the list above) rather than a fixed set — Expenses page
// has an "Add Category" option that hits the POST route below.
router.get('/expenses/categories', (req, res) => {
  const rows = db.prepare(`SELECT name FROM expense_categories ORDER BY sort_order ASC, id ASC`).all();
  res.json(rows.length ? rows.map((r) => r.name) : EXPENSE_CATEGORIES);
});
router.post('/expenses/categories', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Please enter a category name' });
  try {
    const maxOrder = db.prepare(`SELECT COALESCE(MAX(sort_order),-1) v FROM expense_categories`).get().v;
    const info = db.prepare(`INSERT INTO expense_categories (name, sort_order) VALUES (?,?)`).run(name, maxOrder + 1);
    audit(req, 'CREATE', 'expense_categories', info.lastInsertRowid, { name });
    res.json({ ok: true, name });
  } catch (e) {
    res.status(400).json({ error: 'That category already exists' });
  }
});
router.delete('/expenses/categories/:name', (req, res) => {
  const inUse = db.prepare(`SELECT COUNT(*) n FROM expenses WHERE category = ?`).get(req.params.name).n;
  if (inUse > 0) return res.status(400).json({ error: `${inUse} expense(s) already use this category — it can't be removed.` });
  db.prepare(`DELETE FROM expense_categories WHERE name = ?`).run(req.params.name);
  audit(req, 'DELETE', 'expense_categories', null, { name: req.params.name });
  res.json({ ok: true });
});
router.get('/expenses', (req, res) => {
  const { from, to, category } = req.query;
  let sql = `SELECT * FROM expenses WHERE 1=1`;
  const params = [];
  if (from) { sql += ` AND date >= ?`; params.push(from); }
  if (to) { sql += ` AND date <= ?`; params.push(to); }
  if (category) { sql += ` AND category = ?`; params.push(category); }
  sql += ` ORDER BY date DESC, id DESC`;
  res.json(db.prepare(sql).all(...params));
});
router.post('/expenses', (req, res) => {
  const b = req.body;
  const no = nextNo('EXP-', 'expenses', 'expense_no');
  const info = db.prepare(`INSERT INTO expenses (expense_no, date, category, description, amount, mode, reference_no) VALUES (?,?,?,?,?,?,?)`)
    .run(no, b.date, b.category, b.description || '', Number(b.amount) || 0, b.mode || 'Cash', b.reference_no || '');
  audit(req, 'CREATE', 'expenses', info.lastInsertRowid, b);
  res.json(db.prepare(`SELECT * FROM expenses WHERE id = ?`).get(info.lastInsertRowid));
});
router.put('/expenses/:id', (req, res) => {
  const b = req.body;
  db.prepare(`UPDATE expenses SET date=?, category=?, description=?, amount=?, mode=?, reference_no=? WHERE id=?`)
    .run(b.date, b.category, b.description || '', Number(b.amount) || 0, b.mode || 'Cash', b.reference_no || '', req.params.id);
  audit(req, 'UPDATE', 'expenses', req.params.id, b);
  res.json(db.prepare(`SELECT * FROM expenses WHERE id = ?`).get(req.params.id));
});
router.delete('/expenses/:id', (req, res) => {
  db.prepare(`DELETE FROM expenses WHERE id = ?`).run(req.params.id);
  audit(req, 'DELETE', 'expenses', req.params.id, {});
  res.json({ ok: true });
});

module.exports = router;
