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
const SEARCH_LIMIT = 100;

const SYSTEM_PROMPT = `
You are the **LoamLabs Lead Tech**, an expert AI wheel building assistant.

**YOUR PERSONALITY:**
- Professional, technical, direct, and "down to earth."
- Identity: "LoamLabs Automated Lead Tech".

**PROTOCOL:**
1. **ANALYZE:** Look at the user's query.
2. **GATEKEEPING (MANDATORY):** 
   - If User wants **HUBS**: You MUST know **Position** (Front/Rear) AND **Axle Standard** (e.g. Boost, 148) before searching.
   - If specs are missing, Ask clarifying questions immediately. Do not search yet.
3. **SEARCH:** Use the tool only when you have specific details.
4. **REPORT:** Summarize findings concisely.

**LEAD TIME RULES:** 
- In Stock = "Ready to ship"
- Special Order = Manufacturer Lead Time.

**CONTEXT:**
The user's current selections are injected below.
`;

// Helper: Score products based on relevance
function sortProductsByRelevance(products: any[], query: string) {
  const keywords = query.toLowerCase().split(' ').filter(k => k.length > 2); 
  
  return products.map(p => {
    let score = 0;
    const title = p.title.toLowerCase();
    const tags = p.tags.join(' ').toLowerCase();
    
    if (keywords.includes('rear') && !title.includes('rear')) return { product: p, score: -999 };
    if (keywords.includes('front') && !title.includes('front')) return { product: p, score: -999 };

    if (title.includes(query.toLowerCase())) score += 50;
    keywords.forEach(word => {
      if (title.includes(word)) score += 10;
      if (tags.includes(word)) score += 5;
    });
    if (query.toLowerCase().includes('hub') && !tags.includes('component:hub')) score -= 100;

    return { product: p, score };
  })
  .filter(item => item.score > -100)
  .sort((a, b) => b.score - a.score)
  .map(item => item.product);
}

async function lookupProductInfo(query: string) {
  const cleanQuery = query.replace(/\b(front|rear|hub|hubs|wheel|wheels|set|pair|stock|available|in|and)\b/gi, '').trim();
  console.log(`[Tool] Searching Shopify for Brand: "${cleanQuery}" (Context: "${query}")`);
  
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
            variables: { query: cleanQuery } 
        })
    });

    const data = await adminResponse.json();
    if (!data.data || !data.data.products) return "Search failed.";
    
    let rawProducts = data.data.products.edges.map((e: any) => e.node);
    const sortedProducts = sortProductsByRelevance(rawProducts, query);
    
    if (sortedProducts.length === 0) return `No products found matching "${query}".`;

    const products = sortedProducts.map((p: any) => {
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
          return `• ${p.title} | Special Order (~${rawLeadTime} days)`;
      } else {
          return `• ${p.title} | Sold Out`;
      }
    });

    return products.slice(0, 5).join("\n");

  } catch (error) {
    console.error("Shopify Lookup Error:", error);
    return "Error connecting to database.";
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

    let allToolOutputs = [];
    let toolActionTaken = "none";

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
            query: z.string().describe("The search terms") 
          }),
          execute: async (args) => {
            console.log("[Tool Debug] Raw Args:", JSON.stringify(args));
            
            let q = "";
            if (args.query) q = args.query;
            else if (args.product_name) q = args.product_name;
            else q = Object.values(args).join(" ");
            
            q = String(q).trim();
            const qLower = q.toLowerCase();

            // --- MULTI-STAGE GATEKEEPER ---
            const isHubRequest = qLower.includes("hub");
            
            // Gate 1: Position
            const hasPosition = qLower.includes("front") || qLower.includes("rear") || qLower.includes("pair") || qLower.includes("set");
            const contextPosition = buildContext?.position;

            // Gate 2: Axle Standard (New)
            // Look for common axle terms: 100, 110, 142, 148, 157, Boost, Super, DH
            const hasAxle = qLower.match(/100|110|135|142|148|150|157|boost|super|dh/i);
            const contextAxle = buildContext?.axle_spacing;

            // Logic: If Hub request...
            if (isHubRequest) {
                // 1. Check Position
                if (!hasPosition && !contextPosition) {
                    toolActionTaken = "ask_position";
                    return `[SYSTEM]: Stop. Ask "Front or Rear?".`;
                }
                // 2. Check Axle (Only if position is settled)
                if (!hasAxle && !contextAxle) {
                    console.log("[Tool] Position found, but Axle missing. Blocking Search.");
                    toolActionTaken = "ask_axle";
                    return `[SYSTEM]: Stop. Ask "What axle spacing? (e.g. Boost, 12x148)".`;
                }
            }

            // --- SEARCH ---
            toolActionTaken = "search";
            const info = await lookupProductInfo(q);
            allToolOutputs.push(info);
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

    // --- SAFETY NET ---
    if (!hasSentText) {
      if (toolActionTaken === 'ask_position') {
          res.write("I can check that for you. Are you looking for a Front or Rear hub?");
      } else if (toolActionTaken === 'ask_axle') {
          // New fallback for the second gate
          res.write("Got it. What axle spacing do you need? (e.g. Boost 15x110, 12x148, SuperBoost)");
      } else if (allToolOutputs.length > 0) {
          console.log("AI was silent. Using Clean Safety Net.");
          res.write(`I found the following options:\n\n${allToolOutputs.join("\n\n")}`);
          res.write("\n\nDo any of these match your frame?");
      } else {
          res.write("I'm checking the system... could you specify if you need a Front or Rear hub?");
      }
    }

    res.end();

  } catch (error: any) {
    console.error("AI ROUTE ERROR:", error);
    res.status(500).json({ error: error.message || JSON.stringify(error) });
  }
}