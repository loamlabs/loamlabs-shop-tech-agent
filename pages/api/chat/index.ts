// @ts-nocheck
import { google } from '@ai-sdk/google';
import { streamText, tool } from 'ai'; 
import { z } from 'zod';

// Ensure we are using Node runtime for manual response piping
export const config = {
  api: {
    bodyParser: true,
  },
  runtime: 'nodejs',
};

const STANDARD_SHOP_BUILD_DAYS = 5;
const SEARCH_LIMIT = 50;

const SYSTEM_PROMPT = `
You are the **LoamLabs Lead Tech**, an expert AI wheel building assistant.

**YOUR PERSONALITY:**
- Professional, technical, direct, and "down to earth."
- Identity: "LoamLabs Automated Lead Tech".

**CRITICAL SEARCH RULES:**
1. **BROADEN THE SCOPE:** If a user asks "What else do you have?", search for **Component Type + Spec** (e.g. "Rear Hub 12x148"). DO NOT assume the previous brand.
2. **INVENTORY PRECISION:** Parse the tool output carefully. If it lists specific variants in stock, report them.
3. **LEAD TIME MATH:** In Stock = ~${STANDARD_SHOP_BUILD_DAYS} days. Out of Stock = Mfg Lead Time + ${STANDARD_SHOP_BUILD_DAYS} days.

**CONTEXT:**
The user's current selections are injected. If they ask about something NOT selected, use the 'lookup_product_info' tool.
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
    if (!data.data || !data.data.products) return "Search failed or returned no data.";

    const products = data.data.products.edges.map((e: any) => {
      const p = e.node;
      const rawLeadTime = p.leadTime ? parseInt(p.leadTime.value) : 0;
      
      const inStockVariants: string[] = [];
      
      p.variants.edges.forEach((v: any) => {
          const node = v.node;
          const name = node.title.replace('Default Title', 'Standard');
          if (node.inventoryQuantity > 0) {
              inStockVariants.push(`${name} (Qty: ${node.inventoryQuantity})`);
          }
      });

      let stockSummary = "Status: Special Order Only (Out of Stock)";
      if (inStockVariants.length > 0) {
          stockSummary = `> IN STOCK: ${inStockVariants.join(', ')}`;
      }

      return `ITEM: ${p.title} | ${stockSummary} | Mfg Lead Time: ${rawLeadTime} days`;
    });

    if (products.length === 0) return "No products found matching that query.";
    return products.join("\n");

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
            query: z.string().describe("The name or specification of the component to search for") 
          }),
          execute: async ({ query }) => await lookupProductInfo(query),
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
                headers: {
                  'Content-Type': 'application/json',
                  'x-internal-secret': process.env.SPOKE_CALC_API_SECRET || '',
                },
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

    // DEBUG LOGGING LOOP
    for await (const part of result.fullStream) {
        console.log("AI Stream Part Type:", part.type); // LOG TO VERCEL
        if (part.type === 'text-delta' && typeof part.textDelta === 'string') {
            res.write(part.textDelta);
            hasSentText = true;
        }
    }

    // Fallback if AI was silent
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