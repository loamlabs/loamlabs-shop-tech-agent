import { Redis } from '@upstash/redis';
import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { flattenDatabase, geometryConflictProducts } from './sync-flatten.ts';
import { completeVariants } from './sync-paging.ts';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const SHOP_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;

if (!SHOP_DOMAIN || !ACCESS_TOKEN) {
  console.error("❌ Missing Shopify Environment Variables");
  process.exit(1);
}

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Shopify reserves the REQUESTED cost of a query and refills 100 points a second: wait until the bucket holds that much, so the next page is not throttled.
async function paceByCost(json: any) {
  const c = json?.extensions?.cost;
  if (!c || !c.throttleStatus) return;
  const need = (c.requestedQueryCost || 0) - (c.throttleStatus.currentlyAvailable || 0);
  if (need > 0) await sleep(Math.ceil((need / (c.throttleStatus.restoreRate || 100)) * 1000) + 100);
}

// Every field read from a variant (shared by the main query and the extra variant pages).
const VARIANT_FIELDS = `
              id
              title
              sku
              price
              inventoryQuantity
              inventoryPolicy
              
              selectedOptions {
                name
                value
              }

              # --- C. CRITICAL FILTERING ---
              position: metafield(namespace: "custom", key: "wheel_spec_position") { value }
              axle: metafield(namespace: "custom", key: "wheel_spec_hub_spacing") { value }
              brake: metafield(namespace: "custom", key: "wheel_spec_brake_interface") { value }
              size: metafield(namespace: "custom", key: "wheel_spec_rim_size") { value }
              width: metafield(namespace: "custom", key: "wheel_spec_internal_width_mm") { value }
              
              # --- D. ENGINEERING ---
              weight_g_var: metafield(namespace: "custom", key: "weight_g") { value }
              erd: metafield(namespace: "custom", key: "rim_erd") { value }
              freehub_list_var: metafield(namespace: "custom", key: "freehub") { value }

              # Hub geometry on the variant (a master can differ per spacing); the product value is the fallback
              flange_r_dia_var: metafield(namespace: "custom", key: "hub_flange_diameter_right") { value }
              flange_l_dia_var: metafield(namespace: "custom", key: "hub_flange_diameter_left") { value }
              flange_r_off_var: metafield(namespace: "custom", key: "hub_flange_offset_right") { value }
              flange_l_off_var: metafield(namespace: "custom", key: "hub_flange_offset_left") { value }
              sp_offset_r_var: metafield(namespace: "custom", key: "hub_sp_offset_spoke_hole_right") { value }
              sp_offset_l_var: metafield(namespace: "custom", key: "hub_sp_offset_spoke_hole_left") { value }
              
              # --- E. LOGISTICS ---
              lead_time_var: metafield(namespace: "custom", key: "lead_time_days") { value }
`;

// CHANGED: Removed the 'query' parameter to fetch EVERYTHING first
const QUERY = `
query getProducts($cursor: String) {
  products(first: 10, after: $cursor) {
    pageInfo {
      hasNextPage
      endCursor
    }
    edges {
      node {
        id
        title
        handle
        tags
        productType
        
        # --- A. IDENTITY ---
        model: metafield(namespace: "custom", key: "wheel_spec_model") { value }
        pairing_key: metafield(namespace: "custom", key: "pairing_key") { value }
        accessory_category: metafield(namespace: "custom", key: "accessory_category") { value }
        
        # --- D. ENGINEERING ---
        weight_g_product: metafield(namespace: "custom", key: "weight_g") { value }
        hub_type: metafield(namespace: "custom", key: "hub_type") { value }
        freehub_list: metafield(namespace: "custom", key: "freehub") { value }
        
        # Hub Geometry
        flange_r_dia: metafield(namespace: "custom", key: "hub_flange_diameter_right") { value }
        flange_l_dia: metafield(namespace: "custom", key: "hub_flange_diameter_left") { value }
        flange_r_off: metafield(namespace: "custom", key: "hub_flange_offset_right") { value }
        flange_l_off: metafield(namespace: "custom", key: "hub_flange_offset_left") { value }
        sp_offset_r: metafield(namespace: "custom", key: "hub_sp_offset_spoke_hole_right") { value }
        sp_offset_l: metafield(namespace: "custom", key: "hub_sp_offset_spoke_hole_left") { value }
        
        # Lacing
        lacing_policy: metafield(namespace: "custom", key: "hub_lacing_policy") { value }
        
        # Rim Tech
        rim_tension: metafield(namespace: "custom", key: "rim_target_tension_kgf") { value }
        rim_depth_prod: metafield(namespace: "custom", key: "rim_depth_mm") { value }

        # --- E. LOGISTICS ---
        lead_time_prod: metafield(namespace: "custom", key: "lead_time_days") { value }

        options {
          name
          position
        }

        variants(first: 50) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
${VARIANT_FIELDS}            }
          }
        }
      }
    }
  }
}
`;

const VARIANT_PAGE_QUERY = `
query getVariantPage($id: ID!, $cursor: String) {
  product(id: $id) {
    variants(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
${VARIANT_FIELDS}        }
      }
    }
  }
}
`;

async function fetchVariantPage(productId: string, cursor: string) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const response: any = await fetch(`https://${SHOP_DOMAIN}/admin/api/2024-04/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': ACCESS_TOKEN! },
      body: JSON.stringify({ query: VARIANT_PAGE_QUERY, variables: { id: productId, cursor } })
    });
    const json: any = await response.json();
    if (json.errors || !json.data?.product) { await sleep(2000); continue; }
    await paceByCost(json);
    return json.data.product.variants;
  }
  throw new Error(`could not read more variants of ${productId}`);
}

async function fetchAllProducts() {
  let allProducts = [];
  let cursor = null;
  let hasNext = true;

  console.log("🚀 Starting Data Sync (Fetching All)...");

  while (hasNext) {
    const response: any = await fetch(`https://${SHOP_DOMAIN}/admin/api/2024-04/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': ACCESS_TOKEN!
      },
      body: JSON.stringify({
        query: QUERY,
        variables: { cursor }
      })
    });

    const json: any = await response.json();
    
    if (json.errors) {
      console.warn("\n⚠️ API Error. Retrying...");
      await sleep(2000);
      continue; 
    }

    const data: any = json.data.products;
    
    if (data.edges.length > 0) {
        const nodes = data.edges.map((e: any) => e.node);
        for (const node of nodes) {
          // a product with more than 50 variants (a hub master, the Industry Nine SYSTEM front) is read to the end
          if (node.variants?.pageInfo?.hasNextPage) await completeVariants(node, fetchVariantPage);
        }
        allProducts.push(...nodes);
    }

    cursor = data.pageInfo.endCursor;
    hasNext = data.pageInfo.hasNextPage;
    process.stdout.write("."); 
    await sleep(250); 
    await paceByCost(json);
  }

  console.log(`\n📦 Fetched ${allProducts.length} Total Products. Filtering...`);
  return allProducts;
}

async function run() {
  try {
    const rawProducts = await fetchAllProducts();
    const flatDb = flattenDatabase(rawProducts);

    console.log(`🧠 Generated ${flatDb.length} Master Records (Filtered).`);

    // Hub products whose variant and product geometry disagree (the order webhook reads variant first: a stale product copy gives silent wrong lengths)
    const conflicts = geometryConflictProducts(flatDb);
    if (conflicts.length) {
      console.warn(`⚠️ ${conflicts.length} product(s) have hub geometry on a variant that differs from the product value (review):`);
      conflicts.slice(0, 25).forEach(c => console.warn(`   ${c.handle}: ${c.fields.join(', ')} (${c.variants} variants)`));
    }
    
    if (flatDb.length === 0) {
        console.error("❌ Error: Filter removed all products. Check tags!");
        return;
    }

    await redis.set('loamlabs:inventory:master', JSON.stringify(flatDb));
    console.log("✅ Database Synced to Redis Successfully!");
    
    console.log("\n--- Sample Record ---");
    console.log(flatDb[0]);

  } catch (error) {
    console.error("Sync Failed:", error);
  }
}

run();