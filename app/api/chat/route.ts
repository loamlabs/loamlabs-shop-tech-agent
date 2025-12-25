// @ts-nocheck
import { openai } from '@ai-sdk/openai';
import { streamText, tool, convertToCoreMessages } from 'ai';
import { z } from 'zod';

export const maxDuration = 60;
export const dynamic = 'force-dynamic'; // Force dynamic handling

// --- PERSONA & STORE POLICY ---
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
4. **INVENTORY REALITY:** Do not guess stock. If asked "Is this in stock?", use the 'check_live_inventory' tool. 
   - If an item is NOT in stock (quantity <= 0), check the provided 'leadTimeDays' data in the context.
   - You can give a rough estimate based on that lead time, but **always** add the caveat: *"This assumes the manufacturer currently has it in stock, which we would need to verify."*

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

// Helper for GET requests (Health Check)
export async function GET() {
  return new Response(JSON.stringify({ status: "Online", provider: "OpenAI" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// Main POST Handler
export async function POST(req: Request) {
  try {
    const { messages, buildContext } = await req.json();

    const contextInjection = `
      [CURRENT BUILD STATE]:
      - Step: ${buildContext?.step || 'Unknown'}
      - Riding Style: ${buildContext?.ridingStyle || 'Not Selected'}
      - Specs: ${JSON.stringify(buildContext?.specs || {})}
      - Selected Components: ${JSON.stringify(buildContext?.components || {})}
      - Estimated Weight: ${buildContext?.calculatedWeight || 'Unknown'}g
      - Subtotal: $${(buildContext?.subtotal / 100).toFixed(2) || '0.00'}
      - Estimated Shop Lead Time: ${buildContext?.leadTime || 'Standard'} Days
    `;

    const result = await streamText({
      model: openai('gpt-4o-mini'),
      system: SYSTEM_PROMPT + contextInjection,
      messages: convertToCoreMessages(messages),
      tools: {
        check_live_inventory: tool({
          description: 'Checks the real-time stock quantity of a specific product variant.',
          parameters: z.object({
            variantId: z.string().describe('The Shopify Variant ID (GID or numeric) to check.'),
          }),
          execute: async (args: any) => {
            const { variantId } = args;
            const numericId = variantId.replace('gid://shopify/ProductVariant/', '');
            try {
              const response = await fetch(
                `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2024-04/variants/${numericId}.json`,
                {
                  headers: {
                    'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN || '',
                  },
                }
              );
              const data = await response.json();
              const q = data.variant.inventory_quantity;
              const policy = data.variant.inventory_policy;
              
              if (q > 0) return `In Stock: We have ${q} units available right now.`;
              if (q <= 0 && policy === 'continue') return `Special Order: Currently out of stock, but available for order.`;
              return `Sold Out: Currently unavailable.`;
            } catch (error) {
              return 'I could not verify the live inventory right now.';
            }
          },
        }),
        calculate_spoke_lengths: tool({
          description: 'Calculates precise spoke lengths for a rim/hub combination using the internal engineering engine.',
          parameters: z.object({
            erd: z.number().describe('Effective Rim Diameter in mm'),
            pcdLeft: z.number().describe('Hub Pitch Circle Diameter Left'),
            pcdRight: z.number().describe('Hub Pitch Circle Diameter Right'),
            flangeLeft: z.number().describe('Hub Flange Offset Left'),
            flangeRight: z.number().describe('Hub Flange Offset Right'),
            spokeCount: z.number().describe('Number of spokes (e.g., 28, 32)'),
            crossPattern: z.number().describe('Lacing pattern (e.g., 2 or 3)'),
          }),
          execute: async (args: any) => {
            try {
              const response = await fetch(process.env.SPOKE_CALC_API_URL || '', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'x-internal-secret': process.env.SPOKE_CALC_API_SECRET || '',
                },
                body: JSON.stringify(args),
              });
              
              if (!response.ok) throw new Error('Calculation service failed');
              
              const result = await response.json();
              return `Calculated Lengths: Left ${result.left}mm, Right ${result.right}mm. (Note: We handle final rounding during the build).`;
            } catch (error) {
              return 'I tried to run the math, but there is an issue on our end I need to look into. I can estimate based on similar builds if you want.';
            }
          },
        }),
      },
    });

    return result.toAIStreamResponse();

  } catch (error: any) {
    console.error("AI ROUTE ERROR:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}