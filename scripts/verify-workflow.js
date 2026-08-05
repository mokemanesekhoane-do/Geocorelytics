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
    sample_data: { blows_150_1: 7, blows_150_2: 9, blows_150_3: 12, penetration_length_mm: 450 },
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
    const r = await call('POST', `/api/boreholes/${bh.id}/runs`, { depth_from: 9.75, depth_to: 11, rqd_pct: v, drilling_time_min: 30 });
    check(`rejects RQD ${label}`, r.status === 400 && /rqd/i.test(r.data.error || ''), r.data && r.data.error);
  }

  // ---------- Override + audit ----------
  console.log('\nOverride of a calculated value');
  const noReason = await call('POST', `/api/boreholes/${bh.id}/runs`, {
    depth_from: 9.75, depth_to: 12, drilling_time_min: 60, penetration_rate_override: 7.5,
  });
  check('override without a reason is rejected', noReason.status === 400 && /reason/i.test(noReason.data.error || ''),
    noReason.data && noReason.data.error);

  const withReason = await call('POST', `/api/boreholes/${bh.id}/runs`, {
    run_number: 3, depth_from: 9.75, depth_to: 12, drilling_time_min: 60,
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
