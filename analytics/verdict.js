// A/B verdict engine. Implements the criteria in ab-test-review-guide.md as
// code so the verdict is computed, not inferred conversationally. Two-arm
// comparison only -- open_jul2026 is reported separately and never enters
// this calculation (see analyticsSnapshot.js).

const THRESHOLDS = {
  minSampleSize: 120,
  maxVolumeDropPct: 20,
  minCaptureRatio: 1.5,
  noiseFloorPP: 0.5
};

function captureRate(estimates, leads) {
  return estimates > 0 ? leads / estimates : 0;
}

// computeVerdict({ blur: { estimates, leads }, control: { estimates, leads } })
function computeVerdict({ blur, control }) {
  const captureRates = {
    blur: captureRate(blur.estimates, blur.leads),
    control: captureRate(control.estimates, control.leads)
  };

  const volumeDeltaPct = control.estimates > 0
    ? (control.estimates - blur.estimates) / control.estimates
    : 0;

  const captureRatio = captureRates.control > 0
    ? captureRates.blur / captureRates.control
    : null;

  const captureDiffPP = (captureRates.blur - captureRates.control) * 100;

  const metrics = { volumeDeltaPct, captureRatio, captureDiffPP, captureRates };

  if (blur.estimates < THRESHOLDS.minSampleSize || control.estimates < THRESHOLDS.minSampleSize) {
    return {
      verdict: 'insufficient_data',
      reason: `blur arm has ${blur.estimates} estimates, control arm has ${control.estimates}; both must be at least ${THRESHOLDS.minSampleSize}`,
      metrics,
      thresholds: THRESHOLDS
    };
  }

  if (volumeDeltaPct > THRESHOLDS.maxVolumeDropPct / 100) {
    return {
      verdict: 'do_not_activate',
      reason: `blur arm volume is ${(volumeDeltaPct * 100).toFixed(1)}% below control, exceeding the ${THRESHOLDS.maxVolumeDropPct}% max drop`,
      metrics,
      thresholds: THRESHOLDS
    };
  }

  if (Math.abs(captureDiffPP) < THRESHOLDS.noiseFloorPP) {
    return {
      verdict: 'inconclusive',
      reason: `capture rate difference of ${captureDiffPP.toFixed(2)}pp is within the ${THRESHOLDS.noiseFloorPP}pp noise floor`,
      metrics,
      thresholds: THRESHOLDS
    };
  }

  if (captureRatio !== null && captureRatio >= THRESHOLDS.minCaptureRatio) {
    return {
      verdict: 'activate',
      reason: `blur capture rate is ${captureRatio.toFixed(2)}x control, meeting the ${THRESHOLDS.minCaptureRatio}x threshold`,
      metrics,
      thresholds: THRESHOLDS
    };
  }

  return {
    verdict: 'inconclusive',
    reason: `capture ratio ${captureRatio !== null ? captureRatio.toFixed(2) : 'n/a'}x does not meet the ${THRESHOLDS.minCaptureRatio}x activation threshold`,
    metrics,
    thresholds: THRESHOLDS
  };
}

module.exports = { computeVerdict, THRESHOLDS };
