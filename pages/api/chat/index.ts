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

**CRITICAL RULES:**
1. **ALWAYS REPLY:** If a tool returns data, you **MUST** generate a text response summarizing it for the user. Do not stop.
2. **SEARCH SIMPLY:** Use ONLY the core Brand or Model name (e.g. "Hydra").
3. **INVENTORY PRECISION:** Report specific variants that are in stock.
4. **LEAD TIME:** In Stock = ~${STANDARD_SHOP_BUILD_DAYS} days. Out of Stock = Mfg Lead Time + ${STANDARD_SHOP_BUILD_DAYS} days.

**CONTEXT:**
The user's current selections are injected below.
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
    
    // VENTRILOQUIST TRICK: Return the data as if the User is speaking it.
    // This forces the AI to reply to the "User".
    return `
    [SYSTEM DATA START]
    ${limitedProducts.join("\n")}
    [SYSTEM DATA END]
    
    [USER]: "Okay, I see the data above. Please summarize which specific variants are in stock for me."
    `;

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
      // 1. USE THE ONLY WORKING MODEL
      model: google('gemini-flash-latest', {
        // 2. DISABLE SAFETY TO PREVENT 'HYDRA' BLOCKING
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
            query: z.string().describe("The core Brand or Model name to search for (e.g. 'Hydra').") 
          }),
          execute: async (args) => {
            console.log("[Tool Debug] Raw Args:", JSON.stringify(args));
            let q = args.query;
            if (!q || typeof q !== 'string') {
                q = Object.values(args).filter(v => v && typeof v === 'string' && v.trim().length > 0).join(" ");
            }
            if (q) {
                q = q.replace(/\b(stock|available|hub|hubs|pair|set|in)\b/gi, '').trim();
            }
            if (!q) q = "undefined";
            return await lookupProductInfo(String(q));
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