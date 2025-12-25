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

const BASE_SYSTEM_PROMPT = `
You are the **LoamLabs Lead Tech**, an expert AI wheel building assistant.

**YOUR PERSONALITY:**
- Professional, technical, direct, and "down to earth."
- Identity: "LoamLabs Automated Lead Tech".

**CRITICAL STORE POLICIES:**
1. **PRICE IS TRUTH:** If price > $0.00, it is not free.
2. **SCOPE BOUNDARY:** Only discuss products found via tools or context.
3. **INVENTORY REALITY:** Never guess stock. Use 'lookup_product_info'.
   - **Math:** (Mfg Lead Time) + (${STANDARD_SHOP_BUILD_DAYS} days Shop Time) = Total Estimate.

**INTELLIGENT SEARCHING (CRITICAL):**
1. **MAINTAIN CONTEXT:** If the user asks "What do you have in stock?" or "What is faster?", you MUST infer the **Component Type** from the previous conversation.
   - *Bad:* Searching for "in stock fast".
   - *Good:* Searching for "Rear Hub" or "DT Swiss Hub" (if the user was just talking about hubs).
2. **RELEVANCY:** If the user is discussing Hubs, DO NOT recommend Rims or Spokes.
3. **NO REPETITION:** Do not repeat the full specs/lead times of products you *just* listed in your last message. Summarize or move on to new suggestions.

**TECHNICAL CHEAT SHEET:**
- Hydra2 = Industry Nine Hydra.
- Onyx Vesper: Instant engagement, Silent.
- DT Swiss 350: Ratchet, reliable.
- Sapim CX-Ray: Bladed aero.
`;

// 2. SHOPIFY TOOL FUNCTION
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
                products(first: 5, query: $query) {
                  edges {
                    node {
                      title
                      totalInventory
                      leadTime: metafield(namespace: "custom", key: "lead_time_days") { value }
                      variants(first: 5) {
                        edges {
                          node {
                            title
                            inventoryPolicy
                            inventoryQuantity
                            price
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
      const totalLeadTime = rawLeadTime + STANDARD_SHOP_BUILD_DAYS;
      
      // Calculate total stock across variants
      const totalVariantStock = p.variants.edges.reduce((sum: number, v: any) => sum + v.node.inventoryQuantity, 0);
      const isContinue = p.variants.edges.some((v: any) => v.node.inventoryPolicy === 'continue');
      
      let status = "In Stock";
      if (totalVariantStock <= 0) {
          status = isContinue ? `Special Order` : "Sold Out";
      }

      return `Product: ${p.title}
      Status: ${status}
      Total Stock: ${totalVariantStock}
      Mfg Lead Time (metafield: custom.lead_time_days): ${rawLeadTime} days
      Est. Customer Arrival: ~${totalLeadTime} days from order`;
    });

    if (products.length === 0) return "No products found matching that query.";
    return products.join("\n\n----------------\n\n");

  } catch (error) {
    console.error("Shopify Lookup Error:", error);
    return "Error connecting to product database.";
  }
}

// 3. MAIN HANDLER
export default async function handler(req: any, res: any) {
  // CORS
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

    let finalSystemPrompt = BASE_SYSTEM_PROMPT + contextInjection;
    
    if (isAdmin) {
        finalSystemPrompt += `
        
        *** ADMIN DEBUG MODE ACTIVE (User is Staff) ***
        1. If asked about data sources, explicitly state the Metafield Key used (custom.lead_time_days).
        2. If asked "Why did you say that?", explain your reasoning (e.g. "I saw 0 stock and 10 day lead time in the tool output").
        3. You may show raw data snippets if requested.
        `;
    }

    const openAiMessages = [
      { role: 'system', content: finalSystemPrompt },
      ...messages.map((m: any) => ({ role: m.role === 'agent' ? 'assistant' : m.role, content: m.content }))
    ];

    const tools = [
      {
        type: "function",
        function: {
          name: "lookup_product_info",
          description: "Searches the store. IMPORTANT: Include the Component Type in your query (e.g. 'Onyx Hub' or 'Rear Hub') to avoid irrelevant results.",
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
          description: "Calculates spoke lengths.",
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