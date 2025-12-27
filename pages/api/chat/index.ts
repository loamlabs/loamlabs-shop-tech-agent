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

const SEARCH_LIMIT = 100;

// --- KNOWLEDGE BASE ---
// This allows the code to "understand" axles without asking the AI
const AXLE_MAP = {
  front: ['15x110', '15x100', '12x100', '20x110', '110x15', '100x15', '100x12', 'boost front'],
  rear: ['12x148', '12x157', '12x142', '12x150', '135', '148', '157', '150', '142', 'superboost', 'boost rear']
};

const SYSTEM_PROMPT = `
You are the **LoamLabs Lead Tech**, an expert AI wheel building assistant.

**YOUR PERSONA:**
- Professional, technical, direct.
- **NO SIGN-OFFS:** Do not end messages with your name. Just stop talking.

**PROTOCOL:**
1. **ANALYZE:** Look at the user's query.
2. **GATEKEEPING:** If "Hubs" are requested without Position or Axle, ask "Front or Rear?" immediately.
3. **SEARCH:** Use the tool.
4. **REPORT:** List the items found concisely.

**LEAD TIME RULES:** 
- In Stock = "Ready to ship"
- Special Order = Manufacturer Lead Time.

**CONTEXT:**
The user's current selections are injected below.
`;

// Helper: Infer Position from Axle String
function inferPositionFromQuery(query: string) {
  const q = query.toLowerCase();
  for (const token of AXLE_MAP.front) {
    if (q.includes(token)) return 'Front';
  }
  for (const token of AXLE_MAP.rear) {
    if (q.includes(token)) return 'Rear';
  }
  return null; // Could not infer
}

// Helper: Score products based on relevance
function sortProductsByRelevance(products: any[], query: string) {
  const keywords = query.toLowerCase().split(' ').filter(k => k.length > 2); 
  
  return products.map(p => {
    let score = 0;
    const title = p.title.toLowerCase();
    const tags = p.tags.join(' ').toLowerCase();
    
    // Strict Filter: If keyword is "Rear", title MUST have "Rear"
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
  // CLEAN THE QUERY (Keep numbers/axles, remove filler words)
  const cleanQuery = query.replace(/\b(front|rear|hub|hubs|wheel|wheels|set|pair|stock|available|in|and|have|do|you)\b/gi, '').trim();
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
            variables: { query: cleanQuery.split(' ')[0] } // Search broad, filter local
        })
    });

    const data = await adminResponse.json();
    if (!data.data || !data.data.products) return "Search failed.";
    
    let rawProducts = data.data.products.edges.map((e: any) => e.node);
    
    // Sort using the FULL original query to capture "Front/Rear" nuances
    const sortedProducts = sortProductsByRelevance(rawProducts, query);
    
    if (sortedProducts.length === 0) return `No products found matching "${cleanQuery}".`;

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

    let capturedToolOutput = "";
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

            // --- SMART GATEKEEPER ---
            const isHubRequest = qLower.includes("hub");
            const hasPosition = qLower.includes("front") || qLower.includes("rear") || qLower.includes("pair") || qLower.includes("set");
            const contextPosition = buildContext?.position;
            
            // Check for Axle Specs in the query (Inference)
            const inferredPosition = inferPositionFromQuery(qLower);

            // If user said "15x110", we KNOW it's front. Don't block.
            if (isHubRequest && !hasPosition && !contextPosition && !inferredPosition) {
                console.log("[Tool] Intercepted Vague Query.");
                toolActionTaken = "ask_clarification";
                return `[SYSTEM INSTRUCTION]: Stop. Ask "Front or Rear?".`;
            }

            // If we inferred position from axle, append it to the search
            if (inferredPosition && !hasPosition) {
                console.log(`[Tool] Inferred Position: ${inferredPosition} from axle.`);
                q += ` ${inferredPosition}`;
            }

            toolActionTaken = "search";
            const info = await lookupProductInfo(q);
            capturedToolOutput = info;
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
      if (toolActionTaken === 'ask_clarification') {
          res.write("I can check that for you. Are you looking for a Front or Rear hub?");
      } else if (capturedToolOutput) {
          console.log("AI was silent. Using Clean Safety Net.");
          res.write(`I found the following options:\n\n${capturedToolOutput}`);
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