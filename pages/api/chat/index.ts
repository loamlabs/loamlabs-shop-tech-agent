{% comment %}
  LoamLabs Shop Tech Agent (The Interface)
  Connects to: loamlabs-shop-tech-agent.vercel.app
{% endcomment %}

<style>
  /* --- HIDE STANDARD SHOPIFY CHAT ON THIS PAGE --- */
  #shopify-chat, .shopify-chat-widget, iframe#dummy-chat-button-iframe {
    display: none !important;
  }

  /* --- TECH AGENT CSS --- */
  :root {
    --agent-color-primary: #28a745;
    --agent-color-dark: #1a1a1a;
    --agent-bg: #ffffff;
    --agent-text: #333333;
    --agent-border: #e0e0e0;
    --agent-z-index: 2147483640;
  }

  /* 1. The Floating Action Button (FAB) - Side Tab */
  .tech-agent-fab {
    position: fixed;
    top: 50%;
    right: 0;
    transform: translateY(-50%);
    z-index: var(--agent-z-index);
    
    background-color: var(--agent-color-primary);
    color: #fff;
    border: 2px solid #fff;
    border-right: none;
    
    border-top-left-radius: 8px;
    border-bottom-left-radius: 8px;
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
    
    padding: 18px 12px;
    box-shadow: -2px 4px 12px rgba(0,0,0,0.2);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    
    transition: right 0.2s ease, background-color 0.2s;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }

  .tech-agent-fab:hover {
    right: 5px;
    background-color: #218838;
  }

  /* Bouncing Animation */
  .tech-agent-fab.is-bouncing {
    animation: gentleBounce 3s infinite;
  }

  @keyframes gentleBounce {
    0%, 20%, 50%, 80%, 100% { transform: translateY(-50%) translateX(0); }
    40% { transform: translateY(-50%) translateX(-8px); }
    60% { transform: translateY(-50%) translateX(-4px); }
  }

  /* Vertical Text */
  .tech-agent-fab span {
    font-weight: 700;
    font-size: 14px;
    writing-mode: vertical-rl;
    text-orientation: mixed;
    transform: rotate(180deg);
    letter-spacing: 1px;
    text-transform: uppercase;
  }
  
  /* Icon Styling */
  .tech-agent-fab svg {
    width: 26px;
    height: 26px;
    fill: currentColor;
    order: -1;
  }

  /* 2. The Chat Window */
  .tech-agent-window {
    position: fixed;
    top: 50%;
    right: 60px;
    transform: translateY(-50%) translateX(20px);
    width: 380px;
    max-width: 85vw;
    height: 600px;
    max-height: 70vh;
    background-color: var(--agent-bg);
    border: 1px solid var(--agent-border);
    border-radius: 12px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.25);
    z-index: var(--agent-z-index);
    display: flex;
    flex-direction: column;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease, transform 0.2s ease;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }

  .tech-agent-window.is-open {
    opacity: 1;
    pointer-events: auto;
    transform: translateY(-50%) translateX(0);
  }

  /* Header */
  .agent-header {
    background-color: #1a1a1a;
    color: #fff;
    padding: 15px;
    border-top-left-radius: 12px;
    border-top-right-radius: 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .agent-header h3 { margin: 0; font-size: 16px; font-weight: 600; color: #fff; }
  .agent-header .agent-status { font-size: 11px; opacity: 0.8; display: block; font-weight: normal; }
  .agent-close-btn { background: none; border: none; color: #fff; font-size: 24px; cursor: pointer; line-height: 1; padding: 0 5px; }

  /* Messages Area */
  .agent-messages {
    flex-grow: 1;
    padding: 15px;
    overflow-y: auto;
    background-color: #f8f9fa;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .message-row { display: flex; margin-bottom: 5px; }
  .message-row.user { justify-content: flex-end; }
  .message-row.agent { justify-content: flex-start; }

  .message-bubble {
    max-width: 80%;
    padding: 10px 14px;
    border-radius: 12px;
    font-size: 14px;
    line-height: 1.4;
    position: relative;
  }

  .message-row.user .message-bubble { background-color: var(--agent-color-primary); color: #fff; border-bottom-right-radius: 2px; }
  .message-row.agent .message-bubble { background-color: #ffffff; color: var(--agent-text); border: 1px solid #e0e0e0; border-bottom-left-radius: 2px; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }

  /* Typing Indicator */
  .typing-indicator { display: flex; gap: 4px; padding: 12px 14px; background: #fff; border: 1px solid #e0e0e0; border-radius: 12px; width: fit-content; }
  .typing-dot { width: 6px; height: 6px; background: #ccc; border-radius: 50%; animation: typingBounce 1.4s infinite ease-in-out both; }
  .typing-dot:nth-child(1) { animation-delay: -0.32s; }
  .typing-dot:nth-child(2) { animation-delay: -0.16s; }
  @keyframes typingBounce { 0%, 80%, 100% { transform: scale(0); } 40% { transform: scale(1); } }

  /* Input Area */
  .agent-input-area { padding: 15px; background-color: #fff; border-top: 1px solid var(--agent-border); display: flex; gap: 10px; }
  .agent-input { flex-grow: 1; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; outline: none; }
  .agent-input:focus { border-color: var(--agent-color-primary); }
  .agent-send-btn { background-color: var(--agent-color-primary); color: #fff; border: none; border-radius: 6px; padding: 0 15px; cursor: pointer; font-weight: 600; transition: background-color 0.2s; }
  .agent-send-btn:hover { background-color: #218838; }
  .agent-send-btn:disabled { background-color: #ccc; cursor: not-allowed; }

  /* Footer Link */
  .agent-footer-link {
    text-align: center;
    padding: 8px;
    background-color: #f1f1f1;
    border-bottom-left-radius: 12px;
    border-bottom-right-radius: 12px;
    font-size: 11px;
    color: #666;
    border-top: 1px solid #eee;
  }
  .agent-footer-link a { color: #444; text-decoration: underline; cursor: pointer; }

  .message-bubble ul { padding-left: 20px; margin: 5px 0; }
  .message-bubble p { margin: 0 0 5px 0; }
  .message-bubble p:last-child { margin: 0; }
  
  /* Mobile Adjustments */
  @media (max-width: 768px) {
    .tech-agent-fab { top: auto; bottom: 80px; transform: none; right: 0; border-radius: 30px 0 0 30px; flex-direction: row; padding: 12px 20px; }
    .tech-agent-fab span { writing-mode: horizontal-tb; transform: none; }
    .tech-agent-fab svg { order: 0; }
    .tech-agent-window { width: 100%; height: 100%; top: 0; left: 0; right: 0; bottom: 0; transform: none; max-width: none; max-height: none; border-radius: 0; z-index: 2147483647; display: none; }
    .tech-agent-window.is-open { display: flex; }
    .agent-header { border-radius: 0; padding-top: env(safe-area-inset-top); }
  }
</style>

<!-- UI STRUCTURE -->
<button id="tech-agent-fab" class="tech-agent-fab" aria-label="Open Shop Tech">
  <svg viewBox="0 0 24 24">
    <path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/>
  </svg>
  <span>Ask Lead Tech</span>
</button>

<div id="tech-agent-window" class="tech-agent-window">
  <div class="agent-header">
    <div>
      <h3>LoamLabs Lead Tech</h3>
      <span class="agent-status">Automated Wheel Expert</span>
    </div>
    <button id="agent-close-btn" class="agent-close-btn">×</button>
  </div>
  
  <div id="agent-messages" class="agent-messages">
    <div class="message-row agent">
      <div class="message-bubble">
        👋 Welcome to the Builder. I can help you validate specs, check Lead Times, or choose components. What's on your mind?
      </div>
    </div>
  </div>

  <div class="agent-input-area">
    <input type="text" id="agent-input" class="agent-input" placeholder="Ask about rims, hubs, or weight..." autocomplete="off">
    <button id="agent-send-btn" class="agent-send-btn">Send</button>
  </div>
  
  <div class="agent-footer-link">
    Need a human? <a href="/pages/contact-us" target="_blank">Leave a message for the team.</a>
  </div>
</div>

<script>
(function() {
  const VERCEL_API_URL = 'https://loamlabs-shop-tech-agent.vercel.app/api/chat';

  // Move window to body to prevent layout trapping
  const windowEl = document.getElementById('tech-agent-window');
  document.body.appendChild(windowEl);

  const fab = document.getElementById('tech-agent-fab');
  const closeBtn = document.getElementById('agent-close-btn');
  const messagesContainer = document.getElementById('agent-messages');
  const inputEl = document.getElementById('agent-input');
  const sendBtn = document.getElementById('agent-send-btn');

  let messageHistory = [];
  let isThinking = false;

  // --- BOUNCING LOGIC ---
  const SEEN_KEY = 'loamlabs_agent_seen';
  const hasSeenAgent = localStorage.getItem(SEEN_KEY);

  if (!hasSeenAgent) {
    fab.classList.add('is-bouncing');
  }

  function toggleWindow() {
    const isOpen = windowEl.classList.contains('is-open');
    if (!isOpen) {
      windowEl.classList.add('is-open');
      inputEl.focus();
      scrollToBottom();
      fab.classList.remove('is-bouncing');
      localStorage.setItem(SEEN_KEY, 'true');
    } else {
      windowEl.classList.remove('is-open');
    }
  }

  fab.addEventListener('click', toggleWindow);
  closeBtn.addEventListener('click', toggleWindow);

  function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  function appendMessage(role, text) {
    const row = document.createElement('div');
    row.className = `message-row ${role}`;
    const formattedText = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
    row.innerHTML = `<div class="message-bubble">${formattedText}</div>`;
    messagesContainer.appendChild(row);
    scrollToBottom();
    messageHistory.push({ role, content: text });
  }

  async function handleSend() {
    const text = inputEl.value.trim();
    if (!text || isThinking) return;

    inputEl.value = '';
    appendMessage('user', text);

    isThinking = true;
    const typingId = 'typing-' + Date.now();
    const typingIndicator = document.createElement('div');
    typingIndicator.className = 'message-row agent';
    typingIndicator.id = typingId;
    typingIndicator.innerHTML = `<div class="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>`;
    messagesContainer.appendChild(typingIndicator);
    scrollToBottom();

    try {
      let buildContext = {};
      if (window.loamlabs && window.loamlabs.getJerrysContext) {
        buildContext = window.loamlabs.getJerrysContext();
      }

      const isStaff = window._loamlabs_customer_data && 
                      window._loamlabs_customer_data.tags && 
                      window._loamlabs_customer_data.tags.includes('staff_builder');

      const response = await fetch(VERCEL_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: messageHistory,
          buildContext: buildContext,
          isAdmin: isStaff
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Server Error: ${response.status}`);
      }

      const typingEl = document.getElementById(typingId);
      if(typingEl) typingEl.remove();

      const agentRow = document.createElement('div');
      agentRow.className = 'message-row agent';
      const bubble = document.createElement('div');
      bubble.className = 'message-bubble';
      agentRow.appendChild(bubble);
      messagesContainer.appendChild(agentRow);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let done = false;
      let fullResponseText = "";

      while (!done) {
        const { value, done: doneReading } = await reader.read();
        done = doneReading;
        const chunkValue = decoder.decode(value, { stream: true });
        fullResponseText += chunkValue;
        bubble.innerHTML = fullResponseText.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
        scrollToBottom();
      }
      messageHistory.push({ role: 'assistant', content: fullResponseText });

    } catch (error) {
      console.error(error);
      const typingEl = document.getElementById(typingId);
      if(typingEl) typingEl.remove();
      appendMessage('agent', `System Error: ${error.message}. Please check the Vercel logs.`);
    } finally {
      isThinking = false;
    }
  }

  sendBtn.addEventListener('click', handleSend);
  inputEl.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleSend();
  });
})();
</script>