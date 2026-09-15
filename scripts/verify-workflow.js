// Walks the drill -> SPT -> drill cycle exactly as the smart-form spec
// describes it, checking the system carries depths forward on its own.
//
//   node scripts/verify-workflow.js [baseUrl] [email] [password]

const BASE = process.argv[2] || 'http://localhost:3000';
const EMAIL = process.argv[3] || 'admin@drilltrack.test';
const PASSWORD = process.argv[4] || 'localdev12345';

let cookie = '';
const results = [];

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const t = await res.text();
  let data = null;
  try { data = t ? JSON.parse(t) : null; } catch (_) { data = t; }
  return { status: res.status, data };
}

function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const near = (a, b, t = 0.001) => Math.abs(Number(a) - Number(b)) <= t;

async function main() {
  console.log(`Workflow check against ${BASE}\n`);
  await call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });

  const project = (await call('POST', '/api/projects', { name: `Workflow check ${Date.now()}`, client: 'QA', status: 'Active' })).data;
  const bh = (await call('POST', `/api/projects/${project.id}/boreholes`, { code: 'WF-BH01', total_depth: 30, planned_depth: 30, status: 'In Progress' })).data;

  // ---------- Drill 0 -> 6.00 m ----------
  console.log('Drilling run 1: 0 -> 6.00 m, 90 min active');
  const run1 = (await call('POST', `/api/boreholes/${bh.id}/runs`, {
    run_number: 1, depth_from: 0, depth_to: 6.0, date: '2026-08-01',
    drilling_time_min: 90, downtime_min: 45, downtime_reason: 'Rig Move / Setup',
    core_recovered_m: 5.4, rqd_pct: 82,
    // deliberately wrong, to prove the client value is ignored
    penetration_rate_m_hr: 999,
  })).data;
  check('depth drilled derived', near(run1.depth_drilled_m, 6.0), `${run1.depth_drilled_m} m`);
  check('penetration rate = 6.0 m / 1.5 h = 4 m/h', near(run1.penetration_rate_m_hr, 4),
    `stored ${run1.penetration_rate_m_hr} m/h (client sent 999)`);
  check('client-supplied rate ignored', run1.penetration_rate_m_hr !== 999);
  check('downtime excluded from the rate', near(run1.penetration_rate_m_hr, 4),
    '45 min downtime would have given 2.67 m/h');
  check('RQD 82% classified as Good', run1.rqd_classification === 'Good', run1.rqd_classification);

  // ---------- SPT prefill ----------
  console.log('\nSPT prefill');
  const ctx = (await call('GET', `/api/boreholes/${bh.id}/next-interval?kind=sample`)).data;
  check('start depth = end of the drilling run', near(ctx.suggested_from, 6.0), `${ctx.suggested_from} m (${ctx.suggested_source})`);
  check('standard penetration offered as 450 mm', ctx.standard_penetration_mm === 450);
  check('end depth pre-computed as 6.45 m', near(ctx.suggested_to, 6.45), `${ctx.suggested_to} m`);
  check('short-penetration reasons supplied', Array.isArray(ctx.short_penetration_reasons) && ctx.short_penetration_reasons.includes('Refusal'),
    (ctx.short_penetration_reasons || []).join(', '));

  // ---------- Full 450 mm drive ----------
  console.log('\nSPT at the hole bottom, full 450 mm');
  const spt1 = (await call('POST', `/api/boreholes/${bh.id}/samples`, {
    sample_type: 'SPT', sample_ref: 'WF-SPT-01',
    depth_from: 6.0, depth_to: 6.45, penetration_achieved_mm: 450,
    date: '2026-08-01', spt_n_value: 21,
    sample_data: { seating_blows: 7, blows_150_300: 9, blows_300_450: 12, penetration_length_mm: 450 },
  }));
  check('accepted below the drilled depth', spt1.status === 201, spt1.status === 201 ? '6.00–6.45 m' : spt1.data.error);
  check('linked to the run that reached 6.00 m', spt1.data && spt1.data.run_id === run1.id);
  check('no skip reason demanded', spt1.status === 201);

  // ---------- Next run continues from the SPT ----------
  console.log('\nNext drilling run');
  const next = (await call('GET', `/api/boreholes/${bh.id}/next-run`)).data;
  check('continues from the SPT end depth, not the run end', near(next.depth_from, 6.45),
    `${next.depth_from} m (${next.depth_from_source})`);
  check('run number auto-incremented', next.run_number === 2, `run ${next.run_number}`);
  check('carries the previous method and crew forward', next.defaults.drilling_method !== undefined);

  const run2 = (await call('POST', `/api/boreholes/${bh.id}/runs`, {
    run_number: 2, depth_from: 6.45, depth_to: 9.45, date: '2026-08-01', drilling_time_min: 60, rqd_pct: 34,
  }));
  check('run accepted starting at the SPT end depth', run2.status === 201, run2.status === 201 ? '6.45–9.45 m' : run2.data.error);
  check('RQD 34% classified as Poor', run2.data && run2.data.rqd_classification === 'Poor', run2.data && run2.data.rqd_classification);

  // ---------- Partial penetration ----------
  console.log('\nRefusal — drive stops at 300 mm');
  const short = await call('POST', `/api/boreholes/${bh.id}/samples`, {
    sample_type: 'SPT', depth_from: 9.45, depth_to: 9.75, penetration_achieved_mm: 300, date: '2026-08-01',
  });
  check('short drive without a reason is rejected', short.status === 400 && /stopped at/i.test(short.data.error || ''),
    short.data && String(short.data.error).slice(0, 64));

  const shortOk = await call('POST', `/api/boreholes/${bh.id}/samples`, {
    sample_type: 'SPT', sample_ref: 'WF-SPT-02', depth_from: 9.45, depth_to: 9.75,
    penetration_achieved_mm: 300, short_penetration_reason: 'Refusal', date: '2026-08-01',
  });
  check('accepted once the reason is recorded', shortOk.status === 201, shortOk.status === 201 ? '9.45–9.75 m, Refusal' : shortOk.data.error);

  const mismatch = await call('POST', `/api/boreholes/${bh.id}/samples`, {
    sample_type: 'SPT', depth_from: 9.75, depth_to: 10.5, penetration_achieved_mm: 300, short_penetration_reason: 'Refusal',
  });
  check('interval must agree with the stated penetration', mismatch.status === 400 && /does not match/i.test(mismatch.data.error || ''),
    mismatch.data && String(mismatch.data.error).slice(0, 72));

  const afterShort = (await call('GET', `/api/boreholes/${bh.id}/next-run`)).data;
  check('hole advances only by what was achieved', near(afterShort.depth_from, 9.75), `${afterShort.depth_from} m, not 9.90 m`);

  // ---------- RQD bounds ----------
  // Each rule must be rejected for its own reason, not incidentally by an
  // earlier check — otherwise the assertion proves nothing.
  console.log('\nRQD bounds');
  for (const [v, label] of [[-5, 'below 0'], [105, 'above 100']]) {
    const r = await call('POST', `/api/boreholes/${bh.id}/runs`, { depth_from: 9.75, depth_to: 11, date: '2026-08-01', rqd_pct: v, drilling_time_min: 30 });
    check(`rejects RQD ${label}`, r.status === 400 && /rqd/i.test(r.data.error || ''), r.data && r.data.error);
  }

  // ---------- Override + audit ----------
  console.log('\nOverride of a calculated value');
  const noReason = await call('POST', `/api/boreholes/${bh.id}/runs`, {
    depth_from: 9.75, depth_to: 12, date: '2026-08-01', drilling_time_min: 60, penetration_rate_override: 7.5,
  });
  check('override without a reason is rejected', noReason.status === 400 && /reason/i.test(noReason.data.error || ''),
    noReason.data && noReason.data.error);

  const withReason = await call('POST', `/api/boreholes/${bh.id}/runs`, {
    run_number: 3, depth_from: 9.75, depth_to: 12, date: '2026-08-01', drilling_time_min: 60,
    penetration_rate_override: 7.5, override_reason: 'Timer left running through a rod change',
  });
  check('override accepted with a reason', withReason.status === 201 && near(withReason.data.penetration_rate_m_hr, 7.5),
    `stored ${withReason.data && withReason.data.penetration_rate_m_hr} m/h instead of the calculated 2.25`);

  const audit = (await call('GET', `/api/audit/run/${withReason.data.id}`)).data;
  check('override written to the audit trail', Array.isArray(audit) && audit.length === 1, audit[0] && `${audit[0].field}: ${audit[0].computed_value} -> ${audit[0].override_value}`);
  check('audit records who and why', audit[0] && audit[0].reason && audit[0].user_name,
    audit[0] && `${audit[0].user_name}: "${audit[0].reason}"`);

  // ---------- Genuine gap still caught ----------
  console.log('\nUndrilled ground is still refused');
  const undrilled = await call('POST', `/api/boreholes/${bh.id}/samples`, {
    sample_type: 'Shelby', depth_from: 25, depth_to: 25.6,
  });
  check('sample below the hole bottom rejected', undrilled.status === 400, undrilled.data && String(undrilled.data.error).slice(0, 70));

  // ---------- The link must SURVIVE the next run ----------
  // The original version of this script asserted the sample-to-run link
  // immediately after inserting the sample, before the next run existed. That
  // ordering hid a real defect: relinking keyed on the DEEPEST run, so every
  // bottom-of-hole sample silently unlinked the moment the hole went deeper.
  // Re-read the sample now, with three runs above it.
  console.log('\nLink persistence (re-read after later runs exist)');
  const allSamples = (await call('GET', `/api/boreholes/${bh.id}/samples`)).data;
  const firstSpt = allSamples.find((s) => s.sample_ref === 'WF-SPT-01');
  check('bottom-of-hole sample still linked after later runs', !!(firstSpt && firstSpt.run_id),
    firstSpt ? `run_id=${firstSpt.run_id}` : 'sample missing');
  check('still linked to the run that reached its start depth', firstSpt && firstSpt.run_id === run1.id,
    firstSpt && `expected run1=${run1.id}, got ${firstSpt.run_id}`);
  check('no sample left unlinked', allSamples.every((s) => s.run_id), `${allSamples.filter((s) => s.run_id).length}/${allSamples.length} linked`);

  // ---------- Active drilling time off the clock ----------
  console.log('\nActive drilling time derived from start/end time');
  const clocked = await call('POST', `/api/boreholes/${bh.id}/runs`, {
    run_number: 4, depth_from: 12, depth_to: 15, date: '2026-08-02',
    start_time: '07:00', end_time: '15:30', downtime_min: 45,
  });
  check('derived from the clock, less downtime', clocked.status === 201 && near(clocked.data.drilling_time_min, 465),
    `07:00–15:30 = 510 min, less 45 = ${clocked.data && clocked.data.drilling_time_min} min`);
  check('rate uses the derived active time', near(clocked.data.penetration_rate_m_hr, 3 / (465 / 60)),
    `${clocked.data && clocked.data.penetration_rate_m_hr} m/h`);

  const night = await call('POST', `/api/boreholes/${bh.id}/runs`, {
    run_number: 5, depth_from: 15, depth_to: 17, date: '2026-08-02',
    start_time: '22:00', end_time: '04:00', downtime_min: 60,
  });
  check('night shift crossing midnight is not negative', night.status === 201 && near(night.data.drilling_time_min, 300),
    `22:00–04:00 = 360 min, less 60 = ${night.data && night.data.drilling_time_min} min`);

  // ---------- RQD ----------
  console.log('\nRQD');
  const noRqd = await call('POST', `/api/boreholes/${bh.id}/runs`, {
    run_number: 6, depth_from: 17, depth_to: 18, date: '2026-08-02', start_time: '08:00', end_time: '09:00',
  });
  check('a blank RQD is NOT classified', noRqd.status === 201 && noRqd.data.rqd_classification === null,
    `classification: ${JSON.stringify(noRqd.data && noRqd.data.rqd_classification)} (was fabricating "Very Poor")`);

  // ---------- Casing ----------
  console.log('\nCasing run over already-drilled ground');
  const casing = await call('POST', `/api/boreholes/${bh.id}/runs`, {
    run_number: 7, run_type: 'Casing', depth_from: 0, depth_to: 12, date: '2026-08-02',
    drilling_status: 'Casing', remarks: 'Cased to 12 m after drilling',
  });
  check('casing may overlap drilled ground', casing.status === 201, casing.status === 201 ? '0–12 m over drilled ground' : casing.data.error);
  check('casing does not need to continue from the last run', casing.status === 201);

  const afterCasing = (await call('GET', `/api/boreholes/${bh.id}/next-run`)).data;
  check('casing does not move the hole bottom', near(afterCasing.depth_from, 18), `next run still starts at ${afterCasing.depth_from} m`);

  const anaC = (await call('GET', `/api/analytics?borehole_id=${bh.id}`)).data;
  check('casing excluded from metres drilled', near(anaC.headline.total_metres, 18, 0.02),
    `${anaC.headline.total_metres} m — casing's 12 m not double-counted`);
  check('casing counted as a run but reported separately', anaC.headline.casing_runs === 1, `${anaC.headline.casing_runs} casing run(s)`);

  const casingBeyond = await call('POST', `/api/boreholes/${bh.id}/runs`, {
    run_number: 8, run_type: 'Casing', depth_from: 0, depth_to: 28, date: '2026-08-02',
  });
  check('casing past the hole bottom is refused', casingBeyond.status === 400 && /only reached/i.test(casingBeyond.data.error || ''),
    casingBeyond.data && String(casingBeyond.data.error).slice(0, 62));

  // ---------- The hero figure and every chart must agree ----------
  // Metres were previously defined three different ways in one response: the
  // headline merged sampler advance and excluded casing, while the daily,
  // per-shift, rig and planned-vs-actual figures summed raw run intervals.
  // A cased hole showed ~2x the metres on the chart beside the total.
  console.log('\nAll metre figures agree');
  const ana = (await call('GET', `/api/analytics?borehole_id=${bh.id}`)).data;
  const lastDaily = ana.production.daily[ana.production.daily.length - 1];
  const lastPva = ana.plannedVsActual.points.length ? ana.plannedVsActual.points[ana.plannedVsActual.points.length - 1] : null;
  check('daily cumulative ends on the headline total', lastDaily && near(lastDaily.cumulative, ana.headline.total_metres, 0.02),
    `headline ${ana.headline.total_metres} m vs chart ${lastDaily && lastDaily.cumulative} m`);
  if (lastPva) {
    check('planned-vs-actual uses the same total', near(lastPva.actual, ana.headline.total_metres, 0.02),
      `actual ${lastPva.actual} m`);
  }
  check('the headline says what it is counting', !!ana.headline.advance_basis,
    `${ana.headline.advance_basis} — ${ana.headline.run_metres} m cut + ${ana.headline.sampler_advanced_metres} m sampler`);
  check('nothing in the total is missing from the charts', ana.headline.undated_metres === 0,
    `${ana.headline.undated_metres} m undated`);
  check('rig metres exclude casing', ana.equipment.every((e) => e.y <= ana.headline.total_metres + 0.02),
    ana.equipment.map((e) => `${e.x}: ${e.y} m`).join(', '));

  // A date window scopes runs; samples and tests carry their own date and must
  // be scoped to the same window or the total counts metres from other days.
  const oneDay = (await call('GET', `/api/analytics?borehole_id=${bh.id}&date_from=2026-08-01&date_to=2026-08-01`)).data;
  const dailySum = oneDay.production.daily.reduce((a, d) => a + d.y, 0);
  check('a date filter scopes samples too', near(oneDay.headline.total_metres, dailySum, 0.02),
    `total ${oneDay.headline.total_metres} m vs daily sum ${dailySum.toFixed(2)} m`);

  // A blank reading is not a measured zero anywhere in the stack.
  const blanks = (await call('GET', `/api/analytics?borehole_id=${bh.id}`)).data;
  // Runs 4-7 were created with no rqd_pct. Before the blank guard they each
  // arrived as a measured 0%, putting phantom points on the chart and
  // labelling the rock "Very Poor".
  const runsNow = (await call('GET', `/api/boreholes/${bh.id}/runs`)).data;
  const withRqd = runsNow.filter((r) => r.rqd_pct !== null && r.rqd_pct !== undefined).length;
  check('RQD chart plots only runs that recorded an RQD', blanks.groundConditions.rqd.length === withRqd,
    `${blanks.groundConditions.rqd.length} plotted, ${withRqd} of ${runsNow.length} runs have a value`);
  check('no run without RQD is classified', runsNow.every((r) => (r.rqd_pct === null || r.rqd_pct === undefined) === (r.rqd_classification === null)),
    `${runsNow.filter((r) => r.rqd_classification === null).length} unclassified`);

  // ---------- An undated run cannot be charted, so it cannot be saved ----------
  // Every chart on the analytics page is keyed by date. A run saved without
  // one still counted toward metres drilled but sat on no day, so the
  // cumulative line ended below the total printed directly above it — the
  // "total metres does not match the runs" mismatch, reproduced exactly.
  console.log('\nA run must carry a date');
  const undated = await call('POST', `/api/boreholes/${bh.id}/runs`, {
    run_number: 9, depth_from: 18, depth_to: 19, drilling_time_min: 30,
  });
  check('a run with no date is refused', undated.status === 400 && /date is required/i.test(undated.data.error || ''),
    undated.data && String(undated.data.error).slice(0, 70));

  // ---------- Depths are only comparable within one hole ----------
  // Merging every borehole's spans into one list made two holes that both
  // start at surface overlap, so a second hole added almost no metres.
  console.log('\nTwo holes are not merged into one');
  const bh2 = (await call('POST', `/api/projects/${project.id}/boreholes`, {
    code: 'WF-BH02', total_depth: 30, planned_depth: 30, status: 'In Progress',
  })).data;
  await call('POST', `/api/boreholes/${bh2.id}/runs`, {
    run_number: 1, depth_from: 0, depth_to: 8, date: '2026-08-03', drilling_time_min: 120,
  });
  const proj = (await call('GET', `/api/analytics?project_id=${project.id}`)).data;
  const projLast = proj.production.daily[proj.production.daily.length - 1];
  check('a second hole from surface adds its full depth', near(proj.headline.total_metres, 26, 0.02),
    `${proj.headline.total_metres} m — 18 m in BH01 + 8 m in BH02, not merged at surface`);
  check('the project cumulative matches the project total', projLast && near(projLast.cumulative, proj.headline.total_metres, 0.02),
    `headline ${proj.headline.total_metres} m vs chart ${projLast && projLast.cumulative} m`);

  await call('DELETE', `/api/projects/${project.id}`);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${'='.repeat(58)}`);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    failed.forEach((f) => console.log(`  - ${f.name}`));
    process.exit(1);
  }
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
