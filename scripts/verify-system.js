// End-to-end verification of a populated GeoCorelytics instance.
//
// Every assertion recomputes the expected answer from the raw records rather
// than trusting what the API reports, so a bug in the analytics layer cannot
// mask itself. Also drives the rejection paths — bad data must be refused.
//
//   node scripts/verify-system.js [baseUrl] [adminEmail] [adminPassword]

const BASE = process.argv[2] || 'http://localhost:3000';
const EMAIL = process.argv[3] || 'admin@drilltrack.test';
const PASSWORD = process.argv[4] || 'localdev12345';

const results = [];
let jar = {};

async function call(method, path, body, who = 'admin') {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(jar[who] ? { Cookie: jar[who] } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie');
  if (sc) jar[who] = sc.split(';')[0];
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  return { status: res.status, data };
}

function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const near = (a, b, tol = 0.05) => Math.abs(Number(a) - Number(b)) <= tol;

async function main() {
  console.log(`Verifying ${BASE}\n`);
  const login = await call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
  if (login.status !== 200) { console.error('Admin login failed'); process.exit(1); }

  const projects = (await call('GET', '/api/projects')).data;
  const allRuns = (await call('GET', '/api/runs')).data;
  const allSamples = (await call('GET', '/api/samples')).data;
  const allTests = (await call('GET', '/api/tests')).data;

  // ---------- 1. Referential integrity ----------
  console.log('1. Sample & test linkage');
  const unlinkedS = allSamples.filter((s) => !s.run_id);
  const unlinkedT = allTests.filter((t) => !t.run_id);
  check('every sample links to a drilling run', unlinkedS.length === 0, `${allSamples.length - unlinkedS.length}/${allSamples.length}`);
  check('every test links to a drilling run', unlinkedT.length === 0, `${allTests.length - unlinkedT.length}/${allTests.length}`);

  // A sampler is driven ahead of the hole bottom, so an interval may legitimately
  // cross a run boundary. The invariant is that the linked run was the one in
  // progress at the sample's start depth.
  const runById = new Map(allRuns.map((r) => [r.id, r]));
  const badlyLinked = allSamples.filter((s) => {
    const r = runById.get(s.run_id);
    return !r || s.depth_from < r.depth_from - 1e-6 || s.depth_from >= r.depth_to + 1e-6;
  });
  check('linked run was in progress at the sample start depth', badlyLinked.length === 0,
    badlyLinked.length ? `${badlyLinked.length} mislinked` : `all ${allSamples.length} correct`);

  const straddling = allSamples.filter((s) => {
    const r = runById.get(s.run_id);
    return r && s.depth_to > r.depth_to + 1e-6;
  });
  check('boundary-crossing samples attach to the earlier run', straddling.every((s) => {
    const r = runById.get(s.run_id);
    return s.depth_from >= r.depth_from - 1e-6;
  }), `${straddling.length} cross a run boundary`);

  // ---------- 2. Depth continuity within each borehole ----------
  console.log('\n2. Depth continuity');
  let overlaps = 0, reversed = 0;
  const byBh = {};
  allRuns.forEach((r) => (byBh[r.borehole_id] = byBh[r.borehole_id] || []).push(r));
  for (const rs of Object.values(byBh)) {
    rs.sort((a, b) => a.depth_from - b.depth_from);
    rs.forEach((r, i) => {
      if (r.depth_to <= r.depth_from) reversed++;
      if (i && r.depth_from < rs[i - 1].depth_to - 1e-6) overlaps++;
    });
  }
  check('no overlapping drilling runs', overlaps === 0, `${allRuns.length} runs checked`);
  check('no reversed/zero-length runs', reversed === 0);

  // ---------- 3. SPT N-value (ASTM D1586) ----------
  console.log('\n3. SPT calculation');
  const spt = allSamples.filter((s) => s.sample_type === 'SPT' && s.sample_data);
  const wrongN = spt.filter((s) => {
    const d = s.sample_data;
    return Number(s.spt_n_value) !== Number(d.blows_150_2) + Number(d.blows_150_3);
  });
  check('N = 2nd + 3rd increment (seating & 1st excluded)', wrongN.length === 0, `${spt.length} SPT samples`);
  const sample = spt[0];
  if (sample) {
    const d = sample.sample_data;
    check('  worked example', Number(sample.spt_n_value) === Number(d.blows_150_2) + Number(d.blows_150_3),
      `seating ${d.seating_blows} + ${d.blows_150_1}/${d.blows_150_2}/${d.blows_150_3} -> N=${sample.spt_n_value}`);
  }

  // ---------- 4. Decimal fidelity ----------
  console.log('\n4. Decimal handling');
  const decimals = allSamples.filter((s) => String(s.depth_from).includes('.') || String(s.depth_to).includes('.'));
  const truncated = allSamples.filter((s) => Number.isInteger(s.depth_from) && Number.isInteger(s.depth_to) && s.depth_to - s.depth_from === 0);
  check('decimal depths stored intact', decimals.length > 0 && truncated.length === 0,
    `${decimals.length}/${allSamples.length} carry decimals, e.g. ${decimals[0] && decimals[0].depth_from}–${decimals[0] && decimals[0].depth_to} m`);

  // ---------- 5. Analytics arithmetic, recomputed independently ----------
  console.log('\n5. Analytics correctness');
  const a = (await call('GET', '/api/analytics')).data;
  const expectedMetres = allRuns.reduce((s, r) => s + (r.depth_to - r.depth_from), 0);
  check('total metres matches sum of run intervals', near(a.headline.total_metres, expectedMetres, 0.02),
    `api ${a.headline.total_metres} vs computed ${expectedMetres.toFixed(2)}`);
  check('run count matches', a.headline.total_runs === allRuns.length, `${a.headline.total_runs}`);

  const expectedDays = new Set(allRuns.map((r) => r.date).filter(Boolean)).size;
  check('drilling days matches distinct dates', a.headline.drilling_days === expectedDays, `${expectedDays} days`);

  const expectedDown = allRuns.reduce((s, r) => s + (r.downtime_min || 0), 0) / 60;
  check('downtime hours matches sum', near(a.headline.total_downtime_hours, expectedDown, 0.02),
    `api ${a.headline.total_downtime_hours} h vs computed ${expectedDown.toFixed(2)} h`);

  const cored = allRuns.filter((r) => r.core_recovered_m != null);
  const coredSum = cored.reduce((s, r) => s + r.core_recovered_m, 0);
  const coredInterval = cored.reduce((s, r) => s + (r.depth_to - r.depth_from), 0);
  check('core recovery % matches recovered/drilled', near(a.headline.core_recovery_pct, (coredSum / coredInterval) * 100, 0.15),
    `api ${a.headline.core_recovery_pct}% vs computed ${((coredSum / coredInterval) * 100).toFixed(1)}%`);

  const dailySum = a.production.daily.reduce((s, d) => s + d.y, 0);
  check('daily production sums to total', near(dailySum, expectedMetres, 0.3), `${dailySum.toFixed(2)} m`);
  const lastCum = a.production.daily[a.production.daily.length - 1];
  check('cumulative ends at total', lastCum && near(lastCum.cumulative, expectedMetres, 0.3), lastCum && `${lastCum.cumulative} m`);

  // completion % per borehole
  const badPct = (a.completion || []).filter((c) => {
    if (!c.target_depth) return false;
    return !near(c.completion_pct, Math.min(100, (c.current_depth / c.target_depth) * 100), 0.2);
  });
  check('borehole completion % correct', badPct.length === 0, `${a.completion.length} boreholes`);

  // ---------- 6. Recommendations fire on the seeded anomalies ----------
  console.log('\n6. Recommendations');
  const titles = a.recommendations.map((r) => r.title);
  check('flags the low-recovery zone', titles.some((t) => /low core recovery/i.test(t)),
    titles.filter((t) => /recovery/i.test(t))[0] || 'not raised');
  check('flags abnormally slow penetration', titles.some((t) => /slow penetration/i.test(t)),
    titles.filter((t) => /penetration/i.test(t))[0] || 'not raised');
  check('produced actionable recommendations', a.recommendations.length > 0, `${a.recommendations.length} raised`);
  check('every recommendation carries detail text', a.recommendations.every((r) => r.detail && r.detail.length > 20));

  // ---------- 7. Filters actually filter ----------
  console.log('\n7. Filtering');
  const rig = a.dimensions.rigs[0];
  const byRig = (await call('GET', `/api/analytics?rig=${encodeURIComponent(rig)}`)).data;
  const expectRig = allRuns.filter((r) => r.rig_name === rig).reduce((s, r) => s + (r.depth_to - r.depth_from), 0);
  check('rig filter narrows correctly', near(byRig.headline.total_metres, expectRig, 0.02),
    `${rig}: ${byRig.headline.total_metres} m of ${a.headline.total_metres} m`);

  const op = a.dimensions.operators[0];
  const byOp = (await call('GET', `/api/analytics?operator=${encodeURIComponent(op)}`)).data;
  const expectOp = allRuns.filter((r) => r.operator_name === op).reduce((s, r) => s + (r.depth_to - r.depth_from), 0);
  check('operator filter narrows correctly', near(byOp.headline.total_metres, expectOp, 0.02), `${op}: ${byOp.headline.total_metres} m`);

  const proj = projects[0];
  const byProj = (await call('GET', `/api/analytics?project_id=${proj.id}`)).data;
  check('project filter narrows correctly', byProj.headline.total_metres < a.headline.total_metres && byProj.headline.total_metres > 0,
    `${proj.name.slice(0, 28)}: ${byProj.headline.total_metres} m`);

  // ---------- 8. Validation must reject bad data ----------
  console.log('\n8. Validation rejects bad input');
  const bh = (await call('GET', `/api/projects/${proj.id}/boreholes`)).data[0];
  const cases = [
    ['reversed interval', { depth_from: 5, depth_to: 4, sample_type: 'SPT' }],
    ['overlapping an existing sample', { depth_from: bh ? 1.1 : 1.1, depth_to: 1.3, sample_type: 'SPT' }],
    ['beyond the borehole depth', { depth_from: 900, depth_to: 901, sample_type: 'SPT', skip_reason: 'x' }],
    ['zero-length interval', { depth_from: 3, depth_to: 3, sample_type: 'SPT' }],
  ];
  for (const [label, body] of cases) {
    const r = await call('POST', `/api/boreholes/${bh.id}/samples`, body);
    check(`rejects ${label}`, r.status === 400, r.data && r.data.error ? String(r.data.error).slice(0, 62) : `HTTP ${r.status}`);
  }
  // Run-level rules need a clean borehole, otherwise an overlap error fires
  // first and the assertion passes for the wrong reason.
  const scratch = (await call('POST', `/api/projects/${proj.id}/boreholes`, {
    code: `ZZ-VERIFY-${Date.now()}`, total_depth: 50, status: 'Planned',
  })).data;

  const recoveryCase = await call('POST', `/api/boreholes/${scratch.id}/runs`, { depth_from: 0, depth_to: 3, core_recovered_m: 9 });
  check('rejects core recovery exceeding drilled interval', recoveryCase.status === 400 && /core recovered/i.test(recoveryCase.data.error || ''),
    recoveryCase.data && recoveryCase.data.error);

  const rqdCase = await call('POST', `/api/boreholes/${scratch.id}/runs`, { depth_from: 0, depth_to: 3, rqd_pct: 140 });
  check('rejects out-of-range RQD', rqdCase.status === 400 && /rqd/i.test(rqdCase.data.error || ''), rqdCase.data && rqdCase.data.error);

  const gapCase = await call('POST', `/api/boreholes/${scratch.id}/runs`, { depth_from: 0, depth_to: 3 });
  const gapReject = await call('POST', `/api/boreholes/${scratch.id}/runs`, { depth_from: 8, depth_to: 10 });
  check('requires a reason for an unexplained depth gap', gapCase.status === 201 && gapReject.status === 400 && /gap/i.test(gapReject.data.error || ''),
    gapReject.data && String(gapReject.data.error).slice(0, 70));

  const gapAccept = await call('POST', `/api/boreholes/${scratch.id}/runs`, { depth_from: 8, depth_to: 10, skip_reason: 'Cased through collapsed zone' });
  check('accepts the same gap once justified', gapAccept.status === 201, `HTTP ${gapAccept.status}`);

  const noRun = await call('POST', `/api/boreholes/${scratch.id}/samples`, { depth_from: 4, depth_to: 4.5, sample_type: 'SPT', skip_reason: 'x' });
  check('rejects a sample in an undrilled interval', noRun.status === 400 && /drilling run/i.test(noRun.data.error || ''),
    noRun.data && String(noRun.data.error).slice(0, 70));

  await call('DELETE', `/api/boreholes/${scratch.id}`);

  // ---------- 9. Role scoping ----------
  console.log('\n9. Role-based access');
  const cl = await call('POST', '/api/auth/login', { email: 'client@citydot.test', password: 'localdev12345' }, 'client');
  if (cl.status === 200) {
    const clientProjects = (await call('GET', '/api/projects', null, 'client')).data;
    check('client sees only assigned projects', Array.isArray(clientProjects) && clientProjects.length < projects.length,
      `${clientProjects.length} of ${projects.length}`);
    const hse = await call('GET', '/api/hse', null, 'client');
    check('client blocked from HSE register', hse.status === 403, `HTTP ${hse.status}`);
    const users = await call('GET', '/api/users', null, 'client');
    check('client blocked from user admin', users.status === 403, `HTTP ${users.status}`);
    const write = await call('POST', '/api/projects', { name: 'should not work' }, 'client');
    check('client cannot create projects', write.status === 403, `HTTP ${write.status}`);
  } else {
    check('client login', false, 'could not log in as client — skipped scoping checks');
  }

  const fd = await call('POST', '/api/auth/login', { email: 'field@drilltrack.test', password: 'localdev12345' }, 'field');
  if (fd.status === 200) {
    const del = await call('DELETE', `/api/projects/${proj.id}`, null, 'field');
    check('field user cannot delete projects', del.status === 403, `HTTP ${del.status}`);
    const runs = await call('GET', '/api/runs', null, 'field');
    check('field user can read drilling runs', runs.status === 200 && runs.data.length > 0, `${runs.data.length} runs`);
  }

  // ---------- 10. Reports & lookups ----------
  console.log('\n10. Supporting data');
  const lk = (await call('GET', '/api/lookups')).data;
  const catCount = Object.keys(lk.options).length;
  const optCount = Object.values(lk.options).reduce((s, v) => s + v.length, 0);
  check('controlled vocabularies loaded', catCount >= 30 && optCount >= 300, `${catCount} categories, ${optCount} values`);
  const stats = (await call('GET', '/api/stats')).data;
  check('dashboard stats reflect seeded data', stats.total_projects === projects.length && stats.total_samples === allSamples.length,
    `${stats.total_projects} projects, ${stats.total_boreholes} boreholes, ${stats.total_samples} samples`);

  // ---------- Summary ----------
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${'='.repeat(58)}`);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFailures:');
    failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`));
    process.exit(1);
  }
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
