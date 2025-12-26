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
const SEARCH_LIMIT = 50; // Increased to allow for heavy filtering

const SYSTEM_PROMPT = `
You are the **LoamLabs Lead Tech**, an expert AI wheel building assistant.

**YOUR PERSONALITY:**
- Professional, technical, direct, and "down to earth."
- Identity: "LoamLabs Automated Lead Tech".

**CRITICAL RULES:**
1. **RESPECT MODEL NUMBERS:** If the user types "Hydra2" or "Pro 5", search for exactly that. Do not simplify "Hydra2" to "Hydra".
2. **ALWAYS REPLY:** If a tool returns data, you **MUST** generate a text response summarizing it for the user. Do not stop.
3. **INVENTORY PRECISION:** Report specific variants that are in stock.
4. **LEAD TIME:** In Stock = ~${STANDARD_SHOP_BUILD_DAYS} days. Out of Stock = Mfg Lead Time + ${STANDARD_SHOP_BUILD_DAYS} days.

**CONTEXT:**
The user's current selections are injected below.
`;

// Helper to filter results based on Build Context
function filterProductsByContext(products: any[], context: any, query: string) {
  return products.filter(p => {
    const title = p.title.toLowerCase();
    const tags = p.tags.map((t: string) => t.toLowerCase());
    const queryLower = query.toLowerCase();

    // 1. COMPONENT TYPE FILTER (Crucial for filtering out Wheelsets)
    // If the query mentions "hub", ONLY show items tagged 'component:hub'
    if (queryLower.includes('hub') && !tags.includes('component:hub')) return false;
    if (queryLower.includes('rim') && !tags.includes('component:rim')) return false;

    // 2. POSITION FILTER (Front vs Rear)
    // We assume the context object has keys like 'position' or similar. 
    // Adjust 'context.position' to match your actual object key if different.
    if (context?.position) {
        const pos = context.position.toLowerCase();
        if (pos.includes('rear') && title.includes('front')) return false;
        if (pos.includes('front') && title.includes('rear') && !title.includes('front/rear')) return false;
    }

    // 3. BRAKE INTERFACE FILTER
    if (context?.brake_interface) {
        const brake = context.brake_interface.toLowerCase();
        if (brake.includes('centerlock') && title.includes('6-bolt')) return false;
        if (brake.includes('6-bolt') && title.includes('centerlock')) return false;
    }

    // 4. AXLE STANDARD FILTER (Smart Text Matching)
    // If context is "SuperBoost 157", we look for "157" in title
    if (context?.axle_spacing) {
        const axle = context.axle_spacing;
        if (axle.includes('157') && !title.includes('157')) return false;
        if (axle.includes('148') && !title.includes('148')) return false;
        if (axle.includes('142') && !title.includes('142')) return false;
        if (axle.includes('100') && !title.includes('100')) return false;
        if (axle.includes('110') && !title.includes('110')) return false;
    }

    return true;
  });
}

async function lookupProductInfo(query: string, context: any) {
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
                      tags
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
        return "Search failed. The store database returned an error.";
    }
    
    let rawProducts = data.data.products.edges.map((e: any) => e.node);
    console.log(`[Shopify] Raw Results: ${rawProducts.length}`);

    // --- APPLY SMART FILTERS ---
    const filteredProducts = filterProductsByContext(rawProducts, context, query);
    console.log(`[Filter] Filtered down to: ${filteredProducts.length} items`);

    if (filteredProducts.length === 0) {
        return `I found products matching "${query}", but none matched your specific build requirements (Axle/Brake/Position). Check your spelling or try a broader search.`;
    }

    let totalPhysicalStock = 0;

    const formattedProducts = filteredProducts.map((p: any) => {
      const rawLeadTime = p.leadTime ? parseInt(p.leadTime.value) : 7;
      
      const inStockVariants = [];
      const specialOrderVariants = [];

      p.variants.edges.forEach((v: any) => {
          const node = v.node;
          const name = node.title.replace('Default Title', 'Standard');
          if (node.inventoryQuantity > 0) {
              inStockVariants.push(`${name} (Qty: ${node.inventoryQuantity})`);
              totalPhysicalStock += node.inventoryQuantity;
          } else if (node.inventoryPolicy === 'CONTINUE') {
              specialOrderVariants.push(name);
          }
      });

      if (inStockVariants.length > 0) {
          return `• ${p.title} | IN STOCK: ${inStockVariants.join(', ')}`;
      } else if (specialOrderVariants.length > 0) {
          return `• ${p.title} | NO STOCK (Special Order Only: ~${rawLeadTime + STANDARD_SHOP_BUILD_DAYS} days)`;
      } else {
          return `• ${p.title} | Sold Out`;
      }
    });

    const topResults = formattedProducts.slice(0, 5);
    
    return `[DATA START]\n` + 
           topResults.join("\n") + 
           `\n[DATA END]\n\n` + 
           `[SYSTEM COMMAND]: The user is waiting. Summarize these specific ${filteredProducts.length} options. If "NO STOCK", explicitly state "I don't have these in stock right now, but..."`;

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

    // DEBUG CONTEXT
    if (buildContext) console.log("[Context]", JSON.stringify(buildContext));

    const result = await streamText({
      model: google('gemini-flash-latest', {
        safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        ]
      }),
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
            query: z.string().describe("The exact Brand or Model name (e.g. 'Hydra2', 'Hope Pro 5').") 
          }),
          execute: async (args) => {
            console.log("[Tool Debug] Raw Args:", JSON.stringify(args));
            let q = args.query;
            if (!q || typeof q !== 'string') q = Object.values(args).join(" ");
            if (q) q = q.replace(/\b(stock|available|hub|hubs|pair|set|in)\b/gi, '').trim();
            if (!q) q = "undefined";
            
            // PASS CONTEXT TO THE HELPER
            return await lookupProductInfo(String(q), buildContext);
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
      res.write("...");
    }

    res.end();

  } catch (error: any) {
    console.error("AI ROUTE ERROR:", error);
    res.status(500).json({ error: error.message || JSON.stringify(error) });
  }
}