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

const SEARCH_LIMIT = 100; // Need a large pool to filter correctly

const SYSTEM_PROMPT = `
You are the **LoamLabs Lead Tech**, an expert AI wheel building assistant.

**YOUR PERSONALITY:**
- Professional, technical, direct, and "down to earth."
- Identity: "LoamLabs Automated Lead Tech".

**PROTOCOL:**
1. **ANALYZE:** Look at the user's query.
2. **SEARCH:** Use the tool to check stock.
3. **REPORT:** Summarize the results. If you found both Front and Rear options, mention both.

**LEAD TIME RULES:** 
- In Stock = "Ready to ship"
- Special Order = Manufacturer Lead Time (e.g. "9 days").

**CONTEXT:**
The user's current selections are injected below.
`;

async function lookupProductInfo(query: string, rawOriginalQuery: string) {
  // 1. DETECT INTENT
  const lowerQ = rawOriginalQuery.toLowerCase();
  const wantsFront = lowerQ.includes('front');
  const wantsRear = lowerQ.includes('rear');
  const wantsHub = lowerQ.includes('hub');
  
  // Default to "Both" if neither is specified
  const showFront = wantsFront || !wantsRear;
  const showRear = wantsRear || !wantsFront;

  // 2. CLEAN QUERY (Strip Position words to find the Brand)
  const cleanQuery = query.replace(/\b(front|rear|hub|hubs|wheel|wheels|set|pair|stock|available|in|and)\b/gi, '').trim();
  
  console.log(`[Tool] Searching for Brand/Model: "${cleanQuery}" (Intent: F=${showFront}, R=${showRear})`);
  
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
    
    // 3. STRICT FILTERING
    const filtered = rawProducts.filter((p: any) => {
        const title = p.title.toLowerCase();
        const tags = p.tags.map(t => t.toLowerCase());

        // A. Wheelset Filter: If user wants "Hub", discard non-hubs
        if (wantsHub && !tags.includes('component:hub')) return false;

        // B. Brand Match: Title must contain the search term (e.g. "Hope")
        if (!title.includes(cleanQuery.toLowerCase())) return false;

        return true;
    });

    // 4. SEPARATE INTO BUCKETS
    const frontItems = filtered.filter(p => p.title.toLowerCase().includes('front'));
    const rearItems = filtered.filter(p => p.title.toLowerCase().includes('rear'));

    // 5. BUILD THE RESULT LIST
    let finalSelection = [];

    if (showFront) finalSelection.push(...frontItems.slice(0, 4)); // Take top 4 Fronts
    if (showRear) finalSelection.push(...rearItems.slice(0, 4));   // Take top 4 Rears

    if (finalSelection.length === 0) return "No products found matching those specs.";

    // 6. FORMAT OUTPUT
    const formatted = finalSelection.map((p: any) => {
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
          // NO EXTRA 5 DAYS ADDED
          return `• ${p.title} | Special Order (~${rawLeadTime} days)`;
      } else {
          return `• ${p.title} | Sold Out`;
      }
    });

    return formatted.join("\n");

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
            query: z.string().describe("The search terms") 
          }),
          execute: async (args) => {
            console.log("[Tool Debug] Raw Args:", JSON.stringify(args));
            let q = args.query;
            if (!q || typeof q !== 'string') q = Object.values(args).join(" ");
            
            // Pass the RAW ORIGINAL query to the helper so we can detect "Front" and "Rear"
            const info = await lookupProductInfo(String(q), String(q));
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
        console.log("AI was silent. Using Safety Net.");
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