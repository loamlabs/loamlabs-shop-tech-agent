// @ts-nocheck
import OpenAI from 'openai';

// 1. CONFIGURATION
export const config = {
  api: {
    bodyParser: true,
  },
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const STANDARD_SHOP_BUILD_DAYS = 5; // LoamLabs internal build buffer

const SYSTEM_PROMPT = `
You are the **LoamLabs Lead Tech**, an expert AI wheel building assistant.
You are speaking to a customer in the Custom Wheel Builder.

**YOUR PERSONALITY:**
- Professional, technical, direct, and "down to earth."
- You value durability and engineering over marketing hype.
- You speak like a veteran mechanic.
- You are helpful but honest. If a build looks unbalanced (e.g., DH rims on XC hubs), you politely warn them.
- **Identity:** If asked for your name, state that you are the "LoamLabs Automated Lead Tech." Do not pretend to be a specific human.

**CRITICAL STORE POLICIES (PRIME DIRECTIVES):**
1. **PRICE IS TRUTH:** You have access to the live build state. If a component (like a Valve Stem) has a price > $0.00 in the system, it is NOT free. Never tell a customer an item is included unless the price is explicitly $0.00.
2. **NO ASSUMPTIONS:** Do not assume manufacturer policies (like "Reserve includes valves") apply here. LoamLabs custom builds are a la carte.
3. **SCOPE BOUNDARY:** Only discuss products currently available in the builder context provided to you. If a user asks about a brand we don't carry (e.g., "Zipp"), say: "We don't stock those currently. I recommend Reserve or other relevant brands we carry for similar performance."
4. **INVENTORY REALITY:** Do not guess stock. If asked "Is this in stock?" or "What is the lead time?", you MUST use the 'lookup_product_info' tool if the item is not currently selected in the context.
   - Manufacturer Lead Times are stored in the product data (e.g., '10').
   - LoamLabs Build Time is ${STANDARD_SHOP_BUILD_DAYS} days.
   - **Total Lead Time = Manufacturer Time + Build Time.**
   - ALWAYS calculate this for the customer. Example: "The hub has a 10-day lead time, plus our 5-day build time, so expect about 2-3 weeks."

**TECHNICAL CHEAT SHEET (World Knowledge Override):**
- Industry Nine Hydra: 690 POE (0.52°), High buzz, Aluminum spokes available.
- Onyx Vesper: Instant engagement (Sprag Clutch), Silent, slightly heavier but rolls fast.
- DT Swiss 350: 36t Ratchet (10°) standard, reliable, easy service.
- Sapim CX-Ray: Bladed aero, high fatigue life.
- Sapim Race: Double butted (2.0/1.8/2.0), robust, value.
- Berd Spokes: Polyethylene (fabric), ultra-light, high damping, requires specific prep.

**CONTEXT:**
The user's current build configuration (Rims, Hubs, Specs, Prices, Lead Times) is injected into your first message. Use this data to answer specific questions.
`;

// 2. SHOPIFY TOOL FUNCTION (Server-Side)
async function lookupProductInfo(query: string) {
  try {
    const adminResponse = await fetch(`https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2024-04/graphql.json`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN || ''
        },
        body: JSON.stringify({
            query: `
              query searchProducts($query: String!) {
                products(first: 3, query: $query) {
                  edges {
                    node {
                      title
                      totalInventory
                      leadTime: metafield(namespace: "custom", key: "lead_time_days") { value }
                      variants(first: 3) {
                        edges {
                          node {
                            title
                            inventoryPolicy
                            inventoryQuantity
                            price
                          }
                        }
                      }
                    }
                  }
                }
              }
            `,
            variables: { query }
        })
    });

    const data = await adminResponse.json();
    
    if (!data.data || !data.data.products) {
        return "Search failed or returned no data.";
    }

    const products = data.data.products.edges.map((e: any) => {
      const p = e.node;
      // Get Lead Time (Default to 0 if missing)
      const rawLeadTime = p.leadTime ? parseInt(p.leadTime.value) : 0;
      const totalLeadTime = rawLeadTime + STANDARD_SHOP_BUILD_DAYS;
      
      const variant = p.variants.edges[0]?.node;
      const stock = variant ? variant.inventoryQuantity : 0;
      const policy = variant ? variant.inventoryPolicy : 'deny';
      
      let status = "In Stock";
      if (stock <= 0) {
          status = policy === 'continue' 
            ? `Special Order (Mfg Lead Time: ${rawLeadTime} days + ${STANDARD_SHOP_BUILD_DAYS} days build = ~${totalLeadTime} days total)` 
            : "Sold Out";
      } else {
          status = `In Stock (Ships in ~${STANDARD_SHOP_BUILD_DAYS} days)`;
      }

      return `Product: ${p.title}\nStatus: ${status}\nStock Level: ${stock}\nMetadata Lead Time: ${rawLeadTime} days`;
    });

    if (products.length === 0) return "No products found matching that name.";
    return products.join("\n\n");

  } catch (error) {
    console.error("Shopify Lookup Error:", error);
    return "Error connecting to product database.";
  }
}

// 3. MAIN HANDLER
export default async function handler(req: any, res: any) {
  // CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const { messages, buildContext } = req.body;

    const contextInjection = `
      [CURRENT USER SELECTIONS]:
      ${JSON.stringify(buildContext?.components || {})}
    `;

    // 1. Prepare Messages
    const openAiMessages = [
      { role: 'system', content: SYSTEM_PROMPT + contextInjection },
      ...messages.map((m: any) => ({ role: m.role === 'agent' ? 'assistant'