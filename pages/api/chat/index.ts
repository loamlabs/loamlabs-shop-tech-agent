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

const SYSTEM_PROMPT = `
You are the **LoamLabs Lead Tech**, an expert AI wheel building assistant.

**YOUR ROLE:**
- You are a consultant, not a search engine.
- You must understand the build before suggesting parts.

**PROTOCOL:**
1. **GATEKEEPING:** If a user asks for a component (e.g. "Hope hubs") but hasn't specified the **Position** (Front/Rear), you MUST ask for it before searching.
2. **CLARIFY:** If the search results are "Special Order Only", clearly state that.
3. **NO FLUFF:** Keep responses concise and technical.

**CONTEXT:**
The user's current selections are injected below.
`;

// Helper: Score products based on how many query keywords they match
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
    
    // Sort and Filter based on the FULL query (including Front/Rear)
    const sortedProducts = sortProductsByRelevance(rawProducts, query);
    
    if (sortedProducts.length === 0) return "No products found matching that description.";

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

      // REMOVED SHOP BUILD TIME (+5) as requested
      if (inStockVariants.length > 0) {
          return `• ${p.title} | IN STOCK: ${inStockVariants.join(', ')}`;
      } else if (specialOrderVariants.length > 0) {
          return `• ${p.title} | Special Order (Mfg Lead Time: ~${rawLeadTime} days)`;
      } else {
          return `• ${p.title} | Sold Out`;
      }
    });

    const topResults = products.slice(0, 5);
    
    return `[DATA START]\n` + 
           topResults.join("\n") + 
           `\n[DATA END]\n\n` + 
           `[SYSTEM COMMAND]: Summarize these options. Be honest about stock levels.`;

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

    // Variables for the Safety Net
    let capturedToolOutput = "";
    let toolActionTaken = "none"; // 'search', 'ask_clarification', 'none'

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
            
            // --- THE GATEKEEPER LOGIC ---
            let q = args.query.toLowerCase();
            if (!q || q === "undefined") q = Object.values(args).join(" ").toLowerCase();

            // 1. Is it a Hub query?
            const isHubRequest = q.includes("hub");
            // 2. Is Position missing?
            const hasPosition = q.includes("front") || q.includes("rear") || q.includes("pair") || q.includes("set");
            // 3. Is Context missing position?
            const contextPosition = buildContext?.position;

            if (isHubRequest && !hasPosition && !contextPosition) {
                console.log("[Tool] Intercepted Vague Query. Forcing Clarification.");
                toolActionTaken = "ask_clarification";
                return `[SYSTEM INSTRUCTION]: The user asked for "Hubs" but did not specify Front or Rear. STOP. Do not search. Ask the user: "Are you looking for a Front or Rear hub?"`;
            }

            // --- PROCEED TO SEARCH ---
            toolActionTaken = "search";
            const info = await lookupProductInfo(String(args.query));
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

    // --- INTELLIGENT FALLBACK ---
    if (!hasSentText) {
      if (toolActionTaken === 'ask_clarification') {
          // If the AI was told to ask but didn't, WE ask.
          res.write("I can check that for you. Are you looking for a Front or Rear hub?");
      } else if (capturedToolOutput) {
          // If the search ran but AI was silent, show data.
          console.log("AI was silent. Using Data Safety Net.");
          res.write(`I found these items:\n\n${capturedToolOutput.replace(/\[.*?\]/g, '')}`);
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