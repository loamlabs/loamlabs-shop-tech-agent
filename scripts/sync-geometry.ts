// Hub geometry for one variant record: the VARIANT's own value first, the PRODUCT's value as the fallback (never averaged or merged field by field
// beyond that). A product whose variant and product values both exist and disagree is reported, because the order webhook also reads variant first:
// a stale product-level copy then gives silent wrong spoke lengths (a deliberate per-spacing override looks the same, so it is a review flag, not an error).
// No relative imports on purpose: this file runs under tsx and under `node --experimental-strip-types --test`.
export const GEOMETRY_FIELDS = ['flange_r_dia', 'flange_l_dia', 'flange_r_off', 'flange_l_off', 'sp_offset_r', 'sp_offset_l'] as const;

const readNum = (m: any): number | null => {
  const raw = m && m.value !== undefined && m.value !== null ? String(m.value).trim() : '';
  if (!raw) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
};

export function pickGeometry(product: Record<string, any>, variant: Record<string, any>): { values: Record<string, number>; conflicts: string[] } {
  const values: Record<string, number> = {};
  const conflicts: string[] = [];
  for (const f of GEOMETRY_FIELDS) {
    const v = readNum(variant[f + '_var']);
    const p = readNum(product[f]);
    // the product fallback keeps the old expression exactly, so a product with no variant values gives the same number as before
    values[f] = v !== null ? v : parseFloat(product[f]?.value || 0);
    if (v !== null && p !== null && Math.abs(v - p) > 1e-9) conflicts.push(f);
  }
  return { values, conflicts };
}
