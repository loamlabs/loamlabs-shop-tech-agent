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

**GUIDANCE:**
1. **Search Simply:** Use core brand/model names (e.g. "Hydra", "Hope").
2. **Be Helpful:** If you find products, list the in-stock options clearly.
3. **Don't Give Up:** If you find products, YOU MUST TELL THE USER about them.
`;

// Helper to format the list cleanly
function formatProductList(products) {
  if (products.length === 0) return "No matching products found.";
  return products.join("\n");
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

    // --- SAFETY NET VARIABLE ---
    // We will store the search results here. If the AI is silent, we print this.
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
            query: z.string().describe("Brand or Model name (e.g. 'Hydra')") 
          }),
          execute: async (args) => {
            console.log("[Tool Debug] Raw Args:", JSON.stringify(args));
            
            // Clean Query
            let q = args.query;
            if (!q || typeof q !== 'string') q = Object.values(args).join(" ");
            if (q) q = q.replace(/\b(stock|available|hub|hubs|pair|set|in)\b/gi, '').trim();
            if (!q) q = "undefined";

            console.log(`[Tool] Searching Shopify for: "${q}"`);

            // --- SHOPIFY FETCH ---
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
                    variables: { query: q }
                })
            });

            const data = await adminResponse.json();
            if (!data.data || !data.data.products) return "Search Error";

            const count = data.data.products.edges.length;
            console.log(`[Shopify] Found ${count} products`);

            const products = data.data.products.edges.map((e: any) => {
              const p = e.node;
              const inStockVariants = [];
              p.variants.edges.forEach((v: any) => {
                  const node = v.node;
                  const name = node.title.replace('Default Title', 'Standard');
                  if (node.inventoryQuantity > 0 || node.inventoryPolicy === 'CONTINUE') {
                      const qtyMsg = node.inventoryQuantity > 0 ? `Qty: ${node.inventoryQuantity}` : "Made to Order";
                      inStockVariants.push(`${name} (${qtyMsg})`);
                  }
              });
              let stockSummary = "Special Order Only";
              if (inStockVariants.length > 0) stockSummary = `In Stock: ${inStockVariants.join(', ')}`;
              return `• ${p.title} | ${stockSummary}`;
            });

            const top5 = products.slice(0, 5);
            
            // --- CAPTURE FOR FALLBACK ---
            capturedToolOutput = `I found ${count} matching items. Here are the top results:\n\n${top5.join("\n")}`;
            
            return capturedToolOutput;
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

    // --- THE SAFETY NET ---
    // If the AI stayed silent, BUT we have search results, send them directly.
    if (!hasSentText) {
      if (capturedToolOutput) {
        console.log("AI was silent. Sending captured tool output as fallback.");
        res.write(capturedToolOutput);
      } else {
        console.log("AI was silent and no tool output. Sending generic fallback.");
        res.write("I searched for that, but I'm having trouble retrieving the list right now. Please try again.");
      }
    }

    res.end();

  } catch (error: any) {
    console.error("AI ROUTE ERROR:", error);
    res.status(500).json({ error: error.message || JSON.stringify(error) });
  }
}