// ================================================================
// Analytics page + vocabulary administration
//
// One filter bar drives every chart: the filters go to /api/analytics and the
// whole page re-renders from that single response, so a figure and a graph can
// never disagree. Clicking a completion row drills through to the borehole.
// ================================================================

const analyticsState = {
  project_id: '',
  borehole_id: '',
  rig: '',
  operator: '',
  shift: '',
  drilling_method: '',
  sample_type: '',
  test_type: '',
  date_from: '',
  date_to: '',
};

const SEV_CLASS = { critical: 'is-critical', serious: 'is-serious', warning: 'is-warn', info: 'is-info' };

function analyticsQuery() {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(analyticsState)) if (v) params.set(k, v);
  return params.toString();
}

function filterSelect(name, label, options, selected, valueKey, labelKey) {
  return `<div class="filter-item">
    <label>${esc(label)}</label>
    <select data-filter="${name}">
      <option value="">All</option>
      ${options
        .map((o) => {
          const value = valueKey ? o[valueKey] : o;
          const text = labelKey ? o[labelKey] : o;
          return `<option value="${esc(value)}" ${String(value) === String(selected) ? 'selected' : ''}>${esc(text)}</option>`;
        })
        .join('')}
    </select>
  </div>`;
}

async function renderAnalyticsPage() {
  setBreadcrumb([{ label: 'Analytics', href: '#/analytics' }]);
  appEl.innerHTML = `<div class="empty-state">Loading analytics&hellip;</div>`;

  const [a, projects] = await Promise.all([
    api('GET', `/api/analytics?${analyticsQuery()}`),
    api('GET', '/api/projects'),
  ]);
  const boreholes = analyticsState.project_id
    ? await api('GET', `/api/projects/${analyticsState.project_id}/boreholes`)
    : [];

  const h = a.headline;
  const pva = a.plannedVsActual;

  appEl.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Analytics</h1>
        <p class="subtitle">Live analysis of captured drilling, sampling and testing data</p>
      </div>
      <div class="actions-cell"><button id="reset-filters">Reset filters</button></div>
    </div>

    <div class="filter-bar">
      ${filterSelect('project_id', 'Project', projects, analyticsState.project_id, 'id', 'name')}
      ${filterSelect('borehole_id', 'Borehole', boreholes, analyticsState.borehole_id, 'id', 'code')}
      ${filterSelect('rig', 'Rig', a.dimensions.rigs, analyticsState.rig)}
      ${filterSelect('operator', 'Operator', a.dimensions.operators, analyticsState.operator)}
      ${filterSelect('shift', 'Shift', a.dimensions.shifts, analyticsState.shift)}
      ${filterSelect('drilling_method', 'Method', a.dimensions.methods, analyticsState.drilling_method)}
      ${filterSelect('sample_type', 'Sample type', lookupValues('sample_type'), analyticsState.sample_type)}
      ${filterSelect('test_type', 'Test type', lookupValues('test_type'), analyticsState.test_type)}
      <div class="filter-item"><label>From</label><input type="date" data-filter="date_from" value="${esc(analyticsState.date_from)}" /></div>
      <div class="filter-item"><label>To</label><input type="date" data-filter="date_to" value="${esc(analyticsState.date_to)}" /></div>
    </div>

    <div class="hero-figure">
      <span class="hero-label">Total metres drilled</span>
      <span class="hero-value">${h.total_metres ?? 0}<span class="hero-unit"> m</span></span>
      <span class="hero-sub">${h.total_runs} run(s) across ${h.drilling_days} drilling day(s)${
        pva.variance !== null && pva.variance !== undefined
          ? ` &middot; <strong class="${pva.on_track ? 'delta-good' : 'delta-bad'}">${pva.variance >= 0 ? '+' : ''}${pva.variance} m vs plan</strong>`
          : ''
      }</span>
    </div>

    <div class="stat-row">
      <div class="mini-stat"><span class="mini-label">Avg / day</span><strong>${h.avg_metres_per_day ?? '—'} m</strong></div>
      <div class="mini-stat"><span class="mini-label">Avg / run</span><strong>${h.avg_metres_per_run ?? '—'} m</strong></div>
      <div class="mini-stat"><span class="mini-label">Core recovery</span><strong>${h.core_recovery_pct ?? '—'}%</strong></div>
      <div class="mini-stat"><span class="mini-label">Downtime</span><strong>${h.total_downtime_hours ?? 0} h${h.downtime_pct !== null ? ` (${h.downtime_pct}%)` : ''}</strong></div>
      <div class="mini-stat"><span class="mini-label">Samples</span><strong>${h.total_samples}</strong></div>
      <div class="mini-stat"><span class="mini-label">Sample freq.</span><strong>${h.sample_frequency_per_100m ?? '—'} /100 m</strong></div>
      <div class="mini-stat"><span class="mini-label">Tests</span><strong>${h.total_tests}</strong></div>
      <div class="mini-stat"><span class="mini-label">Boreholes</span><strong>${h.boreholes}</strong></div>
    </div>

    ${
      a.recommendations.length
        ? `<div class="section">
            <div class="section-header"><h2>Recommendations</h2></div>
            <div class="rec-list">
              ${a.recommendations
                .map(
                  (r) => `<div class="rec-item ${SEV_CLASS[r.severity] || ''}">
                    <div class="rec-head"><span class="rec-sev">${esc(r.severity)}</span><strong>${esc(r.title)}</strong></div>
                    <p>${esc(r.detail)}</p>
                    ${r.borehole_id ? `<a class="link" href="#/boreholes/${r.borehole_id}">Open borehole &rarr;</a>` : ''}
                  </div>`
                )
                .join('')}
            </div>
          </div>`
        : ''
    }

    <div class="chart-grid">
      <div class="chart-card chart-card-wide">
        <h3>Planned vs actual progress</h3>
        ${
          pva.points.length
            ? lineChart(
                [
                  // Planned is a target reference line, not a data series, so it
                  // wears the muted ink token rather than a categorical hue and
                  // carries a dash pattern as secondary encoding.
                  { label: 'Planned', points: pva.points.map((p) => ({ x: p.x, y: p.planned })), dashed: true, color: '#898781' },
                  { label: 'Actual', points: pva.points.map((p) => ({ x: p.x, y: p.actual })), color: '#2a78d6', area: true },
                ],
                {
                  unit: ' m',
                  xLabel: 'Date',
                  height: 260,
                  ariaLabel: 'Planned versus actual cumulative metres drilled',
                  footnote: `Target ${pva.target} m`,
                }
              )
            : `<div class="chart-empty">Set planned depths and dates on boreholes to compare against plan.</div>`
        }
      </div>

      <div class="chart-card chart-card-wide">
        <h3>Daily &amp; cumulative production</h3>
        ${columnChart(a.production.daily, {
          unit: ' m',
          yLabel: 'Metres per day',
          xLabel: 'Date',
          overlay: { key: 'cumulative', label: 'Cumulative', color: '#eb6834' },
          empty: 'No dated drilling runs in this selection.',
          ariaLabel: 'Metres drilled per day with cumulative total',
          tooltip: (p) =>
            `<div class="tip-title">${esc(p.x)}</div>
             <div class="tip-row">Metres<strong>${p.y} m</strong></div>
             <div class="tip-row">Cumulative<strong>${p.cumulative} m</strong></div>
             <div class="tip-row">Runs<strong>${p.meta ? p.meta.runs : 0}</strong></div>
             <div class="tip-row">Downtime<strong>${p.meta ? p.meta.downtime_hours : 0} h</strong></div>`,
        })}
      </div>

      <div class="chart-card">
        <h3>Average metres per shift</h3>
        ${barChart(a.production.perShift, {
          unit: ' m',
          xLabel: 'Shift',
          yLabel: 'Avg metres/day',
          labelWidth: 110,
          empty: 'No shift data captured.',
          tooltip: (p) => `<div class="tip-title">${esc(p.x)} shift</div>
            <div class="tip-row">Avg/day<strong>${p.y} m</strong></div>
            <div class="tip-row">Total<strong>${p.meta.total_metres} m</strong></div>
            <div class="tip-row">Runs<strong>${p.meta.runs}</strong></div>`,
        })}
      </div>

      <div class="chart-card">
        <h3>Sample frequency &amp; recovery</h3>
        ${barChart(a.sampleRecovery, {
          xLabel: 'Sample type',
          yLabel: 'Count',
          labelWidth: 110,
          empty: 'No samples captured.',
          tooltip: (p) => `<div class="tip-title">${esc(p.x)}</div>
            <div class="tip-row">Samples<strong>${p.y}</strong></div>
            <div class="tip-row">Avg recovery<strong>${p.avg_recovery ?? '—'}%</strong></div>
            <div class="tip-row">Low recovery<strong>${p.low_recovery_count}</strong></div>`,
        })}
      </div>

      <div class="chart-card chart-card-wide">
        <h3>Sample &amp; test distribution by depth</h3>
        ${depthProfileChart(a.depthDistribution, { empty: 'No samples or tests captured in this selection.' })}
      </div>

      <div class="chart-card">
        <h3>Downtime by reason</h3>
        ${barChart(a.downtime.byReason, { unit: ' h', xLabel: 'Reason', yLabel: 'Hours', labelWidth: 170, empty: 'No downtime recorded.', color: '#eb6834' })}
      </div>

      <div class="chart-card">
        <h3>Downtime trend</h3>
        ${columnChart(a.downtime.trend, { unit: ' h', yLabel: 'Hours', xLabel: 'Date', empty: 'No downtime recorded.', color: '#eb6834' })}
      </div>

      <div class="chart-card">
        <h3>Equipment productivity</h3>
        ${barChart(a.equipment, {
          unit: ' m',
          xLabel: 'Rig',
          yLabel: 'Metres',
          labelWidth: 130,
          empty: 'No rigs recorded on drilling runs.',
          tooltip: (p) => `<div class="tip-title">${esc(p.x)}</div>
            <div class="tip-row">Metres<strong>${p.y} m</strong></div>
            <div class="tip-row">Avg/day<strong>${p.avg_per_day ?? '—'} m</strong></div>
            <div class="tip-row">Runs<strong>${p.runs}</strong></div>
            <div class="tip-row">Downtime<strong>${p.downtime_hours} h${p.downtime_pct !== null ? ` (${p.downtime_pct}%)` : ''}</strong></div>`,
        })}
      </div>

      <div class="chart-card">
        <h3>Operator performance</h3>
        ${barChart(a.operators, {
          unit: ' m',
          xLabel: 'Operator',
          yLabel: 'Metres',
          labelWidth: 130,
          empty: 'No operators recorded on drilling runs.',
          tooltip: (p) => `<div class="tip-title">${esc(p.x)}</div>
            <div class="tip-row">Metres<strong>${p.y} m</strong></div>
            <div class="tip-row">Avg/day<strong>${p.avg_per_day ?? '—'} m</strong></div>
            <div class="tip-row">Days<strong>${p.days}</strong></div>
            <div class="tip-row">Downtime<strong>${p.downtime_hours} h</strong></div>`,
        })}
      </div>

      <div class="chart-card">
        <h3>Ground conditions</h3>
        ${barChart(a.groundConditions.conditions, { xLabel: 'Condition', yLabel: 'Runs', labelWidth: 150, empty: 'No ground conditions recorded.', color: '#1baf7a' })}
      </div>

      <div class="chart-card">
        <h3>Groundwater observations</h3>
        ${barChart(a.groundConditions.water, { xLabel: 'Observation', yLabel: 'Runs', labelWidth: 150, empty: 'No groundwater observations recorded.', color: '#2a78d6' })}
      </div>

      ${
        a.groundConditions.rqd.length
          ? `<div class="chart-card chart-card-wide"><h3>RQD with depth</h3>
              ${lineChart([{ label: 'RQD', points: a.groundConditions.rqd.map((p) => ({ x: p.x, y: p.y })) }], {
                unit: '%',
                xLabel: 'Depth (m)',
                xFormat: (v) => `${v} m`,
                ariaLabel: 'Rock quality designation against depth',
              })}</div>`
          : ''
      }
    </div>

    <div class="section">
      <div class="section-header"><h2>Borehole completion</h2></div>
      ${
        a.completion.length === 0
          ? `<div class="empty-state">No boreholes in this selection.</div>`
          : `<table>
              <thead><tr><th>Borehole</th><th>Project</th><th>Status</th><th>Progress</th><th>Current</th><th>Target</th><th>Rate</th><th>Est. completion</th></tr></thead>
              <tbody>
                ${a.completion
                  .map(
                    (c) => `<tr class="clickable-row" data-borehole="${c.borehole_id}">
                      <td><strong>${esc(c.code)}</strong></td>
                      <td>${esc(c.project_name)}</td>
                      <td>${statusBadge(c.status)}</td>
                      <td style="min-width:160px">${progressMeter(c.completion_pct, { empty: 'No target' })}</td>
                      <td class="depth-cell">${c.current_depth ?? 0} m</td>
                      <td class="depth-cell">${c.target_depth ?? '—'}${c.target_depth ? ' m' : ''}</td>
                      <td>${c.rate_m_per_day ?? '—'}${c.rate_m_per_day ? ' m/d' : ''}</td>
                      <td>${c.estimated_completion || '—'}</td>
                    </tr>`
                  )
                  .join('')}
              </tbody>
            </table>`
      }
    </div>

    <div class="section">
      <div class="section-header">
        <h2>Data quality</h2>
        <span class="subtitle">${Object.entries(a.dataQuality.counts).map(([k, v]) => `${v} ${k}`).join(' &middot; ') || 'No issues'}</span>
      </div>
      ${
        a.dataQuality.alerts.length === 0
          ? `<div class="empty-state">No data-quality issues detected.</div>`
          : `<div class="alert-list">${a.dataQuality.alerts
              .map(
                (x) => `<div class="alert-item ${SEV_CLASS[x.severity] || ''}">
                  <span class="rec-sev">${esc(x.severity)}</span>
                  <span>${esc(x.message)}</span>
                  ${x.borehole_id ? `<a class="link" href="#/boreholes/${x.borehole_id}">Open &rarr;</a>` : ''}
                </div>`
              )
              .join('')}</div>`
      }
    </div>
  `;

  appEl.querySelectorAll('[data-filter]').forEach((el) => {
    el.addEventListener('change', () => {
      analyticsState[el.dataset.filter] = el.value;
      // A borehole from the previous project would filter everything to zero.
      if (el.dataset.filter === 'project_id') analyticsState.borehole_id = '';
      renderAnalyticsPage();
    });
  });
  document.getElementById('reset-filters').addEventListener('click', () => {
    Object.keys(analyticsState).forEach((k) => (analyticsState[k] = ''));
    renderAnalyticsPage();
  });
  appEl.querySelectorAll('[data-borehole]').forEach((row) => {
    row.addEventListener('click', () => (location.hash = `#/boreholes/${row.dataset.borehole}`));
  });

  wireCharts(appEl);
}

// ================================================================
// Vocabulary administration
// ================================================================

async function renderLookupsPage() {
  setBreadcrumb([{ label: 'Vocabularies', href: '#/lookups' }]);
  const pending = await api('GET', '/api/lookups/pending');
  const cats = LOOKUPS.categories || {};

  appEl.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Controlled Vocabularies</h1>
        <p class="subtitle">Standard values operators pick from, and custom values awaiting approval</p>
      </div>
    </div>

    <div class="section">
      <div class="section-header"><h2>Awaiting approval (${pending.length})</h2></div>
      ${
        pending.length === 0
          ? `<div class="empty-state">Nothing awaiting approval.</div>`
          : `<table>
              <thead><tr><th>Category</th><th>Proposed value</th><th>Submitted by</th><th>When</th><th></th></tr></thead>
              <tbody>${pending
                .map(
                  (p) => `<tr>
                    <td>${esc(cats[p.category] ? cats[p.category].label : p.category)}</td>
                    <td><strong>${esc(p.value)}</strong></td>
                    <td>${esc(p.created_by_name || '—')}</td>
                    <td>${esc((p.created_at || '').slice(0, 16).replace('T', ' '))}</td>
                    <td class="actions-cell">
                      <button class="link" data-approve="${p.id}">Approve</button>
                      <button class="link" data-reject="${p.id}">Reject</button>
                    </td>
                  </tr>`
                )
                .join('')}</tbody>
            </table>`
      }
    </div>

    <div class="section">
      <div class="section-header"><h2>Standard lists</h2></div>
      <div class="vocab-grid">
        ${Object.entries(cats)
          .map(([key, cfg]) => {
            const opts = LOOKUPS.options[key] || [];
            return `<div class="vocab-card">
              <h3>${esc(cfg.label)}</h3>
              <p class="subtitle">${opts.length} values</p>
              <div class="vocab-values">${opts
                .slice(0, 8)
                .map((o) => `<span class="vocab-chip">${esc(o.value)}</span>`)
                .join('')}${opts.length > 8 ? `<span class="vocab-chip vocab-more">+${opts.length - 8} more</span>` : ''}</div>
            </div>`;
          })
          .join('')}
      </div>
    </div>
  `;

  const review = async (id, decision) => {
    await api('PUT', `/api/lookups/${id}/review`, { decision });
    toast(`Value ${decision.toLowerCase()}`);
    await loadLookups();
    renderLookupsPage();
  };
  appEl.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', () => review(b.dataset.approve, 'Approved')));
  appEl.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', () => review(b.dataset.reject, 'Rejected')));
}
