// ============================================================================
// plan.js — (1) the pop-up that explains, in plain words, WHY something is blocked
//               (module not in the plan / plan expired = read-only / limit reached)
//           (2) the company admin's "Plan & Billing" page: current plan, validity,
//               usage, modules, buying / renewing, requests and billing history
// ============================================================================
const planEsc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const planDay = (s) => { if (!s) return '—'; const d = new Date(String(s).slice(0, 10) + 'T00:00:00Z'); return isNaN(d) ? planEsc(s) : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }); };

function showPlanPopup(data) {
  const sb = (ME && ME.subscription) || {}; const admin = ME && ME.role === 'ADMIN';
  const ct = sb.contact || {}; const contact = [ct.name, ct.email, ct.phone].filter(Boolean).join(' · ');
  let icon = '🔒', title, why, msg = data.error;
  if (data.read_only || sb.read_only) {
    icon = '⏳'; title = 'Your plan has expired — read-only mode';
    why = `Your ${planEsc(sb.plan_name || 'plan')} ${sb.is_trial ? 'trial ' : ''}ended on ${planDay(sb.expires_on)}. You can still sign in, view and export everything, but you cannot add or change anything until the plan is renewed. Nothing has been deleted.`;
    msg = msg && !/read-only because/.test(msg) ? msg : 'This action is not allowed while the plan is expired.';
  } else if (data.plan_limit) {
    icon = '📈'; title = 'Plan limit reached';
    why = 'Your plan allows only a fixed number of users, branches, invoices or storage. Upgrade the plan to add more.';
  } else {
    title = `${planEsc(data.module_label || 'This module')} is not part of your plan`;
    why = `Your ${planEsc(sb.plan_name || 'current')} plan${sb.is_trial ? ' (trial)' : ''} does not include ${planEsc(data.module_label || 'this module')}. ${sb.state === 'GRACE' || sb.state === 'READONLY' ? 'Your plan has also expired. ' : ''}Buy or upgrade a plan that includes it to start using it.`;
    msg = data.error ? data.error : `${planEsc(data.module_label || 'This module')} is not available on your current plan.`;
  }
  window.__planMsg = data.error || msg; window.__planMsgAt = Date.now();
  const old = document.getElementById('planPopup'); if (old) old.remove();
  const el = document.createElement('div'); el.id = 'planPopup'; el.className = 'plan-pop-bg';
  el.innerHTML = `<div class="plan-pop" role="alertdialog" aria-modal="true"><div class="pp-ic">${icon}</div><h3>${title}</h3><div class="pp-why">${why}</div>
    ${data.plan_limit && data.error ? `<p>${planEsc(data.error)}</p>` : ''}
    <p>${admin ? 'You are the company admin — you can request a plan from the <b>Plan &amp; Billing</b> page.' : 'Please ask your company admin to renew or upgrade the plan.'}${contact ? `<br>Platform support: ${planEsc(contact)}` : ''}</p>
    <div class="pp-act"><button class="btn btn-outline" id="ppClose">Close</button>${admin ? '<button class="btn btn-primary" id="ppGo">Plan &amp; Billing</button>' : ''}</div></div>`;
  document.body.appendChild(el);
  document.getElementById('ppClose').onclick = () => el.remove();
  const go = document.getElementById('ppGo'); if (go) go.onclick = () => { el.remove(); closeModal && closeModal(); goTo('myPlan'); };
  el.onclick = (e) => { if (e.target === el) el.remove(); };
}

// ---------------------------------------------------------------- Plan & Billing page
let PLAN_DATA = null;
async function renderMyPlan() {
  const d = await api('/subscription'); PLAN_DATA = d; const s = d.subscription;
  const stateBadge = { ACTIVE: ['badge-green', 'Active'], EXPIRING: ['badge-amber', 'Expiring soon'], GRACE: ['badge-red', 'Expired — grace period'], READONLY: ['badge-red', 'Expired — read-only'] }[s.state] || ['badge-blue', s.state];
  const lim = (v) => v == null ? 'Unlimited' : v;
  const meter = (label, used, limit) => { const pct = limit ? Math.min(100, Math.round(used / limit * 100)) : 0; return `<div><div style="display:flex;justify-content:space-between;font-size:13px;"><span>${label}</span><b>${used ?? 0} / ${lim(limit)}</b></div><div class="pl-meter ${limit && used > limit ? 'over' : limit && used >= limit ? 'warn' : ''}"><b style="width:${limit ? pct : 4}%"></b></div></div>`; };
  const u = s.usage || {}; const L = s.limits || {};
  const dayText = s.legacy ? 'No plan — unlimited, never expires' : s.expires_on ? (s.days_left >= 0 ? `${s.days_left} day${s.days_left === 1 ? '' : 's'} left` : `Expired ${-s.days_left} day${s.days_left === -1 ? '' : 's'} ago`) : 'No expiry date';
  document.getElementById('content').innerHTML = setHeaderBanner('myPlan', s.legacy ? '' : `<button class="btn btn-outline" onclick="openPlanRequest()">Buy / Renew plan</button>`) + `
    ${s.notice ? `<div class="auth-err" style="margin-bottom:12px;">${planEsc(s.notice.text)}</div>` : ''}
    <div class="panel"><div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;align-items:flex-start;">
      <div><div style="color:var(--muted);font-size:12.5px;">Current plan</div><div style="font-size:26px;font-weight:800;">${planEsc(s.plan_name)} ${s.is_trial ? '<small style="font-size:13px;color:var(--muted);">(trial)</small>' : ''}</div>
        <span class="badge ${stateBadge[0]}">${stateBadge[1]}</span> <span style="font-size:13px;margin-left:6px;">${dayText}</span></div>
      <div style="display:grid;grid-template-columns:auto auto;gap:4px 24px;font-size:13.5px;"><span style="color:var(--muted)">Started</span><b>${planDay(s.starts_on)}</b><span style="color:var(--muted)">Valid until</span><b>${s.expires_on ? planDay(s.expires_on) : 'No expiry'}</b>
        <span style="color:var(--muted)">Grace period</span><b>${s.grace_days} days after expiry</b><span style="color:var(--muted)">Price</span><b>${s.plan_price_monthly ? inr(s.plan_price_monthly) + ' / month' : (s.is_trial ? 'Free trial' : '—')}</b></div></div>
      <p style="font-size:12.5px;color:var(--muted);margin:12px 0 0;">After the expiry date you get ${s.grace_days} more days with everything working, then the account becomes <b>read-only</b> (you can sign in, view and export, but not add or change). Nothing is ever deleted.</p></div>
    <div class="panel"><h3 style="margin:0 0 10px;">Usage against your plan</h3><div class="pf-grid3" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;">${meter('Users', u.users, L.max_users)}${meter('Branches', u.branches, L.max_branches)}${meter('Invoices this month', u.invoices_month, L.max_invoices_month)}${meter('Storage (MB)', u.storage_mb, L.max_storage_mb)}</div>
      ${(s.warnings || []).map((w) => `<div class="auth-err" style="margin-top:10px;">${planEsc(w.text)}</div>`).join('')}</div>
    <div class="panel"><h3 style="margin:0 0 10px;">Modules in your plan</h3><div class="pl-mods">${d.modules.map((m) => `<div class="pl-mod ${m.included ? 'on' : 'off'}">${m.included ? '✓' : '🔒'} ${planEsc(m.label)}${m.included ? '' : '<br><small>Not in your plan</small>'}</div>`).join('')}</div></div>
    <div class="panel"><h3 style="margin:0 0 4px;">Plans you can buy</h3><p style="font-size:12.5px;color:var(--muted);margin:0 0 12px;">Choose a plan and the number of months. The platform owner confirms it after payment and your validity is extended automatically.</p>
      <div class="pl-grid">${d.plans.map((p) => `<div class="pl-card ${p.current ? 'current' : ''}"><div style="display:flex;justify-content:space-between;"><b style="font-size:16px;">${planEsc(p.name)}</b>${p.current ? '<span class="badge badge-blue">Your plan</span>' : ''}</div>
        <div class="pl-price">${inr(p.price_monthly)}<small style="font-size:12px;font-weight:500;color:var(--muted)"> / month</small></div>
        <ul><li>${lim(p.max_users)} users</li><li>${lim(p.max_branches)} branches</li><li>${lim(p.max_invoices_month)} invoices / month</li><li>${p.max_storage_mb == null ? 'Unlimited' : p.max_storage_mb + ' MB'} storage</li><li>${p.modules.length >= d.modules.length ? 'All modules' : p.modules.length + ' of ' + d.modules.length + ' modules'}</li></ul>
        <button class="btn ${p.current ? 'btn-outline' : 'btn-primary'}" onclick="openPlanRequest('${p.code}')">${p.current ? 'Renew this plan' : 'Choose ' + planEsc(p.name)}</button></div>`).join('') || '<div style="color:var(--muted)">No plans are on offer yet — please contact support.</div>'}</div></div>
    ${d.requests.length ? `<div class="panel"><h3 style="margin:0 0 8px;">My requests</h3><table><thead><tr><th>Date</th><th>Request</th><th>Status</th><th>Note</th></tr></thead><tbody>${d.requests.map((r) => `<tr><td>${planEsc(String(r.created_at).slice(0, 10))}</td><td>${r.kind === 'RENEW' ? 'Renew' : r.kind === 'UPGRADE' ? 'Change to' : 'Buy'} ${planEsc(r.plan_code)} · ${r.months} month(s)</td><td><span class="badge ${r.status === 'APPROVED' ? 'badge-green' : r.status === 'REJECTED' ? 'badge-red' : 'badge-amber'}">${r.status === 'PENDING' ? 'Waiting for owner' : r.status}</span></td><td>${planEsc(r.review_note || r.note || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${d.billing.length ? `<div class="panel"><h3 style="margin:0 0 8px;">Billing history</h3><table><thead><tr><th>Date</th><th>For</th><th>Amount</th><th>Due</th><th>Status</th></tr></thead><tbody>${d.billing.map((b) => `<tr><td>${planDay(b.issued_on)}</td><td>${planEsc(b.description)}</td><td>${inr(b.amount)}</td><td>${planDay(b.due_on)}</td><td><span class="badge ${b.status === 'PAID' ? 'badge-green' : b.status === 'OVERDUE' ? 'badge-red' : b.status === 'VOID' ? 'badge-violet' : 'badge-amber'}">${b.status}</span>${b.paid_on ? `<br><small>${planDay(b.paid_on)}</small>` : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <div class="panel"><h3 style="margin:0 0 6px;">Payment &amp; support</h3>${d.payment_instructions ? `<p style="white-space:pre-line;font-size:13.5px;">${planEsc(d.payment_instructions)}</p>` : '<p style="font-size:13.5px;color:var(--muted);">Contact the platform owner to pay for your plan.</p>'}
      <p style="font-size:13.5px;margin:6px 0 0;">${[d.contact && d.contact.name, d.contact && d.contact.email, d.contact && d.contact.phone].filter(Boolean).map(planEsc).join(' · ') || ''}</p></div>`;
}
function openPlanRequest(code) {
  const d = PLAN_DATA; const cur = d.plans.find((p) => p.current) || d.plans[0]; const sel = d.plans.find((p) => p.code === code) || cur; if (!sel) return showToast('No plans are available yet.');
  document.getElementById('modalBox').innerHTML = `<div class="modal-head"><h3>Buy / renew a plan</h3><button class="modal-close" onclick="closeModal()">×</button></div><div class="modal-body">
    <div class="form-grid"><div class="form-field"><label>Plan</label><select id="pq_plan" onchange="paintPlanTotal()">${d.plans.map((p) => `<option value="${p.code}" ${p.code === sel.code ? 'selected' : ''}>${planEsc(p.name)} — ${inr(p.price_monthly)}/month</option>`).join('')}</select></div>
      <div class="form-field"><label>For how long</label><select id="pq_months" onchange="paintPlanTotal()">${d.months.map((m) => `<option value="${m}" ${m === 12 ? 'selected' : ''}>${m} month${m > 1 ? 's' : ''}</option>`).join('')}</select></div>
      <div class="form-field"><label>Email for confirmation</label><input id="pq_mail" type="email" value="${planEsc(d.admin_email || '')}"></div>
      <div class="form-field"><label>Note (optional)</label><input id="pq_note" placeholder="e.g. payment reference"></div></div>
    <div id="pq_total" style="margin:10px 0;font-size:15px;"></div>
    ${d.payment_instructions ? `<div class="pp-why" style="background:#EAF0FE;color:#223A7A;border-radius:10px;padding:10px 12px;font-size:13px;white-space:pre-line;"><b>How to pay</b><br>${planEsc(d.payment_instructions)}</div>` : ''}
    <p style="font-size:12.5px;color:var(--muted);">Your request goes to the platform owner. Once your payment is confirmed they approve it and your plan and validity update automatically.</p><div id="pq_err" class="auth-err" style="min-height:0;"></div></div>
    <div class="modal-foot"><button class="btn btn-outline" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="sendPlanRequest()">Send request</button></div>`;
  document.getElementById('modalBg').classList.add('show'); paintPlanTotal();
}
function paintPlanTotal() { const p = PLAN_DATA.plans.find((x) => x.code === document.getElementById('pq_plan').value); const m = Number(document.getElementById('pq_months').value); document.getElementById('pq_total').innerHTML = `Amount: <b>${inr(p.price_monthly * m)}</b> <span style="color:var(--muted);font-size:12.5px;">(${inr(p.price_monthly)} × ${m} month${m > 1 ? 's' : ''})</span>`; }
async function sendPlanRequest() {
  const err = document.getElementById('pq_err'); err.textContent = '';
  try { const r = await api('/subscription/request', { method: 'POST', body: JSON.stringify({ plan_code: document.getElementById('pq_plan').value, months: Number(document.getElementById('pq_months').value), note: document.getElementById('pq_note').value, contact_email: document.getElementById('pq_mail').value }) }); closeModal(); showToast(r.message); renderMyPlan(); }
  catch (e) { err.textContent = e.message; }
}
