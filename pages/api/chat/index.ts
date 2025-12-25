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

export default async function handler(req: any, res: any) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const { messages, buildContext } = req.body;

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

    // Add System Prompt to message history
    const openAiMessages = [
      { role: 'system', content: SYSTEM_PROMPT + contextInjection },
      ...messages.map((m: any) => ({ role: m.role === 'agent' ? 'assistant' : m.role, content: m.content }))
    ];

    // Set up Streaming Response
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
      if (content) {
        res.write(content);
      }
    }

    res.end();

  } catch (error: any) {
    console.error("AI ROUTE ERROR:", error);
    res.status(500).json({ error: error.message });
  }
}