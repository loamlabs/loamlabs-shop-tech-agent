// Which freehub list a hub variant gets: the variant's own list first, the product list as the fallback.
// The two lists are never merged. An unreadable or empty variant value falls back to the product list.
export function pickFreehub(variantValue: string | null | undefined, productList: any[]): any[] {
  let vfh: any = [];
  try {
    vfh = variantValue ? JSON.parse(variantValue) : [];
  } catch (e) {
    vfh = [];
  }
  return Array.isArray(vfh) && vfh.length ? vfh : productList;
}
