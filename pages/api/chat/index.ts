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

**INTELLIGENT WORKFLOW:**
1. **CHECK CONTEXT:** Look at the user's builder selections below.
2. **ASK FIRST:** If the user asks a vague question like "Do you have Hope hubs?", and the context is empty (no axle or position selected), **DO NOT SEARCH YET.** Instead, ask: "Are you looking for Front or Rear? What axle standard do you need (e.g. Boost)?"
3. **SEARCH SECOND:** Only call the 'lookup_product_info' tool once you have enough detail to give a useful answer.

**SEARCH RULES:**
1. **SEARCH SIMPLY:** Use ONLY the core Brand or Model name (e.g. "Hydra").
2. **ALWAYS REPLY:** If a tool returns data, you **MUST** generate a text response summarizing it for the user. Do not stop.
3. **INVENTORY PRECISION:** Report specific variants that are in stock.

**CONTEXT:**
The user's current selections are injected below.
`;

// Helper to filter results based on Build Context AND Query
function filterProductsByContext(products: any[], context: any, query: string) {
  return products.filter(p => {
    const title = p.title.toLowerCase();
    const tags = p.tags.map((t: string) => t.toLowerCase());
    const queryLower = query.toLowerCase();

    // 1. COMPONENT TYPE FILTER
    if (queryLower.includes('hub') && !tags.includes('component:hub')) return false;
    if (queryLower.includes('rim') && !tags.includes('component:rim')) return false;

    // 2. POSITION FILTER (Smart Override)
    // Only apply context filter if query DOES NOT explicitly ask for the opposite
    if (context?.position) {
        const pos = context.position.toLowerCase();
        // If context is Rear, filter out Front... UNLESS user asked for "Front"
        if (pos.includes('rear') && title.includes('front') && !queryLower.includes('front')) return false;
        // If context is Front, filter out Rear... UNLESS user asked for "Rear"
        if (pos.includes('front') && title.includes('rear') && !title.includes('front/rear') && !queryLower.includes('rear')) return false;
    }

    // 3. AXLE STANDARD FILTER
    if (context?.axle_spacing) {
        const axle = context.axle_spacing;
        if (axle.includes('157') && !title.includes('157')) return false;
        if (axle.includes('148') && !title.includes('148')) return false;
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
    
    if (!data.data || !data.data.products) return "Search failed.";
    
    let rawProducts = data.data.products.edges.map((e: any) => e.node);
    const filteredProducts = filterProductsByContext(rawProducts, context, query);

    if (filteredProducts.length === 0) return "No matching products found for your specific build requirements.";

    const formattedProducts = filteredProducts.map((p: any) => {
      const rawLeadTime = p.leadTime ? parseInt(p.leadTime.value) : 7;
      const inStockVariants = [];
      const specialOrderVariants = [];

      p.variants.edges.forEach((v: any) => {
          const node = v.node;
          const name = node.title.replace('Default Title', 'Standard');
          if (node.inventoryQuantity > 0) {
              inStockVariants.push(`${name} (Qty: ${node.inventoryQuantity})`);
          } else if (node.inventoryPolicy === 'CONTINUE') {
              specialOrderVariants.push(name);
          }
      });

      if (inStockVariants.length > 0) {
          return `• ${p.title} | IN STOCK: ${inStockVariants.join(', ')}`;
      } else if (specialOrderVariants.length > 0) {
          return `• ${p.title} | Special Order (~${rawLeadTime + STANDARD_SHOP_BUILD_DAYS} days)`;
      } else {
          return `• ${p.title} | Sold Out`;
      }
    });

    return formattedProducts.slice(0, 5).join("\n");

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

    let capturedToolOutput = "";

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
          description: 'Searches the store inventory.',
          parameters: z.object({ 
            query: z.string().describe("Brand or Model name") 
          }),
          execute: async (args) => {
            console.log("[Tool Debug] Raw Args:", JSON.stringify(args));
            let q = args.query;
            if (!q || typeof q !== 'string') q = Object.values(args).join(" ");
            if (q) q = q.replace(/\b(stock|available|hub|hubs|pair|set|in)\b/gi, '').trim();
            if (!q) q = "undefined";
            
            const info = await lookupProductInfo(String(q), buildContext);
            capturedToolOutput = info; // Save for safety net
            return info;
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
      if (capturedToolOutput) {
        console.log("AI was silent. Using Safety Net.");
        res.write(`I found the following items:\n\n${capturedToolOutput}`);
      } else {
        res.write("I'm checking, but I need a bit more detail. Are you looking for Front or Rear?");
      }
    }

    res.end();

  } catch (error: any) {
    console.error("AI ROUTE ERROR:", error);
    res.status(500).json({ error: error.message || JSON.stringify(error) });
  }
}