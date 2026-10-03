// Offline-first synchronization API for salesperson/mobile clients.
// Mobile devices never connect to PostgreSQL directly; they exchange signed
// application events with the tenant API.
const express = require('express');
const crypto = require('crypto');
const { db, nextNo, stockOutForSale, stockBalance, audit } = require('../db');
const sub = require('../lib/subscription');
const router = express.Router();

function uuid(v) { const s=String(v||'').trim(); return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s) ? s : null; }
function requireDevice(req,res,next) {
  const id=uuid(req.headers['x-device-id'] || req.body?.device_id || req.query?.device_id);
  if(!id) return res.status(400).json({error:'device_id is required'});
  const d=db.prepare(`SELECT * FROM sync_devices WHERE device_id=? AND active=1 AND user_id=?`).get(id, req.user.id);
  if(!d) return res.status(403).json({error:'This device is not registered or has been revoked.'});
  req.device=d; next();
}

router.post('/sync/register-device', (req,res)=>{
  const deviceId=uuid(req.body?.device_id) || crypto.randomUUID();
  const branchId=req.user.branch_id || req.body?.branch_id || null;
  if(req.body?.branch_id && req.user.role !== 'ADMIN' && Number(req.body.branch_id)!==Number(req.user.branch_id)) return res.status(403).json({error:'You cannot register a device for another branch.'});
  db.prepare(`INSERT INTO sync_devices(device_id,user_id,employee_id,branch_id,device_name,platform,app_version,last_seen_at,active)
    VALUES(?,?,?,?,?,?,?,?,1)
    ON CONFLICT(device_id) DO UPDATE SET user_id=excluded.user_id, employee_id=excluded.employee_id, branch_id=excluded.branch_id,
    device_name=excluded.device_name, platform=excluded.platform, app_version=excluded.app_version, last_seen_at=excluded.last_seen_at, active=1`)
    .run(deviceId,req.user.id,req.user.employee_id||null,branchId,String(req.body?.device_name||'Mobile'),String(req.body?.platform||'unknown'),String(req.body?.app_version||''),new Date().toISOString());
  res.json({device_id:deviceId, branch_id:branchId, last_sync_sequence:Number(db.prepare(`SELECT COALESCE(last_sync_sequence,0) v FROM sync_devices WHERE device_id=?`).get(deviceId).v||0)});
});

router.get('/sync/status', requireDevice, (req,res)=>{
  const max=db.prepare(`SELECT COALESCE(MAX(sequence_no),0) v FROM sync_outbox`).get().v;
  res.json({device_id:req.device.device_id, active:true,last_sync_sequence:Number(req.device.last_sync_sequence||0),server_sequence:Number(max||0),pending:Number(max||0)-Number(req.device.last_sync_sequence||0)});
});

function pushInvoice(event, req) {
  const p=event.payload||{};
  const clientUuid=uuid(event.entity_client_id || p.client_uuid);
  if(!clientUuid) throw new Error('SALES_INVOICE requires entity_client_id/client_uuid UUID');
  const existing=db.prepare(`SELECT id,invoice_no FROM sales_invoices WHERE client_uuid=?`).get(clientUuid);
  if(existing) return {status:'duplicate',entity_type:'SALES_INVOICE',entity_id:existing.id,invoice_no:existing.invoice_no,client_uuid:clientUuid};
  let customerId=Number(p.customer_id||0);
  if(!customerId && uuid(p.customer_client_id)){ const c=db.prepare(`SELECT id FROM customers WHERE client_uuid=?`).get(uuid(p.customer_client_id)); if(c) customerId=Number(c.id); }
  const customer=db.prepare(`SELECT id FROM customers WHERE id=? AND active=1`).get(customerId);
  if(!customer) throw new Error('Customer not found in this company');
  const items=Array.isArray(p.items)?p.items:[]; if(!items.length) throw new Error('Invoice must contain at least one item');
  let subtotal=0; const lines=[];
  for(const raw of items){
    const productId=Number(raw.product_id||0), qty=Number(raw.qty||0), rate=Number(raw.rate||0), disc=Number(raw.discount_pct||0);
    if(!productId || qty<=0 || rate<0) throw new Error('Invalid invoice line');
    const product=db.prepare(`SELECT id FROM products WHERE id=? AND active=1`).get(productId); if(!product) throw new Error(`Product ${productId} not found`);
    const amount=Math.round(qty*rate*(1-disc/100)*100)/100; subtotal+=amount; lines.push({productId,qty,rate,disc,amount});
  }
  const discountPct=Number(p.discount_pct||0), gstPct=Number(p.gst_pct||0), gstType=String(p.gst_type||'CGST_SGST');
  const afterDiscount=subtotal*(1-discountPct/100); const gstAmt=afterDiscount*gstPct/100; const grand=afterDiscount+gstAmt;
  const invoiceDate=String(p.invoice_date||new Date().toISOString().slice(0,10));
  const invoiceNo=nextNo('INV-','sales_invoices','invoice_no');
  const tx=db.transaction(()=>{
    const info=db.prepare(`INSERT INTO sales_invoices(invoice_no,invoice_date,customer_id,due_date,discount_pct,gst_pct,gst_type,subtotal,gst_amt,grand_total,salesperson_id,status,client_uuid,branch_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(invoiceNo,invoiceDate,customerId,p.due_date||null,discountPct,gstPct,gstType,afterDiscount,gstAmt,grand,req.user.employee_id||null,'Unpaid',clientUuid,req.device.branch_id||req.user.branch_id||null);
    const invoiceId=info.lastInsertRowid;
    const ins=db.prepare(`INSERT INTO sales_items(invoice_id,product_id,qty,rate,discount_pct,amount) VALUES(?,?,?,?,?,?)`);
    for(const l of lines){ ins.run(invoiceId,l.productId,l.qty,l.rate,l.disc,l.amount); stockOutForSale(invoiceDate,l.productId,l.qty,invoiceId,invoiceNo); }
    audit(req,'CREATE','sales_invoice',invoiceId,{source:'OFFLINE_SYNC',device_id:req.device.device_id,client_uuid:clientUuid});
    db.prepare(`INSERT INTO sync_outbox(entity_type,entity_id,entity_client_id,operation,branch_id,payload) VALUES(?,?,?,?,?,?::jsonb)`)
      .run('SALES_INVOICE',invoiceId,clientUuid,'CREATE',req.device.branch_id||req.user.branch_id||null,JSON.stringify({id:invoiceId,invoice_no:invoiceNo,client_uuid:clientUuid,invoice_date:invoiceDate,customer_id:customerId,grand_total:grand}));
    return invoiceId;
  })();
  return {status:'applied',entity_type:'SALES_INVOICE',entity_id:tx,invoice_no:invoiceNo,client_uuid:clientUuid};
}


function pushCustomer(event, req) {
  const p=event.payload||{};
  const clientUuid=uuid(event.entity_client_id || p.client_uuid);
  if(!clientUuid) throw new Error('CUSTOMER requires entity_client_id/client_uuid UUID');
  const existing=db.prepare(`SELECT id,code FROM customers WHERE client_uuid=?`).get(clientUuid);
  if(existing) return {status:'duplicate',entity_type:'CUSTOMER',entity_id:existing.id,code:existing.code,client_uuid:clientUuid};
  const name=String(p.name||'').trim();
  if(name.length<2 || name.length>120) throw new Error('Customer name must be 2-120 characters');
  const phone=String(p.phone||'').trim().slice(0,30);
  if(phone && db.prepare(`SELECT id FROM customers WHERE phone=? AND active=1 AND name=?`).get(phone,name)) throw new Error('A customer with this name and phone already exists');
  const code=nextNo('CUST-','customers','code');
  const info=db.prepare(`INSERT INTO customers(code,name,contact_person,phone,email,address,gst_no,payment_terms_days,client_uuid) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(code,name,String(p.contact_person||'').slice(0,80)||null,phone||null,String(p.email||'').slice(0,120)||null,String(p.address||'').slice(0,300)||null,String(p.gst_no||'').slice(0,20)||null,Math.max(0,Math.min(365,Number(p.payment_terms_days)||30)),clientUuid);
  audit(req,'CREATE','customers',info.lastInsertRowid,{source:'OFFLINE_SYNC',device_id:req.device.device_id});
  return {status:'applied',entity_type:'CUSTOMER',entity_id:info.lastInsertRowid,code,client_uuid:clientUuid};
}

function pushReceipt(event, req) {
  const p=event.payload||{};
  const clientUuid=uuid(event.entity_client_id || p.client_uuid);
  if(!clientUuid) throw new Error('RECEIPT requires entity_client_id/client_uuid UUID');
  const existing=db.prepare(`SELECT id,receipt_no FROM receipts WHERE client_uuid=?`).get(clientUuid);
  if(existing) return {status:'duplicate',entity_type:'RECEIPT',entity_id:existing.id,receipt_no:existing.receipt_no,client_uuid:clientUuid};
  let customerId=Number(p.customer_id||0);
  if(!customerId && uuid(p.customer_client_id)){ const c=db.prepare(`SELECT id FROM customers WHERE client_uuid=?`).get(uuid(p.customer_client_id)); if(c) customerId=Number(c.id); }
  if(!db.prepare(`SELECT id FROM customers WHERE id=?`).get(customerId)) throw new Error('Customer not found in this company');
  let invoiceId=Number(p.invoice_id||0)||null;
  if(!invoiceId && uuid(p.invoice_client_id)){ const i=db.prepare(`SELECT id FROM sales_invoices WHERE client_uuid=?`).get(uuid(p.invoice_client_id)); if(i) invoiceId=Number(i.id); }
  const amount=Number(p.amount);
  if(!(amount>0) || amount>1e9) throw new Error('Enter a valid receipt amount');
  const mode=['Cash','UPI','Cheque','Bank Transfer','Card'].includes(p.mode)?p.mode:'Cash';
  const date=String(p.date||new Date().toISOString().slice(0,10)).slice(0,10);
  const collectedBy=req.user.employee_id||null;
  const tx=db.transaction(()=>{
    const no=nextNo('RCPT-','receipts','receipt_no');
    const info=db.prepare(`INSERT INTO receipts(receipt_no,date,customer_id,invoice_id,amount,mode,reference_no,remarks,collected_by,client_uuid) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(no,date,customerId,invoiceId,amount,mode,String(p.reference_no||'').slice(0,60),String(p.remarks||'').slice(0,200),collectedBy,clientUuid);
    if(invoiceId){
      require('./returns').helpers.refreshInvoiceStatus(invoiceId);
    }
    audit(req,'CREATE','receipts',info.lastInsertRowid,{source:'OFFLINE_SYNC',device_id:req.device.device_id,receipt_no:no});
    return {id:info.lastInsertRowid,no};
  })();
  return {status:'applied',entity_type:'RECEIPT',entity_id:tx.id,receipt_no:tx.no,client_uuid:clientUuid};
}

router.post('/sync/push', require('../lib/subscription').checkLimit('invoices'), requireDevice, (req,res)=>{
  const events=Array.isArray(req.body?.events)?req.body.events:[];
  if(events.length>200) return res.status(400).json({error:'Maximum 200 events per sync batch'});
  const results=[];
  for(const event of events){
    const eventId=uuid(event?.event_id); if(!eventId){ results.push({status:'rejected',error:'event_id must be a UUID'}); continue; }
    const existing=db.prepare(`SELECT status,error_code,error_message FROM sync_inbox WHERE event_id=?`).get(eventId);
    if(existing){ results.push({event_id:eventId,status:existing.status.toLowerCase(),error:existing.error_message||undefined}); continue; }
    const entity=String(event.entity_type||'').toUpperCase(); const op=String(event.operation||'CREATE').toUpperCase();
    try {
      db.prepare(`INSERT INTO sync_inbox(event_id,device_id,user_id,employee_id,branch_id,entity_type,operation,entity_client_id,client_created_at,payload,status)
        VALUES(?,?,?,?,?,?,?,?,?,?::jsonb,'PENDING')`).run(eventId,req.device.device_id,req.user.id,req.user.employee_id||null,req.device.branch_id||null,entity,op,uuid(event.entity_client_id),String(event.client_created_at||new Date().toISOString()),JSON.stringify(event.payload||{}));
      let result;
      if(entity==='SALES_INVOICE' && op==='CREATE') result=pushInvoice(event,req);
      else if(entity==='CUSTOMER' && op==='CREATE') result=pushCustomer(event,req);
      else if(entity==='RECEIPT' && op==='CREATE') result=pushReceipt(event,req);
      else throw new Error(`Unsupported sync entity/operation: ${entity}/${op}`);
      db.prepare(`UPDATE sync_inbox SET status='APPLIED',processed_at=now() WHERE event_id=?`).run(eventId);
      results.push({event_id:eventId,...result});
    } catch(e){
      db.prepare(`UPDATE sync_inbox SET status='REJECTED',processed_at=now(),error_code=?,error_message=? WHERE event_id=?`).run(e.code||'SYNC_ERROR',String(e.message||e).slice(0,1000),eventId);
      results.push({event_id:eventId,status:'rejected',error:String(e.message||e)});
    }
  }
  db.prepare(`UPDATE sync_devices SET last_seen_at=now() WHERE device_id=?`).run(req.device.device_id);
  res.json({results});
});


// ---- master data for offline use ------------------------------------------------
// One call that gives a device everything a salesperson needs in the field:
// customers (with what they owe), products (rate, GST, stock), settings.
// `version` changes whenever any of it changes, so a device can skip the download.
function buildMaster(req){
  const customers=db.prepare(`SELECT c.id,c.code,c.name,c.contact_person,c.phone,c.address,c.gst_no,c.credit_limit,c.payment_terms_days,c.client_uuid,
      COALESCE((SELECT SUM(grand_total) FROM sales_net WHERE customer_id=c.id),0) - (COALESCE((SELECT SUM(amount) FROM receipts WHERE customer_id=c.id),0) - COALESCE((SELECT SUM(refund_amount) FROM sales_returns WHERE customer_id=c.id AND status='Accepted'),0)) AS outstanding
      FROM customers c WHERE c.active=1 ORDER BY c.name`).all();
  const products=db.prepare(`SELECT id,sku,name,category,unit,sale_rate,gst_rate,hsn_code FROM products WHERE active=1 ORDER BY name`).all()
    .map(p=>({...p,sale_rate:Number(p.sale_rate)||0,gst_rate:Number(p.gst_rate)||0,stock:Math.round((Number(stockBalance('PRODUCT',p.id))||0)*100)/100}));
  const st=db.prepare(`SELECT company_name, gst_no, address, phone, invoice_prefix FROM company_settings WHERE id=1`).get()||{};
  const snap=req.subscription||sub.snapshot(req.company,{withUsage:false});
  const data={
    company:{name:st.company_name||req.company.company_name,gst_no:st.gst_no||null,address:st.address||null,phone:st.phone||null},
    customers:customers.map(c=>({...c,outstanding:Math.round((Number(c.outstanding)||0)*100)/100,credit_limit:Number(c.credit_limit)||0})),
    products,
    subscription:{state:snap.state,read_only:!!snap.read_only,notice:snap.notice?snap.notice.text:null},
  };
  const crypto2=require('crypto');
  data.version=crypto2.createHash('sha1').update(JSON.stringify([data.customers,data.products,data.company])).digest('hex').slice(0,16);
  data.generated_at=new Date().toISOString();
  return data;
}
router.get('/sync/master', requireDevice, (req,res)=>{
  const m=buildMaster(req);
  if(String(req.query.version||'')===m.version) return res.json({unchanged:true,version:m.version,generated_at:m.generated_at,subscription:m.subscription});
  db.prepare(`UPDATE sync_devices SET last_seen_at=now(),last_sync_at=now() WHERE device_id=?`).run(req.device.device_id);
  res.json(m);
});

router.get('/sync/pull', requireDevice, (req,res)=>{
  const after=Math.max(0,Number(req.query.after||req.device.last_sync_sequence||0)); const limit=Math.min(500,Math.max(1,Number(req.query.limit||200)));
  const rows=db.prepare(`SELECT sequence_no,entity_type,entity_id,entity_client_id,operation,branch_id,changed_at,payload FROM sync_outbox WHERE sequence_no>? ORDER BY sequence_no ASC LIMIT ?`).all(after,limit);
  const next=rows.length?Number(rows[rows.length-1].sequence_no):after;
  db.prepare(`UPDATE sync_devices SET last_seen_at=now(),last_sync_at=now() WHERE device_id=?`).run(req.device.device_id);
  res.json({after,next,has_more:rows.length===limit,changes:rows});
});

router.post('/sync/ack', requireDevice, (req,res)=>{
  const seq=Math.max(0,Number(req.body?.sequence_no||0));
  const max=Number(db.prepare(`SELECT COALESCE(MAX(sequence_no),0) v FROM sync_outbox`).get().v||0);
  if(seq>max) return res.status(400).json({error:'sequence_no is ahead of the server'});
  db.prepare(`UPDATE sync_devices SET last_sync_sequence=?,last_sync_at=now(),last_seen_at=now() WHERE device_id=?`).run(seq,req.device.device_id);
  res.json({ok:true,last_sync_sequence:seq});
});

router.post('/sync/revoke-device/:device_id', (req,res)=>{
  if(req.user.role!=='ADMIN') return res.status(403).json({error:'Administrator access required'});
  const id=uuid(req.params.device_id); if(!id) return res.status(400).json({error:'Invalid device id'});
  db.prepare(`UPDATE sync_devices SET active=0 WHERE device_id=?`).run(id); res.json({ok:true});
});

module.exports=router;
