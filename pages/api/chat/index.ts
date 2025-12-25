// @ts-nocheck
import { google } from '@ai-sdk/google';
import { streamText, tool } from 'ai'; 
import { z } from 'zod';

export const config = {
  api: {
    bodyParser: true,
  },
  runtime: 'nodejs',
};

const STANDARD_SHOP_BUILD_DAYS = 5;
const SEARCH_LIMIT = 20;

const SYSTEM_PROMPT = `
You are the **LoamLabs Lead Tech**, an expert AI wheel building assistant.

**YOUR PERSONALITY:**
- Professional, technical, direct, and "down to earth."
- Identity: "LoamLabs Automated Lead Tech".

**CONTEXTUAL INTELLIGENCE:**
You have access to the user's current builder selections (see [CONTEXT] below).
1. **CHECK SPECS:** If the user asks "Is X in stock?", first check if they have selected an **Axle Standard**, **Brake Interface**, or **Spoke Count** in the builder.
2. **NARROW DOWN:** Use these selections to filter the search results mentally.
3. **ASK TO CLARIFY:** If the user hasn't selected an Axle or Spoke Count yet, and the search returns many options, **ASK THEM** for these details to help find the exact part (e.g., "Are you looking for Boost or SuperBoost?").

**CRITICAL SEARCH RULES:**
1. **SEARCH SIMPLY:** Use ONLY the core Brand or Model name (e.g. "Hydra"). Clean out words like "stock" or "hub".
2. **MANDATORY SPEECH:** After using a tool, you **MUST** speak to the user. Explain what you found. NEVER stay silent after a tool result.
3. **INVENTORY PRECISION:** If the tool lists specific variants (e.g. "Black / 32h"), report that exact availability.
4. **LEAD TIME:** In Stock = ~${STANDARD_SHOP_BUILD_DAYS} days. Out of Stock = Mfg Lead Time + ${STANDARD_SHOP_BUILD_DAYS} days.

**CONTEXT:**
The user's current selections are injected below. Use this to guide your questions.
`;

async function lookupProductInfo(query: string) {
  console.log(`[Tool] Searching Shopify for: "${query}"`);
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
                products(first: ${SEARCH_LIMIT}, query: $query) {
                  edges {
                    node {
                      title
                      totalInventory
                      leadTime: metafield(namespace: "custom", key: "lead_time_days") { value }
                      variants(first: 25) {
                        edges {
                          node {
                            title
                            inventoryPolicy
                            inventoryQuantity
                            selectedOptions { name value }
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
        console.error("[Shopify Error] Invalid Data:", JSON.stringify(data));
        return "Search failed. The store database returned an error.";
    }
    
    const count = data.data.products.edges.length;
    console.log(`[Shopify] Found ${count} products for query "${query}"`);

    const products = data.data.products.edges.map((e: any) => {
      const p = e.node;
      const rawLeadTime = p.leadTime ? parseInt(p.leadTime.value) : 0;
      const inStockVariants: string[] = [];
      p.variants.edges.forEach((v: any) => {
          const node = v.node;
          const name = node.title.replace('Default Title', 'Standard');
          // Intelligent Stock Check: Only list if physically in stock OR allow oversell
          if (node.inventoryQuantity > 0 || node.inventoryPolicy === 'CONTINUE') {
              const qtyMsg = node.inventoryQuantity > 0 ? `Qty: ${node.inventoryQuantity}` : "Made to Order";
              inStockVariants.push(`${name} (${qtyMsg})`);
          }
      });
      let stockSummary = "Status: Special Order Only (Out of Stock)";
      if (inStockVariants.length > 0) stockSummary = `> AVAILABLE VARIANTS: ${inStockVariants.join(', ')}`;
      return `ITEM: ${p.title} | ${stockSummary} | Mfg Lead Time: ${rawLeadTime} days`;
    });

    if (products.length === 0) return "No products found matching that query. Try a simpler search term.";
    
    const limitedProducts = products.slice(0, 5);
    console.log(`[Tool] Returning top ${limitedProducts.length} results to AI.`);
    
    // Force the AI to acknowledge the data
    return `FOUND ${count} ITEMS. HERE ARE THE TOP 5:\n` + limitedProducts.join("\n") + "\n\n[INSTRUCTION TO AI: Summarize these options for the user based on their context.]";

  } catch (error) {
    console.error("Shopify Lookup Error:", error);
    return "Error connecting to product database.";
  }
}

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const { messages, buildContext, isAdmin } = req.body;
    let finalSystemPrompt = SYSTEM_PROMPT + `\n[CONTEXT]: ${JSON.stringify(buildContext?.components || {})}`;
    if (isAdmin) finalSystemPrompt += `\n\n**ADMIN DEBUG MODE:** Show raw data if asked.`;

    const result = await streamText({
      model: google('gemini-flash-latest'),
      system: finalSystemPrompt,
      messages: messages.map((m: any) => ({
        role: m.role,
        content: m.content
      })),
      maxSteps: 5,
      tools: {
        lookup_product_info: tool({
          description: 'Searches the store inventory for products.',
          parameters: z.object({ 
            query: z.string().describe("The core Brand or Model name to search for (e.g. 'Hydra'). DO NOT include words like 'stock', 'available', or 'hub'.") 
          }),
          execute: async (args) => {
            console.log("[Tool Debug] Raw Args:", JSON.stringify(args));
            let q = args.query;
            if (!q || typeof q !== 'string') {
                q = Object.values(args)
                    .filter(v => v && typeof v === 'string' && v.trim().length > 0)
                    .join(" ");
            }
            if (q) {
                q = q.replace(/\b(stock|available|hub|hubs|pair|set|in)\b/gi, '').trim();
            }
            if (!q) q = "undefined";
            return await lookupProductInfo(String(q));
          },
        }),
        calculate_spoke_lengths: tool({
          description: 'Calculates precise spoke lengths based on hub and rim geometry.',
          parameters: z.object({
            erd: z.number().describe("Effective Rim Diameter in mm"), 
            pcdLeft: z.number().describe("Pitch Circle Diameter of left flange"), 
            pcdRight: z.number().describe("Pitch Circle Diameter of right flange"),
            flangeLeft: z.number().describe("Flange offset left"), 
            flangeRight: z.number().describe("Flange offset right"),
            spokeCount: z.number().describe("Total number of spokes"), 
            crossPattern: z.number().describe("Spoke crossing pattern")
          }),
          execute: async (args) => {
            try {
              const r = await fetch(process.env.SPOKE_CALC_API_URL || '', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.SPOKE_CALC_API_SECRET || '' },
                body: JSON.stringify(args),
              });
              const d = await r.json();
              return `Calculated: Left ${d.left}mm, Right ${d.right}mm`;
            } catch (e) { return "Calc Error"; }
          },
        }),
      },
    });

    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      'Connection': 'keep-alive'
    });

    let hasSentText = false;

    for await (const part of result.fullStream) {
        console.log("Stream Part Type:", part.type); 
        const textContent = part.textDelta || part.text || part.content || "";
        if (part.type === 'text-delta' && typeof textContent === 'string' && textContent.length > 0) {
            res.write(textContent);
            hasSentText = true;
        }
    }

    if (!hasSentText) {
      console.log("AI returned no text. Sending fallback.");
      res.write("...");
    }

    res.end();

  } catch (error: any) {
    console.error("AI ROUTE ERROR:", error);
    res.status(500).json({ error: error.message || JSON.stringify(error) });
  }
}