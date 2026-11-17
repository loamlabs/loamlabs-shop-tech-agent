// Page through ALL variants of a product. The main query reads the first 50 per product; a product with more (a hub master can have 250 or more,
// the Industry Nine SYSTEM front has 84) comes back with pageInfo.hasNextPage and the rest is read here, 50 at a time.
// `fetchPage(productId, cursor)` returns { edges, pageInfo } (one page of that product's variants); injected so this runs without a network in tests.
export async function completeVariants(
  product: any,
  fetchPage: (productId: string, cursor: string) => Promise<{ edges: any[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }>,
  maxPages = 40,
): Promise<number> {
  const conn = product.variants;
  let added = 0;
  let pages = 0;
  while (conn && conn.pageInfo && conn.pageInfo.hasNextPage) {
    if (++pages > maxPages) throw new Error(`product ${product.id} has more than ${50 * (maxPages + 1)} variants: stopped paging`);
    const page = await fetchPage(product.id, conn.pageInfo.endCursor as string);
    conn.edges.push(...page.edges);
    added += page.edges.length;
    conn.pageInfo = page.pageInfo;
  }
  return added;
}
