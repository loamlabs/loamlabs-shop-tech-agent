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

const SEARCH_LIMIT = 50; // Fetch more items so we can sort/filter them locally

const SYSTEM_PROMPT = `
You are the **LoamLabs Lead Tech**, an expert AI wheel building assistant.

**YOUR PERSONALITY:**
- Professional, technical, direct, and "down to earth."
- Identity: "LoamLabs Automated Lead Tech".

**CRITICAL RULES:**
1. **ALWAYS REPLY:** If a tool returns data, you **MUST** generate a text response summarizing it for the user. Do not stop.
2. **SEARCH SMART:** If the user gives specs (e.g., "Hope 148"), include those specs in your tool query.
3. **INVENTORY PRECISION:** Report specific variants that are in stock.
4. **LEAD TIME:** 
   - In Stock = "Ready to ship/build"
   - Special Order = Manufacturer Lead Time (e.g., "9 days"). (Do NOT add shop build time).

**CONTEXT:**
The user's current selections are injected below.
`;

// Helper: Score products based on how many query keywords they match
function sortProductsByRelevance(products: any[], query: string) {
  const keywords = query.toLowerCase().split(' ').filter(k => k.length > 2); // Ignore small words
  
  return products.map(p => {
    let score = 0;
    const title = p.title.toLowerCase();
    const tags = p.tags.join(' ').toLowerCase();
    
    // Exact Phrase Match Bonus
    if (title.includes(query.toLowerCase())) score += 20;

    // Keyword Match Points
    keywords.forEach(word => {
      if (title.includes(word)) score += 5;
      if (tags.includes(word)) score += 2;
    });

    // Penalize Pre-Built Wheels if looking for Hubs
    if (query.toLowerCase().includes('hub') && !tags.includes('component:hub')) score -= 50;

    return { product: p, score };
  })
  .sort((a, b) => b.score - a.score) // Sort High to Low
  .map(item => item.product);
}

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
            variables: { query: query.split(" ")[0] } // Search Broad (Brand only) first, then filter locally
        })
    });

    const data = await adminResponse.json();
    
    if (!data.data || !data.data.products) {
        return "Search failed. The store database returned an error.";
    }
    
    let rawProducts = data.data.products.edges.map((e: any) => e.node);
    console.log(`[Shopify] Broad Search Found: ${rawProducts.length} items`);

    // --- APPLY INTELLIGENT SORTING ---
    // This moves "Rear" or "148" items to the top if the user asked for them
    const sortedProducts = sortProductsByRelevance(rawProducts, query);
    
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
          // REMOVED THE +5 DAYS
          return `• ${p.title} | Special Order (~${rawLeadTime} days)`;
      } else {
          return `• ${p.title} | Sold Out`;
      }
    });

    const topResults = products.slice(0, 5);
    console.log(`[Tool] Returning top 5 sorted results.`);
    
    return `[DATA START]\n` + 
           topResults.join("\n") + 
           `\n[DATA END]\n\n` + 
           `[SYSTEM COMMAND]: Summarize the stock status of these specific items for the user.`;

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
            query: z.string().describe("The search terms (Brand + Spec)") 
          }),
          execute: async (args) => {
            console.log("[Tool Debug] Raw Args:", JSON.stringify(args));
            let q = args.query;
            if (!q || typeof q !== 'string') q = Object.values(args).join(" ");
            if (q) q = q.replace(/\b(stock|available|pair|set|in)\b/gi, '').trim(); // Keep 'hub' for scoring
            if (!q) q = "undefined";
            
            const info = await lookupProductInfo(String(q));
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
        // VERBOSE LOGGING RESTORED
        if (part.type !== 'text-delta') console.log("Stream Part:", part.type);

        const textContent = part.textDelta || part.text || part.content || "";
        if (part.type === 'text-delta' && typeof textContent === 'string' && textContent.length > 0) {
            res.write(textContent);
            hasSentText = true;
        }
    }

    if (!hasSentText) {
      if (capturedToolOutput) {
        console.log("AI was silent. Using Safety Net with Sorted Results.");
        res.write(capturedToolOutput.replace(/\[.*?\]/g, '')); // Clean system tags
      } else {
        res.write("I'm having trouble connecting to the inventory system. Please try again.");
      }
    }

    res.end();

  } catch (error: any) {
    console.error("AI ROUTE ERROR:", error);
    res.status(500).json({ error: error.message || JSON.stringify(error) });
  }
}