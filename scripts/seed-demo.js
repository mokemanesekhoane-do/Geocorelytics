// Populates a GeoCorelytics instance with a realistic demo dataset.
//
// Everything goes through the HTTP API rather than straight into SQLite, so
// the seed exercises the same validation, run-linking and calculation paths a
// real operator would hit. If the seed succeeds, those paths work.
//
//   node scripts/seed-demo.js [baseUrl] [email] [password]
//
// Defaults to http://localhost:3000 with the local dev admin. Point it at a
// different host only if you actually want demo data there.

const BASE = process.argv[2] || 'http://localhost:3000';
const EMAIL = process.argv[3] || 'admin@drilltrack.test';
const PASSWORD = process.argv[4] || 'localdev12345';

let cookie = '';
const counts = {};
const failures = [];

function tally(kind) {
  counts[kind] = (counts[kind] || 0) + 1;
}

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status} ${data && data.error ? data.error : ''}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Records the failure and keeps going: one rejected row should not abort the
// whole seed, and the summary at the end shows exactly what did not land.
async function tryCall(kind, method, path, body) {
  try {
    const r = await call(method, path, body);
    tally(kind);
    return r;
  } catch (e) {
    failures.push(e.message);
    return null;
  }
}

const round = (v, dp = 2) => Number(v.toFixed(dp));
const pick = (arr, i) => arr[i % arr.length];

// ---------- Reference data ----------

const RIGS = ['Rig-07 (Atlas Copco CS14)', 'Rig-12 (Boart Longyear LF70)'];
const OPERATORS = ['T. Mokoena', 'S. van Wyk', 'P. Ndlovu'];
const HELPERS = ['J. Dlamini', 'M. Botha', 'K. Sithole'];
const SHIFTS = ['Day', 'Night'];

const SOIL_PROFILE = [
  { to: 1.2, type: 'Topsoil', colour: 'Dark Brown', uscs: 'ML - Silt (low plasticity)', consistency: 'Soft', moisture: 'Moist' },
  { to: 4.5, type: 'Clay', colour: 'Reddish Brown', uscs: 'CL - Lean clay', consistency: 'Firm', moisture: 'Moist' },
  { to: 9.0, type: 'Silty Sand', colour: 'Yellowish Brown', uscs: 'SM - Silty sand', consistency: 'Medium Dense', moisture: 'Very Moist' },
  { to: 14.0, type: 'Residual Soil', colour: 'Mottled', uscs: 'SC - Clayey sand', consistency: 'Stiff', moisture: 'Wet' },
  { to: 100, type: 'Weathered Rock', colour: 'Grey', uscs: 'GC - Clayey gravel', consistency: 'Very Stiff', moisture: 'Saturated' },
];

function layerAt(depth) {
  return SOIL_PROFILE.find((l) => depth <= l.to) || SOIL_PROFILE[SOIL_PROFILE.length - 1];
}

const addDays = (iso, n) => new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10);

// ---------- Seeding ----------

async function seedBorehole(projectId, spec) {
  const bh = await call('POST', `/api/projects/${projectId}/boreholes`, {
    code: spec.code,
    easting: spec.easting,
    northing: spec.northing,
    elevation: spec.elevation,
    total_depth: spec.drilledTo,
    planned_depth: spec.plannedDepth,
    planned_start_date: spec.start,
    planned_end_date: addDays(spec.start, spec.plannedDays),
    start_date: spec.start,
    drill_method: 'Rotary Core (Diamond)',
    status: spec.status,
    notes: spec.notes || null,
  });
  tally('boreholes');

  // --- Drilling runs: the backbone everything else hangs off ---
  let depth = 0;
  let runNo = 1;
  let dayOffset = 0;
  let runsToday = 0;
  while (depth < spec.drilledTo - 1e-9) {
    const advance = Math.min(spec.runLengths[(runNo - 1) % spec.runLengths.length], spec.drilledTo - depth);
    const from = round(depth);
    const to = round(depth + advance);
    const layer = layerAt(to);
    const isRock = layer.type === 'Weathered Rock';

    // Recovery and rate degrade in the transition zone, which is what the
    // analytics should later surface as a recommendation.
    const recoveryFactor = spec.poorZone && to > spec.poorZone[0] && to < spec.poorZone[1] ? 0.62 : 0.93 + (runNo % 3) * 0.02;
    const rate = spec.poorZone && to > spec.poorZone[0] && to < spec.poorZone[1] ? 0.6 : isRock ? 1.4 : 2.6;
    const downtime = runNo % 4 === 0 ? 25 + (runNo % 3) * 15 : runNo % 7 === 0 ? 90 : 0;

    await tryCall('drilling runs', 'POST', `/api/boreholes/${bh.id}/runs`, {
      run_number: runNo,
      depth_from: from,
      depth_to: to,
      date: addDays(spec.start, dayOffset),
      shift: pick(SHIFTS, runsToday > 2 ? 1 : 0),
      start_time: runsToday > 2 ? '19:00' : '07:00',
      end_time: runsToday > 2 ? '23:30' : '15:30',
      drilling_method: isRock ? 'Rotary Core (Diamond)' : 'Auger - Flight',
      rig_name: spec.rig,
      operator_name: spec.operator,
      helper_name: pick(HELPERS, runNo),
      bit_type: isRock ? 'Impregnated diamond NQ' : 'Drag bit 150 mm',
      core_barrel_type: isRock ? 'Triple tube NQ3' : null,
      core_recovered_m: round(advance * recoveryFactor),
      rqd_pct: isRock ? round(45 + (runNo % 5) * 9, 1) : null,
      penetration_rate_m_hr: round(rate, 2),
      drilling_time_min: Math.round((advance / rate) * 60),
      downtime_min: downtime,
      downtime_reason: downtime ? (runNo % 7 === 0 ? 'Equipment Breakdown' : 'Rig Move / Setup') : 'None',
      water_loss_pct: isRock ? round(10 + (runNo % 4) * 6, 1) : null,
      groundwater_obs: to > 8 ? 'Seepage' : 'Dry',
      ground_conditions: layer.type,
      drilling_status: 'Drilling',
      remarks: 'Drilling as planned',
      supervisor_name: runNo % 3 === 0 ? 'E. Khumalo' : null,
    });

    depth = to;
    runNo += 1;
    runsToday += 1;
    if (runsToday >= 4) { runsToday = 0; dayOffset += 1; }
  }

  // --- Stratigraphy log: one entry per profile layer, contiguous ---
  let logFrom = 0;
  for (const layer of SOIL_PROFILE) {
    const logTo = Math.min(layer.to, spec.drilledTo);
    if (logTo <= logFrom) continue;
    await tryCall('log entries', 'POST', `/api/boreholes/${bh.id}/logs`, {
      depth_from: round(logFrom),
      depth_to: round(logTo),
      description: `${layer.consistency}, ${layer.moisture.toLowerCase()}, ${layer.colour.toLowerCase()} ${layer.type.toLowerCase()}`,
      uscs_class: layer.uscs,
      notes: null,
    });
    logFrom = logTo;
    if (logFrom >= spec.drilledTo) break;
  }

  // --- Samples: SPT in soil, Shelby in cohesive clay, UDS occasionally ---
  let sampleFrom = spec.firstSampleAt;
  let n = 0;
  while (sampleFrom + 0.45 <= spec.drilledTo) {
    const layer = layerAt(sampleFrom);
    const cohesive = ['Clay', 'Residual Soil'].includes(layer.type);
    const type = n % 5 === 4 && cohesive ? 'UDS' : n % 3 === 2 && cohesive ? 'Shelby' : 'SPT';
    const to = round(sampleFrom + (type === 'SPT' ? 0.45 : 0.6));
    if (to > spec.drilledTo) break;

    const body = {
      sample_type: type,
      sample_ref: `${spec.code}-${type}-${String(n + 1).padStart(2, '0')}`,
      depth_from: round(sampleFrom),
      depth_to: to,
      date: addDays(spec.start, Math.floor(sampleFrom / 3)),
      time: '10:20',
      operator_name: spec.operator,
      lab_status: n % 4 === 0 ? 'In Lab' : 'Pending',
      description: `${layer.consistency} ${layer.colour.toLowerCase()} ${layer.type.toLowerCase()}`,
      groundwater_obs: sampleFrom > 8 ? 'Seepage' : 'Dry',
      skip_reason: 'Routine sampling interval',
      notes: null,
    };

    if (type === 'SPT') {
      // Blow counts rise with depth; N is derived server-side from these.
      const base = 3 + Math.floor(sampleFrom * 0.9);
      const b1 = base, b2 = base + 2, b3 = base + 4;
      body.spt_n_value = b2 + b3;
      body.recovery_pct = round((330 / 450) * 100, 1);
      body.sample_data = {
        sampler_type: 'Standard Split Spoon (51 mm OD)',
        hammer_type: 'Automatic Trip',
        hammer_weight_kg: 63.5,
        drop_height_mm: 760,
        rod_length_m: round(sampleFrom + 1.5, 2),
        sampler_diameter_mm: 51,
        seating_blows: 2,
        blows_150_1: b1,
        blows_150_2: b2,
        blows_150_3: b3,
        penetration_length_mm: 450,
        recovery_length_mm: 330,
        refusal_status: 'No Refusal',
        sample_condition: 'Good',
        moisture_condition: layer.moisture,
        soil_classification: layer.uscs,
        remarks_standard: 'Drilling as planned',
      };
    } else if (type === 'Shelby') {
      body.recovery_pct = round((545 / 600) * 100, 1);
      body.sample_data = {
        tube_type: 'Shelby Thin-Wall',
        tube_diameter_mm: 76.2,
        tube_length_mm: 762,
        wall_thickness_mm: 1.65,
        cutting_edge_condition: 'Sharp / Good',
        push_method: 'Hydraulic Push - Continuous',
        push_length_mm: 600,
        penetration_length_mm: 600,
        recovery_length_mm: 545,
        applied_pressure_kpa: 1850,
        sample_condition: 'Intact / Excellent',
        degree_of_disturbance: 'Undisturbed',
        sample_orientation: 'Vertical',
        top_bottom_id: 'Marked - Both Ends',
        sealing_method: 'Wax Seal (Both Ends)',
        preservation_method: 'Wax Coating',
        storage_condition: 'Upright - Climate Controlled',
      };
    } else {
      body.recovery_pct = round((560 / 600) * 100, 1);
      body.sample_data = {
        sampling_method: 'Rotary Core (Diamond)',
        sampler_dimensions: '76 x 600 mm',
        penetration_length_mm: 600,
        recovery_length_mm: 560,
        sample_diameter_mm: 76,
        soil_classification: layer.uscs,
        material_consistency: layer.consistency,
        moisture_condition: layer.moisture,
        sample_quality_rating: 'SQ2 - Good',
        sample_condition: 'Good',
        degree_of_disturbance: 'Slightly Disturbed',
        sample_orientation: 'Vertical',
        top_bottom_id: 'Marked - Both Ends',
        sealing_method: 'End Caps + Adhesive Tape',
        preservation_method: 'Plastic Wrap + Wax',
        storage_requirements: 'Upright - Ambient',
        required_lab_tests: 'Consolidation, triaxial CU',
      };
    }

    await tryCall('samples', 'POST', `/api/boreholes/${bh.id}/samples`, body);
    sampleFrom = to + spec.sampleGap;
    n += 1;
  }

  // --- In-situ tests ---
  for (const t of spec.tests || []) {
    const isPacker = t.type === 'Packer Test';
    await tryCall('tests', 'POST', `/api/boreholes/${bh.id}/tests`, {
      test_type: t.type,
      test_ref: `${spec.code}-${isPacker ? 'PK' : 'FH'}-${t.from}`,
      depth_from: t.from,
      depth_to: t.to,
      date: addDays(spec.start, Math.floor(t.from / 3)),
      conducted_by: spec.operator,
      result_value: t.result,
      result_unit: isPacker ? 'Lugeon' : 'cm/s',
      skip_reason: 'Test carried out at specified horizon',
      supervisor_name: 'E. Khumalo',
      test_data: isPacker
        ? {
            section_length_m: round(t.to - t.from, 2),
            p1_bar: 2, q1_lpm: 4.2, p2_bar: 4, q2_lpm: 9.1, p3_bar: 6,
            q3_lpm: 14.6, p4_bar: 4, q4_lpm: 9.4, p5_bar: 2, q5_lpm: 4.4,
          }
        : {
            standpipe_type: 'Open Standpipe',
            borehole_diameter_mm: 100,
            casing_diameter_mm: 50,
            initial_water_level_m: round(t.from - 2.4, 2),
            final_water_level_m: round(t.from - 1.1, 2),
            groundwater_level_m: round(t.from - 3.0, 2),
            h1_m: 2.4,
            h2_m: 1.1,
            t1_min: 0,
            t2_min: 30,
            test_start_time: '11:00',
            test_end_time: '11:30',
            water_temperature_c: 18.5,
            correction_factor: 1,
            test_condition: 'Valid',
            groundwater_obs: 'Seepage',
            formation_description: layerAt(t.from).type,
            remarks_standard: 'No anomalies observed',
          },
    });
  }

  return bh;
}

async function main() {
  console.log(`Seeding ${BASE}\n`);
  await call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });

  const projects = [
    {
      name: 'N3 Highway Bridge Upgrade — Geotechnical Investigation',
      client: 'SANRAL',
      location: 'Van Reenen, KwaZulu-Natal',
      start_date: '2026-07-06',
      status: 'Active',
      notes: 'Foundation investigation for the replacement bridge deck and abutments.',
      boreholes: [
        { code: 'BH-01', easting: 29.3841, northing: -28.3712, elevation: 1642.5, drilledTo: 24.5, plannedDepth: 25, start: '2026-07-06', plannedDays: 6, status: 'Complete', runLengths: [3.0, 3.0, 2.5, 3.5], firstSampleAt: 1.0, sampleGap: 1.05, rig: RIGS[0], operator: OPERATORS[0], poorZone: [11, 15], tests: [{ type: 'Falling Head Test', from: 8.0, to: 9.0, result: 0.000042 }, { type: 'Packer Test', from: 17.5, to: 20.5, result: 3.8 }] },
        { code: 'BH-02', easting: 29.3856, northing: -28.3729, elevation: 1639.8, drilledTo: 18.2, plannedDepth: 22, start: '2026-07-09', plannedDays: 5, status: 'In Progress', runLengths: [2.6, 3.2, 2.8], firstSampleAt: 1.5, sampleGap: 1.2, rig: RIGS[1], operator: OPERATORS[1], tests: [{ type: 'Falling Head Test', from: 10.0, to: 11.0, result: 0.000018 }] },
        { code: 'BH-03', easting: 29.3868, northing: -28.3741, elevation: 1644.1, drilledTo: 9.6, plannedDepth: 20, start: '2026-07-13', plannedDays: 5, status: 'In Progress', runLengths: [2.4, 3.6], firstSampleAt: 1.2, sampleGap: 1.4, rig: RIGS[0], operator: OPERATORS[2], tests: [] },
      ],
    },
    {
      name: 'Rustenburg Tailings Storage Facility — Phase 2',
      client: 'Sibanye-Stillwater',
      location: 'Rustenburg, North West',
      start_date: '2026-07-20',
      status: 'Active',
      notes: 'Stability investigation for the raised TSF embankment.',
      boreholes: [
        { code: 'TSF-BH01', easting: 27.2412, northing: -25.6673, elevation: 1156.2, drilledTo: 15.4, plannedDepth: 15, start: '2026-07-20', plannedDays: 4, status: 'Complete', runLengths: [2.2, 2.8, 3.4], firstSampleAt: 0.8, sampleGap: 1.1, rig: RIGS[1], operator: OPERATORS[1], tests: [{ type: 'Falling Head Test', from: 6.5, to: 7.5, result: 0.00021 }] },
        { code: 'TSF-BH02', easting: 27.2438, northing: -25.6691, elevation: 1154.7, drilledTo: 12.0, plannedDepth: 15, start: '2026-07-23', plannedDays: 4, status: 'In Progress', runLengths: [3.0, 2.5, 3.5], firstSampleAt: 1.0, sampleGap: 1.6, rig: RIGS[0], operator: OPERATORS[2], poorZone: [7, 10], tests: [] },
      ],
    },
  ];

  for (const p of projects) {
    const { boreholes, ...projectBody } = p;
    const project = await call('POST', '/api/projects', projectBody);
    tally('projects');
    console.log(`  ${project.name}`);
    for (const spec of boreholes) {
      const bh = await seedBorehole(project.id, spec);
      console.log(`    ${bh.code} — drilled to ${spec.drilledTo} m`);
    }
  }

  // --- Registers ---
  const projectList = await call('GET', '/api/projects');
  const pid = projectList[0].id;

  const hse = [
    { category: 'Safety Inspection', date: '2026-07-07', severity: 'Low', status: 'Closed', description: 'Weekly rig inspection — all guards and E-stops functional.', reported_by: 'E. Khumalo', responsible_person: 'T. Mokoena' },
    { category: 'Near Miss', date: '2026-07-10', severity: 'Medium', status: 'Closed', description: 'Rod dropped from rack; no injury. Rack restraint refitted.', reported_by: 'S. van Wyk', responsible_person: 'Site Supervisor', immediate_action: 'Area cordoned, rack restraint replaced.' },
    { category: 'Toolbox Talk', date: '2026-07-13', severity: 'Low', status: 'Closed', description: 'Manual handling of drill rods and casing.', reported_by: 'E. Khumalo', responsible_person: 'E. Khumalo' },
    { category: 'Environmental Incident', date: '2026-07-16', severity: 'Medium', status: 'Open', description: 'Minor hydraulic seep at rig; drip tray deployed, soil removed.', reported_by: 'P. Ndlovu', responsible_person: 'Environmental Officer', due_date: '2026-08-14' },
    { category: 'PPE Compliance', date: '2026-07-21', severity: 'Low', status: 'Open', description: 'Two crew without hearing protection during percussion drilling.', reported_by: 'E. Khumalo', responsible_person: 'Site Supervisor', due_date: '2026-08-08' },
  ];
  for (const h of hse) await tryCall('HSE records', 'POST', '/api/hse', { ...h, project_id: pid });

  const equipment = [
    { name: 'Atlas Copco CS14', type: 'Core Drilling Rig', asset_tag: 'MK-RIG-007', status: 'In Use', assigned_project_id: pid, last_inspection_date: '2026-07-01', next_maintenance_date: '2026-09-01' },
    { name: 'Boart Longyear LF70', type: 'Core Drilling Rig', asset_tag: 'MK-RIG-012', status: 'In Use', assigned_project_id: pid, last_inspection_date: '2026-06-24', next_maintenance_date: '2026-08-24' },
    { name: 'Water Bowser 5000 L', type: 'Support Vehicle', asset_tag: 'MK-SUP-003', status: 'Available', last_inspection_date: '2026-07-02', next_maintenance_date: '2026-10-02' },
    { name: 'SPT Automatic Trip Hammer', type: 'Test Equipment', asset_tag: 'MK-TST-021', status: 'In Use', assigned_project_id: pid, last_inspection_date: '2026-07-05', next_maintenance_date: '2026-08-30' },
    { name: 'Generator 15 kVA', type: 'Support Equipment', asset_tag: 'MK-SUP-009', status: 'Under Maintenance', last_inspection_date: '2026-06-18', next_maintenance_date: '2026-08-10' },
  ];
  for (const e of equipment) await tryCall('equipment', 'POST', '/api/equipment', e);

  for (let d = 0; d < 12; d++) {
    for (const person of OPERATORS) {
      await tryCall('timesheets', 'POST', '/api/timesheets', {
        person_name: person,
        project_id: pid,
        date: addDays('2026-07-06', d),
        hours: d % 5 === 4 ? 6.5 : 9.5,
        task_description: d % 5 === 4 ? 'Site standdown / maintenance' : 'Drilling, sampling and logging',
      });
    }
  }

  console.log('\nCreated:');
  Object.entries(counts).sort().forEach(([k, v]) => console.log(`  ${String(v).padStart(4)}  ${k}`));
  if (failures.length) {
    console.log(`\n${failures.length} rejected by the API:`);
    failures.slice(0, 15).forEach((f) => console.log('  -', f));
  } else {
    console.log('\nNo rejections — every record passed server-side validation.');
  }
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
