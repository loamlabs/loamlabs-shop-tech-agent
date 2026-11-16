// Run: node --experimental-strip-types --test scripts/freehub-pick.test.mjs   (no network, no packages)
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickFreehub } from './freehub-pick.ts';

const PRODUCT = ['SRAM XD', 'Shimano HG'];
const VARIANT = JSON.stringify(['SRAM XDR', 'Shimano MicroSpline', 'Campagnolo N3W']);

test('variant list only (product has none): the variant list', () => {
  assert.deepEqual(pickFreehub(VARIANT, []), ['SRAM XDR', 'Shimano MicroSpline', 'Campagnolo N3W']);
});
test('product list only (variant has none): the product list', () => {
  assert.deepEqual(pickFreehub(undefined, PRODUCT), PRODUCT);
  assert.deepEqual(pickFreehub(null, PRODUCT), PRODUCT);
  assert.deepEqual(pickFreehub('', PRODUCT), PRODUCT);
  assert.deepEqual(pickFreehub('[]', PRODUCT), PRODUCT, 'an empty variant list falls back');
});
test('both: the variant list wins and the two are never merged', () => {
  const r = pickFreehub(VARIANT, PRODUCT);
  assert.deepEqual(r, ['SRAM XDR', 'Shimano MicroSpline', 'Campagnolo N3W']);
  assert.ok(!r.includes('SRAM XD') && !r.includes('Shimano HG'));
});
test('neither: an empty list (the case after the product field is deleted and a variant has none)', () => {
  assert.deepEqual(pickFreehub(undefined, []), []);
  assert.deepEqual(pickFreehub('[]', []), []);
});
test('a hub that lost its product field but keeps variant lists never writes []', () => {
  assert.notDeepEqual(pickFreehub(VARIANT, []), []);
});
test('unreadable or not-a-list variant value falls back to the product list', () => {
  assert.deepEqual(pickFreehub('not json', PRODUCT), PRODUCT);
  assert.deepEqual(pickFreehub('{"a":1}', PRODUCT), PRODUCT);
  assert.deepEqual(pickFreehub('"XDR"', PRODUCT), PRODUCT);
});
test('each variant is chosen on its own (two variants of one product)', () => {
  assert.deepEqual(pickFreehub(JSON.stringify(['HG']), PRODUCT), ['HG']);
  assert.deepEqual(pickFreehub(undefined, PRODUCT), PRODUCT);
});
