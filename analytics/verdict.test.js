// Plain-assert unit tests for the verdict engine -- no test framework
// dependency added. Run with: node analytics/verdict.test.js
//
// Four fixtures per spec section 15. Fixture 2 as literally stated in the
// spec (140/8 control, 85/14 blur, labelled "expect do_not_activate") is
// internally inconsistent with the spec's own rule ordering: blur's 85
// estimates is below the 120 minimum, so rule 1 (insufficient_data) fires
// before rule 2 (volume drop) ever gets evaluated. That fixture is used
// below as the under-sampled case instead, where it produces the verdict
// the documented algorithm actually returns. Fresh numbers were constructed
// for genuine do_not_activate and noise-floor cases, since the spec gave
// none.

const assert = require('assert');
const { computeVerdict } = require('./verdict');

function run(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

run('activate: control 140/8, blur 125/18', () => {
  const result = computeVerdict({
    control: { estimates: 140, leads: 8 },
    blur: { estimates: 125, leads: 18 }
  });
  assert.strictEqual(result.verdict, 'activate');
  assert.ok(result.metrics.captureRatio >= 1.5);
});

run('insufficient_data: control 140/8, blur 85/14 (spec fixture 2, relabelled)', () => {
  const result = computeVerdict({
    control: { estimates: 140, leads: 8 },
    blur: { estimates: 85, leads: 14 }
  });
  assert.strictEqual(result.verdict, 'insufficient_data');
});

run('do_not_activate: control 200/10, blur 150/10', () => {
  const result = computeVerdict({
    control: { estimates: 200, leads: 10 },
    blur: { estimates: 150, leads: 10 }
  });
  assert.strictEqual(result.verdict, 'do_not_activate');
  assert.ok(result.metrics.volumeDeltaPct > 0.20);
});

run('inconclusive (noise floor): control 200/20, blur 195/19', () => {
  const result = computeVerdict({
    control: { estimates: 200, leads: 20 },
    blur: { estimates: 195, leads: 19 }
  });
  assert.strictEqual(result.verdict, 'inconclusive');
  assert.ok(Math.abs(result.metrics.captureDiffPP) < 0.5);
});

if (process.exitCode !== 1) {
  console.log('\nAll verdict fixtures passed.');
}
