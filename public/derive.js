// ================================================================
// Derived values
//
// Anything the system can work out from what the operator already entered is
// computed here, in one place, and shared verbatim by the browser and the
// server (Node loads this same file). A figure shown live in the form is
// therefore the identical figure that gets stored — the form can never
// promise one number and save another.
//
// Nothing in here is editable in the ordinary flow. Overrides go through the
// audit trail.
// ================================================================

// Number(null) and Number('') are both 0, and 0 is finite — so a plain
// Number() coercion turns "not recorded" into a real zero. On a geotechnical
// record that is fabrication: a blank RQD became "Very Poor" rock, and a run
// with no core logged became 0% recovery. Every numeric read in this file
// goes through here.
function blankToNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Deere's RQD bands, as used in ISRM/geotechnical practice. Boundaries are
// inclusive at the top of each band: 25 is Very Poor, 25.1 is Poor.
// `pick` is the value stored when an operator selects the band by name
// instead of measuring — the midpoint, so it cannot masquerade as a reading
// taken at a boundary.
const RQD_BANDS = [
  { min: 0, max: 25, label: 'Very Poor', pick: 12.5 },
  { min: 25, max: 50, label: 'Poor', pick: 37.5 },
  { min: 50, max: 75, label: 'Fair', pick: 62.5 },
  { min: 75, max: 90, label: 'Good', pick: 82.5 },
  { min: 90, max: 100, label: 'Excellent', pick: 95 },
];

function rqdClassification(pct) {
  const v = blankToNull(pct);
  if (v === null || v < 0 || v > 100) return null;
  return (RQD_BANDS.find((b) => v <= b.max) || RQD_BANDS[RQD_BANDS.length - 1]).label;
}

// Inverse of the above, for when the core logger picks a band rather than
// measuring one. Returns the band so the caller can show the range it implies.
function rqdBand(label) {
  if (!label) return null;
  return RQD_BANDS.find((b) => b.label === label) || null;
}

// Metres advanced by a drilling run.
function depthDrilled(from, to) {
  const a = blankToNull(from);
  const b = blankToNull(to);
  if (a === null || b === null || b <= a) return null;
  return Number((b - a).toFixed(3));
}

const MINUTES_PER_DAY = 1440;

// Minutes on the clock between two HH:MM stamps. A night shift booking on at
// 22:00 and off at 04:00 has crossed midnight, so an end at or before the
// start is read as the following day rather than as negative time. An
// identical pair is a mis-keyed stamp, not a 24-hour run.
function minutesBetween(startTime, endTime) {
  const parse = (t) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(t == null ? '' : t).trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  };
  const s = parse(startTime);
  const e = parse(endTime);
  if (s === null || e === null) return null;
  if (e === s) return 0;
  return e > s ? e - s : e + MINUTES_PER_DAY - s;
}

// Active drilling time: time on the clock less the delays booked against the
// run. This is the figure the penetration rate is computed from, so standing,
// breakdown and waiting time never inflate how fast the ground drilled.
// Never negative — downtime exceeding the shift span is a data error, caught
// by the validation layer rather than silently becoming negative time here.
function activeDrillingMinutes(startTime, endTime, downtimeMin) {
  const span = minutesBetween(startTime, endTime);
  if (span === null) return null;
  const down = blankToNull(downtimeMin);
  const active = span - (down !== null && down > 0 ? down : 0);
  return active > 0 ? Number(active.toFixed(2)) : 0;
}

// Penetration rate uses ACTIVE drilling time only. Standing time, breakdowns
// and other delays are captured separately as downtime and deliberately kept
// out of this figure, so the rate reflects how the ground drilled rather than
// how the shift ran.
function penetrationRate(from, to, activeMinutes) {
  const metres = depthDrilled(from, to);
  const mins = blankToNull(activeMinutes);
  if (metres === null || mins === null || mins <= 0) return null;
  return Number((metres / (mins / 60)).toFixed(3));
}

// A standard SPT drive is 450 mm in three 150 mm increments. The FIRST
// increment (0–150) is the seating drive and is discarded; N is the sum of
// the two that follow. There is no fourth increment — a separate seating
// field plus three more would describe a 600 mm drive, which is not the test.
const SPT_STANDARD_PENETRATION_MM = 450;

const SPT_INCREMENTS = [
  { name: 'seating_blows', label: 'Seating Blows (0–150 mm)', countsTowardN: false },
  { name: 'blows_150_300', label: '1st Blows (150–300 mm)', countsTowardN: true },
  { name: 'blows_300_450', label: '2nd Blows (300–450 mm)', countsTowardN: true },
];

// The sampler is driven from the bottom of the hole, so the SPT starts where
// drilling stopped and ends however far it actually got.
function sptInterval(runEndDepth, penetrationMm) {
  const start = blankToNull(runEndDepth);
  const mm = blankToNull(penetrationMm);
  if (start === null) return null;
  const achieved = mm !== null && mm > 0 ? mm : SPT_STANDARD_PENETRATION_MM;
  return {
    depth_from: Number(start.toFixed(3)),
    depth_to: Number((start + achieved / 1000).toFixed(3)),
    penetration_mm: achieved,
    isPartial: achieved < SPT_STANDARD_PENETRATION_MM,
  };
}

// Reasons a drive can stop short of 450 mm. Anything less than the standard
// penetration has to be attributed to one of these.
const SHORT_PENETRATION_REASONS = [
  'Refusal',
  'Obstruction',
  'Very dense material',
  'Hard layer',
  'Equipment limitation',
];

// N = blows over 150–300 mm plus blows over 300–450 mm. The seating drive is
// excluded (ASTM D1586).
function sptNValue(first150to300, second300to450) {
  const a = blankToNull(first150to300);
  const b = blankToNull(second300to450);
  if (a === null || b === null) return null;
  return a + b;
}

function recoveryPct(recoveredMm, penetrationMm) {
  const r = blankToNull(recoveredMm);
  const p = blankToNull(penetrationMm);
  if (r === null || p === null || p <= 0) return null;
  return Number(((r / p) * 100).toFixed(1));
}

// A run that installs casing rather than advancing the hole. Casing is set
// after drilling, from surface down through ground already cut, so it
// deliberately re-covers depth and must be kept out of every "metres
// advanced" figure.
const RUN_TYPES = ['Drilling', 'Casing'];

function isCasingRun(run) {
  return !!run && String(run.run_type || 'Drilling') === 'Casing';
}

const DERIVE = {
  RQD_BANDS,
  SPT_STANDARD_PENETRATION_MM,
  SPT_INCREMENTS,
  SHORT_PENETRATION_REASONS,
  MINUTES_PER_DAY,
  RUN_TYPES,
  blankToNull,
  rqdClassification,
  rqdBand,
  depthDrilled,
  minutesBetween,
  activeDrillingMinutes,
  penetrationRate,
  sptInterval,
  sptNValue,
  recoveryPct,
  isCasingRun,
};

// Shared by the browser (global) and the server (require).
if (typeof module !== 'undefined' && module.exports) module.exports = DERIVE;
