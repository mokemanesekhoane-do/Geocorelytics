// Analytics + recommendations over captured drilling data.
//
// Everything here is derived on read from drilling_runs / samples / tests —
// nothing is precomputed or cached — so every figure and graph reflects the
// data as captured, and a newly logged run changes the numbers immediately.
//
// All series are returned as plain {x, y, meta} points so the frontend chart
// layer stays dumb: it renders what it is given and uses `meta` for drill-down.

const derive = require('../public/derive');

const ROUND = (v, dp = 2) => (v === null || !Number.isFinite(v) ? null : Number(v.toFixed(dp)));

// Number(null) and Number('') are both 0, and 0 is finite — so the obvious
// coercion silently turns "not recorded" into a measured zero. That put 21 of
// 30 runs on the RQD-vs-depth chart as 0% readings they never had, and raised
// low-recovery warnings against runs where no core was logged at all.
const num = derive.blankToNull;

// Metres a run advanced the hole. Casing is set after drilling, through
// ground already cut, so it advances nothing and must never be counted.
function runMetres(r) {
  if (derive.isCasingRun(r)) return 0;
  return Math.max(0, (num(r.depth_to) ?? 0) - (num(r.depth_from) ?? 0));
}

// Spans that account for the hole being deeper.
//
// Two different questions are asked of this, and they take different sets:
//   'advance'  — what made the hole deeper. Runs that cut ground, and
//                samplers driven ahead of the bit. NOT in-situ tests: a
//                packer or falling-head section is run in a hole that has
//                already been drilled, so counting its length would inflate
//                metres drilled by ground nobody cut.
//   'coverage' — what the record accounts for, used to tell a genuine break
//                from the ordinary drill/sample interleave. Tests belong
//                here: the interval is documented even though it advanced
//                nothing.
// Casing is in neither — it re-covers ground already drilled.
function advanceSpans(runs, samples, tests, mode) {
  const spans = [];
  for (const r of runs) {
    if (derive.isCasingRun(r)) continue;
    spans.push({ from: num(r.depth_from), to: num(r.depth_to), kind: 'run', ref: r });
  }
  for (const s of samples) spans.push({ from: num(s.depth_from), to: num(s.depth_to), kind: 'sample', ref: s });
  if (mode === 'coverage') {
    for (const t of tests) spans.push({ from: num(t.depth_from), to: num(t.depth_to), kind: 'test', ref: t });
  }
  return spans.filter((s) => s.from !== null && s.to !== null && s.to > s.from);
}

// Total ground accounted for in a borehole, merging overlapping spans so a
// sample taken inside a run is not counted twice.
function mergedLength(spans) {
  const sorted = [...spans].sort((a, b) => a.from - b.from);
  let total = 0;
  let curFrom = null;
  let curTo = null;
  for (const s of sorted) {
    if (curTo === null || s.from > curTo + 1e-9) {
      if (curTo !== null) total += curTo - curFrom;
      curFrom = s.from;
      curTo = s.to;
    } else if (s.to > curTo) {
      curTo = s.to;
    }
  }
  if (curTo !== null) total += curTo - curFrom;
  return total;
}

// Builds the shared WHERE fragment for drilling_runs from the filter object.
// `accessibleIds` is null for unrestricted roles, or an array of project ids.
function runFilter(f, accessibleIds) {
  const where = [];
  const params = [];
  if (accessibleIds !== null) {
    if (accessibleIds.length === 0) return { sql: 'AND 1 = 0', params: [] };
    where.push(`b.project_id IN (${accessibleIds.map(() => '?').join(',')})`);
    params.push(...accessibleIds);
  }
  if (f.project_id) { where.push('b.project_id = ?'); params.push(f.project_id); }
  if (f.borehole_id) { where.push('r.borehole_id = ?'); params.push(f.borehole_id); }
  if (f.rig) { where.push('r.rig_name = ?'); params.push(f.rig); }
  if (f.operator) { where.push('r.operator_name = ?'); params.push(f.operator); }
  if (f.shift) { where.push('r.shift = ?'); params.push(f.shift); }
  if (f.drilling_method) { where.push('r.drilling_method = ?'); params.push(f.drilling_method); }
  if (f.date_from) { where.push('r.date >= ?'); params.push(f.date_from); }
  if (f.date_to) { where.push('r.date <= ?'); params.push(f.date_to); }
  return { sql: where.length ? 'AND ' + where.join(' AND ') : '', params };
}

function boreholeFilter(f, accessibleIds) {
  const where = [];
  const params = [];
  if (accessibleIds !== null) {
    if (accessibleIds.length === 0) return { sql: 'AND 1 = 0', params: [] };
    where.push(`b.project_id IN (${accessibleIds.map(() => '?').join(',')})`);
    params.push(...accessibleIds);
  }
  if (f.project_id) { where.push('b.project_id = ?'); params.push(f.project_id); }
  if (f.borehole_id) { where.push('b.id = ?'); params.push(f.borehole_id); }
  return { sql: where.length ? 'AND ' + where.join(' AND ') : '', params };
}

function compute(db, filters, accessibleIds) {
  const f = filters || {};
  const rf = runFilter(f, accessibleIds);
  const bf = boreholeFilter(f, accessibleIds);

  const runs = db
    .prepare(
      `SELECT r.*, b.code AS borehole_code, b.project_id, b.total_depth, b.planned_depth,
              b.status AS borehole_status, p.name AS project_name
       FROM drilling_runs r
       JOIN boreholes b ON b.id = r.borehole_id
       JOIN projects p ON p.id = b.project_id
       WHERE 1=1 ${rf.sql}
       ORDER BY r.date ASC, r.depth_from ASC`
    )
    .all(...rf.params);

  const boreholes = db
    .prepare(
      `SELECT b.*, p.name AS project_name
       FROM boreholes b JOIN projects p ON p.id = b.project_id
       WHERE 1=1 ${bf.sql}`
    )
    .all(...bf.params);

  // Samples and tests carry their own date. Without applying the same
  // window, a one-day filter merged that day's runs with every sample in the
  // hole and reported more metres than were drilled that day.
  const sampleWhere = [];
  const sampleParams = [];
  if (f.sample_type) { sampleWhere.push('s.sample_type = ?'); sampleParams.push(f.sample_type); }
  if (f.date_from) { sampleWhere.push('s.date >= ?'); sampleParams.push(f.date_from); }
  if (f.date_to) { sampleWhere.push('s.date <= ?'); sampleParams.push(f.date_to); }
  const samples = db
    .prepare(
      `SELECT s.*, b.code AS borehole_code, b.project_id
       FROM samples s
       JOIN boreholes b ON b.id = s.borehole_id
       WHERE 1=1 ${bf.sql} ${sampleWhere.length ? 'AND ' + sampleWhere.join(' AND ') : ''}`
    )
    .all(...bf.params, ...sampleParams);

  const testWhere = [];
  const testParams = [];
  if (f.test_type) { testWhere.push('t.test_type = ?'); testParams.push(f.test_type); }
  if (f.date_from) { testWhere.push('t.date >= ?'); testParams.push(f.date_from); }
  if (f.date_to) { testWhere.push('t.date <= ?'); testParams.push(f.date_to); }
  const tests = db
    .prepare(
      `SELECT t.*, b.code AS borehole_code, b.project_id
       FROM tests t
       JOIN boreholes b ON b.id = t.borehole_id
       WHERE 1=1 ${bf.sql} ${testWhere.length ? 'AND ' + testWhere.join(' AND ') : ''}`
    )
    .all(...bf.params, ...testParams);

  return {
    filters: f,
    // A rig/operator/shift/method filter scopes runs but cannot scope samples
    // — sample rows carry no crew fields — so under those filters the totals
    // fall back to run metres rather than mixing a filtered numerator with an
    // unfiltered one.
    headline: headline(runs, boreholes, samples, tests, {
      // Under any filter that scopes samples differently from runs — crew
      // fields samples do not carry, or a sample-type filter that hides some
      // of them — metres fall back to run metres alone rather than mixing two
      // populations. advance_basis reports which is being shown.
      crewScoped: !!(f.rig || f.operator || f.shift || f.drilling_method || f.sample_type),
    }),
    production: production(runs, samples),
    plannedVsActual: plannedVsActual(runs, boreholes, samples),
    completion: completion(boreholes, runs, samples),
    sampleRecovery: sampleRecovery(samples),
    depthDistribution: depthDistribution(samples, tests),
    downtime: downtime(runs),
    equipment: byDimension(runs, 'rig_name', 'Unassigned rig'),
    operators: byDimension(runs, 'operator_name', 'Unnamed operator'),
    groundConditions: groundConditions(runs),
    dataQuality: dataQuality(runs, samples, tests, boreholes),
    recommendations: recommendations(runs, samples, tests, boreholes),
    dimensions: dimensions(db, accessibleIds),
  };
}

// ---------- Headline figures ----------

function headline(runs, boreholes, samples, tests, opts) {
  opts = opts || {};
  // Metres the bit cut. Casing is excluded — it re-covers drilled ground.
  const runM = runs.reduce((a, r) => a + runMetres(r), 0);

  // Metres the hole actually gained, counting samplers driven ahead of the
  // bit. Overlaps are merged so a sample inside a run is not double-counted.
  // Sample rows carry no rig/shift/method (only a date and operator), so
  // sampler-advanced metres cannot be attributed under those filters — there
  // the honest figure is run metres alone, and `advance_basis` says which is
  // being shown rather than letting the two silently disagree.
  const byBh = new Map();
  for (const s of advanceSpans(runs, samples, tests, 'advance')) {
    const id = (s.ref && s.ref.borehole_id) || 0;
    if (!byBh.has(id)) byBh.set(id, []);
    byBh.get(id).push(s);
  }
  let advanced = 0;
  byBh.forEach((spans) => { advanced += mergedLength(spans); });

  const attributable = !opts.crewScoped;
  const metres = attributable ? advanced : runM;

  // How much of that total no daily chart can place, because the underlying
  // record carries no date. Measured as the difference the undated records
  // make to the merged total — not their raw length — so a span that overlaps
  // a dated run is not counted twice and
  // `daily cumulative + undated_metres` always equals `total_metres`.
  const datedByBh = new Map();
  let undatedRecords = 0;
  for (const s of advanceSpans(runs, samples, tests, 'advance')) {
    if (!s.ref || !s.ref.date) { undatedRecords += 1; continue; }
    const id = s.ref.borehole_id || 0;
    if (!datedByBh.has(id)) datedByBh.set(id, []);
    datedByBh.get(id).push(s);
  }
  let datedAdvanced = 0;
  datedByBh.forEach((spans) => { datedAdvanced += mergedLength(spans); });
  const undatedM = Math.max(0, advanced - datedAdvanced);

  // Casing still consumes shift time and still breaks down, so days, downtime
  // and the downtime ratio count every run.
  const days = new Set(runs.map((r) => r.date).filter(Boolean));
  const downMin = runs.reduce((a, r) => a + (num(r.downtime_min) ?? 0), 0);
  // Only runs that actually recorded drilling time can contribute to the
  // ratio. Treating an unrecorded value as zero drilling time drove the
  // percentage toward 100 and fired a false "Excessive downtime".
  const timed = runs.filter((r) => num(r.drilling_time_min) !== null);
  const drillMin = timed.reduce((a, r) => a + (num(r.drilling_time_min) ?? 0), 0);
  const timedDownMin = timed.reduce((a, r) => a + (num(r.downtime_min) ?? 0), 0);

  const coredRuns = runs.filter((r) => !derive.isCasingRun(r) && num(r.core_recovered_m) !== null);
  const cored = coredRuns.reduce((a, r) => a + (num(r.core_recovered_m) ?? 0), 0);
  const coredIntervals = coredRuns.reduce((a, r) => a + runMetres(r), 0);

  const advancingRuns = runs.filter((r) => !derive.isCasingRun(r));
  return {
    total_metres: ROUND(metres),
    run_metres: ROUND(runM),
    sampler_advanced_metres: ROUND(Math.max(0, advanced - runM)),
    advance_basis: attributable ? 'runs + sampler advance' : 'drilling runs only (crew filter applied)',
    // Metres in the total that no daily chart can show, because the record
    // carries no date. Reported so the gap between the total and the end of
    // the cumulative line is always explained rather than unaccounted for.
    undated_metres: ROUND(undatedM),
    undated_records: undatedRecords,
    casing_runs: runs.length - advancingRuns.length,
    total_runs: runs.length,
    drilling_days: days.size,
    avg_metres_per_day: days.size ? ROUND(metres / days.size) : null,
    // Per-run average divides by the runs that actually cut ground, so adding
    // casing to a hole cannot appear to reduce how well it was drilled.
    avg_metres_per_run: advancingRuns.length ? ROUND(runM / advancingRuns.length) : null,
    total_downtime_hours: ROUND(downMin / 60),
    downtime_pct: timed.length && drillMin + timedDownMin > 0 ? ROUND((timedDownMin / (drillMin + timedDownMin)) * 100, 1) : null,
    core_recovery_pct: coredIntervals > 0 ? ROUND((cored / coredIntervals) * 100, 1) : null,
    total_samples: samples.length,
    total_tests: tests.length,
    boreholes: boreholes.length,
    sample_frequency_per_100m: metres > 0 ? ROUND((samples.length / metres) * 100, 1) : null,
  };
}

// ---------- Daily + cumulative production ----------

function production(runs, samples) {
  // Daily production is metres the HOLE GAINED that day, which is the same
  // definition the headline uses. A sampler driven ahead of the bit advances
  // the hole, and samples carry their own date, so those metres are counted
  // on the day they were achieved. Summing run intervals alone left the
  // cumulative line ending below the total shown directly above it.
  //
  // Spans are merged per day so a sample taken inside that day's run is not
  // counted twice.
  const spansByDate = new Map();
  const byDate = new Map();
  // A run or sample saved before a date was mandatory has nowhere to sit on a
  // date axis. Dropping it silently is what left the cumulative line ending
  // below the total printed above it, so it is collected separately and
  // reported rather than discarded.
  const undated = [];
  // Depths are only comparable within one hole. Merging every borehole's spans
  // into one list made two holes that both start at surface overlap, so a
  // project with BH-01 at 0-20 m and BH-02 at 0-15 m reported 20 m instead of
  // 35 m — under the headline, which merges per hole.
  const addSpan = (date, from, to, boreholeId) => {
    if (from === null || to === null || to <= from) return;
    const span = { from, to, bh: boreholeId ?? 0 };
    if (!date) { undated.push(span); return; }
    if (!spansByDate.has(date)) spansByDate.set(date, []);
    spansByDate.get(date).push(span);
  };

  // Merged length of a mixed-borehole span list, each hole merged on its own.
  const mergedByBorehole = (spans) => {
    const byBh = new Map();
    for (const s of spans) {
      if (!byBh.has(s.bh)) byBh.set(s.bh, []);
      byBh.get(s.bh).push(s);
    }
    let total = 0;
    byBh.forEach((list) => { total += mergedLength(list); });
    return total;
  };

  for (const r of runs) {
    if (!derive.isCasingRun(r)) addSpan(r.date, num(r.depth_from), num(r.depth_to), r.borehole_id);
    if (!r.date) continue;
    const cur = byDate.get(r.date) || { runs: 0, downtime: 0, shifts: new Set(), samples: 0 };
    cur.runs += 1;
    cur.downtime += num(r.downtime_min) ?? 0;
    if (r.shift) cur.shifts.add(r.shift);
    byDate.set(r.date, cur);
  }
  for (const s of samples || []) {
    addSpan(s.date, num(s.depth_from), num(s.depth_to), s.borehole_id);
    if (!s.date) continue;
    const cur = byDate.get(s.date) || { runs: 0, downtime: 0, shifts: new Set(), samples: 0 };
    cur.samples += 1;
    byDate.set(s.date, cur);
  }

  // Each day's figure is the NEW ground the hole gained, measured as the
  // merged total through that day minus the merged total through the day
  // before. Merging each day in isolation would count a sample that reaches
  // back into an earlier day's run twice; this cannot, and it guarantees the
  // cumulative line ends exactly on the headline total.
  const dates = [...byDate.keys()].sort();
  const seen = [];
  let prevTotal = 0;
  const daily = dates.map((d) => {
    const v = byDate.get(d);
    seen.push(...(spansByDate.get(d) || []));
    const total = mergedByBorehole(seen);
    const gained = Math.max(0, total - prevTotal);
    prevTotal = total;
    return {
      x: d,
      y: ROUND(gained),
      cumulative: ROUND(total),
      meta: { runs: v.runs, samples: v.samples, downtime_hours: ROUND(v.downtime / 60), shifts: [...v.shifts] },
    };
  });

  const shiftTotals = new Map();
  for (const r of runs) {
    const key = r.shift || 'Unspecified';
    const m = runMetres(r);
    const cur = shiftTotals.get(key) || { metres: 0, count: 0, dates: new Set() };
    cur.metres += m;
    cur.count += 1;
    if (r.date) cur.dates.add(r.date);
    shiftTotals.set(key, cur);
  }
  const perShift = [...shiftTotals.entries()].map(([shift, v]) => ({
    x: shift,
    y: v.dates.size ? ROUND(v.metres / v.dates.size) : ROUND(v.metres),
    meta: { total_metres: ROUND(v.metres), runs: v.count, days: v.dates.size },
  }));

  // Ground that only an undated record covers. Measured as the difference the
  // undated spans make to the merged total, not their raw length, so a span
  // that overlaps a dated run is not counted twice and
  // `cumulative + undated_metres` always equals the headline total.
  const undatedMetres = undated.length ? mergedByBorehole([...seen, ...undated]) - prevTotal : 0;

  return { daily, perShift, undated_metres: ROUND(undatedMetres) };
}

// ---------- Planned vs actual ----------
//
// Actual = cumulative metres by date. Planned = a straight-line target from the
// earliest planned start to the latest planned end across the boreholes in
// scope, toward their combined planned depth. Boreholes without planned values
// fall back to total_depth so a project that never captured a plan still gets a
// meaningful comparison rather than an empty chart.

function plannedVsActual(runs, boreholes, samples) {
  const target = boreholes.reduce((a, b) => a + (num(b.planned_depth) ?? num(b.total_depth) ?? 0), 0);
  const starts = boreholes.map((b) => b.planned_start_date || b.start_date).filter(Boolean).sort();
  const ends = boreholes.map((b) => b.planned_end_date || b.end_date).filter(Boolean).sort();
  const runDates = runs.map((r) => r.date).filter(Boolean).sort();

  const start = starts[0] || runDates[0] || null;
  const end = ends[ends.length - 1] || runDates[runDates.length - 1] || null;
  if (!start || !end || target <= 0) return { target: ROUND(target), points: [], on_track: null };

  // Reuse the daily series so the "actual" curve, the production chart and
  // the headline are all the same number. Computing it independently from run
  // intervals here is what let the variance disagree with the total shown
  // beside it.
  const byDate = new Map();
  for (const d of production(runs, samples).daily) byDate.set(d.x, d.y);

  const dayMs = 86400000;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  const lastMs = Math.max(endMs, runDates.length ? Date.parse(runDates[runDates.length - 1]) : endMs);
  const span = Math.max(1, (endMs - startMs) / dayMs);

  const points = [];
  let cum = 0;
  for (let t = startMs; t <= lastMs; t += dayMs) {
    const iso = new Date(t).toISOString().slice(0, 10);
    cum += byDate.get(iso) || 0;
    const elapsed = (t - startMs) / dayMs;
    points.push({
      x: iso,
      planned: ROUND(Math.min(target, (target * elapsed) / span)),
      actual: ROUND(cum),
    });
    if (points.length > 400) break; // guard against absurd date ranges
  }

  const last = points[points.length - 1];
  return {
    target: ROUND(target),
    points,
    on_track: last ? last.actual >= last.planned : null,
    variance: last ? ROUND(last.actual - last.planned) : null,
  };
}

// ---------- Borehole completion + ETA ----------

// The samples argument is optional so existing callers keep working; when
// supplied, the hole depth includes ground a sampler advanced, which is what
// the borehole page and the dashboard ring report as "current depth".
function completion(boreholes, runs, samples) {
  const runsByBh = new Map();
  for (const r of runs) {
    const arr = runsByBh.get(r.borehole_id) || [];
    arr.push(r);
    runsByBh.set(r.borehole_id, arr);
  }
  return boreholes
    .map((b) => {
      const rs = runsByBh.get(b.id) || [];
      // Casing neither advances the hole nor deepens it.
      const advancing = rs.filter((r) => !derive.isCasingRun(r));
      const drilled = advancing.reduce((a, r) => a + runMetres(r), 0);
      // A sampler driven ahead of the bit leaves the hole deeper than the
      // last run. Measuring depth from runs alone reported a shallower hole
      // than the register, the next-run prefill and the validation layer all
      // agree it is.
      const bhSamples = (samples || []).filter((s) => s.borehole_id === b.id);
      const deepestRun = advancing.length ? Math.max(...advancing.map((r) => num(r.depth_to) ?? 0)) : 0;
      const deepestSample = bhSamples.length ? Math.max(...bhSamples.map((s) => num(s.depth_to) ?? 0)) : 0;
      const deepest = Math.max(deepestRun, deepestSample);
      const targetDepth = num(b.planned_depth) ?? num(b.total_depth) ?? null;
      const pct = targetDepth && targetDepth > 0 ? Math.min(100, (deepest / targetDepth) * 100) : null;

      // ETA from this borehole's own recent rate, not a global average — a
      // slow hole in hard ground shouldn't inherit an optimistic site rate.
      const dates = [...new Set(rs.map((r) => r.date).filter(Boolean))].sort();
      const rate = dates.length ? drilled / dates.length : null;
      const remaining = targetDepth ? Math.max(0, targetDepth - deepest) : null;
      const finished = b.status === 'Complete' || b.status === 'Abandoned';
      let eta = null;
      // A finished hole has no completion to forecast, even if it stopped
      // short of its planned depth — that is a variance, not remaining work.
      if (!finished && rate > 0 && remaining !== null && remaining > 0 && dates.length >= 2) {
        const daysLeft = Math.ceil(remaining / rate);
        // Project from today when drilling has already stalled, otherwise the
        // forecast lands in the past and reads as though it were met.
        const lastDate = Date.parse(dates[dates.length - 1]);
        const from = Math.max(lastDate, Date.parse(new Date().toISOString().slice(0, 10)));
        eta = new Date(from + daysLeft * 86400000).toISOString().slice(0, 10);
      }
      return {
        borehole_id: b.id,
        code: b.code,
        project_id: b.project_id,
        project_name: b.project_name,
        status: b.status,
        target_depth: ROUND(targetDepth),
        current_depth: ROUND(deepest),
        metres_drilled: ROUND(drilled),
        completion_pct: pct === null ? null : ROUND(pct, 1),
        rate_m_per_day: ROUND(rate),
        estimated_completion: eta,
        runs: rs.length,
      };
    })
    .sort((a, b) => (b.completion_pct ?? -1) - (a.completion_pct ?? -1));
}

// ---------- Sample frequency + recovery ----------

function sampleRecovery(samples) {
  const byType = new Map();
  for (const s of samples) {
    const key = s.sample_type || 'Unspecified';
    const cur = byType.get(key) || { count: 0, recoverySum: 0, recoveryCount: 0, low: 0 };
    cur.count += 1;
    const rec = num(s.recovery_pct);
    if (rec !== null) {
      cur.recoverySum += rec;
      cur.recoveryCount += 1;
      if (rec < 50) cur.low += 1;
    }
    byType.set(key, cur);
  }
  return [...byType.entries()].map(([type, v]) => ({
    x: type,
    y: v.count,
    avg_recovery: v.recoveryCount ? ROUND(v.recoverySum / v.recoveryCount, 1) : null,
    low_recovery_count: v.low,
  }));
}

// ---------- Depth distribution of samples + tests ----------
//
// Bucketed into 5 m depth bands so the chart reads as a downhole profile
// rather than a scatter of individual points.

function depthDistribution(samples, tests) {
  const BAND = 5;
  const bands = new Map();
  const put = (depth, key) => {
    const d = num(depth);
    if (d === null) return;
    const band = Math.floor(d / BAND) * BAND;
    const cur = bands.get(band) || {};
    cur[key] = (cur[key] || 0) + 1;
    bands.set(band, cur);
  };
  for (const s of samples) put(s.depth_from ?? s.depth, s.sample_type || 'Other');
  for (const t of tests) put(t.depth_from, 'Test');

  const keys = new Set();
  bands.forEach((v) => Object.keys(v).forEach((k) => keys.add(k)));
  return {
    band_size: BAND,
    series: [...keys],
    points: [...bands.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([band, counts]) => ({ x: band, label: `${band}–${band + BAND} m`, counts })),
  };
}

// ---------- Downtime + delays ----------

function downtime(runs) {
  const byReason = new Map();
  const byDate = new Map();
  for (const r of runs) {
    const mins = num(r.downtime_min) ?? 0;
    if (mins <= 0) continue;
    const reason = r.downtime_reason || 'Unspecified';
    byReason.set(reason, (byReason.get(reason) || 0) + mins);
    if (r.date) byDate.set(r.date, (byDate.get(r.date) || 0) + mins);
  }
  return {
    byReason: [...byReason.entries()]
      .map(([reason, mins]) => ({ x: reason, y: ROUND(mins / 60) }))
      .sort((a, b) => b.y - a.y),
    trend: [...byDate.entries()].sort().map(([date, mins]) => ({ x: date, y: ROUND(mins / 60) })),
  };
}

// ---------- Productivity by rig / operator ----------

function byDimension(runs, field, fallback) {
  const map = new Map();
  for (const r of runs) {
    const key = r[field] || fallback;
    const cur = map.get(key) || { metres: 0, runs: 0, downtime: 0, drillTime: 0, dates: new Set() };
    cur.metres += runMetres(r);
    cur.runs += 1;
    cur.downtime += num(r.downtime_min) ?? 0;
    cur.drillTime += num(r.drilling_time_min) ?? 0;
    if (r.date) cur.dates.add(r.date);
    map.set(key, cur);
  }
  return [...map.entries()]
    .map(([name, v]) => ({
      x: name,
      y: ROUND(v.metres),
      avg_per_day: v.dates.size ? ROUND(v.metres / v.dates.size) : null,
      runs: v.runs,
      days: v.dates.size,
      downtime_hours: ROUND(v.downtime / 60),
      downtime_pct: v.drillTime + v.downtime > 0 ? ROUND((v.downtime / (v.drillTime + v.downtime)) * 100, 1) : null,
    }))
    .sort((a, b) => b.y - a.y);
}

// ---------- Ground conditions ----------

function groundConditions(runs) {
  const conditions = new Map();
  const water = new Map();
  for (const r of runs) {
    if (r.ground_conditions) conditions.set(r.ground_conditions, (conditions.get(r.ground_conditions) || 0) + 1);
    if (r.groundwater_obs) water.set(r.groundwater_obs, (water.get(r.groundwater_obs) || 0) + 1);
  }
  const toArr = (m) => [...m.entries()].map(([x, y]) => ({ x, y })).sort((a, b) => b.y - a.y);

  // RQD trend downhole shows rock-mass quality changing with depth.
  const rqd = runs
    .filter((r) => num(r.rqd_pct) !== null)
    .map((r) => ({ x: ROUND(num(r.depth_to)), y: ROUND(num(r.rqd_pct), 1), meta: { borehole: r.borehole_code, run_id: r.id } }))
    .sort((a, b) => a.x - b.x);

  return { conditions: toArr(conditions), water: toArr(water), rqd };
}

// ---------- Data quality ----------

function dataQuality(runs, samples, tests, boreholes) {
  const alerts = [];
  const push = (severity, message, meta) => alerts.push({ severity, message, ...meta });

  for (const r of runs) {
    const label = `${r.borehole_code} run ${r.run_number ?? '?'} (${r.depth_from}–${r.depth_to} m)`;
    // An undated run still counts toward metres drilled but cannot be placed
    // on any date axis, so it is the reason a cumulative line can end below
    // the total beside it. Serious, not a warning: it makes the charts wrong.
    if (!r.date) {
      push('serious', `${label}: no date recorded — these metres cannot appear on any daily or planned-vs-actual chart`, {
        borehole_id: r.borehole_id, run_id: r.id,
      });
    }
    if (!r.operator_name) push('warning', `${label}: no operator recorded`, { borehole_id: r.borehole_id, run_id: r.id });
    if (!r.drilling_method) push('warning', `${label}: no drilling method recorded`, { borehole_id: r.borehole_id, run_id: r.id });
    const interval = (num(r.depth_to) ?? 0) - (num(r.depth_from) ?? 0);
    const cored = num(r.core_recovered_m);
    if (cored !== null && interval > 0 && cored > interval + 1e-6) {
      push('critical', `${label}: core recovered (${cored} m) exceeds the drilled interval (${ROUND(interval)} m)`, {
        borehole_id: r.borehole_id, run_id: r.id,
      });
    }
    if (!r.approved_at) push('info', `${label}: awaiting supervisor sign-off`, { borehole_id: r.borehole_id, run_id: r.id });
  }

  for (const s of samples) {
    if (!s.run_id) {
      push('serious', `Sample ${s.sample_ref || s.id} (${s.depth_from}–${s.depth_to} m) in ${s.borehole_code} is not linked to any drilling run`, {
        borehole_id: s.borehole_id, sample_id: s.id,
      });
    }
    if (!s.sample_type) push('warning', `Sample ${s.sample_ref || s.id} in ${s.borehole_code}: no sample type recorded`, { sample_id: s.id });
  }

  for (const t of tests) {
    if (!t.run_id) {
      push('serious', `Test ${t.test_ref || t.id} (${t.depth_from}–${t.depth_to} m) in ${t.borehole_code} is not linked to any drilling run`, {
        borehole_id: t.borehole_id, test_id: t.id,
      });
    }
  }

  for (const b of boreholes) {
    if (!b.planned_depth) push('info', `${b.code}: no planned depth set — planned-vs-actual falls back to total depth`, { borehole_id: b.id });
  }

  const order = { critical: 0, serious: 1, warning: 2, info: 3 };
  return {
    alerts: alerts.sort((a, b) => order[a.severity] - order[b.severity]).slice(0, 60),
    counts: alerts.reduce((acc, a) => ({ ...acc, [a.severity]: (acc[a.severity] || 0) + 1 }), {}),
  };
}

// ---------- Recommendations ----------
//
// Pattern detection over the same data — each recommendation states what was
// observed and what to do about it, so it is actionable rather than a bare
// anomaly flag.

function recommendations(runs, samples, tests, boreholes) {
  const recs = [];
  const add = (severity, title, detail, meta) => recs.push({ severity, title, detail, ...(meta || {}) });

  // Sampling gaps: long drilled stretches with no sample taken.
  const byBh = new Map();
  for (const r of runs) {
    const arr = byBh.get(r.borehole_id) || [];
    arr.push(r);
    byBh.set(r.borehole_id, arr);
  }
  for (const [bhId, rs] of byBh) {
    const code = rs[0].borehole_code;
    const bhSamples = samples.filter((s) => s.borehole_id === bhId).map((s) => num(s.depth_from)).filter((d) => d !== null).sort((a, b) => a - b);
    const deepest = Math.max(...rs.map((r) => num(r.depth_to) ?? 0));
    if (deepest >= 10 && bhSamples.length === 0) {
      add('serious', `No samples in ${code}`, `${ROUND(deepest)} m drilled with no samples recorded. Confirm whether sampling was intended for this hole.`, { borehole_id: bhId });
    } else if (bhSamples.length) {
      let prev = 0;
      for (const d of [...bhSamples, deepest]) {
        if (d - prev > 10) {
          add('warning', `Sampling gap in ${code}`, `No sample recorded between ${ROUND(prev)} m and ${ROUND(d)} m (${ROUND(d - prev)} m interval). Typical practice samples at least every 5–10 m.`, { borehole_id: bhId });
          break;
        }
        prev = d;
      }
    }

    // Breaks in the record of the hole. Judged across runs, samples AND tests
    // together: a sampler driven ahead of the bit advances the hole, so the
    // stretch between one run ending and the next beginning is usually the
    // SPT that made it — not missing data. Comparing runs to each other in
    // isolation reported every one of those as an unexplained gap.
    const bhSpans = advanceSpans(
      rs,
      samples.filter((s) => s.borehole_id === bhId),
      tests.filter((t) => t.borehole_id === bhId),
      'coverage'
    ).sort((a, b) => a.from - b.from);

    let covered = null;
    for (const span of bhSpans) {
      if (covered !== null && span.from > covered + 1e-6) {
        // Only a run can be held responsible for continuing the hole, and
        // only if nothing else accounts for the ground.
        const responsible = span.kind === 'run' ? span.ref : null;
        if (!responsible || !responsible.skip_reason) {
          add(
            'serious',
            `Unexplained depth gap in ${code}`,
            `${ROUND(span.from - covered)} m between ${ROUND(covered)} m and ${ROUND(span.from)} m is not accounted for by any drilling run, sample or test, and no reason is recorded.`,
            { borehole_id: bhId, run_id: responsible ? responsible.id : undefined }
          );
        }
      }
      if (covered === null || span.to > covered) covered = span.to;
    }
  }

  // Low core recovery.
  const lowRecovery = runs.filter((r) => {
    const interval = (num(r.depth_to) ?? 0) - (num(r.depth_from) ?? 0);
    const cored = num(r.core_recovered_m);
    return cored !== null && interval > 0 && cored / interval < 0.7;
  });
  if (lowRecovery.length) {
    add('warning', 'Low core recovery', `${lowRecovery.length} run(s) recovered under 70% of the drilled interval. Review bit selection, flush and run length in these zones.`, {
      run_ids: lowRecovery.slice(0, 12).map((r) => r.id),
    });
  }

  // Downtime concentration.
  const totalDown = runs.reduce((a, r) => a + (num(r.downtime_min) ?? 0), 0);
  const totalDrill = runs.reduce((a, r) => a + (num(r.drilling_time_min) ?? 0), 0);
  if (totalDown + totalDrill > 0 && totalDown / (totalDown + totalDrill) > 0.25) {
    const byReason = new Map();
    runs.forEach((r) => {
      const m = num(r.downtime_min) ?? 0;
      if (m > 0) byReason.set(r.downtime_reason || 'Unspecified', (byReason.get(r.downtime_reason || 'Unspecified') || 0) + m);
    });
    const top = [...byReason.entries()].sort((a, b) => b[1] - a[1])[0];
    add('serious', 'Excessive downtime', `Downtime is ${ROUND((totalDown / (totalDown + totalDrill)) * 100, 1)}% of on-site time${top ? `, mostly "${top[0]}" (${ROUND(top[1] / 60)} h)` : ''}. Address the leading cause to recover schedule.`, {});
  }

  // Abnormal penetration rate vs the site's own median.
  const rates = runs.map((r) => num(r.penetration_rate_m_hr)).filter((v) => v !== null && v > 0).sort((a, b) => a - b);
  if (rates.length >= 5) {
    const median = rates[Math.floor(rates.length / 2)];
    const slow = runs.filter((r) => {
      const v = num(r.penetration_rate_m_hr);
      return v !== null && v > 0 && v < median * 0.4;
    });
    if (slow.length) {
      add('warning', 'Abnormally slow penetration', `${slow.length} run(s) advanced at under 40% of the site median (${ROUND(median)} m/h). Check for bit wear, harder ground or flush problems.`, {
        run_ids: slow.slice(0, 12).map((r) => r.id),
      });
    }
  }

  // Schedule slippage per borehole.
  for (const b of boreholes) {
    const target = num(b.planned_depth) ?? num(b.total_depth);
    const rs = byBh.get(b.id) || [];
    if (!target || !rs.length || b.status === 'Complete') continue;
    const deepest = Math.max(...rs.map((r) => num(r.depth_to) ?? 0));
    const plannedEnd = b.planned_end_date || b.end_date;
    if (plannedEnd && deepest < target) {
      const daysLate = Math.floor((Date.now() - Date.parse(plannedEnd)) / 86400000);
      if (daysLate > 0) {
        add('critical', `${b.code} behind schedule`, `Planned completion was ${plannedEnd} (${daysLate} day(s) ago) but the hole is at ${ROUND(deepest)} m of ${ROUND(target)} m.`, { borehole_id: b.id });
      }
    }
  }

  // Inconsistent test results within a borehole (permeability spanning orders of magnitude).
  const testsByBh = new Map();
  for (const t of tests) {
    if (num(t.result_value) === null) continue;
    const arr = testsByBh.get(t.borehole_id) || [];
    arr.push(t);
    testsByBh.set(t.borehole_id, arr);
  }
  for (const [bhId, ts] of testsByBh) {
    const sameType = new Map();
    ts.forEach((t) => {
      const arr = sameType.get(t.test_type) || [];
      arr.push(num(t.result_value));
      sameType.set(t.test_type, arr);
    });
    for (const [type, vals] of sameType) {
      const positive = vals.filter((v) => v > 0);
      if (positive.length < 3) continue;
      const max = Math.max(...positive);
      const min = Math.min(...positive);
      if (min > 0 && max / min > 1000) {
        add('warning', `Inconsistent ${type} results in ${ts[0].borehole_code}`, `Results span ${ROUND(max / min, 0)}× (${min} to ${max}). Verify readings, units and test setup.`, { borehole_id: bhId });
      }
    }
  }

  const order = { critical: 0, serious: 1, warning: 2, info: 3 };
  return recs.sort((a, b) => order[a.severity] - order[b.severity]);
}

// ---------- Filter dimension options ----------

function dimensions(db, accessibleIds) {
  const scope = accessibleIds === null ? '' : accessibleIds.length ? `WHERE b.project_id IN (${accessibleIds.map(() => '?').join(',')})` : 'WHERE 1=0';
  const params = accessibleIds === null ? [] : accessibleIds;
  const distinct = (col) =>
    db
      .prepare(`SELECT DISTINCT r.${col} AS v FROM drilling_runs r JOIN boreholes b ON b.id = r.borehole_id ${scope} ${scope ? 'AND' : 'WHERE'} r.${col} IS NOT NULL AND r.${col} != '' ORDER BY v`)
      .all(...params)
      .map((x) => x.v);
  return {
    rigs: distinct('rig_name'),
    operators: distinct('operator_name'),
    methods: distinct('drilling_method'),
    shifts: distinct('shift'),
  };
}

// completion() is exported so the dashboard's progress ring can show work
// done rather than holes finished, without duplicating the per-borehole maths.
module.exports = { compute, completion, production, advanceSpans, mergedLength, runMetres };
