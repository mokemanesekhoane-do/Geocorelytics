// ================================================================
// Chart layer
//
// Dependency-free SVG charts. Every function takes plain {x, y} data and
// returns markup; hover/tooltip behaviour is attached by wireChart() once the
// markup is in the DOM. Kept deliberately dumb — all aggregation happens
// server-side in analytics.js — so a chart never disagrees with a figure.
//
// Palette: the validated categorical order (blue, orange, aqua, yellow,
// magenta, green, violet, red) assigned in fixed slot order and never cycled.
// Aqua/yellow/magenta sit under 3:1 on white, so every chart ships a legend
// plus a tooltip and table view — identity and value are never colour-alone.
// All-pairs forms (the depth profile) are capped at 3 series, which is the
// documented safe limit for this order.
// ================================================================

// Dark steps of the same eight hues, validated against the navy panel
// (#0d1f3a): all eight clear 3:1 there, worst adjacent CVD ΔE 8.4 and
// normal-vision ΔE 19.3. The light-mode steps were re-checked on this
// surface first and failed — violet fell to 2.2:1 — so they are not reused.
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const STATUS = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b', info: '#3987e5' };
const INK = { primary: '#eaf2fb', secondary: '#b3c1d6', muted: '#8296b3', grid: '#16325c', axis: '#1d4172' };
const SURFACE = '#0d1f3a';

let chartSeq = 0;
const chartData = new Map();

function seriesColor(i) {
  return SERIES[i % SERIES.length];
}

function escXml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Clean axis ticks: 1/2/5 × 10ⁿ so labels land on round numbers.
function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks;
}

function fmtNum(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toFixed(2)));
}

function shortDate(d) {
  if (!d) return '';
  const parts = String(d).split('-');
  return parts.length === 3 ? `${parts[2]}/${parts[1]}` : String(d);
}

function legendHtml(items) {
  // Always present for 2+ series — identity must never rest on colour alone.
  if (items.length < 2) return '';
  return `<div class="chart-legend">${items
    .map((it) => `<span class="chart-legend-item"><span class="chart-swatch" style="background:${it.color}"></span>${escXml(it.label)}</span>`)
    .join('')}</div>`;
}

function tableToggleHtml(id) {
  return `<button type="button" class="chart-table-toggle" data-chart-table="${id}">Table view</button>`;
}

function tableHtml(id, columns, rows) {
  return `<div class="chart-table hidden" id="chart-table-${id}">
    <table class="data-table"><thead><tr>${columns.map((c) => `<th>${escXml(c)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${escXml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>
  </div>`;
}

function emptyChart(message) {
  return `<div class="chart-empty">${escXml(message)}</div>`;
}

function chartFrame(id, inner, { legend = '', table = '', footnote = '' } = {}) {
  return `<div class="chart" data-chart-id="${id}">
    ${legend}
    <div class="chart-canvas">${inner}<div class="chart-tooltip hidden" id="chart-tip-${id}"></div></div>
    ${footnote ? `<div class="chart-foot">${escXml(footnote)}</div>` : ''}
    <div class="chart-actions">${table ? tableToggleHtml(id) : ''}</div>
    ${table}
  </div>`;
}

// ---------- Line chart (single or multi series, time on x) ----------

function lineChart(series, opts = {}) {
  const id = `c${++chartSeq}`;
  const clean = series.filter((s) => s.points && s.points.length);
  if (!clean.length) return emptyChart(opts.empty || 'No data captured yet.');

  const W = 720, H = opts.height || 240;
  const M = { top: 16, right: 54, bottom: 30, left: 46 };
  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;

  const xs = clean[0].points.map((p) => p.x);
  const maxY = Math.max(...clean.flatMap((s) => s.points.map((p) => Number(p.y) || 0)), 0);
  const ticks = niceTicks(maxY || 1);
  const top = ticks[ticks.length - 1] || 1;
  const px = (i, n) => M.left + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const py = (v) => M.top + ih - ((Number(v) || 0) / top) * ih;

  const grid = ticks
    .map((t) => `<line x1="${M.left}" y1="${py(t)}" x2="${M.left + iw}" y2="${py(t)}" stroke="${INK.grid}" stroke-width="1"/>
      <text x="${M.left - 8}" y="${py(t) + 4}" text-anchor="end" font-size="11" fill="${INK.muted}" style="font-variant-numeric:tabular-nums">${fmtNum(t)}</text>`)
    .join('');

  const everyN = Math.max(1, Math.ceil(xs.length / 8));
  const xLabels = xs
    .map((x, i) => (i % everyN === 0 || i === xs.length - 1
      ? `<text x="${px(i, xs.length)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="${INK.muted}">${escXml(opts.xFormat ? opts.xFormat(x) : shortDate(x))}</text>`
      : ''))
    .join('');

  const paths = clean
    .map((s, si) => {
      const color = s.color || seriesColor(si);
      const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${px(i, s.points.length).toFixed(1)},${py(p.y).toFixed(1)}`).join(' ');
      const area = s.area
        ? `<path d="${d} L${px(s.points.length - 1, s.points.length).toFixed(1)},${M.top + ih} L${px(0, s.points.length).toFixed(1)},${M.top + ih} Z" fill="${color}" opacity="0.1"/>`
        : '';
      const dashed = s.dashed ? ' stroke-dasharray="6 4"' : '';
      const last = s.points[s.points.length - 1];
      // End-dot carries a 2px surface ring so it stays legible where series cross.
      const endDot = `<circle cx="${px(s.points.length - 1, s.points.length)}" cy="${py(last.y)}" r="4.5" fill="${color}" stroke="${SURFACE}" stroke-width="2"/>`;
      const endLabel = `<text x="${px(s.points.length - 1, s.points.length) + 9}" y="${py(last.y) + 4}" font-size="11" font-weight="600" fill="${INK.secondary}" style="font-variant-numeric:tabular-nums">${fmtNum(last.y)}</text>`;
      return `${area}<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${dashed}/>${endDot}${endLabel}`;
    })
    .join('');

  // One hover band per x position drives the crosshair + tooltip.
  const bands = xs
    .map((x, i) => {
      const bw = iw / Math.max(1, xs.length - 1 || 1);
      return `<rect class="chart-band" data-i="${i}" x="${px(i, xs.length) - bw / 2}" y="${M.top}" width="${bw}" height="${ih}" fill="transparent"/>`;
    })
    .join('');

  chartData.set(id, {
    type: 'line',
    xs,
    series: clean.map((s, si) => ({ label: s.label, color: s.color || seriesColor(si), points: s.points })),
    geom: { M, iw, ih, px: (i) => px(i, xs.length), py },
    xFormat: opts.xFormat,
    unit: opts.unit || '',
    onSelect: opts.onSelect,
  });

  const legend = legendHtml(clean.map((s, si) => ({ label: s.label, color: s.color || seriesColor(si) })));
  const table = tableHtml(
    id,
    [opts.xLabel || 'Date', ...clean.map((s) => s.label)],
    xs.map((x, i) => [opts.xFormat ? opts.xFormat(x) : x, ...clean.map((s) => fmtNum(s.points[i]?.y))])
  );

  const svg = `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="${escXml(opts.ariaLabel || opts.title || 'Line chart')}">
    ${grid}${xLabels}
    <line class="chart-crosshair hidden" y1="${M.top}" y2="${M.top + ih}" stroke="${INK.axis}" stroke-width="1"/>
    ${paths}
    <line x1="${M.left}" y1="${M.top + ih}" x2="${M.left + iw}" y2="${M.top + ih}" stroke="${INK.axis}" stroke-width="1"/>
    ${bands}
  </svg>`;

  return chartFrame(id, svg, { legend, table, footnote: opts.footnote });
}

// ---------- Bar chart (horizontal categories) ----------

function barChart(points, opts = {}) {
  const id = `c${++chartSeq}`;
  if (!points || !points.length) return emptyChart(opts.empty || 'No data captured yet.');

  const rowH = 30;
  const W = 720;
  const M = { top: 6, right: 70, bottom: 6, left: opts.labelWidth || 150 };
  const H = M.top + M.bottom + points.length * rowH;
  const iw = W - M.left - M.right;
  const max = Math.max(...points.map((p) => Number(p.y) || 0), 0) || 1;

  const bars = points
    .map((p, i) => {
      const y = M.top + i * rowH;
      const w = Math.max(0, ((Number(p.y) || 0) / max) * iw);
      const color = p.color || opts.color || seriesColor(0);
      const barH = Math.min(24, rowH - 8);
      const label = escXml(p.x);
      // 4px rounded data-end, square at the baseline.
      const r = Math.min(4, w);
      const d = w <= 0
        ? ''
        : `M${M.left},${y + (rowH - barH) / 2} h${Math.max(0, w - r)} a${r},${r} 0 0 1 ${r},${r} v${barH - 2 * r} a${r},${r} 0 0 1 ${-r},${r} h${-Math.max(0, w - r)} Z`;
      return `<g class="chart-bar-row" data-i="${i}">
        <text x="${M.left - 10}" y="${y + rowH / 2 + 4}" text-anchor="end" font-size="12" fill="${INK.secondary}">${label.length > 24 ? label.slice(0, 23) + '…' : label}</text>
        ${d ? `<path d="${d}" fill="${color}"/>` : ''}
        <text x="${M.left + w + 8}" y="${y + rowH / 2 + 4}" font-size="12" font-weight="600" fill="${INK.secondary}" style="font-variant-numeric:tabular-nums">${fmtNum(p.y)}${escXml(opts.unit || '')}</text>
        <rect class="chart-hit" data-i="${i}" x="${M.left}" y="${y}" width="${iw}" height="${rowH}" fill="transparent"/>
      </g>`;
    })
    .join('');

  chartData.set(id, { type: 'bar', points, unit: opts.unit || '', onSelect: opts.onSelect, tooltip: opts.tooltip });

  const table = tableHtml(id, [opts.xLabel || 'Category', opts.yLabel || 'Value'], points.map((p) => [p.x, `${fmtNum(p.y)}${opts.unit || ''}`]));
  const svg = `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="${escXml(opts.ariaLabel || opts.title || 'Bar chart')}">${bars}</svg>`;
  return chartFrame(id, svg, { table, footnote: opts.footnote });
}

// ---------- Column chart with optional overlay line ----------

function columnChart(points, opts = {}) {
  const id = `c${++chartSeq}`;
  if (!points || !points.length) return emptyChart(opts.empty || 'No data captured yet.');

  const W = 720, H = opts.height || 230;
  const M = { top: 16, right: 46, bottom: 32, left: 46 };
  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;
  const max = Math.max(...points.map((p) => Number(p.y) || 0), 0) || 1;
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;

  const slot = iw / points.length;
  const barW = Math.min(24, slot - 6); // cap thickness; leftover slot is air
  const py = (v) => M.top + ih - ((Number(v) || 0) / top) * ih;

  const grid = ticks
    .map((t) => `<line x1="${M.left}" y1="${py(t)}" x2="${M.left + iw}" y2="${py(t)}" stroke="${INK.grid}" stroke-width="1"/>
      <text x="${M.left - 8}" y="${py(t) + 4}" text-anchor="end" font-size="11" fill="${INK.muted}" style="font-variant-numeric:tabular-nums">${fmtNum(t)}</text>`)
    .join('');

  const color = opts.color || seriesColor(0);
  const cols = points
    .map((p, i) => {
      const cx = M.left + slot * i + slot / 2;
      const h = Math.max(0, M.top + ih - py(p.y));
      const r = Math.min(4, barW / 2, h);
      const x = cx - barW / 2;
      const y = py(p.y);
      const d = h <= 0 ? '' : `M${x},${y + h} v${-(h - r)} a${r},${r} 0 0 1 ${r},${-r} h${barW - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - r} Z`;
      return `${d ? `<path d="${d}" fill="${color}"/>` : ''}
        <rect class="chart-hit" data-i="${i}" x="${M.left + slot * i}" y="${M.top}" width="${slot}" height="${ih}" fill="transparent"/>`;
    })
    .join('');

  const everyN = Math.max(1, Math.ceil(points.length / 9));
  const xLabels = points
    .map((p, i) => (i % everyN === 0 || i === points.length - 1
      ? `<text x="${M.left + slot * i + slot / 2}" y="${H - 10}" text-anchor="middle" font-size="11" fill="${INK.muted}">${escXml(opts.xFormat ? opts.xFormat(p.x) : shortDate(p.x))}</text>`
      : ''))
    .join('');

  // Optional cumulative overlay — same unit, same axis (never a second scale).
  let overlay = '';
  let legend = '';
  if (opts.overlay) {
    const oMax = Math.max(...points.map((p) => Number(p[opts.overlay.key]) || 0), 0) || 1;
    const oTop = Math.max(top, oMax);
    const oy = (v) => M.top + ih - ((Number(v) || 0) / oTop) * ih;
    const oColor = opts.overlay.color || seriesColor(1);
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${(M.left + slot * i + slot / 2).toFixed(1)},${oy(p[opts.overlay.key]).toFixed(1)}`).join(' ');
    const last = points[points.length - 1];
    overlay = `<path d="${d}" fill="none" stroke="${oColor}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${M.left + slot * (points.length - 1) + slot / 2}" cy="${oy(last[opts.overlay.key])}" r="4.5" fill="${oColor}" stroke="${SURFACE}" stroke-width="2"/>`;
    legend = legendHtml([{ label: opts.yLabel || 'Value', color }, { label: opts.overlay.label, color: oColor }]);
  }

  chartData.set(id, { type: 'column', points, unit: opts.unit || '', onSelect: opts.onSelect, tooltip: opts.tooltip });

  const table = tableHtml(
    id,
    [opts.xLabel || 'Date', opts.yLabel || 'Value', ...(opts.overlay ? [opts.overlay.label] : [])],
    points.map((p) => [opts.xFormat ? opts.xFormat(p.x) : p.x, `${fmtNum(p.y)}${opts.unit || ''}`, ...(opts.overlay ? [`${fmtNum(p[opts.overlay.key])}${opts.unit || ''}`] : [])])
  );

  const svg = `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="${escXml(opts.ariaLabel || opts.title || 'Column chart')}">
    ${grid}${cols}${overlay}${xLabels}
    <line x1="${M.left}" y1="${M.top + ih}" x2="${M.left + iw}" y2="${M.top + ih}" stroke="${INK.axis}" stroke-width="1"/>
  </svg>`;
  return chartFrame(id, svg, { legend, table, footnote: opts.footnote });
}

// ---------- Downhole profile (stacked counts per depth band) ----------
//
// Capped at 3 series: this is an all-pairs comparison (any band may put any
// two series side by side), and 3 is the validated all-pairs limit for this
// palette order. Extra series fold into "Other".

function depthProfileChart(dist, opts = {}) {
  const id = `c${++chartSeq}`;
  if (!dist || !dist.points || !dist.points.length) return emptyChart(opts.empty || 'No samples or tests recorded yet.');

  const MAX_SERIES = 3;
  let names = dist.series.slice();
  let folded = null;
  if (names.length > MAX_SERIES) {
    folded = names.slice(MAX_SERIES - 1);
    names = names.slice(0, MAX_SERIES - 1).concat('Other');
  }
  const countFor = (counts, name) =>
    name === 'Other' && folded ? folded.reduce((a, k) => a + (counts[k] || 0), 0) : counts[name] || 0;

  const rowH = 26;
  const W = 720;
  const M = { top: 6, right: 60, bottom: 6, left: 84 };
  const H = M.top + M.bottom + dist.points.length * rowH;
  const iw = W - M.left - M.right;
  const max = Math.max(...dist.points.map((p) => names.reduce((a, n) => a + countFor(p.counts, n), 0)), 1);

  const rows = dist.points
    .map((p, i) => {
      const y = M.top + i * rowH;
      const barH = Math.min(20, rowH - 6);
      let cursor = M.left;
      const segs = names
        .map((n, si) => {
          const v = countFor(p.counts, n);
          if (!v) return '';
          const w = (v / max) * iw;
          const x = cursor;
          cursor += w;
          // 2px surface gap separates touching segments.
          const drawW = Math.max(0, w - 2);
          return `<rect x="${x}" y="${y + (rowH - barH) / 2}" width="${drawW}" height="${barH}" rx="2" fill="${seriesColor(si)}"/>`;
        })
        .join('');
      const total = names.reduce((a, n) => a + countFor(p.counts, n), 0);
      return `<g><text x="${M.left - 10}" y="${y + rowH / 2 + 4}" text-anchor="end" font-size="11" fill="${INK.secondary}" style="font-variant-numeric:tabular-nums">${escXml(p.label)}</text>
        ${segs}
        <text x="${cursor + 8}" y="${y + rowH / 2 + 4}" font-size="11" font-weight="600" fill="${INK.secondary}" style="font-variant-numeric:tabular-nums">${total}</text>
        <rect class="chart-hit" data-i="${i}" x="${M.left}" y="${y}" width="${iw}" height="${rowH}" fill="transparent"/></g>`;
    })
    .join('');

  chartData.set(id, {
    type: 'depth',
    points: dist.points.map((p) => ({ ...p, _names: names, _folded: folded })),
    names,
    folded,
    onSelect: opts.onSelect,
  });

  const legend = legendHtml(names.map((n, i) => ({ label: n, color: seriesColor(i) })));
  const table = tableHtml(
    id,
    ['Depth band', ...names, 'Total'],
    dist.points.map((p) => [
      p.label,
      ...names.map((n) => String(countFor(p.counts, n))),
      String(names.reduce((a, n) => a + countFor(p.counts, n), 0)),
    ])
  );
  const svg = `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="${escXml(opts.ariaLabel || 'Sample and test distribution by depth')}">${rows}</svg>`;
  return chartFrame(id, svg, {
    legend,
    table,
    footnote: folded ? `"Other" groups ${folded.join(', ')}.` : opts.footnote,
  });
}

// ---------- Progress meter ----------

function progressMeter(pct, opts = {}) {
  const value = pct === null || pct === undefined ? null : Math.max(0, Math.min(100, Number(pct)));
  if (value === null) return `<div class="meter-empty">${escXml(opts.empty || 'No target depth set')}</div>`;
  // Fill carries severity; the track is a lighter step of the same ramp.
  const color = value >= 100 ? STATUS.good : value >= 60 ? '#2a78d6' : value >= 30 ? '#eda100' : '#eb6834';
  return `<div class="meter" role="img" aria-label="${escXml(opts.label || 'Progress')}: ${value.toFixed(0)} percent">
    <div class="meter-track"><div class="meter-fill" style="width:${value}%;background:${color}"></div></div>
    <div class="meter-caption"><span>${escXml(opts.label || '')}</span><strong>${value.toFixed(0)}%</strong></div>
  </div>`;
}

// ---------- Interaction wiring ----------

function wireCharts(root) {
  root = root || document;

  root.querySelectorAll('[data-chart-table]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tbl = document.getElementById(`chart-table-${btn.dataset.chartTable}`);
      if (!tbl) return;
      const showing = !tbl.classList.contains('hidden');
      tbl.classList.toggle('hidden', showing);
      btn.textContent = showing ? 'Table view' : 'Hide table';
    });
  });

  root.querySelectorAll('.chart').forEach((el) => {
    const id = el.dataset.chartId;
    const cfg = chartData.get(id);
    if (!cfg) return;
    const tip = el.querySelector(`#chart-tip-${id}`);
    const svg = el.querySelector('svg');
    if (!tip || !svg) return;

    const show = (html, clientX, clientY) => {
      tip.innerHTML = html;
      tip.classList.remove('hidden');
      const box = el.querySelector('.chart-canvas').getBoundingClientRect();
      let left = clientX - box.left + 12;
      const tipW = tip.offsetWidth || 180;
      if (left + tipW > box.width) left = clientX - box.left - tipW - 12;
      tip.style.left = `${Math.max(0, left)}px`;
      tip.style.top = `${Math.max(0, clientY - box.top + 12)}px`;
    };
    const hide = () => tip.classList.add('hidden');

    if (cfg.type === 'line') {
      const crosshair = svg.querySelector('.chart-crosshair');
      svg.querySelectorAll('.chart-band').forEach((band) => {
        band.addEventListener('mousemove', (e) => {
          const i = Number(band.dataset.i);
          const label = cfg.xFormat ? cfg.xFormat(cfg.xs[i]) : cfg.xs[i];
          const rows = cfg.series
            .map((s) => `<div class="tip-row"><span class="chart-swatch" style="background:${s.color}"></span>${escXml(s.label)}<strong>${fmtNum(s.points[i]?.y)}${escXml(cfg.unit)}</strong></div>`)
            .join('');
          show(`<div class="tip-title">${escXml(label)}</div>${rows}`, e.clientX, e.clientY);
          if (crosshair) {
            const x = cfg.geom.px(i);
            crosshair.setAttribute('x1', x);
            crosshair.setAttribute('x2', x);
            crosshair.classList.remove('hidden');
          }
        });
        band.addEventListener('mouseleave', () => {
          hide();
          if (crosshair) crosshair.classList.add('hidden');
        });
        if (cfg.onSelect) {
          band.style.cursor = 'pointer';
          band.addEventListener('click', () => cfg.onSelect(cfg.xs[Number(band.dataset.i)], Number(band.dataset.i)));
        }
      });
    } else {
      svg.querySelectorAll('.chart-hit').forEach((hit) => {
        hit.addEventListener('mousemove', (e) => {
          const i = Number(hit.dataset.i);
          const p = cfg.points[i];
          if (!p) return;
          let html;
          if (cfg.type === 'depth') {
            const rows = cfg.names
              .map((n, si) => {
                const v = n === 'Other' && cfg.folded ? cfg.folded.reduce((a, k) => a + (p.counts[k] || 0), 0) : p.counts[n] || 0;
                return v ? `<div class="tip-row"><span class="chart-swatch" style="background:${seriesColor(si)}"></span>${escXml(n)}<strong>${v}</strong></div>` : '';
              })
              .join('');
            html = `<div class="tip-title">${escXml(p.label)}</div>${rows || '<div class="tip-row">No records</div>'}`;
          } else if (cfg.tooltip) {
            html = cfg.tooltip(p);
          } else {
            html = `<div class="tip-title">${escXml(p.x)}</div><div class="tip-row"><strong>${fmtNum(p.y)}${escXml(cfg.unit)}</strong></div>`;
          }
          show(html, e.clientX, e.clientY);
        });
        hit.addEventListener('mouseleave', hide);
        if (cfg.onSelect) {
          hit.style.cursor = 'pointer';
          hit.addEventListener('click', () => cfg.onSelect(cfg.points[Number(hit.dataset.i)], Number(hit.dataset.i)));
        }
      });
    }
  });
}
