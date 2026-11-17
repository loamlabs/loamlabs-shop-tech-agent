// Run: node --experimental-strip-types --test scripts/sync-geometry.test.mjs scripts/freehub-pick.test.mjs   (no network, no packages)
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickGeometry } from './sync-geometry.ts';
import { completeVariants } from './sync-paging.ts';
import { flattenDatabase, geometryConflictProducts } from './sync-flatten.ts';

const m = (v) => (v === undefined ? null : { value: String(v) });
const product = (over = {}) => ({ id: 'P1', handle: 'hub', title: 'Hub', tags: ['component:hub'], flange_r_dia: m(64), flange_l_dia: m(58), flange_r_off: m(25), flange_l_off: m(37), sp_offset_r: null, sp_offset_l: null, hub_type: m('Classic Flange'), freehub_list: null, lead_time_prod: null, weight_g_product: m(315), variants: { edges: [] }, ...over });
const variant = (over = {}) => ({ id: 'V1', title: '32h / Black', sku: null, price: '249.99', inventoryQuantity: 0, inventoryPolicy: 'DENY', selectedOptions: [{ name: 'Color', value: 'Black' }, { name: 'Spoke Count', value: '32h' }], ...over });

test('variant geometry wins, the product value is the fallback, and nothing is mixed up between fields', () => {
  const g = pickGeometry(product(), variant({ flange_l_off_var: m(34), flange_r_off_var: m(22) }));
  assert.equal(g.values.flange_l_off, 34); assert.equal(g.values.flange_r_off, 22);
  assert.equal(g.values.flange_l_dia, 58); assert.equal(g.values.flange_r_dia, 64);   // not on the variant: product value
});
test('no variant geometry: exactly the old product-only numbers, 0 where the product has none', () => {
  const g = pickGeometry(product(), variant());
  assert.deepEqual(g.values, { flange_r_dia: 64, flange_l_dia: 58, flange_r_off: 25, flange_l_off: 37, sp_offset_r: 0, sp_offset_l: 0 });
  assert.deepEqual(g.conflicts, []);
});
test('a master (no product geometry, variant has it): the variant numbers', () => {
  const g = pickGeometry(product({ flange_r_dia: null, flange_l_dia: null, flange_r_off: null, flange_l_off: null }), variant({ flange_r_off_var: m(25), flange_l_off_var: m(37), flange_r_dia_var: m(64), flange_l_dia_var: m(58) }));
  assert.equal(g.values.flange_l_off, 37); assert.equal(g.values.flange_r_dia, 64); assert.deepEqual(g.conflicts, []);
});
test('variant and product disagree: the variant wins and the field is flagged; equal values are not flagged; blank or garbage variant values are ignored', () => {
  const g = pickGeometry(product(), variant({ flange_l_off_var: m(34), flange_r_off_var: m(25), flange_l_dia_var: m(''), flange_r_dia_var: m('abc') }));
  assert.equal(g.values.flange_l_off, 34); assert.deepEqual(g.conflicts, ['flange_l_off']);
  assert.equal(g.values.flange_l_dia, 58); assert.equal(g.values.flange_r_dia, 64);
});

test('paging: a product with 120 variants is read to the end; one with 3 asks for nothing', async () => {
  const mk = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ node: { id: 'v' + (from + i) } }));
  const all = mk(120); const calls = [];
  const fetchPage = async (id, cursor) => { calls.push(cursor); const start = Number(cursor); const edges = all.slice(start, start + 50); const next = start + 50; return { edges, pageInfo: { hasNextPage: next < all.length, endCursor: String(next) } }; };
  const big = { id: 'P', variants: { edges: all.slice(0, 50), pageInfo: { hasNextPage: true, endCursor: '50' } } };
  assert.equal(await completeVariants(big, fetchPage), 70); assert.equal(big.variants.edges.length, 120); assert.deepEqual(calls, ['50', '100']);
  assert.equal(new Set(big.variants.edges.map((e) => e.node.id)).size, 120);
  const small = { id: 'S', variants: { edges: mk(3), pageInfo: { hasNextPage: false, endCursor: null } } };
  assert.equal(await completeVariants(small, async () => { throw new Error('must not be called'); }), 0);
  await assert.rejects(() => completeVariants({ id: 'X', variants: { edges: [], pageInfo: { hasNextPage: true, endCursor: 'a' } } }, async () => ({ edges: [], pageInfo: { hasNextPage: true, endCursor: 'a' } }), 3), /stopped paging/);
});

test('records: a single-spacing product gives the same record as before (no new key); a conflict adds geometry_conflicts only on its records', () => {
  const p = product({ variants: { edges: [{ node: variant() }, { node: variant({ id: 'V2', title: '32h / Blue', flange_l_off_var: m(34) }) }] } });
  const flat = flattenDatabase([p]);
  assert.equal(flat.length, 2);
  assert.equal(flat[0].flange_l_off, 37); assert.ok(!('geometry_conflicts' in flat[0]));
  assert.equal(flat[1].flange_l_off, 34); assert.deepEqual(flat[1].geometry_conflicts, ['flange_l_off']);
  assert.deepEqual(geometryConflictProducts(flat), [{ product_id: 'P1', handle: 'hub', fields: ['flange_l_off'], variants: 1 }]);
  assert.equal(flat[0].weight, 315); assert.deepEqual(flat[0].freehub_compatibility, []);
});
test('products without a component tag are still dropped; weight stays variant first', () => {
  assert.equal(flattenDatabase([product({ tags: ['wheelset'] })]).length, 0);
  const p = product({ variants: { edges: [{ node: variant({ weight_g_var: m(300) }) }] } });
  assert.equal(flattenDatabase([p])[0].weight, 300);
});
