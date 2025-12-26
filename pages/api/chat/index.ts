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
const SEARCH_LIMIT = 100; // Increased to ensure we capture Front AND Rear variants

const SYSTEM_PROMPT = `
You are the **LoamLabs Lead Tech**, an expert AI wheel building assistant.

**YOUR PERSONALITY:**
- Professional, technical, direct, and "down to earth."
- Identity: "LoamLabs Automated Lead Tech".

**PROTOCOL:**
1. **ANALYZE:** Look at the user's query. Is it vague? (e.g. "Do you have Hope hubs?").
2. **ASK:** If the user did NOT specify "Front" or "Rear", you MUST ask them to clarify before searching.
   - *Example:* "I can check that. Are you looking for a Front or Rear hub?"
3. **SEARCH:** Once you have the Position (Front/Rear), use the tool.
4. **REPORT:** Summarize the results clearly.

**LEAD TIME RULES:** 
- In Stock = "Ready to ship"
- Special Order = Manufacturer Lead Time (e.g. "9 days").

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
    
    // Exact Phrase Match Bonus
    if (title.includes(query.toLowerCase())) score += 50;

    // Keyword Match Points
    keywords.forEach(word => {
      if (title.includes(word)) score += 10;
      if (tags.includes(word)) score += 5;
    });

    // Penalize Pre-Built Wheels if looking for Hubs
    if (query.toLowerCase().includes('hub') && !tags.includes('component:hub')) score -= 100;

    return { product: p, score };
  })
  .sort((a, b) => b.score - a.score) // Sort High to Low
  .map(item => item.product);
}

async function lookupProductInfo(query: string) {
  console.log(`[Tool] Searching Shopify for: "${query}"`);
  try {
    // 1. BROAD FETCH
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
            // Search only the first word (e.g. "Hope") to get maximum candidates, then filter locally
            variables: { query: query.split(" ")[0] } 
        })
    });

    const data = await adminResponse.json();
    
    if (!data.data || !data.data.products) {
        return { 
            cleanOutput: "Search failed. Store database error.", 
            aiPayload: "System Error: Shopify API failed." 
        };
    }
    
    let rawProducts = data.data.products.edges.map((e: any) => e.node);
    console.log(`[Shopify] Broad Search Found: ${rawProducts.length} items`);

    // 2. INTELLIGENT SORT & FILTER
    const sortedProducts = sortProductsByRelevance(rawProducts, query);
    
    if (sortedProducts.length === 0) {
        return {
            cleanOutput: "No products found matching that query.",
            aiPayload: "Tool Result: 0 matches found."
        };
    }

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

    const topResults = products.slice(0, 5); // Still limit output for readability
    console.log(`[Tool] Returning top 5 sorted results.`);
    
    const cleanOutput = topResults.join("\n");
    
    return {
        cleanOutput: cleanOutput,
        aiPayload: `[DATA START]\n${cleanOutput}\n[DATA END]\n\n[SYSTEM COMMAND]: The user is waiting. Summarize these specific items for the user.`
    };

  } catch (error) {
    console.error("Shopify Lookup Error:", error);
    return { cleanOutput: "Error connecting to database.", aiPayload: "Error." };
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

    // Store the CLEAN output here for fallback
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
            query: z.string().describe("The search terms (Brand + Spec)") 
          }),
          execute: async (args) => {
            console.log("[Tool Debug] Raw Args:", JSON.stringify(args));
            let q = args.query;
            if (!q || typeof q !== 'string') q = Object.values(args).join(" ");
            if (q) q = q.replace(/\b(stock|available|pair|set|in)\b/gi, '').trim(); 
            if (!q) q = "undefined";
            
            const resultObj = await lookupProductInfo(String(q));
            
            // Capture the CLEAN text for the fallback
            capturedToolOutput = resultObj.cleanOutput; 
            
            // Return the INSTRUCTIVE text to the AI
            return resultObj.aiPayload;
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
        if (part.type !== 'text-delta') console.log("Stream Part:", part.type);

        const textContent = part.textDelta || part.text || part.content || "";
        if (part.type === 'text-delta' && typeof textContent === 'string' && textContent.length > 0) {
            res.write(textContent);
            hasSentText = true;
        }
    }

    // CLEAN SAFETY NET
    if (!hasSentText) {
      if (capturedToolOutput) {
        console.log("AI was silent. Using Clean Safety Net.");
        res.write(`I found these items:\n\n${capturedToolOutput}`);
      } else {
        res.write("I need a bit more detail. Are you looking for Front or Rear hubs?");
      }
    }

    res.end();

  } catch (error: any) {
    console.error("AI ROUTE ERROR:", error);
    res.status(500).json({ error: error.message || JSON.stringify(error) });
  }
}