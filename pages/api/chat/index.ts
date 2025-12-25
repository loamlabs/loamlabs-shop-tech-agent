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
const SEARCH_LIMIT = 50;

const SYSTEM_PROMPT = `
You are the **LoamLabs Lead Tech**, an expert AI wheel building assistant.

**YOUR PERSONALITY:**
- Professional, technical, direct, and "down to earth."
- Identity: "LoamLabs Automated Lead Tech".

**CRITICAL SEARCH RULES:**
1. **SEARCH SIMPLY:** When using the 'lookup_product_info' tool, use ONLY the core Brand or Model name (e.g., "Hydra", "Vesper", "Hydra2"). 
2. **NO FLUFF:** NEVER include words like "stock", "available", "hub", or "price" in the search query. They break the search engine.
3. **INVENTORY PRECISION:** Parse the tool output carefully. If it lists specific variants in stock, report them.
4. **LEAD TIME MATH:** In Stock = ~${STANDARD_SHOP_BUILD_DAYS} days. Out of Stock = Mfg Lead Time + ${STANDARD_SHOP_BUILD_DAYS} days.
5. **ALWAYS REPLY:** Even if the tool returns "No products found", you MUST tell the user "I couldn't find anything matching [Term]. Did you mean...?"

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
    
    // Debug Log for Shopify Response
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
          if (node.inventoryQuantity > 0) {
              inStockVariants.push(`${name} (Qty: ${node.inventoryQuantity})`);
          }
      });
      let stockSummary = "Status: Special Order Only (Out of Stock)";
      if (inStockVariants.length > 0) stockSummary = `> IN STOCK: ${inStockVariants.join(', ')}`;
      return `ITEM: ${p.title} | ${stockSummary} | Mfg Lead Time: ${rawLeadTime} days`;
    });

    if (products.length === 0) return "No products found matching that query. Try a simpler search term.";
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
            query: z.string().describe("The core Brand or Model name to search for (e.g. 'Hydra'). DO NOT include words like 'stock', 'available', or 'hub'.") 
          }),
          execute: async (args) => {
            console.log("[Tool Debug] Raw Args:", JSON.stringify(args));
            
            let q = args.query;
            
            // Intelligent Argument Reconstruction
            if (!q || typeof q !== 'string') {
                q = Object.values(args)
                    .filter(v => v && typeof v === 'string' && v.trim().length > 0)
                    .join(" ");
            }
            
            // CLEANUP: Remove common "fluff" words that break Shopify search
            if (q) {
                // Remove "stock", "available", "hub", "hubs", "in" (case insensitive)
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