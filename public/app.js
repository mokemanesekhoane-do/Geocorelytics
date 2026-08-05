const appEl = document.getElementById('app');
const breadcrumbEl = document.getElementById('breadcrumb');
const modalRoot = document.getElementById('modal-root');
const searchInput = document.getElementById('global-search');
const searchResultsEl = document.getElementById('search-results');
const authRoot = document.getElementById('auth-root');
const shellEl = document.getElementById('shell');

const ICON_COLORS = ['#1c8a4d', '#2f6fa8', '#b3790f', '#8a4fc9', '#c94a3f', '#0e7c8c'];

let currentUser = null;

// ---------- API helper ----------

async function api(method, url, body) {
  const opts = { method };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (res.status === 401) {
    if (currentUser) {
      currentUser = null;
      showLoginScreen('Your session expired. Please sign in again.');
    }
    throw new Error('Not authenticated');
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (data.error) message = data.error;
    } catch (_) {}
    throw new Error(message);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---------- Toast ----------

function toast(message, isError) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ---------- Modal ----------

function closeModal() {
  modalRoot.innerHTML = '';
}

function openModal({ title, fieldsHtml, onSubmit, submitLabel }) {
  modalRoot.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal">
        <h3>${title}</h3>
        <form id="modal-form">
          <div class="form-grid">${fieldsHtml}</div>
          <div class="modal-actions">
            <button type="button" id="modal-cancel">Cancel</button>
            <button type="submit" class="primary">${submitLabel || 'Save'}</button>
          </div>
        </form>
      </div>
    </div>
  `;
  const backdrop = modalRoot.querySelector('.modal-backdrop');
  const form = modalRoot.querySelector('#modal-form');
  modalRoot.querySelector('#modal-cancel').onclick = closeModal;
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());
    for (const key in data) {
      if (data[key] === '') data[key] = null;
    }
    try {
      await onSubmit(data);
      closeModal();
    } catch (err) {
      toast(err.message, true);
    }
  });
  return form;
}

// ---------- Helpers ----------

function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function statusBadge(status) {
  const slug = (status || '').toLowerCase().replace(/\s+/g, '');
  return `<span class="badge status-${slug}">${esc(status || 'Unknown')}</span>`;
}

function roleBadge(role) {
  return `<span class="role-badge role-${(role || '').toLowerCase()}">${esc(role)}</span>`;
}

function fmt(val, suffix) {
  if (val === null || val === undefined || val === '') return '&mdash;';
  return esc(val) + (suffix || '');
}

// A bare <input type="number"> defaults to step=1, which silently rejects
// decimal depths like 1.6 m. Every numeric field in this app is a real
// measurement, so they all accept decimals.
function numStep(type) {
  return type === 'number' ? ' step="any"' : '';
}

// ---------- Depth continuity helpers (stratigraphy log + in-situ tests) ----------

function lastEndDepth(rows) {
  return rows.length ? Math.max(...rows.map((r) => r.depth_to)) : 0;
}

function depthFieldsHtml(lastEnd, existing) {
  existing = existing || {};
  return `
    <div>
      <label>Depth From (m) * <span style="font-weight:400;color:var(--text-dim);">continues from ${lastEnd} m</span></label>
      <input type="number" step="any" name="depth_from" required value="${esc(existing.depth_from ?? lastEnd)}" />
    </div>
    <div><label>Depth To (m) *</label><input type="number" step="any" name="depth_to" required value="${esc(existing.depth_to ?? '')}" /></div>
    <div class="full hidden" id="gap-reason-wrap">
      <label>Reason for Skipped Interval *</label>
      <textarea name="skip_reason" placeholder="e.g. No recovery between 4.0-4.5 m, core loss">${esc(existing.skip_reason || '')}</textarea>
    </div>
  `;
}

// Wires the live gap-reason toggle onto a form built with depthFieldsHtml.
// Call after openModal() so the returned form element is in the DOM.
function wireDepthContinuity(form, lastEnd) {
  const fromInput = form.querySelector('input[name="depth_from"]');
  const gapWrap = form.querySelector('#gap-reason-wrap');
  const gapInput = form.querySelector('textarea[name="skip_reason"]');
  if (!fromInput || !gapWrap) return;
  function update() {
    const val = parseFloat(fromInput.value);
    const isGap = Number.isFinite(val) && val > lastEnd + 1e-9;
    gapWrap.classList.toggle('hidden', !isGap);
    if (gapInput) gapInput.required = isGap;
  }
  fromInput.addEventListener('input', update);
  update();
}

// ================================================================
// Drilling runs — the unit of production
//
// Every sample and test is captured *within* a run, so the run form is the
// one place the shared context (date, shift, rig, method, operator) is
// entered. Subsequent forms inherit it rather than asking again.
// ================================================================

const RUN_FIELD_GROUPS = [
  {
    title: 'Shift & crew',
    fields: [
      { name: 'date', label: 'Date', type: 'date' },
      { name: 'shift', label: 'Shift', lookup: 'shift' },
      { name: 'start_time', label: 'Start Time', type: 'time' },
      { name: 'end_time', label: 'End Time', type: 'time' },
      { name: 'rig_name', label: 'Drilling Rig', type: 'text', placeholder: 'e.g. Rig-07' },
      { name: 'operator_name', label: 'Operator', type: 'text' },
      { name: 'helper_name', label: 'Assistant / Helper', type: 'text' },
      { name: 'drilling_status', label: 'Drilling Status', lookup: 'drilling_status' },
    ],
  },
  {
    title: 'Method & tooling',
    fields: [
      { name: 'drilling_method', label: 'Drilling Method', lookup: 'drilling_method' },
      { name: 'bit_type', label: 'Bit Type', type: 'text' },
      { name: 'core_barrel_type', label: 'Core Barrel Type', type: 'text' },
    ],
  },
  {
    title: 'Recovery & rate',
    fields: [
      { name: 'core_recovered_m', label: 'Core Recovered (m)', type: 'number' },
      { name: 'rqd_pct', label: 'RQD (%)', type: 'number' },
      { name: 'penetration_rate_m_hr', label: 'Penetration Rate (m/h)', type: 'number' },
      { name: 'drilling_time_min', label: 'Drilling Time (min)', type: 'number' },
      { name: 'recovery_quality', label: 'Recovery Quality', lookup: 'recovery_quality', dataOnly: true },
      { name: 'fracture_condition', label: 'Fracture Condition', lookup: 'fracture_condition', dataOnly: true },
    ],
  },
  {
    title: 'Ground & water',
    fields: [
      { name: 'ground_conditions', label: 'Ground Conditions', lookup: 'soil_type' },
      { name: 'groundwater_obs', label: 'Groundwater Observation', lookup: 'groundwater_obs' },
      { name: 'water_loss_pct', label: 'Water Loss (%)', type: 'number' },
    ],
  },
  {
    title: 'Delays & close-out',
    fields: [
      { name: 'downtime_min', label: 'Downtime (min)', type: 'number' },
      { name: 'downtime_reason', label: 'Downtime Reason', lookup: 'downtime_reason' },
      { name: 'refusal_reason', label: 'Refusal Reason', lookup: 'refusal_reason' },
      { name: 'supervisor_name', label: 'Supervisor Verification', type: 'text', placeholder: 'Supervisor name to approve' },
      { name: 'remarks', label: 'Remarks', lookup: 'standard_remarks', full: true },
    ],
  },
];

function runFieldHtml(f, value) {
  if (f.lookup) return lookupSelectHtml(f.lookup, f.name, value, { label: f.label, full: f.full });
  const wrap = f.full ? 'full' : '';
  return `<div class="${wrap}"><label>${esc(f.label)}</label><input type="${f.type}"${numStep(f.type)} name="${esc(f.name)}" placeholder="${esc(f.placeholder || '')}" value="${esc(value ?? '')}" /></div>`;
}

// `prefill` comes from /next-run: the last run's context, so the operator
// confirms rather than retypes.
function runModalFieldsHtml(prefill, existing) {
  existing = existing || {};
  const val = (name) => existing[name] ?? prefill.defaults?.[name] ?? '';
  const lastEnd = existing.depth_from ?? prefill.depth_from ?? 0;
  const runNo = existing.run_number ?? prefill.run_number;
  return `
    <div><label>Run Number</label><input type="number" step="1" name="run_number" value="${esc(runNo)}" /></div>
    <div class="item"><span class="label">Target depth</span>${prefill.target_depth ? `${prefill.target_depth} m` : '&mdash;'}</div>
    ${depthFieldsHtml(lastEnd, existing)}
    <div class="full" id="run-validation"></div>
    ${RUN_FIELD_GROUPS.map(
      (g) => `<div class="full form-section-title">${esc(g.title)}</div>` +
        g.fields.filter((f) => !f.dataOnly).map((f) => runFieldHtml(f, existing[f.name] ?? (f.name === 'date' ? val('date') || todayStr() : val(f.name)))).join('')
    ).join('')}
  `;
}

async function openRunModal(boreholeId, existing, onSaved) {
  const prefill = existing
    ? { depth_from: existing.depth_from, run_number: existing.run_number, target_depth: null, defaults: {} }
    : await api('GET', `/api/boreholes/${boreholeId}/next-run`);
  const lastEnd = existing ? existing.depth_from : prefill.depth_from;
  const form = openModal({
    title: existing ? `Edit Drilling Run ${existing.run_number ?? ''}` : `New Drilling Run ${prefill.run_number}`,
    submitLabel: existing ? 'Save Run' : 'Log Run',
    fieldsHtml: runModalFieldsHtml(prefill, existing),
    onSubmit: async (data) => {
      const saved = existing
        ? await api('PUT', `/api/runs/${existing.id}`, data)
        : await api('POST', `/api/boreholes/${boreholeId}/runs`, data);
      await submitCustomLookups(form);
      toast(existing ? 'Drilling run updated' : 'Drilling run logged');
      if (onSaved) await onSaved(saved);
    },
  });
  wireDepthContinuity(form, lastEnd);
  wireLookups(form);
  wireRunValidation(form, prefill.target_depth);
  return form;
}

// Live checks mirroring the server's rules, so the operator is told at the
// point of entry rather than on submit.
function wireRunValidation(form, targetDepth) {
  const box = form.querySelector('#run-validation');
  if (!box) return;
  const get = (n) => form.querySelector(`[name="${n}"]`);
  function check() {
    const from = parseFloat(get('depth_from')?.value);
    const to = parseFloat(get('depth_to')?.value);
    const core = parseFloat(get('core_recovered_m')?.value);
    const rqd = parseFloat(get('rqd_pct')?.value);
    const issues = [];
    if (Number.isFinite(from) && Number.isFinite(to)) {
      if (to <= from) issues.push(['error', 'Depth To must be greater than Depth From']);
      const interval = to - from;
      if (Number.isFinite(core) && core > interval + 1e-6) {
        issues.push(['error', `Core recovered (${core} m) exceeds the drilled interval (${interval.toFixed(2)} m)`]);
      }
      if (Number.isFinite(core) && interval > 0 && core / interval < 0.7) {
        issues.push(['warn', `Core recovery is ${((core / interval) * 100).toFixed(0)}% — low for this interval`]);
      }
      if (targetDepth && to > targetDepth + 1e-9) {
        issues.push(['error', `Depth ${to} m is beyond the borehole target depth (${targetDepth} m)`]);
      }
      if (interval > 6) issues.push(['warn', `Run length is ${interval.toFixed(2)} m — unusually long, please confirm`]);
    }
    if (Number.isFinite(rqd) && (rqd < 0 || rqd > 100)) issues.push(['error', 'RQD must be between 0 and 100%']);
    renderValidation(box, issues);
  }
  form.addEventListener('input', check);
  form.addEventListener('lookup-change', check);
  check();
}

function renderValidation(box, issues) {
  if (!issues.length) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = issues
    .map(([kind, msg]) => `<div class="validation-msg ${kind === 'error' ? 'is-error' : 'is-warn'}">${kind === 'error' ? '&#9888;' : '&#9432;'} ${esc(msg)}</div>`)
    .join('');
}

// Shared live validation for sample/test interval forms: depth must sit inside
// a recorded run and within what has actually been drilled.
function wireIntervalValidation(form, context) {
  const box = form.querySelector('#interval-validation');
  if (!box) return;
  function check() {
    const from = parseFloat(form.querySelector('[name="depth_from"]')?.value);
    const to = parseFloat(form.querySelector('[name="depth_to"]')?.value);
    const issues = [];
    if (Number.isFinite(from) && Number.isFinite(to)) {
      if (to <= from) issues.push(['error', 'Depth To must be greater than Depth From']);
      if (context.drilled_to !== undefined && to > context.drilled_to + 1e-9) {
        issues.push(['error', `Only ${context.drilled_to} m has been drilled. Log the drilling run covering this depth first.`]);
      }
      const run = (context.runs || []).find((r) => from >= r.depth_from - 1e-9 && to <= r.depth_to + 1e-9);
      const overlap = (context.runs || []).find((r) => Math.min(to, r.depth_to) - Math.max(from, r.depth_from) > 0);
      if (run) {
        issues.push(['ok', `Within drilling run ${run.run_number ?? run.id} (${run.depth_from}–${run.depth_to} m)${run.operator_name ? ` · ${run.operator_name}` : ''}`]);
      } else if (overlap) {
        issues.push(['warn', `Straddles run ${overlap.run_number ?? overlap.id} (${overlap.depth_from}–${overlap.depth_to} m) — it will link to that run`]);
      } else if ((context.runs || []).length) {
        issues.push(['error', 'No drilling run covers this interval']);
      }
    }
    box.innerHTML = issues
      .map(([kind, msg]) => {
        const cls = kind === 'error' ? 'is-error' : kind === 'warn' ? 'is-warn' : 'is-ok';
        const icon = kind === 'error' ? '&#9888;' : kind === 'warn' ? '&#9432;' : '&#10003;';
        return `<div class="validation-msg ${cls}">${icon} ${esc(msg)}</div>`;
      })
      .join('');
  }
  form.addEventListener('input', check);
  check();
}

// ================================================================
// Test-type-specific forms
//
// Each in-situ test type has its own parameters, validation, and result
// calculation. Raw readings are stored per-test as `test_data` (JSON) so new
// test types can be added later without a schema change; the computed
// headline result is mirrored into result_value/result_unit for the
// register/report tables. Formulas are standard textbook methods, shown with
// their name in the UI, and the computed result is always editable — this
// is a field data system, not a substitute for engineering sign-off.
// ================================================================

const TEST_TYPES = {
  'Falling Head Test': {
    resultLabel: 'Coefficient of Permeability (k)',
    formulaNote: 'Hvorslev method for an uncased test section (valid for intake length / borehole radius > 8). Only test section from/to depth, diameters, and h/t readings drive the calculation — everything else is contextual record-keeping.',
    fields: [
      // Geometry — measured, so free numeric entry; standpipe type is standard.
      { name: 'standpipe_type', label: 'Standpipe / Casing Type', lookup: 'standpipe_type' },
      { name: 'borehole_diameter_mm', label: 'Borehole Diameter (mm)', type: 'number', placeholder: 'e.g. 100' },
      { name: 'casing_diameter_mm', label: 'Standpipe / Casing Diameter (mm)', type: 'number', placeholder: 'e.g. 50' },
      // Water levels and heads
      { name: 'initial_water_level_m', label: 'Initial Water Level (m bgl)', type: 'number' },
      { name: 'final_water_level_m', label: 'Final Water Level (m bgl)', type: 'number' },
      { name: 'groundwater_level_m', label: 'Groundwater / Static Level (m bgl)', type: 'number' },
      { name: 'h1_m', label: 'Initial Head h₁ (m)', type: 'number' },
      { name: 'h2_m', label: 'Final Head h₂ (m)', type: 'number' },
      // Timing
      { name: 't1_min', label: 'Time t₁ (min)', type: 'number', placeholder: '0' },
      { name: 't2_min', label: 'Time t₂ (min)', type: 'number' },
      { name: 'test_start_time', label: 'Test Start Time', type: 'time' },
      { name: 'test_end_time', label: 'Test End Time', type: 'time' },
      // Conditions
      { name: 'water_temperature_c', label: 'Water Temperature (°C)', type: 'number' },
      { name: 'correction_factor', label: 'Correction Factor (optional, multiplies k)', type: 'number', placeholder: '1.0' },
      { name: 'test_condition', label: 'Test Condition / Validity', lookup: 'test_condition' },
      { name: 'groundwater_obs', label: 'Groundwater Observation', lookup: 'groundwater_obs' },
      { name: 'formation_description', label: 'Soil / Formation Description', lookup: 'soil_type', full: true },
      { name: 'remarks_standard', label: 'Remarks', lookup: 'standard_remarks', full: true },
    ],
    compute(v) {
      const r = num(v.casing_diameter_mm) / 2000;
      const R = num(v.borehole_diameter_mm) / 2000;
      const Le = num(v.depth_to) - num(v.depth_from);
      const h1 = num(v.h1_m);
      const h2 = num(v.h2_m);
      const dt = num(v.t2_min) - num(v.t1_min ?? 0);
      const geometryValid = r > 0 && R > 0 && Le > 0 && Le / R > 1;
      const readingsValid = h1 > 0 && h2 > 0 && dt > 0 && h1 > h2;
      let duration = null;
      if (v.test_start_time && v.test_end_time) {
        const [sh, sm] = v.test_start_time.split(':').map(Number);
        const [eh, em] = v.test_end_time.split(':').map(Number);
        duration = eh * 60 + em - (sh * 60 + sm);
      }
      if (!geometryValid || !readingsValid) {
        return {
          value: null,
          unit: 'cm/s',
          validity: geometryValid ? 'Invalid — check h₁/h₂/t₁/t₂ readings' : 'Invalid — check diameters and test interval (intake length ÷ borehole radius must exceed 1)',
          duration,
        };
      }
      const kMetersPerMin = ((r * r * Math.log(Le / R)) / (2 * Le * dt)) * Math.log(h1 / h2);
      if (!Number.isFinite(kMetersPerMin) || kMetersPerMin <= 0) {
        return { value: null, unit: 'cm/s', validity: 'Invalid — calculation did not converge to a positive value', duration };
      }
      let kCmPerSec = (kMetersPerMin * 100) / 60;
      const correction = num(v.correction_factor);
      if (correction > 0) kCmPerSec *= correction;
      return { value: kCmPerSec, unit: 'cm/s', validity: 'Valid', duration };
    },
  },
  'Packer Test': {
    resultLabel: 'Lugeon Value',
    formulaNote: '5-stage pressure test; Lugeon = flow (L/min) ÷ [section length (m) × (pressure (bar) ÷ 10)], averaged across stages',
    fields: [
      { name: 'section_length_m', label: 'Test Section Length (m)', type: 'number' },
      { name: 'p1_bar', label: 'Stage 1 Pressure (bar)', type: 'number' },
      { name: 'q1_lpm', label: 'Stage 1 Flow (L/min)', type: 'number' },
      { name: 'p2_bar', label: 'Stage 2 Pressure (bar)', type: 'number' },
      { name: 'q2_lpm', label: 'Stage 2 Flow (L/min)', type: 'number' },
      { name: 'p3_bar', label: 'Stage 3 Pressure (bar)', type: 'number' },
      { name: 'q3_lpm', label: 'Stage 3 Flow (L/min)', type: 'number' },
      { name: 'p4_bar', label: 'Stage 4 Pressure (bar)', type: 'number' },
      { name: 'q4_lpm', label: 'Stage 4 Flow (L/min)', type: 'number' },
      { name: 'p5_bar', label: 'Stage 5 Pressure (bar)', type: 'number' },
      { name: 'q5_lpm', label: 'Stage 5 Flow (L/min)', type: 'number' },
    ],
    compute(v) {
      const L = num(v.section_length_m);
      const lugeons = [];
      for (let i = 1; i <= 5; i++) {
        const p = num(v[`p${i}_bar`]);
        const q = num(v[`q${i}_lpm`]);
        if (p > 0 && q >= 0) lugeons.push(q / (L * (p / 10)));
      }
      if (!(L > 0) || lugeons.length === 0) {
        return { value: null, unit: 'Lugeon', validity: 'Invalid — enter section length and at least one pressure/flow stage' };
      }
      const avg = lugeons.reduce((a, b) => a + b, 0) / lugeons.length;
      return { value: avg, unit: 'Lugeon', validity: 'Valid' };
    },
  },
};

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

// Standard equipment/condition fields become searchable dropdowns over the
// controlled vocabulary; measured quantities stay free numeric entry, because
// there is no standard list for a reading the operator takes off an instrument.
function testFieldInputHtml(f, value) {
  if (f.lookup) return lookupSelectHtml(f.lookup, `tf_${f.name}`, value, { label: f.label, full: f.full });
  const wrap = f.full ? 'full' : '';
  if (f.type === 'textarea') {
    return `<div class="${wrap}"><label>${esc(f.label)}</label><textarea name="tf_${f.name}" placeholder="${esc(f.placeholder || '')}">${esc(value ?? '')}</textarea></div>`;
  }
  return `<div class="${wrap}"><label>${esc(f.label)}</label><input type="${f.type}"${numStep(f.type)} name="tf_${f.name}" placeholder="${esc(f.placeholder || '')}" value="${esc(value ?? '')}" /></div>`;
}

function testTypeFieldsHtml(testType, existingData) {
  const config = TEST_TYPES[testType];
  existingData = existingData || {};
  if (!config) return '';
  return (
    `<div class="full" style="font-size:0.78rem;color:var(--text-dim);margin:2px 0 4px;">${esc(config.formulaNote)}</div>` +
    config.fields.map((f) => testFieldInputHtml(f, existingData[f.name])).join('')
  );
}

function wireTestTypeCalc(form, testType) {
  const config = TEST_TYPES[testType];
  const preview = form.querySelector('#test-result-preview');
  const resultValueInput = form.querySelector('input[name="result_value"]');
  const resultUnitInput = form.querySelector('input[name="result_unit"]');
  const testDataInput = form.querySelector('input[name="test_data"]');
  const depthFromInput = form.querySelector('input[name="depth_from"]');
  const depthToInput = form.querySelector('input[name="depth_to"]');
  if (!config) return;

  function recalc() {
    const values = {};
    config.fields.forEach((f) => {
      const input = form.querySelector(`[name="tf_${f.name}"]`);
      values[f.name] = input ? input.value : '';
    });
    values.depth_from = depthFromInput ? depthFromInput.value : '';
    values.depth_to = depthToInput ? depthToInput.value : '';
    testDataInput.value = JSON.stringify(values);
    const result = config.compute(values);
    resultValueInput.value = result.value !== null ? result.value.toFixed(6) : '';
    resultUnitInput.value = result.unit || '';

    const durationText = result.duration !== null && result.duration !== undefined ? ` &middot; Duration: ${result.duration} min` : '';
    if (result.value !== null) {
      preview.innerHTML = `${esc(config.resultLabel)}: ${result.value.toPrecision(4)} ${esc(result.unit)} &middot; ${esc(result.validity)}${durationText}`;
      preview.style.color = result.validity === 'Valid' ? 'var(--green-dark)' : 'var(--amber)';
    } else {
      preview.innerHTML = `${esc(result.validity || 'Enter readings above to calculate the result.')}${durationText}`;
      preview.style.color = 'var(--text-dim)';
    }
  }

  config.fields.forEach((f) => {
    const input = form.querySelector(`[name="tf_${f.name}"]`);
    if (!input) return;
    input.addEventListener('input', recalc);
    // Lookup fields write to a hidden input and signal via `change`, not
    // `input` — without this a picked dropdown value never reaches test_data.
    input.addEventListener('change', recalc);
  });
  form.addEventListener('lookup-change', recalc);
  if (depthFromInput) depthFromInput.addEventListener('input', recalc);
  if (depthToInput) depthToInput.addEventListener('input', recalc);
  recalc();
}

function testModalFieldsHtml(lastEnd, existing) {
  existing = existing || {};
  const testType = existing.test_type || 'Falling Head Test';
  return `
    <div class="full">
      <label>Test Type *</label>
      <select name="test_type" id="test-type-select">
        ${Object.keys(TEST_TYPES)
          .map((tt) => `<option ${tt === testType ? 'selected' : ''}>${tt}</option>`)
          .join('')}
      </select>
    </div>
    <div><label>Borehole / Test-Hole Reference</label><input name="test_ref" value="${esc(existing.test_ref || '')}" /></div>
    ${depthFieldsHtml(lastEnd, existing)}
    <div class="full" id="interval-validation"></div>
    <div><label>Date</label><input type="date" name="date" value="${esc(existing.date || todayStr())}" /></div>
    <div><label>Operator Name</label><input name="conducted_by" value="${esc(existing.conducted_by || '')}" /></div>
    <div class="full" id="test-type-fields-wrap">
      <div class="form-grid" id="test-type-fields">${testTypeFieldsHtml(testType, existing.test_data)}</div>
    </div>
    <div class="full" style="background:var(--shell-bg);border-radius:var(--radius-sm);padding:12px 14px;font-weight:600;font-size:0.88rem;" id="test-result-preview">
      Enter readings above to calculate the result.
    </div>
    <div class="full"><label>Remarks</label><textarea name="notes">${esc(existing.notes || '')}</textarea></div>
    <div><label>Supervisor Approval</label><input name="supervisor_name" value="${esc(existing.supervisor_name || '')}" placeholder="Supervisor name to approve" /></div>
    <div class="item"><span class="label">Sign-off Timestamp</span>${fmt(existing.approved_at)}</div>
    <input type="hidden" name="result_value" value="${esc(existing.result_value ?? '')}" />
    <input type="hidden" name="result_unit" value="${esc(existing.result_unit || '')}" />
    <input type="hidden" name="test_data" value="" />
  `;
}

function wireTestModal(form, lastEnd, context) {
  wireDepthContinuity(form, lastEnd);
  wireLookups(form);
  const typeSelect = form.querySelector('#test-type-select');
  const fieldsContainer = form.querySelector('#test-type-fields');
  function rebuild() {
    fieldsContainer.innerHTML = testTypeFieldsHtml(typeSelect.value, {});
    wireLookups(form);
    wireTestTypeCalc(form, typeSelect.value);
  }
  typeSelect.addEventListener('change', rebuild);
  wireTestTypeCalc(form, typeSelect.value);
  if (context) wireIntervalValidation(form, context);
}

// ================================================================
// Sample-type-specific forms (SPT, Shelby Tube, UDS)
//
// Each sampling method has its own parameters, calculations, and blocking
// validation. Type-specific readings are stored as `sample_data` (JSON) so
// new methods can be added without a schema change; N-value/recovery% are
// mirrored into spt_n_value/recovery_pct for the register/report tables.
// Depth continuity is shared across all sample types on a borehole — the
// driller works down the hole taking one sample at a time regardless of
// method, so "last recorded end depth" spans SPT/Shelby/UDS together.
// ================================================================

const SAMPLE_TYPES = {
  SPT: {
    resultLabel: 'N-Value',
    formulaNote: 'N = blows for 2nd 150 mm + blows for 3rd 150 mm (seating and 1st increment excluded, per ASTM D1586)',
    fields: [
      // Equipment — standard catalogues, so dropdowns.
      { name: 'sampler_type', label: 'Sampler Type', lookup: 'sampler_type' },
      { name: 'hammer_type', label: 'Hammer Type', lookup: 'hammer_type' },
      // Measured equipment dimensions stay numeric.
      { name: 'hammer_weight_kg', label: 'Hammer Weight (kg)', type: 'number', placeholder: '63.5' },
      { name: 'drop_height_mm', label: 'Drop Height (mm)', type: 'number', placeholder: '760' },
      { name: 'rod_length_m', label: 'Rod Length (m)', type: 'number' },
      { name: 'sampler_diameter_mm', label: 'Sampler Diameter (mm)', type: 'number' },
      // Blow counts — the N-value inputs.
      { name: 'seating_blows', label: 'Seating Blows (0–150 mm)', type: 'number' },
      { name: 'blows_150_1', label: 'Blows — 1st 150 mm', type: 'number' },
      { name: 'blows_150_2', label: 'Blows — 2nd 150 mm', type: 'number' },
      { name: 'blows_150_3', label: 'Blows — 3rd 150 mm', type: 'number' },
      { name: 'penetration_length_mm', label: 'Penetration Length (mm)', type: 'number', placeholder: '450' },
      { name: 'recovery_length_mm', label: 'Sample Recovery Length (mm)', type: 'number' },
      // Outcome and condition — standard terms.
      { name: 'refusal_status', label: 'Refusal Status', lookup: 'refusal_status' },
      { name: 'sample_condition', label: 'Sample Condition', lookup: 'sample_condition' },
      { name: 'moisture_condition', label: 'Moisture Condition', lookup: 'moisture' },
      { name: 'soil_classification', label: 'Soil Classification (USCS)', lookup: 'uscs_class' },
      { name: 'remarks_standard', label: 'Remarks', lookup: 'standard_remarks', full: true },
      { name: 'disturbance_obstruction', label: 'Disturbance / Obstruction Encountered', type: 'textarea', full: true },
    ],
    compute(v) {
      const b2 = v.blows_150_2 === '' || v.blows_150_2 === undefined ? null : num(v.blows_150_2);
      const b3 = v.blows_150_3 === '' || v.blows_150_3 === undefined ? null : num(v.blows_150_3);
      // N is the 2nd + 3rd increments; the seating drive and 1st increment are
      // excluded per ASTM D1586.
      const nValue = b2 !== null && b3 !== null ? b2 + b3 : null;
      const totalPen = num(v.penetration_length_mm);
      const recoveryLen = num(v.recovery_length_mm);
      const recoveryPct = totalPen > 0 && v.recovery_length_mm !== '' ? (recoveryLen / totalPen) * 100 : null;
      const warnings = [];
      const isRefusal = !!v.refusal_status && v.refusal_status !== 'No Refusal';
      [num(v.blows_150_1), b2 ?? 0, b3 ?? 0].forEach((b, i) => {
        if (b >= 50 && !isRefusal) warnings.push(`Blow count ≥50 in increment ${i + 1} — consider recording a refusal status`);
      });
      if (!isRefusal && totalPen > 0 && totalPen < 450) warnings.push('Incomplete penetration (<450 mm) — verify or record a refusal status');
      if (recoveryPct !== null && recoveryPct > 100) warnings.push('Recovery exceeds penetration length — check the readings');
      return { nValue, recoveryPct, warnings, resultText: nValue !== null ? `N = ${nValue}` : null };
    },
  },
  Shelby: {
    resultLabel: 'Recovery %',
    formulaNote: 'Recovery % = recovered length ÷ penetration length. Recovered length cannot exceed penetration or tube length.',
    fields: [
      // Tube specification — type/condition come from standard catalogues;
      // the dimensions are measured, so they stay numeric.
      { name: 'tube_type', label: 'Tube Type', lookup: 'tube_type' },
      { name: 'tube_diameter_mm', label: 'Tube Diameter (mm)', type: 'number' },
      { name: 'tube_length_mm', label: 'Tube Length (mm)', type: 'number' },
      { name: 'wall_thickness_mm', label: 'Wall Thickness (mm)', type: 'number' },
      { name: 'cutting_edge_condition', label: 'Cutting-Edge Condition', lookup: 'cutting_edge_condition' },
      // Push
      { name: 'push_method', label: 'Push Method', lookup: 'push_method' },
      { name: 'push_length_mm', label: 'Push Length (mm)', type: 'number' },
      { name: 'penetration_length_mm', label: 'Penetration Length (mm)', type: 'number' },
      { name: 'recovery_length_mm', label: 'Recovered Sample Length (mm)', type: 'number' },
      { name: 'applied_pressure_kpa', label: 'Applied Pressure / Thrust (kPa)', type: 'number' },
      // Sample condition and orientation — standard terms.
      { name: 'sample_condition', label: 'Sample Condition', lookup: 'sample_condition' },
      { name: 'degree_of_disturbance', label: 'Degree of Disturbance', lookup: 'disturbance_degree' },
      { name: 'sample_orientation', label: 'Sample Orientation', lookup: 'sample_orientation' },
      { name: 'top_bottom_id', label: 'Top / Bottom Identification', lookup: 'top_bottom_id' },
      // Handling
      { name: 'sealing_method', label: 'Sealing Method', lookup: 'sealing_method' },
      { name: 'preservation_method', label: 'Preservation Method', lookup: 'preservation_method' },
      { name: 'storage_condition', label: 'Storage Condition', lookup: 'storage_condition' },
      { name: 'transport_details', label: 'Transport Details', type: 'textarea', full: true },
    ],
    compute(v) {
      const penetration = num(v.penetration_length_mm);
      const tubeLength = num(v.tube_length_mm);
      const recovered = num(v.recovery_length_mm);
      const recoveryPct = penetration > 0 && v.recovery_length_mm !== '' ? (recovered / penetration) * 100 : null;
      const warnings = [];
      if (v.recovery_length_mm !== '' && penetration > 0 && recovered > penetration) {
        warnings.push('Recovered length exceeds penetration length — will be rejected on save');
      }
      if (v.recovery_length_mm !== '' && tubeLength > 0 && recovered > tubeLength) {
        warnings.push('Recovered length exceeds tube length — will be rejected on save');
      }
      return { nValue: null, recoveryPct, warnings, resultText: null };
    },
  },
  UDS: {
    resultLabel: 'Recovery %',
    formulaNote: 'Recovery % = recovered length ÷ penetration length. Recovered length cannot exceed penetration length.',
    fields: [
      { name: 'sampling_method', label: 'Sampling Method', lookup: 'drilling_method' },
      { name: 'sampler_dimensions', label: 'Sampler Dimensions', type: 'text', placeholder: 'e.g. 76 x 600 mm' },
      { name: 'penetration_length_mm', label: 'Penetration Length (mm)', type: 'number' },
      { name: 'recovery_length_mm', label: 'Sample Recovery Length (mm)', type: 'number' },
      { name: 'sample_diameter_mm', label: 'Sample Diameter (mm)', type: 'number' },
      { name: 'soil_classification', label: 'Soil Classification (USCS)', lookup: 'uscs_class' },
      { name: 'material_consistency', label: 'Material Consistency', lookup: 'consistency' },
      { name: 'material_density', label: 'Material Density (granular)', lookup: 'density' },
      { name: 'moisture_condition', label: 'Moisture Condition', lookup: 'moisture' },
      {
        name: 'sample_quality_rating',
        label: 'Sample Quality Rating',
        type: 'select',
        options: ['SQ1 - Excellent', 'SQ2 - Good', 'SQ3 - Fair', 'SQ4 - Poor', 'SQ5 - Very Poor'],
      },
      { name: 'sample_condition', label: 'Sample Condition', lookup: 'sample_condition' },
      { name: 'degree_of_disturbance', label: 'Degree of Disturbance', lookup: 'disturbance_degree' },
      { name: 'visible_defects', label: 'Visible Defects / Cracks / Contamination', type: 'textarea', full: true },
      { name: 'sample_orientation', label: 'Sample Orientation', lookup: 'sample_orientation' },
      { name: 'top_bottom_id', label: 'Top / Bottom Identification', lookup: 'top_bottom_id' },
      { name: 'sealing_method', label: 'Sealing Method', lookup: 'sealing_method' },
      { name: 'preservation_method', label: 'Preservation Method', lookup: 'preservation_method' },
      { name: 'required_lab_tests', label: 'Required Laboratory Tests', type: 'textarea', full: true },
      { name: 'storage_requirements', label: 'Storage Requirements', lookup: 'storage_condition' },
      { name: 'dispatched_at', label: 'Date/Time Dispatched', type: 'datetime-local' },
      { name: 'receiving_lab', label: 'Receiving Laboratory', type: 'text' },
    ],
    compute(v) {
      const penetration = num(v.penetration_length_mm);
      const recovered = num(v.recovery_length_mm);
      const recoveryPct = penetration > 0 && v.recovery_length_mm !== '' ? (recovered / penetration) * 100 : null;
      const warnings = [];
      if (v.recovery_length_mm !== '' && penetration > 0 && recovered > penetration) {
        warnings.push('Recovered length exceeds penetration length — will be rejected on save');
      }
      if ((v.dispatched_at && !v.receiving_lab) || (!v.dispatched_at && v.receiving_lab)) {
        warnings.push('Chain of custody incomplete — dispatch date and receiving laboratory are both required together');
      }
      return { nValue: null, recoveryPct, warnings, resultText: null };
    },
  },
};

function sampleFieldInputHtml(f, value) {
  const wrap = f.full ? 'full' : '';
  value = value ?? '';
  // Lookup-backed fields become searchable dropdowns over the controlled
  // vocabulary instead of free text.
  if (f.lookup) {
    return lookupSelectHtml(f.lookup, `sf_${f.name}`, value, { label: f.label, full: f.full });
  }
  if (f.type === 'select') {
    return `<div class="${wrap}"><label>${esc(f.label)}</label><select name="sf_${f.name}">${f.options
      .map((o) => `<option ${o === value ? 'selected' : ''}>${esc(o)}</option>`)
      .join('')}</select></div>`;
  }
  if (f.type === 'textarea') {
    return `<div class="${wrap}"><label>${esc(f.label)}</label><textarea name="sf_${f.name}">${esc(value)}</textarea></div>`;
  }
  return `<div class="${wrap}"><label>${esc(f.label)}</label><input type="${f.type}"${numStep(f.type)} name="sf_${f.name}" placeholder="${esc(f.placeholder || '')}" value="${esc(value)}" /></div>`;
}

function sampleTypeFieldsHtml(sampleType, existingData) {
  const config = SAMPLE_TYPES[sampleType];
  existingData = existingData || {};
  if (!config) return '';
  return (
    `<div class="full" style="font-size:0.78rem;color:var(--text-dim);margin:2px 0 4px;">${esc(config.formulaNote)}</div>` +
    config.fields.map((f) => sampleFieldInputHtml(f, existingData[f.name])).join('')
  );
}

function wireSampleTypeCalc(form, sampleType) {
  const config = SAMPLE_TYPES[sampleType];
  const preview = form.querySelector('#sample-result-preview');
  const nValueInput = form.querySelector('input[name="spt_n_value"]');
  const recoveryInput = form.querySelector('input[name="recovery_pct"]');
  const sampleDataInput = form.querySelector('input[name="sample_data"]');
  if (!config) return;

  function recalc() {
    const values = {};
    config.fields.forEach((f) => {
      const input = form.querySelector(`[name="sf_${f.name}"]`);
      values[f.name] = input ? input.value : '';
    });
    sampleDataInput.value = JSON.stringify(values);
    const result = config.compute(values);
    nValueInput.value = result.nValue ?? '';
    recoveryInput.value = result.recoveryPct !== null ? result.recoveryPct.toFixed(1) : '';

    const lines = [];
    if (result.resultText) lines.push(result.resultText);
    if (result.recoveryPct !== null) lines.push(`${config.resultLabel === 'Recovery %' ? '' : 'Recovery: '}${result.recoveryPct.toFixed(1)}%`);
    if (result.warnings.length === 0 && lines.length === 0) {
      preview.textContent = 'Enter readings above to calculate the result.';
      preview.style.color = 'var(--text-dim)';
    } else {
      preview.innerHTML =
        (lines.length ? `<div>${lines.map(esc).join(' &middot; ')}</div>` : '') +
        result.warnings.map((w) => `<div style="color:var(--amber);">&#9888; ${esc(w)}</div>`).join('');
      preview.style.color = result.warnings.length ? 'var(--amber)' : 'var(--green-dark)';
    }
  }

  config.fields.forEach((f) => {
    const input = form.querySelector(`[name="sf_${f.name}"]`);
    if (!input) return;
    input.addEventListener('input', recalc);
    // Lookup fields write to a hidden input, which never emits `input` — they
    // signal via `change`, so without this a picked dropdown value would be
    // left out of the serialised sample_data.
    input.addEventListener('change', recalc);
  });
  form.addEventListener('lookup-change', recalc);
  recalc();
}

function sampleModalFieldsHtml(lastEnd, existing) {
  existing = existing || {};
  const sampleType = existing.sample_type || 'SPT';
  const existingData = existing.sample_data || {};
  return `
    <div class="full">
      <label>Sample/Test Type *</label>
      <select name="sample_type" id="sample-type-select">
        ${Object.keys(SAMPLE_TYPES)
          .map((t) => `<option ${t === sampleType ? 'selected' : ''}>${t}</option>`)
          .join('')}
      </select>
    </div>
    <div><label>Sample/Test Reference</label><input name="sample_ref" value="${esc(existing.sample_ref || '')}" /></div>
    <div><label>Date</label><input type="date" name="date" value="${esc(existing.date || todayStr())}" /></div>
    <div><label>Time</label><input type="time" name="time" value="${esc(existing.time || '')}" /></div>
    ${depthFieldsHtml(lastEnd, existing)}
    <div class="full" id="interval-validation"></div>
    <div class="full" id="sample-type-fields-wrap">
      <div class="form-grid" id="sample-type-fields">${sampleTypeFieldsHtml(sampleType, existingData)}</div>
    </div>
    <div class="full" style="background:var(--shell-bg);border-radius:var(--radius-sm);padding:12px 14px;font-weight:600;font-size:0.88rem;" id="sample-result-preview">
      Enter readings above to calculate the result.
    </div>
    <div class="full"><label>Soil / Material Description</label><textarea name="description">${esc(existing.description || '')}</textarea></div>
    ${lookupSelectHtml('groundwater_obs', 'groundwater_obs', existing.groundwater_obs, { label: 'Groundwater Observations' })}
    <div>
      <label>Lab Status</label>
      <select name="lab_status">
        ${['Pending', 'In Lab', 'Complete'].map((s) => `<option ${s === (existing.lab_status || 'Pending') ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
    </div>
    <div><label>Operator Name</label><input name="operator_name" value="${esc(existing.operator_name || '')}" /></div>
    <div><label>Supervisor Verification</label><input name="supervisor_name" value="${esc(existing.supervisor_name || '')}" placeholder="Supervisor name to approve" /></div>
    <div class="item"><span class="label">Sign-off Timestamp</span>${fmt(existing.approved_at)}</div>
    <div class="full"><label>Field Remarks</label><textarea name="notes">${esc(existing.notes || '')}</textarea></div>
    <input type="hidden" name="spt_n_value" value="${esc(existing.spt_n_value ?? '')}" />
    <input type="hidden" name="recovery_pct" value="${esc(existing.recovery_pct ?? '')}" />
    <input type="hidden" name="sample_data" value="" />
  `;
}

function wireSampleModal(form, lastEnd, context) {
  wireDepthContinuity(form, lastEnd);
  wireLookups(form);
  const typeSelect = form.querySelector('#sample-type-select');
  const fieldsContainer = form.querySelector('#sample-type-fields');
  function rebuild() {
    fieldsContainer.innerHTML = sampleTypeFieldsHtml(typeSelect.value, {});
    wireLookups(form);
    wireSampleTypeCalc(form, typeSelect.value);
  }
  typeSelect.addEventListener('change', rebuild);
  wireSampleTypeCalc(form, typeSelect.value);
  if (context) wireIntervalValidation(form, context);
}

// ================================================================
// Expanded HSE module
//
// hse_records is a single unified register: `category` selects which of the
// categories below applies, and each category's own fields live in the
// `details` JSON blob so new categories can be added without a schema
// change. Every category shares the same lifecycle fields (responsible
// person, due date, status, approval sign-off) so the dashboard can roll up
// outstanding/overdue/severity stats uniformly across all of them.
// ================================================================

const HSE_CATEGORIES = {
  'Toolbox Talk': {
    icon: '\u{1F5E3}\u{FE0F}',
    fields: [
      { name: 'topic', label: 'Topic', type: 'text' },
      { name: 'attendees', label: 'Attendees (one per line)', type: 'textarea', full: true },
      { name: 'duration_minutes', label: 'Duration (minutes)', type: 'number' },
    ],
  },
  'Pre-Start Inspection': {
    icon: '✅',
    fields: [
      { name: 'equipment_ref', label: 'Equipment / Vehicle', type: 'text' },
      { name: 'checklist', label: 'Checklist Notes', type: 'textarea', full: true },
      { name: 'defects_found', label: 'Defects Found', type: 'textarea', full: true },
      { name: 'safe_to_operate', label: 'Safe to Operate', type: 'select', options: ['Yes', 'No'] },
    ],
  },
  'JHA / Risk Assessment': {
    icon: '⚠️',
    fields: [
      { name: 'task', label: 'Task Description', type: 'text', full: true },
      { name: 'hazards', label: 'Hazards Identified', type: 'textarea', full: true },
      { name: 'risk_before', label: 'Risk Rating Before Controls', type: 'select', options: ['Low', 'Medium', 'High', 'Critical'] },
      { name: 'controls', label: 'Controls Implemented', type: 'textarea', full: true },
      { name: 'risk_after', label: 'Risk Rating After Controls', type: 'select', options: ['Low', 'Medium', 'High', 'Critical'] },
    ],
  },
  'PPE Inspection': {
    icon: '\u{1F9BA}',
    fields: [
      { name: 'ppe_type', label: 'PPE Type', type: 'text' },
      { name: 'condition', label: 'Condition', type: 'select', options: ['Good', 'Fair', 'Poor - Needs Replacement'] },
      { name: 'defects', label: 'Defects Found', type: 'textarea', full: true },
    ],
  },
  'Equipment Inspection': {
    icon: '\u{1F6E0}️',
    fields: [
      { name: 'equipment_ref', label: 'Equipment', type: 'text' },
      { name: 'checklist', label: 'Inspection Notes', type: 'textarea', full: true },
      { name: 'defects', label: 'Defects Found', type: 'textarea', full: true },
      { name: 'safe_to_operate', label: 'Safe to Operate', type: 'select', options: ['Yes', 'No'] },
    ],
  },
  'Incident/Accident': {
    icon: '\u{1F6A8}',
    fields: [
      { name: 'injury_type', label: 'Injury Type', type: 'text' },
      { name: 'body_part', label: 'Body Part Affected', type: 'text' },
      { name: 'medical_treatment', label: 'Medical Treatment Given', type: 'textarea', full: true },
      { name: 'reportable', label: 'Reportable Incident (e.g. RIDDOR)', type: 'select', options: ['No', 'Yes'] },
    ],
  },
  'Near Miss': {
    icon: '❗',
    fields: [
      { name: 'potential_consequence', label: 'Potential Consequence', type: 'textarea', full: true },
      { name: 'likelihood', label: 'Likelihood If Recurred', type: 'select', options: ['Low', 'Medium', 'High'] },
    ],
  },
  'Unsafe Act/Condition': {
    icon: '\u{1F6D1}',
    fields: [
      { name: 'act_or_condition', label: 'Type', type: 'select', options: ['Unsafe Act', 'Unsafe Condition'] },
      { name: 'immediate_risk', label: 'Immediate Risk Level', type: 'select', options: ['Low', 'Medium', 'High'] },
    ],
  },
  'Environmental/Spill': {
    icon: '\u{1F30D}',
    fields: [
      { name: 'substance', label: 'Substance / Material', type: 'text' },
      { name: 'volume', label: 'Estimated Volume', type: 'text' },
      { name: 'containment_action', label: 'Containment Action Taken', type: 'textarea', full: true },
    ],
  },
  'Emergency Preparedness': {
    icon: '\u{1F6A2}',
    fields: [
      { name: 'drill_type', label: 'Drill / Exercise Type', type: 'text' },
      { name: 'response_time', label: 'Response Time', type: 'text' },
      { name: 'findings', label: 'Findings', type: 'textarea', full: true },
    ],
  },
  'First Aid': {
    icon: '\u{1FA79}',
    fields: [
      { name: 'injury_description', label: 'Injury Description', type: 'textarea', full: true },
      { name: 'treatment_given', label: 'Treatment Given', type: 'textarea', full: true },
      { name: 'treated_by', label: 'Treated By', type: 'text' },
      { name: 'hospital_referral', label: 'Referred to Hospital', type: 'select', options: ['No', 'Yes'] },
    ],
  },
  'Fitness for Work': {
    icon: '\u{1F4AA}',
    fields: [
      { name: 'employee_name', label: 'Employee Name', type: 'text' },
      { name: 'fatigue_level', label: 'Self-Assessed Fatigue Level', type: 'select', options: ['Low', 'Moderate', 'High'] },
      { name: 'fit_for_work', label: 'Fit for Work', type: 'select', options: ['Yes', 'No'] },
    ],
  },
  'Permit to Work': {
    icon: '\u{1F4DD}',
    fields: [
      { name: 'permit_type', label: 'Permit Type', type: 'select', options: ['Hot Work', 'Confined Space', 'Excavation', 'Working at Height', 'Electrical Isolation', 'Other'] },
      { name: 'permit_number', label: 'Permit Number', type: 'text' },
      { name: 'valid_from', label: 'Valid From', type: 'datetime-local' },
      { name: 'valid_to', label: 'Valid To', type: 'datetime-local' },
      { name: 'issued_by', label: 'Issued By', type: 'text' },
    ],
  },
  'Site Induction': {
    icon: '\u{1F393}',
    fields: [
      { name: 'person_inducted', label: 'Person Inducted', type: 'text' },
      { name: 'competencies', label: 'Competencies Verified', type: 'textarea', full: true },
      { name: 'induction_valid_until', label: 'Valid Until', type: 'date' },
    ],
  },
  'Waste/Housekeeping': {
    icon: '\u{1F9F9}',
    fields: [
      { name: 'area', label: 'Area Inspected', type: 'text' },
      { name: 'issues_found', label: 'Issues Found', type: 'textarea', full: true },
    ],
  },
  'Weather/Ground Conditions': {
    icon: '⛅',
    fields: [
      { name: 'weather', label: 'Weather Description', type: 'text' },
      { name: 'ground_condition', label: 'Ground Condition Rating', type: 'select', options: ['Good', 'Fair', 'Poor - Unsafe'] },
      { name: 'work_suspended', label: 'Work Suspended', type: 'select', options: ['No', 'Yes'] },
    ],
  },
  'Corrective Action': {
    icon: '\u{1F527}',
    fields: [{ name: 'action_description', label: 'Action Description', type: 'textarea', full: true }],
  },
};

function hseFieldInputHtml(f, value) {
  const wrap = f.full ? 'full' : '';
  value = value ?? '';
  if (f.type === 'select') {
    return `<div class="${wrap}"><label>${esc(f.label)}</label><select name="hf_${f.name}">${f.options
      .map((o) => `<option ${o === value ? 'selected' : ''}>${esc(o)}</option>`)
      .join('')}</select></div>`;
  }
  if (f.type === 'textarea') {
    return `<div class="${wrap}"><label>${esc(f.label)}</label><textarea name="hf_${f.name}">${esc(value)}</textarea></div>`;
  }
  return `<div class="${wrap}"><label>${esc(f.label)}</label><input type="${f.type}"${numStep(f.type)} name="hf_${f.name}" value="${esc(value)}" /></div>`;
}

function hseCategoryFieldsHtml(category, details) {
  const config = HSE_CATEGORIES[category];
  details = details || {};
  if (!config) return '';
  return config.fields.map((f) => hseFieldInputHtml(f, details[f.name])).join('');
}

function hseProjectOptionsHtml(projects, selected) {
  return (
    `<option value="">&mdash; General / Not project-specific &mdash;</option>` +
    projects.map((p) => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}</option>`).join('')
  );
}

function hseModalFieldsHtml(record, projects) {
  record = record || {};
  const category = record.category || 'Toolbox Talk';
  return `
    <div class="full">
      <label>Category *</label>
      <select name="category" id="hse-category-select">
        ${Object.keys(HSE_CATEGORIES)
          .map((c) => `<option ${c === category ? 'selected' : ''}>${c}</option>`)
          .join('')}
      </select>
    </div>
    <div><label>Date *</label><input type="date" name="date" required value="${esc(record.date || todayStr())}" /></div>
    <div><label>Project</label><select name="project_id">${hseProjectOptionsHtml(projects, record.project_id)}</select></div>
    <div><label>Location on Site</label><input name="location" value="${esc(record.location || '')}" placeholder="e.g. Near BH-03, laydown area" /></div>
    <div>
      <label>Risk / Severity</label>
      <select name="severity">
        ${['Low', 'Medium', 'High', 'Critical'].map((s) => `<option ${s === (record.severity || 'Low') ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
    </div>
    <div class="full"><label>Description / Notes</label><textarea name="description">${esc(record.description || '')}</textarea></div>
    <div class="full form-grid" id="hse-category-fields">${hseCategoryFieldsHtml(category, record.details)}</div>
    <div class="full"><label>Immediate Action Taken</label><textarea name="immediate_action">${esc(record.immediate_action || '')}</textarea></div>
    <div class="full"><label>Root Cause (if applicable)</label><textarea name="root_cause">${esc(record.root_cause || '')}</textarea></div>
    <div class="full"><label>Corrective / Preventive Action</label><textarea name="corrective_action">${esc(record.corrective_action || '')}</textarea></div>
    <div><label>Witnesses</label><input name="witnesses" value="${esc(record.witnesses || '')}" /></div>
    <div><label>Reported By</label><input name="reported_by" value="${esc(record.reported_by || currentUser.name)}" /></div>
    <div><label>Responsible Person</label><input name="responsible_person" value="${esc(record.responsible_person || '')}" /></div>
    <div><label>Action Due Date</label><input type="date" name="due_date" value="${esc(record.due_date || '')}" /></div>
    <div>
      <label>Status</label>
      <select name="status">
        ${['Open', 'In Progress', 'Closed'].map((s) => `<option ${s === (record.status || 'Open') ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
    </div>
    <div><label>Closed Date</label><input type="date" name="closed_date" value="${esc(record.closed_date || '')}" /></div>
    <div><label>Approved / Signed Off By</label><input name="approved_by" value="${esc(record.approved_by || '')}" placeholder="Supervisor name" /></div>
    <div class="item"><span class="label">Sign-off Timestamp</span>${fmt(record.approved_at)}</div>
    <input type="hidden" name="details" value="" />
  `;
}

function wireHseModal(form) {
  const categorySelect = form.querySelector('#hse-category-select');
  const fieldsContainer = form.querySelector('#hse-category-fields');
  const detailsInput = form.querySelector('[name="details"]');

  function syncDetails() {
    const config = HSE_CATEGORIES[categorySelect.value];
    const details = {};
    if (config) {
      config.fields.forEach((f) => {
        const input = form.querySelector(`[name="hf_${f.name}"]`);
        if (input) details[f.name] = input.value;
      });
    }
    detailsInput.value = JSON.stringify(details);
  }

  categorySelect.addEventListener('change', () => {
    fieldsContainer.innerHTML = hseCategoryFieldsHtml(categorySelect.value, {});
    syncDetails();
  });
  // Sync on every keystroke/change within the dynamic fields so the hidden
  // `details` input is always current by the time the form's submit handler
  // (attached earlier, by openModal) reads it via FormData.
  fieldsContainer.addEventListener('input', syncDetails);
  fieldsContainer.addEventListener('change', syncDetails);
  syncDetails();
}

function iconColor(id) {
  return ICON_COLORS[id % ICON_COLORS.length];
}

function initial(name) {
  return (name || '?').trim().charAt(0).toUpperCase();
}

function canWrite() {
  return currentUser && (currentUser.role === 'Admin' || currentUser.role === 'Field');
}

function isAdmin() {
  return currentUser && currentUser.role === 'Admin';
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ================================================================
// Auth
// ================================================================

async function boot() {
  try {
    const res = await fetch('/api/auth/status');
    if (!res.ok) throw new Error(`Server responded with ${res.status}`);
    const status = await res.json();
    if (status.needsSetup) return showSetupScreen();
    if (!status.user) return showLoginScreen();
    currentUser = status.user;
    await loadLookups();
    showApp();
  } catch (err) {
    showAuth(`
      <div class="auth-card">
        <div class="brand"><img class="brand-logo" src="assets/geocorelytics-logo.png" alt="GeoCorelytics" /></div>
        <h2>Can't reach the server</h2>
        <p class="auth-subtitle">GeoCorelytics couldn't connect to its backend. Make sure the server is running (<code>npm start</code>), then reload this page.</p>
        <button type="button" class="primary" style="width:100%;padding:11px;" onclick="location.reload()">Retry</button>
      </div>
    `);
  }
}

function showAuth(html) {
  shellEl.classList.add('hidden');
  authRoot.classList.remove('hidden');
  authRoot.innerHTML = html;
}

function showApp() {
  authRoot.classList.add('hidden');
  shellEl.classList.remove('hidden');
  renderUserChip();
  renderSidenav();
  router();
}

function showLoginScreen(errorMsg) {
  showAuth(`
    <div class="auth-card">
      <div class="brand"><img class="brand-logo" src="assets/geocorelytics-logo.png" alt="GeoCorelytics" /></div>
      <h2>Sign in</h2>
      <p class="auth-subtitle">Geotechnical drilling management system</p>
      ${errorMsg ? `<div class="auth-error">${esc(errorMsg)}</div>` : ''}
      <form id="login-form">
        <div><label>Email</label><input type="email" name="email" required autofocus /></div>
        <div><label>Password</label><input type="password" name="password" required /></div>
        <button type="submit" class="primary">Sign In</button>
      </form>
      <p class="auth-alt">Need an account? Contact your GeoCorelytics administrator.</p>
    </div>
  `);
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    try {
      const user = await api('POST', '/api/auth/login', data);
      currentUser = user;
      await loadLookups();
      showApp();
    } catch (err) {
      showLoginScreen(err.message);
    }
  });
}

function showSetupScreen(errorMsg) {
  showAuth(`
    <div class="auth-card">
      <div class="brand"><img class="brand-logo" src="assets/geocorelytics-logo.png" alt="GeoCorelytics" /></div>
      <h2>Create Admin Account</h2>
      <p class="auth-subtitle">First-time setup &mdash; this account will have full Admin access</p>
      ${errorMsg ? `<div class="auth-error">${esc(errorMsg)}</div>` : ''}
      <form id="setup-form">
        <div><label>Full Name</label><input name="name" required autofocus /></div>
        <div><label>Email</label><input type="email" name="email" required /></div>
        <div><label>Password (min 8 characters)</label><input type="password" name="password" minlength="8" required /></div>
        <div><label>Confirm Password</label><input type="password" name="confirm" minlength="8" required /></div>
        <button type="submit" class="primary">Create Account &amp; Sign In</button>
      </form>
    </div>
  `);
  document.getElementById('setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    if (data.password !== data.confirm) return showSetupScreen('Passwords do not match');
    try {
      const user = await api('POST', '/api/auth/setup', data);
      currentUser = user;
      await loadLookups();
      showApp();
    } catch (err) {
      showSetupScreen(err.message);
    }
  });
}

async function logout() {
  try {
    await api('POST', '/api/auth/logout');
  } catch (_) {}
  currentUser = null;
  showLoginScreen();
}

function renderUserChip() {
  const chip = document.getElementById('user-chip');
  chip.innerHTML = `
    <div class="user-chip-avatar">${initial(currentUser.name)}</div>
    <div class="user-chip-body">
      <div class="user-chip-name">${esc(currentUser.name)}</div>
      <div class="user-chip-role">${esc(currentUser.role)}</div>
    </div>
    <button id="logout-btn">Logout</button>
  `;
  document.getElementById('logout-btn').addEventListener('click', logout);
}

// ---------- Sidebar ----------

function navLink(item) {
  return `<a href="${item.href}" data-nav="${item.key}"><span class="nav-icon">${item.icon}</span>${esc(item.label)}</a>`;
}

function renderSidenav() {
  let html = `<div class="nav-section-label">Menu</div>`;
  html += [
    { key: 'dashboard', href: '#/', icon: '&#9635;', label: 'Dashboard' },
    { key: 'projects', href: '#/projects', icon: '&#128193;', label: 'Projects' },
    { key: 'analytics', href: '#/analytics', icon: '&#128200;', label: 'Analytics' },
  ]
    .map(navLink)
    .join('');

  if (canWrite()) {
    html += `<div class="nav-section-label">Registers</div>`;
    html += [
      { key: 'registers-samples', href: '#/registers/samples', icon: '&#129514;', label: 'Samples' },
      { key: 'registers-tests', href: '#/registers/tests', icon: '&#128202;', label: 'Tests' },
      { key: 'registers-hse', href: '#/registers/hse', icon: '&#9888;', label: 'HSE' },
      { key: 'registers-equipment', href: '#/registers/equipment', icon: '&#128736;', label: 'Equipment' },
      { key: 'registers-timesheets', href: '#/registers/timesheets', icon: '&#128337;', label: 'Timesheets' },
    ]
      .map(navLink)
      .join('');
  }

  if (isAdmin()) {
    html += `<div class="nav-section-label">Admin</div>`;
    html += navLink({ key: 'users', href: '#/users', icon: '&#128100;', label: 'Users' });
    html += navLink({ key: 'lookups', href: '#/lookups', icon: '&#128203;', label: 'Vocabularies' });
  }

  document.getElementById('sidenav').innerHTML = html;
}

function setActiveNav(section) {
  document.querySelectorAll('#sidenav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === section);
  });
}

// ---------- Global search ----------

let searchDebounce;

function hideSearchResults() {
  searchResultsEl.classList.add('hidden');
  searchResultsEl.innerHTML = '';
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  const q = searchInput.value.trim();
  if (!q) return hideSearchResults();
  searchDebounce = setTimeout(async () => {
    const results = await api('GET', `/api/search?q=${encodeURIComponent(q)}`);
    renderSearchResults(results);
  }, 200);
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-wrap')) hideSearchResults();
});

function renderSearchResults({ projects, boreholes }) {
  if (projects.length === 0 && boreholes.length === 0) {
    searchResultsEl.innerHTML = `<div class="search-empty">No matches found</div>`;
    searchResultsEl.classList.remove('hidden');
    return;
  }
  let html = '';
  if (projects.length) {
    html += `<div class="search-group-label">Projects</div>`;
    html += projects
      .map(
        (p) => `
      <div class="search-item" data-href="#/projects/${p.id}">
        <span class="primary-text">${esc(p.name)}</span>
        <span class="secondary-text">${esc(p.client || '')}</span>
      </div>`
      )
      .join('');
  }
  if (boreholes.length) {
    html += `<div class="search-group-label">Boreholes</div>`;
    html += boreholes
      .map(
        (b) => `
      <div class="search-item" data-href="#/boreholes/${b.id}">
        <span class="primary-text">${esc(b.code)}</span>
        <span class="secondary-text">${esc(b.project_name)}</span>
      </div>`
      )
      .join('');
  }
  searchResultsEl.innerHTML = html;
  searchResultsEl.classList.remove('hidden');
  searchResultsEl.querySelectorAll('.search-item').forEach((item) => {
    item.addEventListener('click', () => {
      location.hash = item.dataset.href;
      searchInput.value = '';
      hideSearchResults();
    });
  });
}

// ================================================================
// Router
// ================================================================

function setBreadcrumb(items) {
  breadcrumbEl.innerHTML = items
    .map((item, i) => {
      if (i === items.length - 1) return `<span class="current">${esc(item.label)}</span>`;
      return `<a href="${item.href}">${esc(item.label)}</a><span>/</span>`;
    })
    .join(' ');
}

function accessDenied() {
  appEl.innerHTML = `<div class="empty-state">You don't have access to this page.</div>`;
}

async function router() {
  const hash = location.hash.slice(1) || '/';
  let m;
  try {
    if (hash === '/projects') {
      setActiveNav('projects');
      return await renderProjectsList();
    }
    if ((m = hash.match(/^\/projects\/(\d+)\/report$/))) {
      setActiveNav('projects');
      return await renderProjectReport(Number(m[1]));
    }
    if ((m = hash.match(/^\/projects\/(\d+)$/))) {
      setActiveNav('projects');
      return await renderProjectDetail(Number(m[1]));
    }
    if ((m = hash.match(/^\/boreholes\/(\d+)$/))) {
      setActiveNav('projects');
      return await renderBoreholeDetail(Number(m[1]));
    }
    if (hash === '/registers/samples') {
      setActiveNav('registers-samples');
      if (!canWrite()) return accessDenied();
      return await renderSamplesRegister();
    }
    if (hash === '/registers/tests') {
      setActiveNav('registers-tests');
      if (!canWrite()) return accessDenied();
      return await renderTestsRegister();
    }
    if (hash === '/registers/hse') {
      setActiveNav('registers-hse');
      if (!canWrite()) return accessDenied();
      return await renderHseRegister();
    }
    if (hash === '/registers/equipment') {
      setActiveNav('registers-equipment');
      if (!canWrite()) return accessDenied();
      return await renderEquipmentRegister();
    }
    if (hash === '/registers/timesheets') {
      setActiveNav('registers-timesheets');
      if (!canWrite()) return accessDenied();
      return await renderTimesheetsRegister();
    }
    if (hash.startsWith('/analytics')) {
      setActiveNav('analytics');
      return await renderAnalyticsPage();
    }
    if (hash === '/users') {
      setActiveNav('users');
      if (!isAdmin()) return accessDenied();
      return await renderUsersPage();
    }
    if (hash === '/lookups') {
      setActiveNav('lookups');
      if (!isAdmin()) return accessDenied();
      return await renderLookupsPage();
    }
    setActiveNav('dashboard');
    if (currentUser.role === 'Field') return await renderFieldDashboard();
    return await renderDashboard();
  } catch (err) {
    appEl.innerHTML = `<div class="empty-state">Error: ${esc(err.message)}</div>`;
  }
}

window.addEventListener('hashchange', router);
window.addEventListener('DOMContentLoaded', boot);

// ================================================================
// Field quick-capture dashboard
// ================================================================

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function fdLogSession(text) {
  const log = document.getElementById('fd-session-log');
  if (!log) return;
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const row = document.createElement('div');
  row.className = 'attachment-row';
  row.innerHTML = `<span class="file-name">${esc(text)}</span><span class="file-meta">${time}</span>`;
  if (log.classList.contains('empty-state')) {
    log.classList.remove('empty-state');
    log.textContent = '';
  }
  log.prepend(row);
}

async function renderFieldDashboard() {
  setBreadcrumb([{ label: 'Quick Capture', href: '#/' }]);
  const projects = await api('GET', '/api/projects');

  let selectedProjectId = null;
  let selectedBoreholeId = null;

  appEl.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Quick Capture</h1>
        <p class="subtitle">Pick a project and borehole, then log data in a couple of taps</p>
      </div>
    </div>

    <div class="panel">
      <div class="fd-picker">
        <div>
          <label>Project</label>
          <select id="fd-project">
            <option value="">Select a project&hellip;</option>
            ${projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label>Borehole</label>
          <select id="fd-borehole" disabled>
            <option value="">Select a project first&hellip;</option>
          </select>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-header"><h2>Borehole Data</h2></div>
      <div class="fd-grid">
        <button class="fd-card" id="fd-run-btn" disabled>
          <div class="fd-card-icon">&#9881;</div>
          <div class="fd-card-title">Drilling Run</div>
          <div class="fd-card-sub">Log the advance &mdash; do this first</div>
        </button>
        <button class="fd-card" id="fd-log-btn" disabled>
          <div class="fd-card-icon">&#128203;</div>
          <div class="fd-card-title">Stratigraphy Log</div>
          <div class="fd-card-sub">Record a soil/rock layer</div>
        </button>
        <button class="fd-card" id="fd-sample-btn" disabled>
          <div class="fd-card-icon">&#129514;</div>
          <div class="fd-card-title">Sample</div>
          <div class="fd-card-sub">Log a sample taken</div>
        </button>
        <button class="fd-card" id="fd-test-btn" disabled>
          <div class="fd-card-icon">&#128202;</div>
          <div class="fd-card-title">In-situ Test</div>
          <div class="fd-card-sub">Falling Head / Packer Test</div>
        </button>
      </div>
    </div>

    <div class="section">
      <div class="section-header"><h2>Project Data</h2></div>
      <div class="fd-grid">
        <button class="fd-card" id="fd-timesheet-btn" disabled>
          <div class="fd-card-icon">&#128337;</div>
          <div class="fd-card-title">Timesheet</div>
          <div class="fd-card-sub">Log hours worked today</div>
        </button>
        <button class="fd-card" id="fd-hse-btn" disabled>
          <div class="fd-card-icon">&#9888;</div>
          <div class="fd-card-title">HSE Record</div>
          <div class="fd-card-sub">Report an incident or observation</div>
        </button>
      </div>
    </div>

    <div class="section">
      <div class="section-header"><h2>Captured This Session</h2></div>
      <div id="fd-session-log" class="empty-state">Nothing captured yet &mdash; entries you add will show up here.</div>
    </div>
  `;

  const projectSelect = document.getElementById('fd-project');
  const boreholeSelect = document.getElementById('fd-borehole');
  const runBtn = document.getElementById('fd-run-btn');
  const logBtn = document.getElementById('fd-log-btn');
  const sampleBtn = document.getElementById('fd-sample-btn');
  const testBtn = document.getElementById('fd-test-btn');
  const timesheetBtn = document.getElementById('fd-timesheet-btn');
  const hseBtn = document.getElementById('fd-hse-btn');

  projectSelect.addEventListener('change', async () => {
    selectedProjectId = projectSelect.value || null;
    selectedBoreholeId = null;
    boreholeSelect.innerHTML = `<option value="">Loading&hellip;</option>`;
    boreholeSelect.disabled = true;
    runBtn.disabled = true;
    logBtn.disabled = true;
    sampleBtn.disabled = true;
    testBtn.disabled = true;
    timesheetBtn.disabled = !selectedProjectId;
    hseBtn.disabled = !selectedProjectId;

    if (!selectedProjectId) {
      boreholeSelect.innerHTML = `<option value="">Select a project first&hellip;</option>`;
      return;
    }
    const boreholes = await api('GET', `/api/projects/${selectedProjectId}/boreholes`);
    boreholeSelect.innerHTML =
      `<option value="">Select a borehole&hellip;</option>` +
      boreholes.map((b) => `<option value="${b.id}">${esc(b.code)}</option>`).join('');
    boreholeSelect.disabled = false;
  });

  boreholeSelect.addEventListener('change', () => {
    selectedBoreholeId = boreholeSelect.value || null;
    runBtn.disabled = !selectedBoreholeId;
    logBtn.disabled = !selectedBoreholeId;
    sampleBtn.disabled = !selectedBoreholeId;
    testBtn.disabled = !selectedBoreholeId;
  });

  function boreholeLabel() {
    return boreholeSelect.options[boreholeSelect.selectedIndex]?.text || '';
  }
  function projectLabel() {
    return projectSelect.options[projectSelect.selectedIndex]?.text || '';
  }

  logBtn.addEventListener('click', async () => {
    const existingLogs = await api('GET', `/api/boreholes/${selectedBoreholeId}/logs`);
    const lastEnd = lastEndDepth(existingLogs);
    const form = openModal({
      title: `Add Stratigraphy Log — ${boreholeLabel()}`,
      submitLabel: 'Add Entry',
      fieldsHtml: `
        ${depthFieldsHtml(lastEnd)}
        <div class="full"><label>Description</label><input name="description" placeholder="e.g. Firm brown clay, some gravel" /></div>
        <div><label>USCS Classification</label><input name="uscs_class" placeholder="e.g. CL, SM, GP" /></div>
      `,
      onSubmit: async (data) => {
        await api('POST', `/api/boreholes/${selectedBoreholeId}/logs`, data);
        toast('Log entry added');
        fdLogSession(`Log: ${data.depth_from}–${data.depth_to} m on ${boreholeLabel()}`);
      },
    });
    wireDepthContinuity(form, lastEnd);
  });

  runBtn.addEventListener('click', async () => {
    await openRunModal(selectedBoreholeId, null, (saved) => {
      fdLogSession(`Drilling run ${saved.run_number} — ${saved.depth_from}–${saved.depth_to} m on ${boreholeLabel()}`);
    });
  });

  sampleBtn.addEventListener('click', async () => {
    const ctx = await api('GET', `/api/boreholes/${selectedBoreholeId}/next-interval?kind=sample`);
    const lastEnd = ctx.suggested_from;
    const form = openModal({
      title: `Add Sample — ${boreholeLabel()}`,
      submitLabel: 'Add Sample',
      fieldsHtml: sampleModalFieldsHtml(lastEnd, { operator_name: ctx.defaults.operator_name, date: ctx.defaults.date }),
      onSubmit: async (data) => {
        data.sample_data = data.sample_data ? JSON.parse(data.sample_data) : null;
        await api('POST', `/api/boreholes/${selectedBoreholeId}/samples`, data);
        await submitCustomLookups(form);
        toast('Sample added');
        fdLogSession(`${data.sample_type} sample ${data.depth_from}–${data.depth_to} m on ${boreholeLabel()}`);
      },
    });
    wireSampleModal(form, lastEnd, ctx);
  });

  testBtn.addEventListener('click', async () => {
    const ctx = await api('GET', `/api/boreholes/${selectedBoreholeId}/next-interval?kind=test`);
    const lastEnd = ctx.suggested_from;
    const form = openModal({
      title: `Add In-situ Test — ${boreholeLabel()}`,
      submitLabel: 'Add Test',
      fieldsHtml: testModalFieldsHtml(lastEnd, { conducted_by: ctx.defaults.operator_name, date: ctx.defaults.date }),
      onSubmit: async (data) => {
        data.test_data = data.test_data ? JSON.parse(data.test_data) : null;
        await api('POST', `/api/boreholes/${selectedBoreholeId}/tests`, data);
        await submitCustomLookups(form);
        toast('Test added');
        fdLogSession(`${data.test_type} on ${boreholeLabel()}`);
      },
    });
    wireTestModal(form, lastEnd, ctx);
  });

  timesheetBtn.addEventListener('click', () => {
    openModal({
      title: `Log Timesheet — ${projectLabel()}`,
      submitLabel: 'Add Entry',
      fieldsHtml: `
        <div><label>Person Name *</label><input name="person_name" required value="${esc(currentUser.name)}" /></div>
        <div><label>Date *</label><input type="date" name="date" required value="${todayStr()}" /></div>
        <div><label>Hours *</label><input type="number" step="any" name="hours" required /></div>
        <div class="full"><label>Task Description</label><input name="task_description" /></div>
      `,
      onSubmit: async (data) => {
        await api('POST', '/api/timesheets', { ...data, project_id: selectedProjectId });
        toast('Timesheet entry added');
        fdLogSession(`Timesheet: ${data.hours}h on ${projectLabel()}`);
      },
    });
  });

  hseBtn.addEventListener('click', () => {
    const form = openModal({
      title: `Report HSE Record — ${projectLabel()}`,
      submitLabel: 'Submit Record',
      fieldsHtml: hseModalFieldsHtml({ project_id: Number(selectedProjectId), reported_by: currentUser.name }, projects),
      onSubmit: async (data) => {
        data.details = data.details ? JSON.parse(data.details) : null;
        await api('POST', '/api/hse', data);
        toast('HSE record submitted');
        fdLogSession(`HSE (${data.category}) on ${projectLabel()}`);
      },
    });
    wireHseModal(form);
  });
}

// ================================================================
// Dashboard
// ================================================================

async function renderDashboard() {
  setBreadcrumb([{ label: 'Dashboard', href: '#/' }]);
  const [stats, projects] = await Promise.all([api('GET', '/api/stats'), api('GET', '/api/projects')]);
  const recent = projects.slice(0, 5);

  const segments = [
    { color: 'var(--green)', label: 'Complete', value: stats.boreholes_complete },
    { color: 'var(--blue)', label: 'In Progress', value: stats.boreholes_in_progress },
    { color: 'var(--amber)', label: 'Planned', value: stats.boreholes_planned },
  ];
  const accounted = segments.reduce((sum, s) => sum + s.value, 0);
  const other = stats.total_boreholes - accounted;
  if (other > 0) segments.push({ color: '#d7dbd8', label: 'Other', value: other });

  let ringCss = '#e9ebe8';
  let pct = 0;
  if (stats.total_boreholes > 0) {
    let cursor = 0;
    const stops = [];
    segments.forEach((s) => {
      const start = cursor;
      const end = cursor + (s.value / stats.total_boreholes) * 100;
      stops.push(`${s.color} ${start}% ${end}%`);
      cursor = end;
    });
    ringCss = stops.join(', ');
    pct = Math.round((stats.boreholes_complete / stats.total_boreholes) * 100);
  }

  appEl.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Dashboard</h1>
        <p class="subtitle">Overview of your geotechnical drilling projects</p>
      </div>
      ${canWrite() ? `<button class="primary" id="new-project-btn">+ New Project</button>` : ''}
    </div>

    <div class="stat-grid">
      <div class="stat-card featured">
        <div class="stat-head"><span>Total Projects</span><span class="stat-icon">&#8599;</span></div>
        <div class="stat-value">${stats.total_projects}</div>
        <div class="stat-foot">${stats.active_projects} active</div>
      </div>
      <div class="stat-card">
        <div class="stat-head"><span>Total Boreholes</span><span class="stat-icon">&#8599;</span></div>
        <div class="stat-value">${stats.total_boreholes}</div>
        <div class="stat-foot">${stats.boreholes_in_progress} in progress</div>
      </div>
      <div class="stat-card">
        <div class="stat-head"><span>Boreholes Complete</span><span class="stat-icon">&#8599;</span></div>
        <div class="stat-value">${stats.boreholes_complete}</div>
        <div class="stat-foot">${stats.boreholes_planned} planned</div>
      </div>
      <div class="stat-card">
        <div class="stat-head"><span>Samples Pending Lab</span><span class="stat-icon">&#8599;</span></div>
        <div class="stat-value">${stats.samples_pending}</div>
        <div class="stat-foot">${stats.total_samples} total samples</div>
      </div>
    </div>

    <div class="dash-grid">
      <div class="panel">
        <div class="panel-header">
          <h2>Recent Projects</h2>
          <a href="#/projects" style="font-size:0.82rem;color:var(--green-dark);text-decoration:none;font-weight:600;">View all</a>
        </div>
        <div class="recent-list">
          ${
            recent.length === 0
              ? `<div class="empty-state">No projects yet.</div>`
              : recent
                  .map(
                    (p) => `
              <a class="recent-item" href="#/projects/${p.id}">
                <span class="project-icon" style="background:${iconColor(p.id)}">${initial(p.name)}</span>
                <span class="recent-item-body">
                  <span class="recent-item-title">${esc(p.name)}</span><br/>
                  <span class="recent-item-sub">${esc(p.client || 'No client')}</span>
                </span>
                ${statusBadge(p.status)}
              </a>`
                  )
                  .join('')
          }
        </div>
      </div>

      <div class="panel">
        <div class="panel-header"><h2>Borehole Progress</h2></div>
        <div class="ring-wrap">
          <div class="ring" style="background: conic-gradient(${ringCss})">
            <div class="ring-center">
              <span class="ring-value">${pct}%</span>
              <span class="ring-label">Complete</span>
            </div>
          </div>
          <div class="ring-legend">
            ${segments
              .filter((s) => s.value > 0)
              .map((s) => `<span><span class="dot" style="background:${s.color}"></span>${s.label} (${s.value})</span>`)
              .join('')}
          </div>
        </div>
      </div>
    </div>
  `;

  if (canWrite()) document.getElementById('new-project-btn').addEventListener('click', openNewProjectModal);
}

// ================================================================
// Projects
// ================================================================

function openNewProjectModal() {
  openModal({
    title: 'New Project',
    submitLabel: 'Create Project',
    fieldsHtml: `
      <div class="full"><label>Project Name *</label><input name="name" required /></div>
      <div><label>Client</label><input name="client" /></div>
      <div><label>Location</label><input name="location" /></div>
      <div><label>Start Date</label><input type="date" name="start_date" /></div>
      <div>
        <label>Status</label>
        <select name="status">
          <option>Active</option>
          <option>Planned</option>
          <option>On Hold</option>
          <option>Complete</option>
        </select>
      </div>
      <div class="full"><label>Notes</label><textarea name="notes"></textarea></div>
    `,
    onSubmit: async (data) => {
      const project = await api('POST', '/api/projects', data);
      toast('Project created');
      location.hash = `#/projects/${project.id}`;
    },
  });
}

async function renderProjectsList() {
  setBreadcrumb([{ label: 'Projects', href: '#/projects' }]);
  const projects = await api('GET', '/api/projects');

  appEl.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Projects</h1>
        <p class="subtitle">Geotechnical drilling projects and sites</p>
      </div>
      ${canWrite() ? `<button class="primary" id="new-project-btn">+ New Project</button>` : ''}
    </div>
    ${
      projects.length === 0
        ? `<div class="empty-state">No projects yet.</div>`
        : `<table>
            <thead>
              <tr><th>Name</th><th>Client</th><th>Location</th><th>Start Date</th><th>Status</th></tr>
            </thead>
            <tbody>
              ${projects
                .map(
                  (p) => `
                <tr class="clickable" data-id="${p.id}">
                  <td>${esc(p.name)}</td>
                  <td>${fmt(p.client)}</td>
                  <td>${fmt(p.location)}</td>
                  <td>${fmt(p.start_date)}</td>
                  <td>${statusBadge(p.status)}</td>
                </tr>`
                )
                .join('')}
            </tbody>
          </table>`
    }
  `;

  appEl.querySelectorAll('tbody tr.clickable').forEach((row) => {
    row.addEventListener('click', () => {
      location.hash = `#/projects/${row.dataset.id}`;
    });
  });

  if (canWrite()) document.getElementById('new-project-btn').addEventListener('click', openNewProjectModal);
}

async function renderProjectDetail(id) {
  const project = await api('GET', `/api/projects/${id}`);
  const boreholes = await api('GET', `/api/projects/${id}/boreholes`);

  setBreadcrumb([
    { label: 'Projects', href: '#/projects' },
    { label: project.name, href: `#/projects/${id}` },
  ]);

  appEl.innerHTML = `
    <div class="page-header">
      <div>
        <h1>${esc(project.name)}</h1>
        <p class="subtitle">${fmt(project.client)} &middot; ${fmt(project.location)}</p>
      </div>
      <div class="actions-cell">
        <button id="view-report-btn">View Report</button>
        ${canWrite() ? `<button id="edit-project-btn">Edit</button>` : ''}
        ${isAdmin() ? `<button class="danger" id="delete-project-btn">Delete</button>` : ''}
      </div>
    </div>

    <div class="meta-grid">
      <div class="item"><span class="label">Status</span>${statusBadge(project.status)}</div>
      <div class="item"><span class="label">Start Date</span>${fmt(project.start_date)}</div>
      <div class="item"><span class="label">Boreholes</span>${project.borehole_count}</div>
      <div class="item"><span class="label">Notes</span>${fmt(project.notes)}</div>
    </div>

    <div class="section">
      <div class="section-header">
        <h2>Boreholes</h2>
        ${canWrite() ? `<button class="primary" id="new-borehole-btn">+ New Borehole</button>` : ''}
      </div>
      ${
        boreholes.length === 0
          ? `<div class="empty-state">No boreholes logged yet for this project.</div>`
          : `<table>
              <thead>
                <tr><th>Code</th><th>Total Depth</th><th>Method</th><th>Start</th><th>End</th><th>Status</th></tr>
              </thead>
              <tbody>
                ${boreholes
                  .map(
                    (b) => `
                  <tr class="clickable" data-id="${b.id}">
                    <td>${esc(b.code)}</td>
                    <td class="depth-cell">${fmt(b.total_depth, ' m')}</td>
                    <td>${fmt(b.drill_method)}</td>
                    <td>${fmt(b.start_date)}</td>
                    <td>${fmt(b.end_date)}</td>
                    <td>${statusBadge(b.status)}</td>
                  </tr>`
                  )
                  .join('')}
              </tbody>
            </table>`
      }
    </div>

    <div class="section">
      <div class="section-header"><h2>Site Map</h2></div>
      <div id="site-map-container"></div>
    </div>

    <div class="section">
      <div class="section-header"><h2>Project Files</h2></div>
      <div id="attachments-container"></div>
    </div>
  `;

  appEl.querySelectorAll('tbody tr.clickable').forEach((row) => {
    row.addEventListener('click', () => {
      location.hash = `#/boreholes/${row.dataset.id}`;
    });
  });

  document.getElementById('view-report-btn').addEventListener('click', () => {
    location.hash = `#/projects/${id}/report`;
  });

  renderSiteMap(document.getElementById('site-map-container'), boreholes);
  renderAttachments(document.getElementById('attachments-container'), 'project', id);

  if (canWrite()) {
    document.getElementById('edit-project-btn').addEventListener('click', () => {
      openModal({
        title: 'Edit Project',
        submitLabel: 'Save Changes',
        fieldsHtml: `
          <div class="full"><label>Project Name *</label><input name="name" required value="${esc(project.name)}" /></div>
          <div><label>Client</label><input name="client" value="${esc(project.client || '')}" /></div>
          <div><label>Location</label><input name="location" value="${esc(project.location || '')}" /></div>
          <div><label>Start Date</label><input type="date" name="start_date" value="${esc(project.start_date || '')}" /></div>
          <div>
            <label>Status</label>
            <select name="status">
              ${['Active', 'Planned', 'On Hold', 'Complete']
                .map((s) => `<option ${s === project.status ? 'selected' : ''}>${s}</option>`)
                .join('')}
            </select>
          </div>
          <div class="full"><label>Notes</label><textarea name="notes">${esc(project.notes || '')}</textarea></div>
        `,
        onSubmit: async (data) => {
          await api('PUT', `/api/projects/${id}`, data);
          toast('Project updated');
          renderProjectDetail(id);
        },
      });
    });

    document.getElementById('new-borehole-btn').addEventListener('click', () => {
      openModal({
        title: 'New Borehole',
        submitLabel: 'Create Borehole',
        fieldsHtml: `
          <div class="full"><label>Borehole Code * (e.g. BH-01)</label><input name="code" required /></div>
          <div><label>Easting</label><input type="number" step="any" name="easting" /></div>
          <div><label>Northing</label><input type="number" step="any" name="northing" /></div>
          <div><label>Elevation (m)</label><input type="number" step="any" name="elevation" /></div>
          <div><label>Total Depth (m)</label><input type="number" step="any" name="total_depth" /></div>
          <div><label>Planned Depth (m)</label><input type="number" step="any" name="planned_depth" placeholder="Target for progress tracking" /></div>
          <div><label>Planned Start</label><input type="date" name="planned_start_date" /></div>
          <div><label>Planned End</label><input type="date" name="planned_end_date" /></div>
          <div><label>Drilling Method</label><input name="drill_method" placeholder="e.g. Rotary, Auger, SPT" /></div>
          <div><label>Start Date</label><input type="date" name="start_date" /></div>
          <div><label>End Date</label><input type="date" name="end_date" /></div>
          <div>
            <label>Status</label>
            <select name="status">
              <option>Planned</option>
              <option>In Progress</option>
              <option>Complete</option>
              <option>Abandoned</option>
            </select>
          </div>
          <div class="full"><label>Notes</label><textarea name="notes"></textarea></div>
        `,
        onSubmit: async (data) => {
          const borehole = await api('POST', `/api/projects/${id}/boreholes`, data);
          toast('Borehole created');
          location.hash = `#/boreholes/${borehole.id}`;
        },
      });
    });
  }

  if (isAdmin()) {
    document.getElementById('delete-project-btn').addEventListener('click', async () => {
      if (!confirm(`Delete project "${project.name}" and all its boreholes, logs, and samples? This cannot be undone.`)) return;
      await api('DELETE', `/api/projects/${id}`);
      toast('Project deleted');
      location.hash = '#/projects';
    });
  }
}

// ---------- Site map ----------

function renderSiteMap(container, boreholes) {
  const points = boreholes.filter((b) => b.easting !== null && b.easting !== '' && b.northing !== null && b.northing !== '');
  if (points.length === 0) {
    container.innerHTML = `<div class="empty-state">No boreholes have coordinates yet. Add Easting/Northing to a borehole to see it on the site map.</div>`;
    return;
  }

  const W = 760;
  const H = 380;
  const pad = 40;
  const xs = points.map((p) => Number(p.easting));
  const ys = points.map((p) => Number(p.northing));
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;

  const scaleX = (x) => pad + ((x - minX) / spanX) * (W - pad * 2);
  const scaleY = (y) => H - pad - ((y - minY) / spanY) * (H - pad * 2);

  const statusColor = { Complete: 'var(--green)', 'In Progress': 'var(--blue)', Planned: 'var(--amber)', Abandoned: 'var(--red)' };

  const pointsHtml = points
    .map((p) => {
      const cx = points.length === 1 ? W / 2 : scaleX(Number(p.easting));
      const cy = points.length === 1 ? H / 2 : scaleY(Number(p.northing));
      const color = statusColor[p.status] || 'var(--green)';
      return `
      <g class="site-map-point" data-id="${p.id}">
        <circle cx="${cx}" cy="${cy}" r="9" style="fill:${color}"></circle>
        <text x="${cx + 13}" y="${cy + 4}">${esc(p.code)}</text>
      </g>`;
    })
    .join('');

  container.innerHTML = `
    <div class="site-map-wrap">
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="380" class="site-map-grid">
        <line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" />
        <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${H - pad}" />
        ${pointsHtml}
      </svg>
    </div>
  `;

  container.querySelectorAll('.site-map-point').forEach((g) => {
    g.addEventListener('click', () => {
      location.hash = `#/boreholes/${g.dataset.id}`;
    });
  });
}

// ---------- Attachments ----------

async function renderAttachments(container, entityType, entityId) {
  container.innerHTML = `<div class="empty-state">Loading files&hellip;</div>`;
  let files;
  try {
    files = await api('GET', `/api/attachments?entity_type=${entityType}&entity_id=${entityId}`);
  } catch (err) {
    container.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
    return;
  }

  const listHtml =
    files.length === 0
      ? `<div class="empty-state">No files attached yet.</div>`
      : `<div class="attachment-list">
          ${files
            .map(
              (f) => `
            <div class="attachment-row">
              <span class="file-name">${esc(f.original_name)}</span>
              <span class="file-meta">${formatBytes(f.size)}</span>
              <a href="/api/attachments/${f.id}/download">Download</a>
              ${canWrite() ? `<button class="link" data-delete-attachment="${f.id}">Delete</button>` : ''}
            </div>`
            )
            .join('')}
        </div>`;

  container.innerHTML =
    listHtml +
    (canWrite()
      ? `<form id="upload-form" class="upload-row">
          <input type="file" name="file" required />
          <button type="submit" class="primary">Upload</button>
        </form>`
      : '');

  container.querySelectorAll('[data-delete-attachment]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this file?')) return;
      await api('DELETE', `/api/attachments/${btn.dataset.deleteAttachment}`);
      renderAttachments(container, entityType, entityId);
    });
  });

  const uploadForm = document.getElementById('upload-form');
  if (uploadForm) {
    uploadForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fileInput = uploadForm.querySelector('input[type="file"]');
      if (!fileInput.files[0]) return;
      const formData = new FormData();
      formData.append('file', fileInput.files[0]);
      formData.append('entity_type', entityType);
      formData.append('entity_id', entityId);
      try {
        await api('POST', '/api/attachments', formData);
        toast('File uploaded');
        renderAttachments(container, entityType, entityId);
      } catch (err) {
        toast(err.message, true);
      }
    });
  }
}

// ================================================================
// Borehole detail
// ================================================================

// Live progress panel for one borehole — every figure derives from the runs
// and samples actually captured, so it moves the moment data is logged.
function boreholeProgressHtml(a, borehole) {
  const c = (a.completion || []).find((x) => x.borehole_id === borehole.id) || {};
  const h = a.headline || {};
  const dailyPoints = (a.production?.daily || []).map((d) => ({ x: d.x, y: d.y, cumulative: d.cumulative, meta: d.meta }));
  const rqd = a.groundConditions?.rqd || [];

  return `
    <div class="section">
      <div class="section-header"><h2>Progress</h2></div>
      <div class="progress-grid">
        <div class="progress-main">
          ${progressMeter(c.completion_pct, { label: `${c.current_depth ?? 0} m of ${c.target_depth ?? '—'} m`, empty: 'Set a planned or total depth to track completion' })}
          <div class="stat-row">
            <div class="mini-stat"><span class="mini-label">Metres drilled</span><strong>${h.total_metres ?? 0} m</strong></div>
            <div class="mini-stat"><span class="mini-label">Runs</span><strong>${h.total_runs ?? 0}</strong></div>
            <div class="mini-stat"><span class="mini-label">Avg / day</span><strong>${h.avg_metres_per_day ?? '—'} m</strong></div>
            <div class="mini-stat"><span class="mini-label">Core recovery</span><strong>${h.core_recovery_pct ?? '—'}%</strong></div>
            <div class="mini-stat"><span class="mini-label">Downtime</span><strong>${h.total_downtime_hours ?? 0} h</strong></div>
            <div class="mini-stat"><span class="mini-label">Est. completion</span><strong>${c.estimated_completion || '—'}</strong></div>
          </div>
        </div>
      </div>

      <div class="chart-grid">
        <div class="chart-card">
          <h3>Daily production</h3>
          ${columnChart(dailyPoints, {
            unit: ' m',
            yLabel: 'Metres drilled',
            xLabel: 'Date',
            overlay: { key: 'cumulative', label: 'Cumulative', color: '#eb6834' },
            empty: 'No dated drilling runs yet.',
            ariaLabel: 'Metres drilled per day with cumulative total',
          })}
        </div>
        <div class="chart-card">
          <h3>Sample &amp; test distribution by depth</h3>
          ${depthProfileChart(a.depthDistribution, { empty: 'No samples or tests recorded yet.' })}
        </div>
        ${
          rqd.length
            ? `<div class="chart-card"><h3>RQD with depth</h3>
                ${lineChart([{ label: 'RQD', points: rqd.map((p) => ({ x: p.x, y: p.y })) }], {
                  unit: '%',
                  xLabel: 'Depth (m)',
                  xFormat: (v) => `${v} m`,
                  ariaLabel: 'Rock quality designation against depth',
                })}</div>`
            : ''
        }
      </div>
    </div>
  `;
}

async function renderBoreholeDetail(id) {
  const borehole = await api('GET', `/api/boreholes/${id}`);
  const project = await api('GET', `/api/projects/${borehole.project_id}`);
  const logs = await api('GET', `/api/boreholes/${id}/logs`);
  const samples = await api('GET', `/api/boreholes/${id}/samples`);
  const tests = await api('GET', `/api/boreholes/${id}/tests`);
  const runs = await api('GET', `/api/boreholes/${id}/runs`);
  const bhAnalytics = await api('GET', `/api/analytics?borehole_id=${id}`);

  setBreadcrumb([
    { label: 'Projects', href: '#/projects' },
    { label: project.name, href: `#/projects/${project.id}` },
    { label: borehole.code, href: `#/boreholes/${id}` },
  ]);

  appEl.innerHTML = `
    <div class="page-header">
      <div>
        <h1>${esc(borehole.code)}</h1>
        <p class="subtitle">${esc(project.name)}</p>
      </div>
      <div class="actions-cell">
        ${canWrite() ? `<button id="edit-borehole-btn">Edit</button><button class="danger" id="delete-borehole-btn">Delete</button>` : ''}
      </div>
    </div>

    <div class="meta-grid">
      <div class="item"><span class="label">Status</span>${statusBadge(borehole.status)}</div>
      <div class="item"><span class="label">Total Depth</span>${fmt(borehole.total_depth, ' m')}</div>
      <div class="item"><span class="label">Drilling Method</span>${fmt(borehole.drill_method)}</div>
      <div class="item"><span class="label">Coordinates</span>${
        borehole.easting !== null && borehole.easting !== '' && borehole.northing !== null && borehole.northing !== ''
          ? `${esc(borehole.easting)}, ${esc(borehole.northing)}`
          : '&mdash;'
      }</div>
      <div class="item"><span class="label">Elevation</span>${fmt(borehole.elevation, ' m')}</div>
      <div class="item"><span class="label">Start &rarr; End</span>${fmt(borehole.start_date)} &rarr; ${fmt(borehole.end_date)}</div>
      <div class="item"><span class="label">Notes</span>${fmt(borehole.notes)}</div>
    </div>

    ${boreholeProgressHtml(bhAnalytics, borehole)}

    <div class="section">
      <div class="section-header">
        <h2>Drilling Runs</h2>
        ${canWrite() ? `<button class="primary" id="new-run-btn">+ Log Drilling Run</button>` : ''}
      </div>
      ${
        runs.length === 0
          ? `<div class="empty-state">No drilling runs logged yet. Log a run before capturing samples or tests &mdash; every sample links to the run it was taken from.</div>`
          : `<table>
              <thead><tr><th>Run</th><th>Depth From</th><th>Depth To</th><th>Date</th><th>Shift</th><th>Method</th><th>Rig</th><th>Operator</th><th>Core Rec.</th><th>RQD</th><th>Downtime</th>${canWrite() ? '<th></th>' : ''}</tr></thead>
              <tbody>
                ${runs
                  .map((r) => {
                    const interval = (r.depth_to ?? 0) - (r.depth_from ?? 0);
                    const recPct = r.core_recovered_m !== null && interval > 0 ? (r.core_recovered_m / interval) * 100 : null;
                    return `<tr>
                      <td><strong>${fmt(r.run_number)}</strong></td>
                      <td class="depth-cell">${r.depth_from} m</td>
                      <td class="depth-cell">${r.depth_to} m</td>
                      <td>${fmt(r.date)}</td>
                      <td>${fmt(r.shift)}</td>
                      <td>${fmt(r.drilling_method)}</td>
                      <td>${fmt(r.rig_name)}</td>
                      <td>${fmt(r.operator_name)}</td>
                      <td>${recPct === null ? '&mdash;' : `${recPct.toFixed(0)}%`}</td>
                      <td>${fmt(r.rqd_pct, '%')}</td>
                      <td>${r.downtime_min ? `${r.downtime_min} min` : '&mdash;'}</td>
                      ${canWrite() ? `<td class="actions-cell"><button class="link" data-edit-run="${r.id}">Edit</button><button class="link" data-delete-run="${r.id}">Delete</button></td>` : ''}
                    </tr>`;
                  })
                  .join('')}
              </tbody>
            </table>`
      }
    </div>

    <div class="section">
      <div class="section-header">
        <h2>Stratigraphy Log</h2>
        ${canWrite() ? `<button class="primary" id="new-log-btn">+ Add Log Entry</button>` : ''}
      </div>
      ${
        logs.length === 0
          ? `<div class="empty-state">No stratigraphy logged yet.</div>`
          : `<table>
              <thead>
                <tr><th>Depth From</th><th>Depth To</th><th>Description</th><th>USCS</th><th>Notes</th>${canWrite() ? '<th></th>' : ''}</tr>
              </thead>
              <tbody>
                ${logs
                  .map(
                    (l) => `
                  <tr>
                    <td class="depth-cell">${l.depth_from} m</td>
                    <td class="depth-cell">${l.depth_to} m</td>
                    <td>${fmt(l.description)}</td>
                    <td>${fmt(l.uscs_class)}</td>
                    <td>${fmt(l.notes)}</td>
                    ${
                      canWrite()
                        ? `<td class="actions-cell">
                      <button class="link" data-edit-log="${l.id}">Edit</button>
                      <button class="link" data-delete-log="${l.id}">Delete</button>
                    </td>`
                        : ''
                    }
                  </tr>`
                  )
                  .join('')}
              </tbody>
            </table>`
      }
    </div>

    <div class="section">
      <div class="section-header">
        <h2>Samples</h2>
        ${canWrite() ? `<button class="primary" id="new-sample-btn">+ Add Sample</button>` : ''}
      </div>
      ${
        samples.length === 0
          ? `<div class="empty-state">No samples recorded yet.</div>`
          : `<table>
              <thead>
                <tr><th>Depth</th><th>Ref</th><th>Type</th><th>N-Value</th><th>Recovery %</th><th>Lab Status</th><th>Notes</th>${canWrite() ? '<th></th>' : ''}</tr>
              </thead>
              <tbody>
                ${samples
                  .map(
                    (s) => `
                  <tr>
                    <td class="depth-cell">${s.depth_from}&ndash;${s.depth_to} m</td>
                    <td>${fmt(s.sample_ref)}</td>
                    <td>${fmt(s.sample_type)}</td>
                    <td>${fmt(s.spt_n_value)}</td>
                    <td>${fmt(s.recovery_pct, '%')}</td>
                    <td>${statusBadge(s.lab_status)}</td>
                    <td>${fmt(s.notes)}</td>
                    ${
                      canWrite()
                        ? `<td class="actions-cell">
                      <button class="link" data-edit-sample="${s.id}">Edit</button>
                      <button class="link" data-delete-sample="${s.id}">Delete</button>
                    </td>`
                        : ''
                    }
                  </tr>`
                  )
                  .join('')}
              </tbody>
            </table>`
      }
    </div>

    <div class="section">
      <div class="section-header">
        <h2>In-situ Tests</h2>
        ${canWrite() ? `<button class="primary" id="new-test-btn">+ Add Test</button>` : ''}
      </div>
      ${
        tests.length === 0
          ? `<div class="empty-state">No in-situ tests recorded yet.</div>`
          : `<table>
              <thead>
                <tr><th>Type</th><th>Depth From</th><th>Depth To</th><th>Result</th><th>Date</th><th>Conducted By</th>${canWrite() ? '<th></th>' : ''}</tr>
              </thead>
              <tbody>
                ${tests
                  .map(
                    (t) => `
                  <tr>
                    <td>${esc(t.test_type)}</td>
                    <td class="depth-cell">${fmt(t.depth_from, ' m')}</td>
                    <td class="depth-cell">${fmt(t.depth_to, ' m')}</td>
                    <td>${fmt(t.result_value)} ${fmt(t.result_unit, '')}</td>
                    <td>${fmt(t.date)}</td>
                    <td>${fmt(t.conducted_by)}</td>
                    ${
                      canWrite()
                        ? `<td class="actions-cell">
                      <button class="link" data-edit-test="${t.id}">Edit</button>
                      <button class="link" data-delete-test="${t.id}">Delete</button>
                    </td>`
                        : ''
                    }
                  </tr>`
                  )
                  .join('')}
              </tbody>
            </table>`
      }
    </div>

    <div class="section">
      <div class="section-header"><h2>Files</h2></div>
      <div id="attachments-container"></div>
    </div>
  `;

  renderAttachments(document.getElementById('attachments-container'), 'borehole', id);

  if (!canWrite()) return;

  document.getElementById('edit-borehole-btn').addEventListener('click', () => {
    openModal({
      title: 'Edit Borehole',
      submitLabel: 'Save Changes',
      fieldsHtml: `
        <div class="full"><label>Borehole Code *</label><input name="code" required value="${esc(borehole.code)}" /></div>
        <div><label>Easting</label><input type="number" step="any" name="easting" value="${fmt(borehole.easting).replace('&mdash;','')}" /></div>
        <div><label>Northing</label><input type="number" step="any" name="northing" value="${fmt(borehole.northing).replace('&mdash;','')}" /></div>
        <div><label>Elevation (m)</label><input type="number" step="any" name="elevation" value="${fmt(borehole.elevation).replace('&mdash;','')}" /></div>
        <div><label>Total Depth (m)</label><input type="number" step="any" name="total_depth" value="${fmt(borehole.total_depth).replace('&mdash;','')}" /></div>
        <div><label>Planned Depth (m)</label><input type="number" step="any" name="planned_depth" value="${fmt(borehole.planned_depth).replace('&mdash;','')}" /></div>
        <div><label>Planned Start</label><input type="date" name="planned_start_date" value="${fmt(borehole.planned_start_date).replace('&mdash;','')}" /></div>
        <div><label>Planned End</label><input type="date" name="planned_end_date" value="${fmt(borehole.planned_end_date).replace('&mdash;','')}" /></div>
        <div><label>Drilling Method</label><input name="drill_method" value="${esc(borehole.drill_method || '')}" /></div>
        <div><label>Start Date</label><input type="date" name="start_date" value="${esc(borehole.start_date || '')}" /></div>
        <div><label>End Date</label><input type="date" name="end_date" value="${esc(borehole.end_date || '')}" /></div>
        <div>
          <label>Status</label>
          <select name="status">
            ${['Planned', 'In Progress', 'Complete', 'Abandoned']
              .map((s) => `<option ${s === borehole.status ? 'selected' : ''}>${s}</option>`)
              .join('')}
          </select>
        </div>
        <div class="full"><label>Notes</label><textarea name="notes">${esc(borehole.notes || '')}</textarea></div>
      `,
      onSubmit: async (data) => {
        await api('PUT', `/api/boreholes/${id}`, data);
        toast('Borehole updated');
        renderBoreholeDetail(id);
      },
    });
  });

  document.getElementById('delete-borehole-btn').addEventListener('click', async () => {
    if (!confirm(`Delete borehole "${borehole.code}" and all its logs and samples? This cannot be undone.`)) return;
    await api('DELETE', `/api/boreholes/${id}`);
    toast('Borehole deleted');
    location.hash = `#/projects/${project.id}`;
  });

  const newRunBtn = document.getElementById('new-run-btn');
  if (newRunBtn) {
    newRunBtn.addEventListener('click', () => openRunModal(id, null, () => renderBoreholeDetail(id)));
  }

  appEl.querySelectorAll('[data-edit-run]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const run = runs.find((r) => String(r.id) === btn.dataset.editRun);
      openRunModal(id, run, () => renderBoreholeDetail(id));
    });
  });

  appEl.querySelectorAll('[data-delete-run]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this drilling run? Samples and tests in this interval will be unlinked.')) return;
      await api('DELETE', `/api/runs/${btn.dataset.deleteRun}`);
      toast('Drilling run deleted');
      renderBoreholeDetail(id);
    });
  });

  document.getElementById('new-log-btn').addEventListener('click', () => {
    const lastEnd = lastEndDepth(logs);
    const form = openModal({
      title: 'Add Stratigraphy Log Entry',
      submitLabel: 'Add Entry',
      fieldsHtml: `
        ${depthFieldsHtml(lastEnd)}
        <div class="full"><label>Description</label><input name="description" placeholder="e.g. Firm brown clay, some gravel" /></div>
        ${lookupSelectHtml('uscs_class', 'uscs_class', '', { label: 'USCS Classification' })}
        ${lookupSelectHtml('soil_type', 'soil_type', '', { label: 'Soil Type' })}
        ${lookupSelectHtml('soil_colour', 'soil_colour', '', { label: 'Soil Colour' })}
        ${lookupSelectHtml('consistency', 'consistency', '', { label: 'Consistency' })}
        ${lookupSelectHtml('density', 'density', '', { label: 'Density' })}
        ${lookupSelectHtml('moisture', 'moisture', '', { label: 'Moisture' })}
        ${lookupSelectHtml('weathering', 'weathering', '', { label: 'Weathering Grade' })}
        ${lookupSelectHtml('rock_strength', 'rock_strength', '', { label: 'Rock Strength' })}
        ${lookupSelectHtml('rock_type', 'rock_type', '', { label: 'Rock Type / Lithology' })}
        ${lookupSelectHtml('fracture_condition', 'fracture_condition', '', { label: 'Fracture Condition' })}
        <div class="full"><label>Notes</label><textarea name="notes"></textarea></div>
      `,
      onSubmit: async (data) => {
        // Descriptive vocabulary fields ride along in notes-style columns the
        // log table already has; only the columns that exist are sent.
        const payload = {
          depth_from: data.depth_from, depth_to: data.depth_to, skip_reason: data.skip_reason,
          description: [data.consistency, data.moisture, data.soil_colour, data.soil_type, data.weathering, data.rock_type, data.rock_strength, data.fracture_condition, data.description]
            .filter(Boolean).join(', ') || null,
          uscs_class: data.uscs_class,
          notes: data.notes,
        };
        await api('POST', `/api/boreholes/${id}/logs`, payload);
        await submitCustomLookups(form);
        toast('Log entry added');
        renderBoreholeDetail(id);
      },
    });
    wireDepthContinuity(form, lastEnd);
    wireLookups(form);
  });

  document.getElementById('new-sample-btn').addEventListener('click', async () => {
    const ctx = await api('GET', `/api/boreholes/${id}/next-interval?kind=sample`);
    const lastEnd = ctx.suggested_from;
    const form = openModal({
      title: 'Add Sample',
      submitLabel: 'Add Sample',
      fieldsHtml: sampleModalFieldsHtml(lastEnd, { operator_name: ctx.defaults.operator_name, date: ctx.defaults.date }),
      onSubmit: async (data) => {
        data.sample_data = data.sample_data ? JSON.parse(data.sample_data) : null;
        await api('POST', `/api/boreholes/${id}/samples`, data);
        await submitCustomLookups(form);
        toast('Sample added');
        renderBoreholeDetail(id);
      },
    });
    wireSampleModal(form, lastEnd, ctx);
  });

  appEl.querySelectorAll('[data-delete-log]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this log entry?')) return;
      await api('DELETE', `/api/logs/${btn.dataset.deleteLog}`);
      renderBoreholeDetail(id);
    });
  });

  appEl.querySelectorAll('[data-delete-sample]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this sample?')) return;
      await api('DELETE', `/api/samples/${btn.dataset.deleteSample}`);
      renderBoreholeDetail(id);
    });
  });

  appEl.querySelectorAll('[data-edit-log]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const log = logs.find((l) => l.id === Number(btn.dataset.editLog));
      openModal({
        title: 'Edit Log Entry',
        submitLabel: 'Save Changes',
        fieldsHtml: `
          <div><label>Depth From (m) *</label><input type="number" step="any" name="depth_from" required value="${esc(log.depth_from)}" /></div>
          <div><label>Depth To (m) *</label><input type="number" step="any" name="depth_to" required value="${esc(log.depth_to)}" /></div>
          <div class="full"><label>Description</label><input name="description" value="${esc(log.description || '')}" /></div>
          <div><label>USCS Classification</label><input name="uscs_class" value="${esc(log.uscs_class || '')}" /></div>
          <div class="full"><label>Notes</label><textarea name="notes">${esc(log.notes || '')}</textarea></div>
          <div class="full"><label>Reason for Skipped Interval (if any)</label><textarea name="skip_reason">${esc(log.skip_reason || '')}</textarea></div>
        `,
        onSubmit: async (data) => {
          await api('PUT', `/api/logs/${log.id}`, data);
          toast('Log entry updated');
          renderBoreholeDetail(id);
        },
      });
    });
  });

  appEl.querySelectorAll('[data-edit-sample]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sample = samples.find((s) => s.id === Number(btn.dataset.editSample));
      const otherSamples = samples.filter((s) => s.id !== sample.id);
      const lastEnd = lastEndDepth(otherSamples);
      const form = openModal({
        title: 'Edit Sample',
        submitLabel: 'Save Changes',
        fieldsHtml: sampleModalFieldsHtml(lastEnd, sample),
        onSubmit: async (data) => {
          data.sample_data = data.sample_data ? JSON.parse(data.sample_data) : null;
          await api('PUT', `/api/samples/${sample.id}`, data);
          await submitCustomLookups(form);
          toast('Sample updated');
          renderBoreholeDetail(id);
        },
      });
      wireSampleModal(form, lastEnd);
      const modalEl = form.closest('.modal');
      const attachSection = document.createElement('div');
      attachSection.style.marginTop = '18px';
      attachSection.style.paddingTop = '16px';
      attachSection.style.borderTop = '1px solid var(--border)';
      attachSection.innerHTML = `<label>Photographs / Attachments</label><div id="sample-attachments"></div>`;
      modalEl.appendChild(attachSection);
      renderAttachments(attachSection.querySelector('#sample-attachments'), 'sample', sample.id);
    });
  });

  const newTestBtn = document.getElementById('new-test-btn');
  if (newTestBtn) {
    newTestBtn.addEventListener('click', async () => {
      const ctx = await api('GET', `/api/boreholes/${id}/next-interval?kind=test`);
      const lastEnd = ctx.suggested_from;
      const form = openModal({
        title: 'Add In-situ Test',
        submitLabel: 'Add Test',
        fieldsHtml: testModalFieldsHtml(lastEnd, { conducted_by: ctx.defaults.operator_name, date: ctx.defaults.date }),
        onSubmit: async (data) => {
          data.test_data = data.test_data ? JSON.parse(data.test_data) : null;
          await api('POST', `/api/boreholes/${id}/tests`, data);
          await submitCustomLookups(form);
          toast('Test added');
          renderBoreholeDetail(id);
        },
      });
      wireTestModal(form, lastEnd, ctx);
    });
  }

  appEl.querySelectorAll('[data-delete-test]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this test record?')) return;
      await api('DELETE', `/api/tests/${btn.dataset.deleteTest}`);
      renderBoreholeDetail(id);
    });
  });

  appEl.querySelectorAll('[data-edit-test]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const test = tests.find((t) => t.id === Number(btn.dataset.editTest));
      const otherTests = tests.filter((t) => t.id !== test.id);
      const lastEnd = lastEndDepth(otherTests);
      const form = openModal({
        title: 'Edit In-situ Test',
        submitLabel: 'Save Changes',
        fieldsHtml: testModalFieldsHtml(lastEnd, test),
        onSubmit: async (data) => {
          data.test_data = data.test_data ? JSON.parse(data.test_data) : null;
          await api('PUT', `/api/tests/${test.id}`, data);
          await submitCustomLookups(form);
          toast('Test updated');
          renderBoreholeDetail(id);
        },
      });
      wireTestModal(form, lastEnd);
      const modalEl = form.closest('.modal');
      const attachSection = document.createElement('div');
      attachSection.style.marginTop = '18px';
      attachSection.style.paddingTop = '16px';
      attachSection.style.borderTop = '1px solid var(--border)';
      attachSection.innerHTML = `<label>Photographs / Attachments</label><div id="test-attachments"></div>`;
      modalEl.appendChild(attachSection);
      renderAttachments(attachSection.querySelector('#test-attachments'), 'test', test.id);
    });
  });
}

// ================================================================
// Registers
// ================================================================

// ---------- Samples register (read-only master list) ----------

async function renderSamplesRegister() {
  setBreadcrumb([{ label: 'Samples Register', href: '#/registers/samples' }]);
  const samples = await api('GET', '/api/samples');

  appEl.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Samples Register</h1>
        <p class="subtitle">All samples across every project. Edit from the borehole page.</p>
      </div>
    </div>
    ${
      samples.length === 0
        ? `<div class="empty-state">No samples recorded yet.</div>`
        : `<table>
            <thead>
              <tr><th>Project</th><th>Borehole</th><th>Ref</th><th>Depth</th><th>Type</th><th>N-Value</th><th>Recovery %</th><th>Lab Status</th></tr>
            </thead>
            <tbody>
              ${samples
                .map(
                  (s) => `
                <tr class="clickable" data-id="${s.borehole_id}">
                  <td>${esc(s.project_name)}</td>
                  <td>${esc(s.borehole_code)}</td>
                  <td>${fmt(s.sample_ref)}</td>
                  <td class="depth-cell">${s.depth_from}&ndash;${s.depth_to} m</td>
                  <td>${fmt(s.sample_type)}</td>
                  <td>${fmt(s.spt_n_value)}</td>
                  <td>${fmt(s.recovery_pct, '%')}</td>
                  <td>${statusBadge(s.lab_status)}</td>
                </tr>`
                )
                .join('')}
            </tbody>
          </table>`
    }
  `;

  appEl.querySelectorAll('tbody tr.clickable').forEach((row) => {
    row.addEventListener('click', () => {
      location.hash = `#/boreholes/${row.dataset.id}`;
    });
  });
}

// ---------- Tests register (Falling Head Test, Packer Testing) ----------

async function renderTestsRegister() {
  setBreadcrumb([{ label: 'Tests Register', href: '#/registers/tests' }]);
  const tests = await api('GET', '/api/tests');

  appEl.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Tests Register</h1>
        <p class="subtitle">Falling Head Tests and Packer Testing across every project. Edit from the borehole page.</p>
      </div>
    </div>
    ${
      tests.length === 0
        ? `<div class="empty-state">No in-situ tests recorded yet.</div>`
        : `<table>
            <thead>
              <tr><th>Project</th><th>Borehole</th><th>Type</th><th>Depth From</th><th>Depth To</th><th>Result</th><th>Date</th></tr>
            </thead>
            <tbody>
              ${tests
                .map(
                  (t) => `
                <tr class="clickable" data-id="${t.borehole_id}">
                  <td>${esc(t.project_name)}</td>
                  <td>${esc(t.borehole_code)}</td>
                  <td>${esc(t.test_type)}</td>
                  <td class="depth-cell">${fmt(t.depth_from, ' m')}</td>
                  <td class="depth-cell">${fmt(t.depth_to, ' m')}</td>
                  <td>${fmt(t.result_value)} ${fmt(t.result_unit, '')}</td>
                  <td>${fmt(t.date)}</td>
                </tr>`
                )
                .join('')}
            </tbody>
          </table>`
    }
  `;

  appEl.querySelectorAll('tbody tr.clickable').forEach((row) => {
    row.addEventListener('click', () => {
      location.hash = `#/boreholes/${row.dataset.id}`;
    });
  });
}

// ---------- HSE register ----------

async function loadProjectOptions() {
  const projects = await api('GET', '/api/projects');
  return projects;
}

async function renderHseRegister() {
  setBreadcrumb([{ label: 'HSE Register', href: '#/registers/hse' }]);
  const [records, projects, stats] = await Promise.all([
    api('GET', '/api/hse'),
    loadProjectOptions(),
    api('GET', '/api/hse/stats'),
  ]);

  let categoryFilter = '';
  let statusFilter = '';

  const severityColor = { Low: 'var(--blue)', Medium: 'var(--amber)', High: 'var(--red)', Critical: 'var(--red)' };

  appEl.innerHTML = `
    <div class="page-header">
      <div>
        <h1>HSE Register</h1>
        <p class="subtitle">Site health, safety &amp; environment management</p>
      </div>
      <button class="primary" id="new-hse-btn">+ New HSE Record</button>
    </div>

    <div class="stat-grid">
      <div class="stat-card featured">
        <div class="stat-head"><span>Outstanding Items</span><span class="stat-icon">&#9888;</span></div>
        <div class="stat-value">${stats.total_open}</div>
        <div class="stat-foot">Open or in progress</div>
      </div>
      <div class="stat-card">
        <div class="stat-head"><span>Overdue Actions</span><span class="stat-icon">&#8599;</span></div>
        <div class="stat-value">${stats.overdue_actions}</div>
        <div class="stat-foot">Past due date, not closed</div>
      </div>
      <div class="stat-card">
        <div class="stat-head"><span>High/Critical Open</span><span class="stat-icon">&#8599;</span></div>
        <div class="stat-value">${stats.high_severity_open}</div>
        <div class="stat-foot">Needs priority attention</div>
      </div>
      <div class="stat-card">
        <div class="stat-head"><span>Closed This Month</span><span class="stat-icon">&#8599;</span></div>
        <div class="stat-value">${stats.closed_this_month}</div>
        <div class="stat-foot">${stats.total_this_month} logged this month</div>
      </div>
    </div>

    <div class="dash-grid">
      <div class="panel">
        <div class="panel-header"><h2>By Category</h2></div>
        <div class="recent-list">
          ${stats.by_category
            .map(
              (c) => `
            <div class="recent-item" style="cursor:default;">
              <span class="project-icon" style="background:${iconColor(c.category.length)}">${(HSE_CATEGORIES[c.category] || {}).icon || '\u{1F4CB}'}</span>
              <span class="recent-item-body"><span class="recent-item-title">${esc(c.category)}</span></span>
              <span class="badge status-pending">${c.count}</span>
            </div>`
            )
            .join('') || `<div class="empty-state">No records yet.</div>`}
        </div>
      </div>
      <div class="panel">
        <div class="panel-header"><h2>Open Items by Severity</h2></div>
        <div class="recent-list">
          ${['Low', 'Medium', 'High', 'Critical']
            .map((s) => {
              const row = stats.by_severity.find((r) => r.severity === s);
              return `
            <div class="recent-item" style="cursor:default;">
              <span class="dot" style="background:${severityColor[s]};width:12px;height:12px;"></span>
              <span class="recent-item-body"><span class="recent-item-title">${s}</span></span>
              <span class="badge status-pending">${row ? row.count : 0}</span>
            </div>`;
            })
            .join('')}
          ${stats.pending_approval > 0 ? `<div class="recent-item" style="cursor:default;border-top:1px solid var(--border);margin-top:6px;padding-top:12px;"><span class="recent-item-body"><span class="recent-item-title">Closed &amp; awaiting sign-off</span></span><span class="badge status-onhold">${stats.pending_approval}</span></div>` : ''}
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <h2>All Records</h2>
        <div style="display:flex;gap:10px;">
          <select id="hse-category-filter" style="width:auto;">
            <option value="">All Categories</option>
            ${Object.keys(HSE_CATEGORIES)
              .map((c) => `<option value="${esc(c)}">${esc(c)}</option>`)
              .join('')}
          </select>
          <select id="hse-status-filter" style="width:auto;">
            <option value="">All Statuses</option>
            <option>Open</option>
            <option>In Progress</option>
            <option>Closed</option>
          </select>
        </div>
      </div>
      <div id="hse-table-wrap"></div>
    </div>
  `;

  function renderTable() {
    const filtered = records.filter(
      (r) => (!categoryFilter || r.category === categoryFilter) && (!statusFilter || r.status === statusFilter)
    );
    const wrap = document.getElementById('hse-table-wrap');
    wrap.innerHTML =
      filtered.length === 0
        ? `<div class="empty-state">No HSE records match this filter.</div>`
        : `<table>
            <thead>
              <tr><th>Date</th><th>Category</th><th>Project</th><th>Severity</th><th>Responsible</th><th>Due</th><th>Status</th><th>Sign-off</th><th></th></tr>
            </thead>
            <tbody>
              ${filtered
                .map(
                  (r) => `
                <tr>
                  <td>${esc(r.date)}</td>
                  <td>${(HSE_CATEGORIES[r.category] || {}).icon || ''} ${esc(r.category || r.type)}</td>
                  <td>${fmt(r.project_name)}</td>
                  <td>${statusBadge(r.severity)}</td>
                  <td>${fmt(r.responsible_person)}</td>
                  <td>${fmt(r.due_date)}</td>
                  <td>${statusBadge(r.status)}</td>
                  <td>${r.approved_by ? `&#10003; ${esc(r.approved_by)}` : '&mdash;'}</td>
                  <td class="actions-cell">
                    <button class="link" data-edit="${r.id}">Edit</button>
                    <button class="link" data-delete="${r.id}">Delete</button>
                  </td>
                </tr>`
                )
                .join('')}
            </tbody>
          </table>`;

    wrap.querySelectorAll('[data-edit]').forEach((btn) => {
      btn.addEventListener('click', () => openEditModal(Number(btn.dataset.edit)));
    });
    wrap.querySelectorAll('[data-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this HSE record?')) return;
        await api('DELETE', `/api/hse/${btn.dataset.delete}`);
        renderHseRegister();
      });
    });
  }

  function openEditModal(recordId) {
    const record = records.find((r) => r.id === recordId);
    const form = openModal({
      title: `Edit HSE Record — ${record.category || record.type}`,
      submitLabel: 'Save Changes',
      fieldsHtml: hseModalFieldsHtml(record, projects),
      onSubmit: async (data) => {
        data.details = data.details ? JSON.parse(data.details) : null;
        await api('PUT', `/api/hse/${record.id}`, data);
        toast('HSE record updated');
        renderHseRegister();
      },
    });
    wireHseModal(form);
    const modalEl = form.closest('.modal');
    const attachSection = document.createElement('div');
    attachSection.style.marginTop = '18px';
    attachSection.style.paddingTop = '16px';
    attachSection.style.borderTop = '1px solid var(--border)';
    attachSection.innerHTML = `<label>Evidence / Photos</label><div id="hse-attachments"></div>`;
    modalEl.appendChild(attachSection);
    renderAttachments(attachSection.querySelector('#hse-attachments'), 'hse', record.id);
  }

  document.getElementById('hse-category-filter').addEventListener('change', (e) => {
    categoryFilter = e.target.value;
    renderTable();
  });
  document.getElementById('hse-status-filter').addEventListener('change', (e) => {
    statusFilter = e.target.value;
    renderTable();
  });

  document.getElementById('new-hse-btn').addEventListener('click', () => {
    const form = openModal({
      title: 'New HSE Record',
      submitLabel: 'Create Record',
      fieldsHtml: hseModalFieldsHtml(null, projects),
      onSubmit: async (data) => {
        data.details = data.details ? JSON.parse(data.details) : null;
        await api('POST', '/api/hse', data);
        toast('HSE record created');
        renderHseRegister();
      },
    });
    wireHseModal(form);
  });

  renderTable();
}

// ---------- Equipment register ----------

async function renderEquipmentRegister() {
  setBreadcrumb([{ label: 'Equipment Register', href: '#/registers/equipment' }]);
  const [items, projects] = await Promise.all([api('GET', '/api/equipment'), loadProjectOptions()]);

  appEl.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Equipment Register</h1>
        <p class="subtitle">Drill rigs, vehicles, and tools</p>
      </div>
      <button class="primary" id="new-equipment-btn">+ New Equipment</button>
    </div>
    ${
      items.length === 0
        ? `<div class="empty-state">No equipment recorded yet.</div>`
        : `<table>
            <thead>
              <tr><th>Name</th><th>Type</th><th>Asset Tag</th><th>Status</th><th>Assigned Project</th><th>Next Maintenance</th><th></th></tr>
            </thead>
            <tbody>
              ${items
                .map(
                  (e) => `
                <tr>
                  <td>${esc(e.name)}</td>
                  <td>${fmt(e.type)}</td>
                  <td>${fmt(e.asset_tag)}</td>
                  <td>${statusBadge(e.status)}</td>
                  <td>${fmt(e.project_name)}</td>
                  <td>${fmt(e.next_maintenance_date)}</td>
                  <td class="actions-cell">
                    <button class="link" data-edit="${e.id}">Edit</button>
                    <button class="link" data-delete="${e.id}">Delete</button>
                  </td>
                </tr>`
                )
                .join('')}
            </tbody>
          </table>`
    }
  `;

  const projectOptionsHtml = (selected) =>
    `<option value="">&mdash; Unassigned &mdash;</option>` +
    projects.map((p) => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}</option>`).join('');

  function equipmentFieldsHtml(e) {
    e = e || {};
    return `
      <div class="full"><label>Name *</label><input name="name" required value="${esc(e.name || '')}" /></div>
      <div><label>Type</label><input name="type" placeholder="e.g. Drill Rig, Support Vehicle, Tool" value="${esc(e.type || '')}" /></div>
      <div><label>Asset Tag</label><input name="asset_tag" value="${esc(e.asset_tag || '')}" /></div>
      <div>
        <label>Status</label>
        <select name="status">
          ${['Available', 'In Use', 'Maintenance', 'Out of Service']
            .map((s) => `<option ${s === e.status ? 'selected' : ''}>${s}</option>`)
            .join('')}
        </select>
      </div>
      <div><label>Assigned Project</label><select name="assigned_project_id">${projectOptionsHtml(e.assigned_project_id)}</select></div>
      <div><label>Last Inspection</label><input type="date" name="last_inspection_date" value="${esc(e.last_inspection_date || '')}" /></div>
      <div><label>Next Maintenance</label><input type="date" name="next_maintenance_date" value="${esc(e.next_maintenance_date || '')}" /></div>
      <div class="full"><label>Notes</label><textarea name="notes">${esc(e.notes || '')}</textarea></div>
    `;
  }

  document.getElementById('new-equipment-btn').addEventListener('click', () => {
    openModal({
      title: 'New Equipment',
      submitLabel: 'Add Equipment',
      fieldsHtml: equipmentFieldsHtml(),
      onSubmit: async (data) => {
        await api('POST', '/api/equipment', data);
        toast('Equipment added');
        renderEquipmentRegister();
      },
    });
  });

  appEl.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = items.find((e) => e.id === Number(btn.dataset.edit));
      openModal({
        title: 'Edit Equipment',
        submitLabel: 'Save Changes',
        fieldsHtml: equipmentFieldsHtml(item),
        onSubmit: async (data) => {
          await api('PUT', `/api/equipment/${item.id}`, data);
          toast('Equipment updated');
          renderEquipmentRegister();
        },
      });
    });
  });

  appEl.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this equipment record?')) return;
      await api('DELETE', `/api/equipment/${btn.dataset.delete}`);
      renderEquipmentRegister();
    });
  });
}

// ---------- Timesheets register ----------

async function renderTimesheetsRegister() {
  setBreadcrumb([{ label: 'Timesheets', href: '#/registers/timesheets' }]);
  const [entries, projects] = await Promise.all([api('GET', '/api/timesheets'), loadProjectOptions()]);

  appEl.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Timesheets</h1>
        <p class="subtitle">Field personnel hours by project</p>
      </div>
      <button class="primary" id="new-timesheet-btn">+ New Entry</button>
    </div>
    ${
      entries.length === 0
        ? `<div class="empty-state">No timesheet entries yet.</div>`
        : `<table>
            <thead>
              <tr><th>Date</th><th>Person</th><th>Project</th><th>Hours</th><th>Task</th><th></th></tr>
            </thead>
            <tbody>
              ${entries
                .map(
                  (t) => `
                <tr>
                  <td>${esc(t.date)}</td>
                  <td>${esc(t.person_name)}</td>
                  <td>${fmt(t.project_name)}</td>
                  <td class="depth-cell">${t.hours}</td>
                  <td>${fmt(t.task_description)}</td>
                  <td class="actions-cell">
                    <button class="link" data-edit="${t.id}">Edit</button>
                    <button class="link" data-delete="${t.id}">Delete</button>
                  </td>
                </tr>`
                )
                .join('')}
            </tbody>
          </table>`
    }
  `;

  const projectOptionsHtml = (selected) =>
    `<option value="">&mdash; General &mdash;</option>` +
    projects.map((p) => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}</option>`).join('');

  function timesheetFieldsHtml(t) {
    t = t || {};
    return `
      <div><label>Person Name *</label><input name="person_name" required value="${esc(t.person_name || '')}" /></div>
      <div><label>Date *</label><input type="date" name="date" required value="${esc(t.date || '')}" /></div>
      <div><label>Project</label><select name="project_id">${projectOptionsHtml(t.project_id)}</select></div>
      <div><label>Hours *</label><input type="number" step="any" name="hours" required value="${esc(t.hours ?? '')}" /></div>
      <div class="full"><label>Task Description</label><input name="task_description" value="${esc(t.task_description || '')}" /></div>
      <div class="full"><label>Notes</label><textarea name="notes">${esc(t.notes || '')}</textarea></div>
    `;
  }

  document.getElementById('new-timesheet-btn').addEventListener('click', () => {
    openModal({
      title: 'New Timesheet Entry',
      submitLabel: 'Add Entry',
      fieldsHtml: timesheetFieldsHtml(),
      onSubmit: async (data) => {
        await api('POST', '/api/timesheets', data);
        toast('Timesheet entry added');
        renderTimesheetsRegister();
      },
    });
  });

  appEl.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const entry = entries.find((t) => t.id === Number(btn.dataset.edit));
      openModal({
        title: 'Edit Timesheet Entry',
        submitLabel: 'Save Changes',
        fieldsHtml: timesheetFieldsHtml(entry),
        onSubmit: async (data) => {
          await api('PUT', `/api/timesheets/${entry.id}`, data);
          toast('Timesheet entry updated');
          renderTimesheetsRegister();
        },
      });
    });
  });

  appEl.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this timesheet entry?')) return;
      await api('DELETE', `/api/timesheets/${btn.dataset.delete}`);
      renderTimesheetsRegister();
    });
  });
}

// ================================================================
// Users (Admin only)
// ================================================================

async function renderUsersPage() {
  setBreadcrumb([{ label: 'Users', href: '#/users' }]);
  const [users, projects] = await Promise.all([api('GET', '/api/users'), loadProjectOptions()]);

  appEl.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Users</h1>
        <p class="subtitle">Manage Admin, Field, and Client accounts</p>
      </div>
      <button class="primary" id="new-user-btn">+ New User</button>
    </div>
    <table>
      <thead>
        <tr><th>Name</th><th>Email</th><th>Role</th><th>Project Access</th><th></th></tr>
      </thead>
      <tbody>
        ${users
          .map(
            (u) => `
          <tr>
            <td>${esc(u.name)}</td>
            <td>${esc(u.email)}</td>
            <td>${roleBadge(u.role)}</td>
            <td>${
              u.role === 'Client'
                ? u.project_ids.length === 0
                  ? '&mdash;'
                  : u.project_ids
                      .map((pid) => esc((projects.find((p) => p.id === pid) || {}).name || '?'))
                      .join(', ')
                : '<span style="color:var(--text-dim)">All projects</span>'
            }</td>
            <td class="actions-cell">
              <button class="link" data-edit="${u.id}">Edit</button>
              ${u.id !== currentUser.id ? `<button class="link" data-delete="${u.id}">Delete</button>` : ''}
            </td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>
  `;

  function projectChecklistHtml(selectedIds) {
    selectedIds = selectedIds || [];
    return `
      <div class="full">
        <label>Client Project Access</label>
        <div class="checkbox-list">
          ${projects
            .map(
              (p) => `
            <label><input type="checkbox" name="project_ids" value="${p.id}" ${selectedIds.includes(p.id) ? 'checked' : ''} /> ${esc(p.name)}</label>`
            )
            .join('')}
        </div>
      </div>
    `;
  }

  function collectProjectIds(form) {
    return Array.from(form.querySelectorAll('input[name="project_ids"]:checked')).map((cb) => Number(cb.value));
  }

  document.getElementById('new-user-btn').addEventListener('click', () => {
    const form = openModal({
      title: 'New User',
      submitLabel: 'Create User',
      fieldsHtml: `
        <div><label>Full Name *</label><input name="name" required /></div>
        <div><label>Email *</label><input type="email" name="email" required /></div>
        <div><label>Password * (min 8 characters)</label><input type="password" name="password" minlength="8" required /></div>
        <div>
          <label>Role *</label>
          <select name="role" id="new-user-role">
            <option>Admin</option>
            <option>Field</option>
            <option>Client</option>
          </select>
        </div>
        <div class="full hidden" id="new-user-projects">${projectChecklistHtml([])}</div>
      `,
      onSubmit: async (data, formEl) => {
        const payload = { ...data, project_ids: collectProjectIds(form) };
        await api('POST', '/api/users', payload);
        toast('User created');
        renderUsersPage();
      },
    });
    const roleSelect = form.querySelector('#new-user-role');
    const projectsWrap = form.querySelector('#new-user-projects');
    const toggle = () => projectsWrap.classList.toggle('hidden', roleSelect.value !== 'Client');
    roleSelect.addEventListener('change', toggle);
    toggle();
  });

  appEl.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const user = users.find((u) => u.id === Number(btn.dataset.edit));
      const form = openModal({
        title: 'Edit User',
        submitLabel: 'Save Changes',
        fieldsHtml: `
          <div><label>Full Name *</label><input name="name" required value="${esc(user.name)}" /></div>
          <div><label>Email *</label><input type="email" name="email" required value="${esc(user.email)}" /></div>
          <div><label>New Password (leave blank to keep current)</label><input type="password" name="password" minlength="8" /></div>
          <div>
            <label>Role *</label>
            <select name="role" id="edit-user-role">
              ${['Admin', 'Field', 'Client'].map((r) => `<option ${r === user.role ? 'selected' : ''}>${r}</option>`).join('')}
            </select>
          </div>
          <div class="full ${user.role === 'Client' ? '' : 'hidden'}" id="edit-user-projects">${projectChecklistHtml(user.project_ids)}</div>
        `,
        onSubmit: async (data) => {
          const payload = { ...data, project_ids: collectProjectIds(form) };
          await api('PUT', `/api/users/${user.id}`, payload);
          toast('User updated');
          renderUsersPage();
        },
      });
      const roleSelect = form.querySelector('#edit-user-role');
      const projectsWrap = form.querySelector('#edit-user-projects');
      roleSelect.addEventListener('change', () => projectsWrap.classList.toggle('hidden', roleSelect.value !== 'Client'));
    });
  });

  appEl.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this user? They will lose access immediately.')) return;
      await api('DELETE', `/api/users/${btn.dataset.delete}`);
      toast('User deleted');
      renderUsersPage();
    });
  });
}

// ================================================================
// Report
// ================================================================

async function renderProjectReport(id) {
  const project = await api('GET', `/api/projects/${id}`);
  const boreholes = await api('GET', `/api/projects/${id}/boreholes`);
  const hseRecords = await api('GET', `/api/projects/${id}/hse`);
  const boreholesWithData = await Promise.all(
    boreholes.map(async (b) => ({
      ...b,
      logs: await api('GET', `/api/boreholes/${b.id}/logs`),
      samples: await api('GET', `/api/boreholes/${b.id}/samples`),
      tests: await api('GET', `/api/boreholes/${b.id}/tests`),
    }))
  );

  setBreadcrumb([
    { label: 'Projects', href: '#/projects' },
    { label: project.name, href: `#/projects/${id}` },
    { label: 'Report', href: `#/projects/${id}/report` },
  ]);

  const today = new Date().toLocaleDateString();

  appEl.innerHTML = `
    <div class="report-letterhead">
      <img src="assets/logo.png" alt="Mokay Group of Companies" />
      <span class="subtitle">Mokay Group of Companies</span>
    </div>

    <div class="report-header">
      <div>
        <h1>Geotechnical Drilling Report</h1>
        <p class="subtitle">Generated ${esc(today)}</p>
      </div>
      <div class="actions-cell no-print">
        <button id="back-btn">&larr; Back to Project</button>
        <button class="primary" id="print-btn">Print / Export PDF</button>
      </div>
    </div>

    <div class="report-block">
      <h3>Project Summary</h3>
      <div class="meta-grid">
        <div class="item"><span class="label">Project Name</span>${esc(project.name)}</div>
        <div class="item"><span class="label">Client</span>${fmt(project.client)}</div>
        <div class="item"><span class="label">Location</span>${fmt(project.location)}</div>
        <div class="item"><span class="label">Status</span>${statusBadge(project.status)}</div>
        <div class="item"><span class="label">Start Date</span>${fmt(project.start_date)}</div>
        <div class="item"><span class="label">Total Boreholes</span>${boreholes.length}</div>
      </div>
      ${project.notes ? `<p><strong>Notes:</strong> ${esc(project.notes)}</p>` : ''}
    </div>

    <div class="report-block">
      <h3>Borehole Summary</h3>
      ${
        boreholes.length === 0
          ? `<div class="empty-state">No boreholes recorded for this project.</div>`
          : `<table>
              <thead><tr><th>Code</th><th>Total Depth</th><th>Method</th><th>Status</th><th>Start</th><th>End</th></tr></thead>
              <tbody>
                ${boreholes
                  .map(
                    (b) => `
                  <tr>
                    <td>${esc(b.code)}</td>
                    <td class="depth-cell">${fmt(b.total_depth, ' m')}</td>
                    <td>${fmt(b.drill_method)}</td>
                    <td>${statusBadge(b.status)}</td>
                    <td>${fmt(b.start_date)}</td>
                    <td>${fmt(b.end_date)}</td>
                  </tr>`
                  )
                  .join('')}
              </tbody>
            </table>`
      }
    </div>

    <div class="report-block">
      <h3>Borehole Detail</h3>
      ${
        boreholesWithData.length === 0
          ? ''
          : boreholesWithData
              .map(
                (b) => `
        <div class="report-borehole">
          <h2 style="margin:0 0 4px;">${esc(b.code)}</h2>
          <p class="subtitle" style="margin:0 0 12px;">Total depth ${fmt(b.total_depth, ' m')} &middot; ${fmt(b.drill_method)}</p>

          <p style="font-weight:700;font-size:0.85rem;margin:14px 0 6px;">Stratigraphy Log</p>
          ${
            b.logs.length === 0
              ? `<p class="subtitle">No stratigraphy logged.</p>`
              : `<table>
                  <thead><tr><th>Depth From</th><th>Depth To</th><th>Description</th><th>USCS</th></tr></thead>
                  <tbody>
                    ${b.logs
                      .map(
                        (l) => `
                      <tr><td class="depth-cell">${l.depth_from} m</td><td class="depth-cell">${l.depth_to} m</td><td>${fmt(l.description)}</td><td>${fmt(l.uscs_class)}</td></tr>`
                      )
                      .join('')}
                  </tbody>
                </table>`
          }

          <p style="font-weight:700;font-size:0.85rem;margin:14px 0 6px;">Samples</p>
          ${
            b.samples.length === 0
              ? `<p class="subtitle">No samples recorded.</p>`
              : `<table>
                  <thead><tr><th>Depth</th><th>Ref</th><th>Type</th><th>N-Value</th><th>Recovery %</th><th>Lab Status</th></tr></thead>
                  <tbody>
                    ${b.samples
                      .map(
                        (s) => `
                      <tr><td class="depth-cell">${s.depth_from}&ndash;${s.depth_to} m</td><td>${fmt(s.sample_ref)}</td><td>${fmt(s.sample_type)}</td><td>${fmt(s.spt_n_value)}</td><td>${fmt(s.recovery_pct, '%')}</td><td>${statusBadge(s.lab_status)}</td></tr>`
                      )
                      .join('')}
                  </tbody>
                </table>`
          }

          <p style="font-weight:700;font-size:0.85rem;margin:14px 0 6px;">In-situ Tests</p>
          ${
            b.tests.length === 0
              ? `<p class="subtitle">No in-situ tests recorded.</p>`
              : `<table>
                  <thead><tr><th>Type</th><th>Depth From</th><th>Depth To</th><th>Result</th><th>Date</th></tr></thead>
                  <tbody>
                    ${b.tests
                      .map(
                        (t) => `
                      <tr><td>${esc(t.test_type)}</td><td class="depth-cell">${fmt(t.depth_from, ' m')}</td><td class="depth-cell">${fmt(t.depth_to, ' m')}</td><td>${fmt(t.result_value)} ${fmt(t.result_unit, '')}</td><td>${fmt(t.date)}</td></tr>`
                      )
                      .join('')}
                  </tbody>
                </table>`
          }
        </div>`
              )
              .join('')
      }
    </div>

    <div class="report-block">
      <h3>HSE Records</h3>
      ${
        hseRecords.length === 0
          ? `<div class="empty-state">No HSE records logged for this project.</div>`
          : `<table>
              <thead><tr><th>Date</th><th>Category</th><th>Severity</th><th>Location</th><th>Description</th><th>Corrective Action</th><th>Responsible</th><th>Due</th><th>Status</th><th>Sign-off</th></tr></thead>
              <tbody>
                ${hseRecords
                  .map(
                    (r) => `
                  <tr>
                    <td>${esc(r.date)}</td>
                    <td>${esc(r.category || r.type)}</td>
                    <td>${statusBadge(r.severity)}</td>
                    <td>${fmt(r.location)}</td>
                    <td>${fmt(r.description)}</td>
                    <td>${fmt(r.corrective_action)}</td>
                    <td>${fmt(r.responsible_person)}</td>
                    <td>${fmt(r.due_date)}</td>
                    <td>${statusBadge(r.status)}</td>
                    <td>${fmt(r.approved_by)}</td>
                  </tr>`
                  )
                  .join('')}
              </tbody>
            </table>`
      }
    </div>
  `;

  document.getElementById('back-btn').addEventListener('click', () => {
    location.hash = `#/projects/${id}`;
  });
  document.getElementById('print-btn').addEventListener('click', () => window.print());
}
