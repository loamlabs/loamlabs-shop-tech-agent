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
1. **ANALYZE:** Look at the user's query. If they ask for "Front and Rear", you may need to search twice or search broadly.
2. **SEARCH SIMPLY:** Use ONLY the core Brand or Model name (e.g. "Hydra").
3. **REPORT:** Summarize the results clearly.

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
    
    // STRICT FILTER: If the search term isn't in the title/tags, kill it.
    // We check against the first significant keyword (e.g., "Hope")
    if (keywords.length > 0 && !title.includes(keywords[0]) && !tags.includes(keywords[0])) {
        return { product: p, score: -9999 };
    }

    if (title.includes(query.toLowerCase())) score += 50;

    keywords.forEach(word => {
      if (title.includes(word)) score += 10;
      if (tags.includes(word)) score += 5;
    });

    if (query.toLowerCase().includes('hub') && !tags.includes('component:hub')) score -= 100;

    return { product: p, score };
  })
  .filter(item => item.score > -100) // Remove the bad matches
  .sort((a, b) => b.score - a.score)
  .map(item => item.product);
}

async function lookupProductInfo(query: string) {
  // CLEAN THE QUERY: Remove Position/Type words to find the BRAND/MODEL
  // e.g. "Front Hope Hub" -> "Hope"
  const cleanQuery = query.replace(/\b(front|rear|hub|hubs|wheel|wheels|set|pair|stock|available|in)\b/gi, '').trim();
  
  console.log(`[Tool] Searching Shopify for: "${cleanQuery}" (Original: "${query}")`);
  
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
            // Search using the CLEANED query (Brand/Model only)
            variables: { query: cleanQuery } 
        })
    });

    const data = await adminResponse.json();
    
    if (!data.data || !data.data.products) {
        return "Search failed.";
    }
    
    let rawProducts = data.data.products.edges.map((e: any) => e.node);
    console.log(`[Shopify] Broad Search Found: ${rawProducts.length} items`);

    // Sort using the ORIGINAL query (so "Front" sorts to top if asked for)
    // But passing the clean query as the "Strict Keyword" to enforce Brand matching
    const sortedProducts = sortProductsByRelevance(rawProducts, cleanQuery);
    
    if (sortedProducts.length === 0) return "No products found matching that query.";

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

    const topResults = products.slice(0, 5);
    console.log(`[Tool] Returning top 5 sorted results.`);
    
    return topResults.join("\n");

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

    // Global variable to accumulate results from multiple tool calls
    let allToolOutputs = [];

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
            
            // Extract the meaningful query from whatever the AI sent
            let q = args.query;
            if (!q || typeof q !== 'string') q = Object.values(args).join(" ");
            if (!q) q = "undefined";
            
            const info = await lookupProductInfo(String(q));
            
            // APPEND result to global list instead of overwriting
            allToolOutputs.push(`Results for "${q}":\n${info}`);
            
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
        if (part.type !== 'text-delta') console.log("Stream Part:", part.type);

        const textContent = part.textDelta || part.text || part.content || "";
        if (part.type === 'text-delta' && typeof textContent === 'string' && textContent.length > 0) {
            res.write(textContent);
            hasSentText = true;
        }
    }

    if (!hasSentText) {
      if (allToolOutputs.length > 0) {
        console.log("AI was silent. Using Accumulated Safety Net.");
        res.write(allToolOutputs.join("\n\n"));
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