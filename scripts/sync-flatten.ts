// Turns raw Shopify products (as read by sync-db.ts) into the flat master records. Pure: no network, no Redis, no environment.
// Relative imports carry the .ts extension so this runs under tsx and under `node --experimental-strip-types --test`.
import { pickFreehub } from './freehub-pick.ts';
import { pickGeometry } from './sync-geometry.ts';

export function flattenDatabase(products: any[]) {
  const flatList: any[] = [];

  products.forEach(p => {
    // --- JAVASCRIPT FILTER ---
    // Only keep items that have a tag starting with "component:"
    // e.g., "component:rim", "component:hub"
    const hasComponentTag = p.tags.some((t: string) => t.toLowerCase().startsWith('component:'));

    if (!hasComponentTag) {
        // Skip this product (it's likely a wheelset, t-shirt, or other item)
        return;
    }

    const baseData = {
      product_id: p.id,
      handle: p.handle,
      model: p.model?.value || p.title,
      tags: p.tags,
      hub_type: p.hub_type?.value,
      freehub_compatibility: p.freehub_list?.value ? JSON.parse(p.freehub_list.value) : [],
      lacing_policy: p.lacing_policy?.value,
      flange_r_dia: parseFloat(p.flange_r_dia?.value || 0),
      flange_l_dia: parseFloat(p.flange_l_dia?.value || 0),
      flange_r_off: parseFloat(p.flange_r_off?.value || 0),
      flange_l_off: parseFloat(p.flange_l_off?.value || 0),
      sp_offset_r: parseFloat(p.sp_offset_r?.value || 0),
      sp_offset_l: parseFloat(p.sp_offset_l?.value || 0),
      rim_tension: parseFloat(p.rim_tension?.value || 0),
      rim_depth: parseFloat(p.rim_depth_prod?.value || 0),
    };

    p.variants.edges.forEach((v: any) => {
      const variant = v.node;

      let color = "";
      let holes = "";

      variant.selectedOptions.forEach((opt: any) => {
        const name = opt.name.toLowerCase();
        if (name.includes('color') || name.includes('colour')) color = opt.value;
        if (name.includes('hole') || name.includes('count')) holes = opt.value;
      });

      const leadTime = parseInt(variant.lead_time_var?.value || p.lead_time_prod?.value || "7");
      // Variant weight first; a spoke product's base weight (custom.spoke_base_weight_g, for a 260 mm spoke) second; the old product weight_g last (cleared on spokes on Nov 17 2026).
      const weight = parseFloat(variant.weight_g_var?.value || p.spoke_base_weight_g?.value || p.weight_g_product?.value || "0");

      // Variant list first; the product list is only the fallback (never merged).
      const freehub = pickFreehub(variant.freehub_list_var?.value, baseData.freehub_compatibility);

      // Hub geometry: the variant's own number first, the product's as the fallback (same order as the order webhook).
      // A product that has a value on both sides and they differ is flagged with geometry_conflicts (the key exists only then, so every other record is unchanged).
      const geo = pickGeometry(p, variant);

      flatList.push({
        id: variant.id,
        title: variant.title === "Default Title" ? p.title : `${p.title} - ${variant.title}`,
        price: variant.price,
        stock: variant.inventoryQuantity,
        policy: variant.inventoryPolicy,
        lead_time: leadTime,
        ...baseData,
        ...geo.values,
        ...(geo.conflicts.length ? { geometry_conflicts: geo.conflicts } : {}),
        freehub_compatibility: freehub,
        color: color,
        holes: holes,
        position: variant.position?.value || "",
        axle: variant.axle?.value || "",
        brake: variant.brake?.value || "",
        size: variant.size?.value || "",
        width: variant.width?.value || "",
        erd: parseFloat(variant.erd?.value || 0),
        weight: weight
      });
    });
  });

  return flatList;
}

/** products (not variants) whose variant and product geometry disagree: [{ product_id, handle, fields }] */
export function geometryConflictProducts(flat: any[]) {
  const by = new Map<string, { product_id: string; handle: string; fields: Set<string>; variants: number }>();
  for (const r of flat) {
    if (!r.geometry_conflicts) continue;
    const e = by.get(r.product_id) || { product_id: r.product_id, handle: r.handle, fields: new Set<string>(), variants: 0 };
    r.geometry_conflicts.forEach((f: string) => e.fields.add(f)); e.variants++; by.set(r.product_id, e);
  }
  return [...by.values()].map(e => ({ product_id: e.product_id, handle: e.handle, fields: [...e.fields], variants: e.variants }));
}
