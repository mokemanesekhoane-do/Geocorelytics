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

// Deere's RQD bands, as used in ISRM/geotechnical practice. Boundaries are
// inclusive at the top of each band: 25 is Very Poor, 25.1 is Poor.
const RQD_BANDS = [
  { max: 25, label: 'Very Poor' },
  { max: 50, label: 'Poor' },
  { max: 75, label: 'Fair' },
  { max: 90, label: 'Good' },
  { max: 100, label: 'Excellent' },
];

function rqdClassification(pct) {
  const v = Number(pct);
  if (!Number.isFinite(v) || v < 0 || v > 100) return null;
  return (RQD_BANDS.find((b) => v <= b.max) || RQD_BANDS[RQD_BANDS.length - 1]).label;
}

// Metres advanced by a drilling run.
function depthDrilled(from, to) {
  const a = Number(from);
  const b = Number(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  return Number((b - a).toFixed(3));
}

// Penetration rate uses ACTIVE drilling time only. Standing time, breakdowns
// and other delays are captured separately as downtime and deliberately kept
// out of this figure, so the rate reflects how the ground drilled rather than
// how the shift ran.
function penetrationRate(from, to, activeMinutes) {
  const metres = depthDrilled(from, to);
  const mins = Number(activeMinutes);
  if (metres === null || !Number.isFinite(mins) || mins <= 0) return null;
  return Number((metres / (mins / 60)).toFixed(3));
}

// Standard SPT drive is three 150 mm increments.
const SPT_STANDARD_PENETRATION_MM = 450;

// The sampler is driven from the bottom of the hole, so the SPT starts where
// drilling stopped and ends however far it actually got.
function sptInterval(runEndDepth, penetrationMm) {
  const start = Number(runEndDepth);
  const mm = Number(penetrationMm);
  if (!Number.isFinite(start)) return null;
  const achieved = Number.isFinite(mm) && mm > 0 ? mm : SPT_STANDARD_PENETRATION_MM;
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

// N is the sum of the 2nd and 3rd 150 mm increments; the seating drive and
// the first increment are excluded (ASTM D1586).
function sptNValue(blows2, blows3) {
  const b2 = Number(blows2);
  const b3 = Number(blows3);
  if (!Number.isFinite(b2) || !Number.isFinite(b3)) return null;
  return b2 + b3;
}

function recoveryPct(recoveredMm, penetrationMm) {
  const r = Number(recoveredMm);
  const p = Number(penetrationMm);
  if (!Number.isFinite(r) || !Number.isFinite(p) || p <= 0) return null;
  return Number(((r / p) * 100).toFixed(1));
}

const DERIVE = {
  RQD_BANDS,
  SPT_STANDARD_PENETRATION_MM,
  SHORT_PENETRATION_REASONS,
  rqdClassification,
  depthDrilled,
  penetrationRate,
  sptInterval,
  sptNValue,
  recoveryPct,
};

// Shared by the browser (global) and the server (require).
if (typeof module !== 'undefined' && module.exports) module.exports = DERIVE;
