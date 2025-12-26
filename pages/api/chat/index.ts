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

// Pass 'isAdmin' into the helper to toggle debug info
async function lookupProductInfo(query: string, isAdmin: boolean) {
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
    if (!data.data || !data.data.products) return "Search Error";

    const count = data.data.products.edges.length;
    console.log(`[Shopify] Found ${count} products`);

    if (count === 0) return "No products found matching that name.";

    let totalPhysicalStock = 0;

    const products = data.data.products.edges.map((e: any) => {
      const p = e.node;
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

      // MATH BREAKDOWN FOR ADMINS
      const leadTimeDisplay = isAdmin 
        ? `~${rawLeadTime + STANDARD_SHOP_BUILD_DAYS} days [${rawLeadTime} Mfg + ${STANDARD_SHOP_BUILD_DAYS} Shop]`
        : `~${rawLeadTime + STANDARD_SHOP_BUILD_DAYS} days`;

      if (inStockVariants.length > 0) {
          return `• ${p.title} | IN STOCK: ${inStockVariants.join(', ')}`;
      } else if (specialOrderVariants.length > 0) {
          return `• ${p.title} | NO STOCK (Special Order: ${leadTimeDisplay})`;
      } else {
          return `• ${p.title} | Sold Out`;
      }
    });

    const topResults = products.slice(0, 5);
    
    let output = "";
    if (totalPhysicalStock === 0) {
        output = `SUMMARY: Found ${count} matching products, but ZERO are physically in stock.\n` +
                 `They are available for Special Order.\n\n` +
                 `DETAILS:\n${topResults.join("\n")}`;
    } else {
        output = `SUMMARY: Found ${count} matching products. Some are IN STOCK.\n\n` +
                 `DETAILS:\n${topResults.join("\n")}`;
    }
    
    return output;

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

    // DEBUG: Log the user's build context so we can build filters later
    if (buildContext) {
        console.log("=== USER BUILD CONTEXT ===");
        console.log(JSON.stringify(buildContext, null, 2));
        console.log("==========================");
    }

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

            // Pass isAdmin to helper to show math
            const info = await lookupProductInfo(String(q), isAdmin);
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
      if (capturedToolOutput) {
        console.log("AI was silent. Displaying structured data.");
        res.write(capturedToolOutput);
      } else {
        res.write("I'm checking the shelves... can you try asking that one more time?");
      }
    }

    res.end();

  } catch (error: any) {
    console.error("AI ROUTE ERROR:", error);
    res.status(500).json({ error: error.message || JSON.stringify(error) });
  }
}