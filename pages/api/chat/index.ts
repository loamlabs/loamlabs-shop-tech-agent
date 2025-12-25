// @ts-nocheck
import OpenAI from 'openai';
import { z } from 'zod';

export const config = {
  api: {
    bodyParser: true,
  },
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const STANDARD_SHOP_BUILD_DAYS = 5;

const SYSTEM_PROMPT = `
You are the **LoamLabs Lead Tech**, an expert AI wheel building assistant.

**YOUR PERSONALITY:**
- Professional, technical, direct, and "down to earth."
- Identity: "LoamLabs Automated Lead Tech".

**CRITICAL BEHAVIOR RULES:**
1. **PROACTIVITY:** If a user asks "What else do you have?", **DO NOT GUESS.**
   - First, check if you know their **Axle Spacing** (e.g. 15x110) and **Brake Style** (e.g. 6-Bolt).
   - If you don't know, **ASK THEM FIRST**. (e.g., "To check stock accurately, do you need Boost (15x110) or Standard (12x100) spacing?").
   - Only run the search *after* you know what fits their bike.

2. **INVENTORY PRECISION:** 
   - The search tool returns a list of *specific variants* that are in stock.
   - Do NOT say "DT Swiss 180 is out of stock" just because *some* are out.
   - Look closely at the tool output. If it says "IN STOCK VARIANTS: 12x100", tell the user: "I have the 12x100 version in stock, but the 15x110 is special order."

3. **LEAD TIME MATH:**
   - **In Stock Items:** ~${STANDARD_SHOP_BUILD_DAYS} business days to build.
   - **Out of Stock:** (Mfg Lead Time from Tool) + (${STANDARD_SHOP_BUILD_DAYS} days Shop Time).

**SEARCHING:** 
- If specific search fails (e.g. "Hydra2"), try broad terms like "Industry Nine" or "DT Swiss".
`;

// 2. SHOPIFY TOOL FUNCTION (Advanced Variant Analysis)
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
                products(first: 15, query: $query) {
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
                            price
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
    if (!data.data || !data.data.products) return "Search failed or returned no data.";

    const products = data.data.products.edges.map((e: any) => {
      const p = e.node;
      const rawLeadTime = p.leadTime ? parseInt(p.leadTime.value) : 0;
      
      // Analyze Variants
      const inStockVariants: string[] = [];
      const outOfStockVariants: string[] = [];
      
      p.variants.edges.forEach((v: any) => {
          const node = v.node;
          // Get useful specs from title or options
          const name = node.title.replace('Default Title', 'Standard');
          
          if (node.inventoryQuantity > 0) {
              inStockVariants.push(`${name} (Qty: ${node.inventoryQuantity})`);
          } else if (node.inventoryPolicy === 'continue') {
              outOfStockVariants.push(name);
          }
      });

      let stockSummary = "";
      if (inStockVariants.length > 0) {
          stockSummary = `> IN STOCK VARIANTS: ${inStockVariants.join(', ')}`;
      } else {
          stockSummary = "> ALL VARIANTS OUT OF STOCK (Special Order Only)";
      }

      return `PRODUCT: ${p.title}
      Mfg Lead Time: ${rawLeadTime} days
      ${stockSummary}`;
    });

    if (products.length === 0) return "No products found matching that query.";
    return products.join("\n\n");

  } catch (error) {
    console.error("Shopify Lookup Error:", error);
    return "Error connecting to product database.";
  }
}

// 3. MAIN HANDLER
export default async function handler(req: any, res: any) {
  // CORS Headers
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

    const contextInjection = `
      [CURRENT USER SELECTIONS]:
      ${JSON.stringify(buildContext?.components || {})}
    `;

    let finalSystemPrompt = SYSTEM_PROMPT + contextInjection;

    if (isAdmin) {
        finalSystemPrompt += `\n\n**ADMIN DEBUG MODE:** Show raw data if asked.`;
    }

    const openAiMessages = [
      { role: 'system', content: finalSystemPrompt },
      ...messages.map((m: any) => ({ 
        role: m.role === 'agent' ? 'assistant' : m.role, 
        content: m.content 
      }))
    ];

    const tools = [
      {
        type: "function",
        function: {
          name: "lookup_product_info",
          description: "Searches the store. Query should be the Product Name or Category (e.g. 'DT Swiss Hubs', 'Rear Hub').",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "calculate_spoke_lengths",
          description: "Calculates precise spoke lengths.",
          parameters: {
            type: "object",
            properties: {
              erd: { type: "number" },
              pcdLeft: { type: "number" },
              pcdRight: { type: "number" },
              flangeLeft: { type: "number" },
              flangeRight: { type: "number" },
              spokeCount: { type: "number" },
              crossPattern: { type: "number" },
            },
            required: ["erd", "pcdLeft", "pcdRight", "flangeLeft", "flangeRight", "spokeCount", "crossPattern"]
          }
        }
      }
    ];

    const firstResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: openAiMessages,
      tools: tools,
      tool_choice: "auto",
    });

    const responseMessage = firstResponse.choices[0].message;
    const toolCalls = responseMessage.tool_calls;

    if (toolCalls) {
      openAiMessages.push(responseMessage);

      for (const toolCall of toolCalls) {
        const fnName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
        let functionResponse = "Error";

        if (fnName === "lookup_product_info") {
          functionResponse = await lookupProductInfo(args.query);
        } else if (fnName === "calculate_spoke_lengths") {
           try {
            const apiRes = await fetch(process.env.SPOKE_CALC_API_URL || '', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-internal-secret': process.env.SPOKE_CALC_API_SECRET || '',
              },
              body: JSON.stringify(args),
            });
            const calcData = await apiRes.json();
            functionResponse = `Calculated: Left ${calcData.left}mm, Right ${calcData.right}mm`;
           } catch(e) { functionResponse = "Calc Error"; }
        }

        openAiMessages.push({
          tool_call_id: toolCall.id,
          role: "tool",
          name: fnName,
          content: functionResponse,
        });
      }
    }

    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      'Connection': 'keep-alive'
    });

    const stream = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: openAiMessages,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) res.write(content);
    }

    res.end();

  } catch (error: any) {
    console.error("AI ROUTE ERROR:", error);
    res.status(500).json({ error: error.message });
  }
}