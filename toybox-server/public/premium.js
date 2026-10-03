// ============================================================================
// premium.js — small visual effects for the whole app (no data logic)
//   * ripple on buttons   * numbers on stat cards count up   * top bar gains a
//   shadow when you scroll   * nicer chart defaults   * respects "reduce motion"
// ============================================================================
(function () {
  'use strict';
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- ripple on every button -------------------------------------------------
  if (!reduce) document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest && e.target.closest('.btn'); if (!b || b.disabled) return;
    const r = b.getBoundingClientRect(); const d = Math.max(r.width, r.height);
    const s = document.createElement('span'); s.className = 'ripple';
    s.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
    b.appendChild(s); setTimeout(() => s.remove(), 650);
  }, { passive: true });

  // ---- top bar shadow on scroll ------------------------------------------------
  const onScroll = () => { const t = document.getElementById('topbar'); if (t) t.classList.toggle('scrolled', window.scrollY > 6); };
  window.addEventListener('scroll', onScroll, { passive: true }); onScroll();

  // ---- count-up for stat numbers ----------------------------------------------
  const NUM = /^(\D*?)(-?\d[\d,]*(?:\.\d+)?)(\D*)$/;
  function countUp(el) {
    if (reduce || el.dataset.cu || el.children.length) return; el.dataset.cu = '1';
    const text = el.textContent.trim(); const m = text.match(NUM); if (!m) return;
    const target = Number(m[2].replace(/,/g, '')); if (!isFinite(target) || Math.abs(target) < 10) return;
    const dec = (m[2].split('.')[1] || '').length; const indian = /,\d{2},\d{3}/.test(m[2]) || /₹/.test(m[1]);
    const fmt = (v) => v.toLocaleString(indian ? 'en-IN' : 'en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    const t0 = performance.now(), dur = 900;
    const step = (t) => { const p = Math.min(1, (t - t0) / dur); const e = 1 - Math.pow(1 - p, 3); el.textContent = m[1] + fmt(target * e) + m[3]; if (p < 1) requestAnimationFrame(step); else el.textContent = text; };
    requestAnimationFrame(step);
  }
  const scan = (root) => (root.querySelectorAll ? root.querySelectorAll('.stat-num,.kpi .n,.pipe-stage .qty') : []).forEach(countUp);
  function watch() {
    const host = document.getElementById('content'); if (!host) return;
    new MutationObserver((muts) => muts.forEach((m) => m.addedNodes.forEach((n) => { if (n.nodeType === 1) { scan(n); if (n.matches && n.matches('.stat-num,.kpi .n,.pipe-stage .qty')) countUp(n); } }))).observe(host, { childList: true, subtree: true });
    scan(host);
  }

  // ---- charts -------------------------------------------------------------------
  function chartDefaults() {
    if (!window.Chart || !Chart.defaults) return;
    try {
      const d = Chart.defaults; d.font.family = "'Inter','Segoe UI',system-ui,sans-serif"; d.font.size = 12; d.color = '#6A7494';
      d.animation = { duration: reduce ? 0 : 1000, easing: 'easeOutQuart' };
      d.elements.bar.borderRadius = 8; d.elements.bar.borderSkipped = false; d.elements.line.tension = 0.38; d.elements.line.borderWidth = 3; d.elements.point.radius = 3; d.elements.point.hoverRadius = 6;
      d.plugins.legend.labels.usePointStyle = true; d.plugins.legend.labels.boxWidth = 8; d.plugins.legend.labels.padding = 14;
      d.plugins.tooltip.backgroundColor = 'rgba(21,26,51,.94)'; d.plugins.tooltip.padding = 11; d.plugins.tooltip.cornerRadius = 12; d.plugins.tooltip.titleFont = { weight: '700' }; d.plugins.tooltip.boxPadding = 5;
      if (d.scale && d.scale.grid) d.scale.grid.color = 'rgba(120,130,170,.14)';
    } catch (_) { /* cosmetic only */ }
  }
  document.addEventListener('DOMContentLoaded', () => { chartDefaults(); watch(); });
  if (document.readyState !== 'loading') { chartDefaults(); watch(); }
})();
