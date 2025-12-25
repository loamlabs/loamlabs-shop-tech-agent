// @ts-nocheck
import OpenAI from 'openai';

// 1. CONFIGURATION
export const config = {
  api: {
    bodyParser: true,
  },
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const STANDARD_SHOP_BUILD_DAYS = 5; // LoamLabs internal build buffer

const SYSTEM_PROMPT = `
You are the **LoamLabs Lead Tech**, an expert AI wheel building assistant.
You are speaking to a customer in the Custom Wheel Builder.

**YOUR PERSONALITY:**
- Professional, technical, direct, and "down to earth."
- You value durability and engineering over marketing hype.
- You speak like a veteran mechanic.
- You are helpful but honest. If a build looks unbalanced (e.g., DH rims on XC hubs), you politely warn them.
- **Identity:** If asked for your name, state that you are the "LoamLabs Automated Lead Tech." Do not pretend to be a specific human.

**CRITICAL STORE POLICIES (PRIME DIRECTIVES):**
1. **PRICE IS TRUTH:** You have access to the live build state. If a component (like a Valve Stem) has a price > $0.00 in the system, it is NOT free. Never tell a customer an item is included unless the price is explicitly $0.00.
2. **NO ASSUMPTIONS:** Do not assume manufacturer policies (like "Reserve includes valves") apply here. LoamLabs custom builds are a la carte.
3. **SCOPE BOUNDARY:** Only discuss products currently available in the builder context provided to you. If a user asks about a brand we don't carry (e.g., "Zipp"), say: "We don't stock those currently. I recommend Reserve or other relevant brands we carry for similar performance."
4. **INVENTORY REALITY:** Do not guess stock. If asked "Is this in stock?", use the 'lookup_product_info' tool. 
   - **Search Logic:** If a user asks for "Hydra2", search for "Industry Nine Hydra" or just "Hydra".
   - **Lead Time Math:** (Manufacturer Lead Time from tool) + (${STANDARD_SHOP_BUILD_DAYS} days Shop Time) = Total Estimate.
   - *Example:* "That hub is special order. Industry Nine takes about 10 days to ship it to us, plus our 5 day build time, so you're looking at about 3 weeks total."

**TECHNICAL CHEAT SHEET (World Knowledge Override):**
- Industry Nine Hydra: 690 POE (0.52°), High buzz, Aluminum spokes available.
- Onyx Vesper: Instant engagement (Sprag Clutch), Silent, slightly heavier but rolls fast.
- DT Swiss 350: 36t Ratchet (10°) standard, reliable, easy service.
- Sapim CX-Ray: Bladed aero, high fatigue life.
- Sapim Race: Double butted (2.0/1.8/2.0), robust, value.
- Berd Spokes: Polyethylene (fabric), ultra-light, high damping, requires specific prep.

**CONTEXT:**
The user's current build configuration (Rims, Hubs, Specs, Prices, Lead Times) is injected into your first message. Use this data to answer specific questions.
`;
`;

// 2. SHOPIFY TOOL FUNCTION (Server-Side)
async function lookupProductInfo(query: string) {
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
                products(first: 3, query: $query) {
                  edges {
                    node {
                      title
                      totalInventory
                      leadTime: metafield(namespace: "custom", key: "lead_time_days") { value }
                      variants(first: 3) {
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
    
    if (!data.data || !data.data.products) {
        return "Search failed or returned no data.";
    }

    const products = data.data.products.edges.map((e: any) => {
      const p = e.node;
      // Get Lead Time (Default to 0 if missing)
      const rawLeadTime = p.leadTime ? parseInt(p.leadTime.value) : 0;
      const totalLeadTime = rawLeadTime + STANDARD_SHOP_BUILD_DAYS;
      
      const variant = p.variants.edges[0]?.node;
      const stock = variant ? variant.inventoryQuantity : 0;
      const policy = variant ? variant.inventoryPolicy : 'deny';
      
      let status = "In Stock";
      if (stock <= 0) {
          status = policy === 'continue' 
            ? `Special Order (Mfg Lead Time: ${rawLeadTime} days + ${STANDARD_SHOP_BUILD_DAYS} days build = ~${totalLeadTime} days total)` 
            : "Sold Out";
      } else {
          status = `In Stock (Ships in ~${STANDARD_SHOP_BUILD_DAYS} days)`;
      }

      return `Product: ${p.title}\nStatus: ${status}\nStock Level: ${stock}\nMetadata Lead Time: ${rawLeadTime} days`;
    });

    if (products.length === 0) return "No products found matching that name.";
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
    const { messages, buildContext } = req.body;

    const contextInjection = `
      [CURRENT USER SELECTIONS]:
      ${JSON.stringify(buildContext?.components || {})}
    `;

    // 1. Prepare Messages
    const openAiMessages = [
      { role: 'system', content: SYSTEM_PROMPT + contextInjection },
      ...messages.map((m: any) => ({ 
        role: m.role === 'agent' ? 'assistant' : m.role, 
        content: m.content 
      }))
    ];

    // 2. Define Tools Schema
    const tools = [
      {
        type: "function",
        function: {
          name: "lookup_product_info",
          description: "Searches the store for a product. Use broad terms if specific ones fail (e.g. 'Hydra' instead of 'Hydra2').",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Product name to search." },
            },
            required: ["query"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "calculate_spoke_lengths",
          description: "Calculates precise spoke lengths using the internal engine.",
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

    // 3. First Call to OpenAI
    const firstResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: openAiMessages,
      tools: tools,
      tool_choice: "auto",
    });

    const responseMessage = firstResponse.choices[0].message;
    const toolCalls = responseMessage.tool_calls;

    // 4. Handle Tool Calls
    if (toolCalls) {
      openAiMessages.push(responseMessage);

      for (const toolCall of toolCalls) {
        const fnName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
        let functionResponse = "Error executing tool.";

        if (fnName === "lookup_product_info") {
          functionResponse = await lookupProductInfo(args.query);
        } 
        else if (fnName === "calculate_spoke_lengths") {
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
            functionResponse = `Calculated Lengths: Left ${calcData.left}mm, Right ${calcData.right}mm.`;
          } catch (e) {
            functionResponse = "Error connecting to spoke calculator service.";
          }
        }

        openAiMessages.push({
          tool_call_id: toolCall.id,
          role: "tool",
          name: fnName,
          content: functionResponse,
        });
      }
    }

    // 5. Final Streaming Response
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