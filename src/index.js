export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    // 1. Dummy /v1/models endpoint (Claude Code validation ke liye)
    if (url.pathname.endsWith("/v1/models")) {
      return jsonResponse({
        object: "list",
        data: [
          { id: "claude-3-5-sonnet-20241022", object: "model", created: 1700000000, owned_by: "anthropic" },
          { id: "claude-3-5-haiku-20241022", object: "model", created: 1700000000, owned_by: "anthropic" },
        ],
      });
    }

    // 2. Dummy /count_tokens endpoint (Zero API call)
    if (url.pathname.endsWith("/count_tokens")) {
      return jsonResponse({ input_tokens: 250 });
    }

    if (request.method !== "POST") {
      return new Response("Worker Active", { status: 200 });
    }

    try {
      const body = await request.json();
      const apiKey =
        env.GROQ_API_KEY ||
        request.headers.get("x-api-key") ||
        (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");

      if (!apiKey) {
        return anthropicError("GROQ_API_KEY missing in Worker secrets or headers.", 401);
      }

      // 3. BACKGROUND NOISE BLOCKER:
      // Claude Code ke title generation & background pings ko Groq par mat bhejo
      const lastUserMsg = extractLastUserText(body.messages || []);
      if (
        lastUserMsg.includes("Please write a 5-10 word title") ||
        lastUserMsg.includes("Generate a concise title") ||
        lastUserMsg.includes("is_error") && lastUserMsg.length < 150
      ) {
        return buildAnthropicReply("Task", body.stream, body.model);
      }

      // 4. STRICT 500-TOKEN HARD CAP (~1800 characters max total payload)
      const MAX_TOTAL_CHARS = 1800; // ~450-500 tokens max
      const compactSystem = "You are a concise coding assistant. Give short, direct code answers.";
      
      // Sirf aakhiri user message aur zaroori context rakhein
      let trimmedUserText = lastUserMsg.slice(-1400); // Max ~350 tokens user prompt
      if (!trimmedUserText.trim()) trimmedUserText = "Hello";

      const groqMessages = [
        { role: "system", content: compactSystem },
        { role: "user", content: trimmedUserText },
      ];

      // Total safety check: agar abhi bhi 1800 chars se zyada ho toh kaat dein
      const totalChars = JSON.stringify(groqMessages).length;
      if (totalChars > MAX_TOTAL_CHARS) {
        groqMessages[1].content = groqMessages[1].content.slice(-1200);
      }

      // 5. Primary & Fallback Models (High TPM on Groq)
      const primaryModel = request.headers.get("X-Target-Model") || env.TARGET_MODEL || "llama-3.3-70b-versatile";
      const fallbackModel = "llama-3.1-8b-instant";

      let groqRes = await callGroq(apiKey, primaryModel, groqMessages);

      // Agar primary model par 429 ya error aaye toh turant 8b-instant par fallback karein
      if (!groqRes.ok) {
        groqRes = await callGroq(apiKey, fallbackModel, groqMessages);
      }

      if (!groqRes.ok) {
        const errText = await groqRes.text();
        return anthropicError(`Groq Error (${groqRes.status}): ${errText.slice(0, 200)}`, groqRes.status);
      }

      const groqData = await groqRes.json();
      const replyText = groqData.choices?.[0]?.message?.content || "Done.";

      return buildAnthropicReply(replyText, body.stream, body.model);
    } catch (err) {
      return anthropicError(`Proxy Exception: ${err.message}`, 500);
    }
  },
};

// --- Helper Functions ---

async function callGroq(apiKey, model, messages) {
  return fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 512,
      temperature: 0.2,
    }),
  });
}

function extractLastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const content = messages[i].content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text)
          .join("\n");
      }
    }
  }
  return "";
}

function buildAnthropicReply(text, isStream, modelName) {
  const id = "msg_" + Date.now();
  const model = modelName || "claude-3-5-sonnet-20241022";

  if (isStream) {
    const encoder = new TextEncoder();
    const events = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id, type: "message", role: "assistant", content: [], model, stop_reason: null, usage: { input_tokens: 350, output_tokens: 1 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 100 } })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ].join("");

    return new Response(encoder.encode(events), {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  return jsonResponse({
    id,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 350, output_tokens: 100 },
  });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function anthropicError(message, status = 400) {
  return jsonResponse(
    {
      type: "error",
      error: { type: "api_error", message },
    },
    status
  );
}
