// ============================================================================
// returns.js — Customer Returns (credit notes) and Returns to Supplier (debit notes)
// A return is first PENDING. When a manager / accountant / admin ACCEPTS it, the server
// updates stock, the customer / supplier balance, the invoice status, GST and every
// report in one step. Nothing is changed by a pending or rejected return.
// ============================================================================
const R_PILLS = ['Pending', 'Accepted', 'Rejected', ''];
let salesRetFilter = 'Pending', purchRetFilter = 'Pending';
const retCanDecide = () => ME && ['ADMIN', 'MANAGER', 'ACCOUNTANT'].includes(String(ME.role).toUpperCase());
const retBadge = (s) => `<span class="badge ${s === 'Accepted' ? 'badge-green' : s === 'Rejected' ? 'badge-red' : 'badge-amber'}">${s}</span>`;
const retEsc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const REASONS = ['Damaged / defective', 'Wrong item sent', 'Quality not as expected', 'Customer changed mind', 'Excess quantity', 'Expired / old stock', 'Other'];
const RMODES = ['Cash', 'Bank Transfer', 'Cheque', 'UPI', 'Card'];
const pills = (cur, fn) => R_PILLS.map((f) => `<button class="btn btn-sm ${cur === f ? 'btn-primary' : 'btn-outline'}" onclick="${fn}('${f}')">${f || 'All'}</button>`).join(' ');
const reasonSelect = (id) => `<select id="${id}" onchange="document.getElementById('${id}_other').style.display=this.value==='Other'?'':'none'">${REASONS.map((r) => `<option>${r}</option>`).join('')}</select><input id="${id}_other" placeholder="Describe the reason" style="display:none;margin-top:6px;">`;
const reasonValue = (id) => { const v = document.getElementById(id).value; return v === 'Other' ? (document.getElementById(id + '_other').value.trim() || '') : v; };
const refundFields = (prefix, label) => `<div class="form-field"><label>${label} (₹) — optional</label><input type="number" id="${prefix}_amt" min="0" step="0.01" value="0"></div>
  <div class="form-field"><label>Refund mode</label><select id="${prefix}_mode">${RMODES.map((m) => `<option>${m}</option>`).join('')}</select></div>
  <div class="form-field"><label>Reference</label><input id="${prefix}_ref" placeholder="UPI / cheque no."></div>`;
const errBox = (id) => `<div id="${id}" class="auth-err" style="min-height:0;"></div>`;
const setErr = (id, m) => { const e = document.getElementById(id); if (e) e.textContent = m || ''; };

// ----------------------------------------------------------- customer returns
async function renderSalesReturns() {
  const rows = await api('/sales-returns' + (salesRetFilter ? '?status=' + salesRetFilter : ''));
  const all = salesRetFilter ? await api('/sales-returns') : rows;
  const pend = all.filter((r) => r.status === 'Pending').length, accVal = all.filter((r) => r.status === 'Accepted').reduce((t, r) => t + Number(r.grand_total), 0);
  document.getElementById('content').innerHTML = setHeaderBanner('salesReturns', `<button class="btn btn-outline" onclick="openSalesReturnForm()">${ic('plus')} New Customer Return</button>`) + `
    <div class="grid-stats" style="margin-bottom:14px;">${statCard('receipt', '#EF9F2E', 'Waiting for approval', pend, 'Pending returns')}${statCard('dollar', '#E15A5A', 'Returned value (accepted)', inr(accVal), 'Credit notes issued')}</div>
    <div style="margin:0 0 12px;display:flex;gap:6px;flex-wrap:wrap;">${pills(salesRetFilter, 'setSalesRetFilter')}</div>
    <div class="panel" style="padding:0;"><div class="tbl-scroll"><table>
      <thead><tr><th>Return No</th><th>Date</th><th>Customer</th><th>Invoice</th><th>Items</th><th>Value (incl. GST)</th><th>Refund</th><th>Status</th><th>Raised by</th><th style="text-align:right;">Actions</th></tr></thead>
      <tbody>${rows.length ? rows.map((r) => `<tr><td><b>${r.return_no}</b></td><td>${fmtDate(r.return_date)}</td><td>${retEsc(r.customer_name)}</td><td>${retEsc(r.invoice_no)}</td><td>${r.item_count}</td><td>${inr(r.grand_total)}</td><td>${r.refund_amount > 0 ? inr(r.refund_amount) + ' <small>' + retEsc(r.refund_mode || '') + '</small>' : '—'}</td><td>${retBadge(r.status)}</td><td>${retEsc(r.created_by_name || '')}</td>
        <td><div class="row-actions" style="justify-content:flex-end;">
          <button class="btn btn-sm btn-outline" onclick="viewSalesReturn(${r.id})">View</button>
          ${r.status === 'Pending' && retCanDecide() ? `<button class="btn btn-sm btn-primary" onclick="openDecideReturn('sales',${r.id},'accept')">Accept</button><button class="btn btn-sm btn-danger" onclick="openDecideReturn('sales',${r.id},'reject')">Reject</button>` : ''}
          ${r.status === 'Accepted' ? `<button class="icon-btn" title="Print credit note" onclick="printCreditNote(${r.id})">${ic('print')}</button>` : ''}
          ${r.status === 'Accepted' && ME.role === 'ADMIN' ? `<button class="btn btn-sm btn-outline" onclick="openDecideReturn('sales',${r.id},'reverse')">Reverse</button>` : ''}
          ${r.status !== 'Accepted' ? `<button class="icon-btn del" title="Delete" onclick="deleteReturn('sales',${r.id})">${ic('trash')}</button>` : ''}
        </div></td></tr>`).join('') : '<tr class="empty-row"><td colspan="10">No customer returns here. Use "New Customer Return" or the ↩ button on an invoice.</td></tr>'}</tbody></table></div></div>`;
}
function setSalesRetFilter(f) { salesRetFilter = f; renderSalesReturns(); }

let RET_CTX = null;
async function openSalesReturnForm(invoiceId) {
  let sales = CACHE.sales; if (!sales) { sales = await api('/sales'); CACHE.sales = sales; }
  const list = sales.filter((i) => i.status !== 'Returned');
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>New Customer Return</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="form-field"><label>Invoice the goods are returned against</label><select id="sr_inv" onchange="loadReturnInvoice()"><option value="">— choose invoice —</option>${list.map((i) => `<option value="${i.id}" ${i.id === invoiceId ? 'selected' : ''}>${retEsc(i.invoice_no)} — ${retEsc(i.customer_name)} — ${inr(i.grand_total)}</option>`).join('')}</select></div>
      <div class="form-field"><label>Return date</label><input type="date" id="sr_date" value="${todayISO()}"></div>
    </div>
    <div id="sr_lines" style="margin:10px 0;"><div class="mut" style="color:var(--muted)">Choose an invoice to see what can be returned.</div></div>
    <div class="form-grid"><div class="form-field"><label>Reason for return</label>${reasonSelect('sr_reason')}</div>
      <div class="form-field"><label>Remarks (optional)</label><input id="sr_remarks"></div></div>
    <div class="form-grid" style="margin-top:6px;">${refundFields('sr_ref', 'Cash / money refunded to customer now')}</div>
    <div style="font-size:12px;color:var(--muted);margin-top:4px;">Leave the refund at 0 to simply reduce what the customer owes (credit note). Enter an amount if you hand money back.</div>
    ${retCanDecide() ? '<label class="pf-chk" style="display:flex;gap:7px;align-items:center;margin-top:10px;"><input type="checkbox" id="sr_now" checked> Accept immediately (update stock and accounts now)</label>' : '<div style="font-size:12px;color:var(--muted);margin-top:8px;">This will be sent to a manager for approval. Stock and accounts change only when it is accepted.</div>'}
    ${errBox('sr_err')}</div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveSalesReturn()">Save Return</button></div>`;
  document.getElementById('modalBg').classList.add('show');
  if (invoiceId) loadReturnInvoice();
}
async function loadReturnInvoice() {
  const id = Number(document.getElementById('sr_inv').value); const host = document.getElementById('sr_lines');
  RET_CTX = null; if (!id) { host.innerHTML = ''; return; }
  try {
    const d = await api('/sales-returns/for-invoice/' + id); RET_CTX = d;
    host.innerHTML = `<div style="font-size:13px;margin-bottom:6px;"><b>${retEsc(d.invoice.customer_name)}</b> · ${retEsc(d.invoice.invoice_no)} · GST ${d.invoice.gst_pct}%</div>
      <div class="tbl-scroll"><table class="ret-lines"><thead><tr><th>Product</th><th>Sold</th><th>Already returned</th><th>Can return</th><th>Return qty</th><th>Condition</th></tr></thead><tbody>
      ${d.lines.map((l, i) => `<tr><td>${retEsc(l.product_name)}</td><td>${l.sold_qty}</td><td>${l.returned_qty + l.pending_qty}${l.pending_qty ? ` <small>(${l.pending_qty} pending)</small>` : ''}</td><td>${l.available_qty}</td>
        <td><input type="number" min="0" max="${l.available_qty}" step="any" id="sr_q_${i}" value="0" oninput="paintReturnTotal()" ${l.available_qty <= 0 ? 'disabled' : ''}></td>
        <td><select id="sr_c_${i}" ${l.available_qty <= 0 ? 'disabled' : ''}><option value="Good">Good — back to stock</option><option value="Damaged">Damaged — do not restock</option></select></td></tr>`).join('')}
      </tbody></table></div><div id="sr_tot" style="margin-top:8px;max-width:320px;margin-left:auto;"></div>`;
    paintReturnTotal();
  } catch (e) { host.innerHTML = `<div class="auth-err">${retEsc(e.message)}</div>`; }
}
function paintReturnTotal() {
  if (!RET_CTX) return; let sub = 0;
  RET_CTX.lines.forEach((l, i) => { const q = Number((document.getElementById('sr_q_' + i) || {}).value) || 0; sub += q * l.unit_net; });
  sub = Math.round(sub * RET_CTX.factor * 100) / 100; const gst = Math.round(sub * Number(RET_CTX.invoice.gst_pct) / 100 * 100) / 100;
  document.getElementById('sr_tot').innerHTML = `<div class="ret-total"><span>Taxable value</span><span>${inr(sub)}</span></div><div class="ret-total"><span>GST (${RET_CTX.invoice.gst_pct}%)</span><span>${inr(gst)}</span></div><div class="ret-total g"><span>Credit to customer</span><span>${inr(sub + gst)}</span></div>`;
}
async function saveSalesReturn() {
  setErr('sr_err'); if (!RET_CTX) return setErr('sr_err', 'Choose an invoice first.');
  const items = RET_CTX.lines.map((l, i) => ({ product_id: l.product_id, qty: Number(document.getElementById('sr_q_' + i).value) || 0, restock: document.getElementById('sr_c_' + i).value !== 'Damaged' })).filter((x) => x.qty > 0);
  if (!items.length) return setErr('sr_err', 'Enter the quantity being returned for at least one product.');
  const reason = reasonValue('sr_reason'); if (reason.length < 3) return setErr('sr_err', 'Please give the reason for the return.');
  try {
    const r = await api('/sales-returns', { method: 'POST', body: JSON.stringify({ invoice_id: RET_CTX.invoice.id, return_date: document.getElementById('sr_date').value, reason, remarks: document.getElementById('sr_remarks').value, items, refund_amount: Number(document.getElementById('sr_ref_amt').value) || 0, refund_mode: document.getElementById('sr_ref_mode').value, refund_reference: document.getElementById('sr_ref_ref').value, accept_now: !!(document.getElementById('sr_now') && document.getElementById('sr_now').checked) }) });
    closeModal(); CACHE.sales = null; showToast(r.status === 'Accepted' ? `${r.return_no} accepted — stock and accounts updated` : `${r.return_no} saved — waiting for approval`); salesRetFilter = r.status; goTo('salesReturns');
  } catch (e) { setErr('sr_err', e.message); }
}
async function viewSalesReturn(id) {
  const r = await api('/sales-returns/' + id);
  document.getElementById('modalBox').innerHTML = `<div class="modal-head"><h3>${r.return_no} ${retBadge(r.status)}</h3><button class="modal-close" onclick="closeModal()">×</button></div><div class="modal-body">
    <p style="font-size:13.5px;"><b>${retEsc(r.customer_name)}</b> · Invoice ${retEsc(r.invoice_no)} · ${fmtDate(r.return_date)}<br>Reason: ${retEsc(r.reason)}${r.remarks ? ' — ' + retEsc(r.remarks) : ''}</p>
    <table><thead><tr><th>Product</th><th>Qty</th><th>Value</th><th>Stock</th></tr></thead><tbody>${r.items.map((i) => `<tr><td>${retEsc(i.product_name)}</td><td>${i.qty} ${retEsc(i.unit || '')}</td><td>${inr(i.amount)}</td><td>${i.restock ? 'Back to stock' : 'Damaged — not restocked'}</td></tr>`).join('')}</tbody></table>
    <div style="max-width:300px;margin:10px 0 0 auto;"><div class="ret-total"><span>Taxable</span><span>${inr(r.subtotal)}</span></div><div class="ret-total"><span>GST ${r.gst_pct}%</span><span>${inr(r.gst_amt)}</span></div><div class="ret-total g"><span>Total credit</span><span>${inr(r.grand_total)}</span></div>${r.refund_amount > 0 ? `<div class="ret-total"><span>Refunded (${retEsc(r.refund_mode)})</span><span>${inr(r.refund_amount)}</span></div>` : ''}</div>
    <p style="font-size:12.5px;color:var(--muted);margin-top:10px;">Raised by ${retEsc(r.created_by_name || '')} on ${retEsc(r.created_at || '')}${r.decided_by_name ? `<br>${r.status === 'Accepted' ? 'Accepted' : 'Decided'} by ${retEsc(r.decided_by_name)} on ${retEsc(r.decided_at || '')}${r.decision_note ? ' — ' + retEsc(r.decision_note) : ''}` : ''}</p></div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Close</button>${r.status === 'Accepted' ? `<button class="btn btn-primary" onclick="printCreditNote(${r.id})">Print credit note</button>` : ''}</div>`;
  document.getElementById('modalBg').classList.add('show');
}
async function printCreditNote(id) {
  const r = await api('/sales-returns/' + id); const co = (typeof COMPANY !== 'undefined' && COMPANY) || {};
  const w = window.open('', '_blank'); if (!w) return showToast('Allow pop-ups to print');
  w.document.write(`<html><head><title>${r.return_no}</title><style>body{font-family:Arial;padding:28px;max-width:720px;margin:auto}table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #ddd;padding:7px;text-align:left}.r{text-align:right}h2{margin:0}</style></head><body>
    <h2>${retEsc(co.company_name || '')}</h2><div>${retEsc(co.address || '')} ${co.gst_no ? '· GSTIN ' + retEsc(co.gst_no) : ''}</div><h3 style="margin-top:20px;">CREDIT NOTE ${retEsc(r.return_no)}</h3>
    <p>Date: ${fmtDate(r.return_date)}<br>Customer: <b>${retEsc(r.customer_name)}</b><br>Against invoice: ${retEsc(r.invoice_no)}<br>Reason: ${retEsc(r.reason)}</p>
    <table><tr><th>Item</th><th class="r">Qty</th><th class="r">Amount</th></tr>${r.items.map((i) => `<tr><td>${retEsc(i.product_name)}</td><td class="r">${i.qty}</td><td class="r">${Number(i.amount).toFixed(2)}</td></tr>`).join('')}
    <tr><td colspan="2" class="r">Taxable value</td><td class="r">${Number(r.subtotal).toFixed(2)}</td></tr><tr><td colspan="2" class="r">GST ${r.gst_pct}%</td><td class="r">${Number(r.gst_amt).toFixed(2)}</td></tr><tr><td colspan="2" class="r"><b>Total credit</b></td><td class="r"><b>${Number(r.grand_total).toFixed(2)}</b></td></tr></table>
    ${r.refund_amount > 0 ? `<p>Refunded to customer: Rs. ${Number(r.refund_amount).toFixed(2)} (${retEsc(r.refund_mode)})</p>` : '<p>The amount is credited to the customer\'s account.</p>'}
    <script>window.onload=()=>window.print()<\/script></body></html>`); w.document.close();
}

// ----------------------------------------------------------- shared decide / delete
function openDecideReturn(kind, id, action) {
  const sales = kind === 'sales'; const title = { accept: 'Accept return', reject: 'Reject return', reverse: 'Reverse accepted return' }[action];
  const help = { accept: sales ? 'Accepting puts the goods back into stock (unless damaged), reduces what the customer owes, and updates GST and every report.' : 'Accepting takes the goods out of stock, reduces what you owe the supplier, and updates Input GST and every report.', reject: 'Nothing changes in stock or accounts. The person who raised it will see your reason.', reverse: 'Undoes the stock and account changes made when it was accepted.' }[action];
  document.getElementById('modalBox').innerHTML = `<div class="modal-head"><h3>${title}</h3><button class="modal-close" onclick="closeModal()">×</button></div><div class="modal-body">
    <p style="font-size:13.5px;color:var(--muted);">${help}</p>
    ${action === 'accept' ? `<div class="form-grid">${refundFields('dr', sales ? 'Money refunded to customer' : 'Money refunded by supplier')}</div><div style="font-size:12px;color:var(--muted);margin:4px 0 8px;">Leave at 0 if no money changes hands.</div>` : ''}
    <div class="form-field full"><label>${action === 'accept' ? 'Note (optional)' : 'Reason (required)'}</label><input id="dr_note" placeholder="${action === 'accept' ? 'e.g. Checked, goods in good condition' : 'Write the reason'}"></div>${errBox('dr_err')}</div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn ${action === 'accept' ? 'btn-primary' : 'btn-danger'}" onclick="doDecideReturn('${kind}',${id},'${action}')">${title}</button></div>`;
  document.getElementById('modalBg').classList.add('show');
}
async function doDecideReturn(kind, id, action) {
  setErr('dr_err'); const base = kind === 'sales' ? '/sales-returns/' : '/purchase-returns/'; const note = document.getElementById('dr_note').value.trim();
  const body = { note }; if (action === 'accept' && Number(document.getElementById('dr_amt').value) > 0) { body.refund_amount = Number(document.getElementById('dr_amt').value); body.refund_mode = document.getElementById('dr_mode').value; body.refund_reference = document.getElementById('dr_ref').value; }
  try { await api(base + id + '/' + action, { method: 'POST', body: JSON.stringify(body) }); closeModal(); CACHE.sales = null; showToast(action === 'accept' ? 'Accepted — stock and accounts updated' : action === 'reject' ? 'Return rejected' : 'Return reversed'); kind === 'sales' ? renderSalesReturns() : renderPurchaseReturns(); }
  catch (e) { setErr('dr_err', e.message); }
}
async function deleteReturn(kind, id) { if (!confirm('Delete this return?')) return; try { await api((kind === 'sales' ? '/sales-returns/' : '/purchase-returns/') + id, { method: 'DELETE' }); kind === 'sales' ? renderSalesReturns() : renderPurchaseReturns(); } catch (e) { showToast(e.message); } }

// ----------------------------------------------------------- returns to supplier
async function renderPurchaseReturns() {
  const rows = await api('/purchase-returns' + (purchRetFilter ? '?status=' + purchRetFilter : ''));
  const all = purchRetFilter ? await api('/purchase-returns') : rows;
  const pend = all.filter((r) => r.status === 'Pending').length, accVal = all.filter((r) => r.status === 'Accepted').reduce((t, r) => t + Number(r.total), 0);
  document.getElementById('content').innerHTML = setHeaderBanner('purchaseReturns', `<button class="btn btn-outline" onclick="openPurchaseReturnForm()">${ic('plus')} New Return to Supplier</button>`) + `
    <div class="grid-stats" style="margin-bottom:14px;">${statCard('cart', '#EF9F2E', 'Waiting for approval', pend, 'Pending returns')}${statCard('dollar', '#E15A5A', 'Returned value (accepted)', inr(accVal), 'Debit notes issued')}</div>
    <div style="margin:0 0 12px;display:flex;gap:6px;flex-wrap:wrap;">${pills(purchRetFilter, 'setPurchRetFilter')}</div>
    <div class="panel" style="padding:0;"><div class="tbl-scroll"><table>
      <thead><tr><th>Return No</th><th>Date</th><th>Supplier</th><th>Purchase</th><th>Item</th><th>Qty</th><th>Value (incl. GST)</th><th>Refund</th><th>Status</th><th style="text-align:right;">Actions</th></tr></thead>
      <tbody>${rows.length ? rows.map((r) => `<tr><td><b>${r.return_no}</b></td><td>${fmtDate(r.return_date)}</td><td>${retEsc(r.supplier_name)}</td><td>${retEsc(r.purchase_no)}</td><td>${retEsc(r.item_name)}</td><td>${r.qty} ${retEsc(r.unit || '')}</td><td>${inr(r.total)}</td><td>${r.refund_amount > 0 ? inr(r.refund_amount) : '—'}</td><td>${retBadge(r.status)}${r.decision_note ? `<br><small>${retEsc(r.decision_note)}</small>` : ''}</td>
        <td><div class="row-actions" style="justify-content:flex-end;">
          ${r.status === 'Pending' && retCanDecide() ? `<button class="btn btn-sm btn-primary" onclick="openDecideReturn('purchase',${r.id},'accept')">Accept</button><button class="btn btn-sm btn-danger" onclick="openDecideReturn('purchase',${r.id},'reject')">Reject</button>` : ''}
          ${r.status === 'Accepted' ? `<button class="icon-btn" title="Print debit note" onclick="printDebitNote(${r.id})">${ic('print')}</button>` : ''}
          ${r.status === 'Accepted' && ME.role === 'ADMIN' ? `<button class="btn btn-sm btn-outline" onclick="openDecideReturn('purchase',${r.id},'reverse')">Reverse</button>` : ''}
          ${r.status !== 'Accepted' ? `<button class="icon-btn del" title="Delete" onclick="deleteReturn('purchase',${r.id})">${ic('trash')}</button>` : ''}
        </div></td></tr>`).join('') : '<tr class="empty-row"><td colspan="10">No returns to suppliers here. Use "New Return to Supplier" or the ↩ button on a received purchase.</td></tr>'}</tbody></table></div></div>`;
}
function setPurchRetFilter(f) { purchRetFilter = f; renderPurchaseReturns(); }
let PRET_CTX = null;
async function openPurchaseReturnForm(purchaseId) {
  const purchases = (await api('/purchases')).filter((p) => p.status === 'Received' && p.item_type !== 'ASSET');
  document.getElementById('modalBox').innerHTML = `
    <div class="modal-head"><h3>New Return to Supplier</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="form-field"><label>Purchase the goods are returned against</label><select id="pr_pur" onchange="loadReturnPurchase()"><option value="">— choose purchase —</option>${purchases.map((p) => `<option value="${p.id}" ${p.id === purchaseId ? 'selected' : ''}>${retEsc(p.purchase_no)} — ${retEsc(p.supplier_name)} — ${retEsc(p.material_name)}</option>`).join('')}</select></div>
      <div class="form-field"><label>Return date</label><input type="date" id="pr_date" value="${todayISO()}"></div></div>
    <div id="pr_info" style="margin:10px 0;"></div>
    <div class="form-grid"><div class="form-field"><label>Quantity to return</label><input type="number" id="pr_qty" min="0" step="any" oninput="paintPurchaseReturnTotal()"></div>
      <div class="form-field"><label>Reason for return</label>${reasonSelect('pr_reason')}</div></div>
    <div class="form-grid"><div class="form-field full"><label>Remarks (optional)</label><input id="pr_remarks"></div>${refundFields('pr_ref', 'Money refunded by supplier now')}</div>
    <div id="pr_tot" style="max-width:320px;margin-left:auto;"></div>
    ${retCanDecide() ? '<label style="display:flex;gap:7px;align-items:center;margin-top:10px;"><input type="checkbox" id="pr_now" checked> Accept immediately (update stock and accounts now)</label>' : '<div style="font-size:12px;color:var(--muted);margin-top:8px;">This will be sent to a manager for approval.</div>'}
    ${errBox('pr_err')}</div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="savePurchaseReturn()">Save Return</button></div>`;
  document.getElementById('modalBg').classList.add('show');
  if (purchaseId) loadReturnPurchase();
}
async function loadReturnPurchase() {
  const id = Number(document.getElementById('pr_pur').value); const host = document.getElementById('pr_info'); PRET_CTX = null;
  if (!id) { host.innerHTML = ''; return; }
  try {
    const d = await api('/purchase-returns/for-purchase/' + id); PRET_CTX = d; const p = d.purchase;
    host.innerHTML = `<div style="font-size:13px;background:var(--paper,#f5f7fb);padding:10px;border-radius:10px;"><b>${retEsc(p.supplier_name)}</b> · ${retEsc(p.item_name)} · bought ${p.qty} ${retEsc(p.unit || '')} @ ${inr(p.rate)} (GST ${p.gst_pct}%)<br>Can still return: <b>${d.available_qty}</b>${d.pending_qty ? ` (${d.pending_qty} already pending)` : ''} · Stock on hand now: <b>${d.stock_on_hand ?? '—'}</b></div>`;
    document.getElementById('pr_qty').max = d.available_qty; paintPurchaseReturnTotal();
  } catch (e) { host.innerHTML = `<div class="auth-err">${retEsc(e.message)}</div>`; }
}
function paintPurchaseReturnTotal() {
  if (!PRET_CTX) return; const p = PRET_CTX.purchase; const q = Number(document.getElementById('pr_qty').value) || 0; const amt = Math.round(q * p.rate * 100) / 100; const gst = Math.round(amt * p.gst_pct / 100 * 100) / 100;
  document.getElementById('pr_tot').innerHTML = `<div class="ret-total"><span>Taxable value</span><span>${inr(amt)}</span></div><div class="ret-total"><span>GST (${p.gst_pct}%)</span><span>${inr(gst)}</span></div><div class="ret-total g"><span>Debit to supplier</span><span>${inr(amt + gst)}</span></div>`;
}
async function savePurchaseReturn() {
  setErr('pr_err'); if (!PRET_CTX) return setErr('pr_err', 'Choose a purchase first.');
  const qty = Number(document.getElementById('pr_qty').value) || 0; if (!(qty > 0)) return setErr('pr_err', 'Enter the quantity being returned.');
  const reason = reasonValue('pr_reason'); if (reason.length < 3) return setErr('pr_err', 'Please give the reason for the return.');
  try {
    const r = await api('/purchase-returns', { method: 'POST', body: JSON.stringify({ purchase_id: PRET_CTX.purchase.id, return_date: document.getElementById('pr_date').value, qty, reason, remarks: document.getElementById('pr_remarks').value, refund_amount: Number(document.getElementById('pr_ref_amt').value) || 0, refund_mode: document.getElementById('pr_ref_mode').value, refund_reference: document.getElementById('pr_ref_ref').value, accept_now: !!(document.getElementById('pr_now') && document.getElementById('pr_now').checked) }) });
    closeModal(); showToast(r.status === 'Accepted' ? `${r.return_no} accepted — stock and accounts updated` : `${r.return_no} saved — waiting for approval`); purchRetFilter = r.status; goTo('purchaseReturns');
  } catch (e) { setErr('pr_err', e.message); }
}
async function printDebitNote(id) {
  const r = await api('/purchase-returns/' + id); const co = (typeof COMPANY !== 'undefined' && COMPANY) || {};
  const w = window.open('', '_blank'); if (!w) return showToast('Allow pop-ups to print');
  w.document.write(`<html><head><title>${r.return_no}</title><style>body{font-family:Arial;padding:28px;max-width:720px;margin:auto}table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #ddd;padding:7px;text-align:left}.r{text-align:right}</style></head><body>
    <h2>${retEsc(co.company_name || '')}</h2><div>${retEsc(co.address || '')} ${co.gst_no ? '· GSTIN ' + retEsc(co.gst_no) : ''}</div><h3 style="margin-top:20px;">DEBIT NOTE ${retEsc(r.return_no)}</h3>
    <p>Date: ${fmtDate(r.return_date)}<br>Supplier: <b>${retEsc(r.supplier_name)}</b><br>Against purchase: ${retEsc(r.purchase_no)}<br>Reason: ${retEsc(r.reason)}</p>
    <table><tr><th>Item</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr><tr><td>${retEsc(r.item_name)}</td><td class="r">${r.qty} ${retEsc(r.unit || '')}</td><td class="r">${Number(r.rate).toFixed(2)}</td><td class="r">${Number(r.amount).toFixed(2)}</td></tr>
    <tr><td colspan="3" class="r">GST ${r.gst_pct}%</td><td class="r">${Number(r.gst_amt).toFixed(2)}</td></tr><tr><td colspan="3" class="r"><b>Total debit</b></td><td class="r"><b>${Number(r.total).toFixed(2)}</b></td></tr></table>
    ${r.refund_amount > 0 ? `<p>Refund received from supplier: Rs. ${Number(r.refund_amount).toFixed(2)} (${retEsc(r.refund_mode)})</p>` : ''}<script>window.onload=()=>window.print()<\/script></body></html>`); w.document.close();
}

// Buttons on an invoice / purchase row call these. (They are deliberately not named "...Form(id)", because the app asks for the
// admin password before EDITING a record — raising a return is a normal action for sales and store staff.)
function openSalesReturnFor(invoiceId) { return openSalesReturnForm(invoiceId); }
function openPurchaseReturnFor(purchaseId) { return openPurchaseReturnForm(purchaseId); }
