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
2. **GATEKEEPING:** If the user asks for "Hubs" generally, ask "Front or Rear?" before searching.
3. **SEARCH:** Use the tool.
4. **REPORT:** 
   - If the tool says "TOO MANY RESULTS", list the few examples provided but **immediately ask** clarifying questions (e.g. "I found 20 options. Do you need Boost or SuperBoost?").
   - If "NO STOCK", be honest.

**LEAD TIME RULES:** 
- In Stock = "Ready to ship"
- Special Order = Manufacturer Lead Time (e.g. "9 days").

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
  // CLEAN THE QUERY
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
    
    // Sort and Filter
    const sortedProducts = sortProductsByRelevance(rawProducts, query);
    
    if (sortedProducts.length === 0) return `No products found matching "${query}".`;

    const totalMatches = sortedProducts.length;

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

    // --- INTELLIGENT RESULT LIMITING ---
    const topResults = products.slice(0, 5);
    
    let systemInstruction = `[SYSTEM COMMAND]: Summarize these options.`;
    
    // If too many results, FORCE the AI to ask clarifying questions
    if (totalMatches > 6) {
        systemInstruction = `[SYSTEM COMMAND]: Found ${totalMatches} items (Too many to list). Show the top 5 below, but then you MUST ask the user to clarify Axle Spacing (e.g. Boost) or Brake Style to narrow the list.`;
    }

    return `[DATA START]\n` + 
           topResults.join("\n") + 
           `\n[DATA END]\n\n` + 
           systemInstruction;

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

    // Global variable to accumulate results from multiple tool calls (Front + Rear)
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
            
            // --- ROBUST ARGUMENT PARSING ---
            // Grab ANY string value from args to avoid "undefined" errors
            let q = "";
            if (args.query) q = args.query;
            else if (args.product_name) q = args.product_name; // Fix for "Hope Front Hub"
            else q = Object.values(args).join(" ");
            
            q = String(q).trim();
            const qLower = q.toLowerCase();

            // --- GATEKEEPER LOGIC ---
            const isHubRequest = qLower.includes("hub");
            const hasPosition = qLower.includes("front") || qLower.includes("rear") || qLower.includes("pair") || qLower.includes("set");
            const contextPosition = buildContext?.position;

            if (isHubRequest && !hasPosition && !contextPosition) {
                console.log("[Tool] Intercepted Vague Query. Forcing Clarification.");
                toolActionTaken = "ask_clarification";
                return `[SYSTEM INSTRUCTION]: The user asked for "Hubs" but did not specify Front or Rear. STOP. Ask: "Are you looking for a Front or Rear hub?"`;
            }

            // --- EXECUTE SEARCH ---
            toolActionTaken = "search";
            const info = await lookupProductInfo(q);
            
            // Append to global list (handles Front + Rear parallel calls)
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
      if (toolActionTaken === 'ask_clarification') {
          res.write("I can check that for you. Are you looking for a Front or Rear hub?");
      } else if (allToolOutputs.length > 0) {
          // Join multiple results (e.g. Front Results + Rear Results)
          const combinedOutput = allToolOutputs.join("\n\n---\n\n").replace(/\[.*?\]/g, '');
          console.log("AI was silent. Using Accumulated Safety Net.");
          res.write(`I found these items:\n\n${combinedOutput}`);
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