import { Redis } from '@upstash/redis';
import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

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

// CHANGED: Removed the 'query' parameter to fetch EVERYTHING first
const QUERY = `
query getProducts($cursor: String) {
  products(first: 20, after: $cursor) {
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
          edges {
            node {
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
              
              # --- E. LOGISTICS ---
              lead_time_var: metafield(namespace: "custom", key: "lead_time_days") { value }
            }
          }
        }
      }
    }
  }
}
`;

async function fetchAllProducts() {
  let allProducts = [];
  let cursor = null;
  let hasNext = true;

  console.log("🚀 Starting Data Sync (Fetching All)...");

  while (hasNext) {
    const response = await fetch(`https://${SHOP_DOMAIN}/admin/api/2024-04/graphql.json`, {
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

    const json = await response.json();
    
    if (json.errors) {
      console.warn("\n⚠️ API Error. Retrying...");
      await sleep(2000);
      continue; 
    }

    const data = json.data.products;
    
    if (data.edges.length > 0) {
        allProducts.push(...data.edges.map((e: any) => e.node));
    }

    cursor = data.pageInfo.endCursor;
    hasNext = data.pageInfo.hasNextPage;
    process.stdout.write("."); 
    await sleep(250); 
  }

  console.log(`\n📦 Fetched ${allProducts.length} Total Products. Filtering...`);
  return allProducts;
}

function flattenDatabase(products: any[]) {
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
      const weight = parseFloat(variant.weight_g_var?.value || p.weight_g_product?.value || "0");

      flatList.push({
        id: variant.id,
        title: variant.title === "Default Title" ? p.title : `${p.title} - ${variant.title}`,
        price: variant.price,
        stock: variant.inventoryQuantity,
        policy: variant.inventoryPolicy,
        lead_time: leadTime,
        ...baseData,
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

async function run() {
  try {
    const rawProducts = await fetchAllProducts();
    const flatDb = flattenDatabase(rawProducts);

    console.log(`🧠 Generated ${flatDb.length} Master Records (Filtered).`);
    
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