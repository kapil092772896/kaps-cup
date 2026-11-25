export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    if (url.pathname.endsWith("/v1/models")) {
      return jsonResponse({
        object: "list",
        data: [
          { id: "claude-3-5-sonnet-20241022", object: "model", created: 1700000000, owned_by: "anthropic" },
          { id: "claude-3-5-haiku-20241022", object: "model", created: 1700000000, owned_by: "anthropic" },
        ],
      });
    }

    if (url.pathname.endsWith("/count_tokens")) {
      return jsonResponse({ input_tokens: 450 });
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
        return anthropicError("GROQ_API_KEY missing.", 401);
      }

      // 1. COMPLETE BACKGROUND NOISE BLOCKER (System + User dono check karega)
      const sysText = extractText(body.system).toLowerCase();
      const lastMsg = body.messages?.[body.messages.length - 1];
      const rawText = extractText(lastMsg?.content);
      const lowerRaw = rawText.toLowerCase();

      if (
        sysText.includes("5-10 word title") ||
        sysText.includes("concise title") ||
        sysText.includes("summarize this coding session") ||
        lowerRaw.includes("please write a 5-10 word title") ||
        lowerRaw.includes("generate a concise title") ||
        (lowerRaw.trim() === "ping" || lowerRaw.trim() === "test")
      ) {
        return buildAnthropicReply({ text: "Coding Session" }, body.stream, body.model);
      }

      // 2. STRICT 500-TOKEN PAYLOAD TRIMMER
      const recentMsgs = (body.messages || []).slice(-2);
      const groqMessages = [
        {
          role: "system",
          content: "You are Claude Code. Use Write, Edit, Read, Bash tools directly on files. Keep replies short.",
        },
      ];

      for (const m of recentMsgs) {
        const mapped = mapAnthropicToGroqMsg(m);
        if (mapped) groqMessages.push(mapped);
      }

      // 3. Compact Tools (~220 tokens total, taaki auto file edit chalta rahe)
      const compactTools = [
        {
          type: "function",
          function: {
            name: "Write",
            description: "Write content to file",
            parameters: {
              type: "object",
              properties: {
                file_path: { type: "string" },
                content: { type: "string" },
              },
              required: ["file_path", "content"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "Edit",
            description: "Replace exact text in file",
            parameters: {
              type: "object",
              properties: {
                file_path: { type: "string" },
                old_string: { type: "string" },
                new_string: { type: "string" },
              },
              required: ["file_path", "old_string", "new_string"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "Read",
            description: "Read file content",
            parameters: {
              type: "object",
              properties: { file_path: { type: "string" } },
              required: ["file_path"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "Bash",
            description: "Execute shell command",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        },
      ];

      // 4. SMART MODEL ROUTING (Haiku/Background -> 8B Fast Model, Main -> 70B/Custom)
      const reqModel = (body.model || "").toLowerCase();
      const isBackgroundModel = reqModel.includes("haiku");
      const mainModel = request.headers.get("X-Target-Model") || env.TARGET_MODEL || "llama-3.3-70b-versatile";
      const fastModel = "llama-3.1-8b-instant";

      const chosenModel = isBackgroundModel ? fastModel : mainModel;

      let groqRes = await callGroq(apiKey, chosenModel, groqMessages, compactTools);

      // Agar main model 429 ya error de toh turant fastModel par fallback karein
      if (!groqRes.ok && chosenModel !== fastModel) {
        groqRes = await callGroq(apiKey, fastModel, groqMessages, compactTools);
      }

      if (!groqRes.ok) {
        const errText = await groqRes.text();
        return anthropicError(`Groq Error (${groqRes.status}): ${errText.slice(0, 180)}`, groqRes.status);
      }

      const groqData = await groqRes.json();
      const choice = groqData.choices?.[0]?.message || {};

      return buildAnthropicReply(
        {
          text: choice.content || "",
          toolCalls: choice.tool_calls || [],
        },
        body.stream,
        body.model
      );
    } catch (err) {
      return anthropicError(`Proxy Error: ${err.message}`, 500);
    }
  },
};

// --- Helpers ---

async function callGroq(apiKey, model, messages, tools) {
  return fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      tools,
      tool_choice: "auto",
      max_tokens: 1024,
      temperature: 0.1,
    }),
  });
}

function extractText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => c.text || c.content || "").join("\n");
  }
  return "";
}

function mapAnthropicToGroqMsg(msg) {
  const role = msg.role === "assistant" ? "assistant" : "user";
  const content = msg.content;

  if (typeof content === "string") {
    return { role, content: content.slice(-1000) };
  }

  if (Array.isArray(content)) {
    const toolRes = content.find((c) => c.type === "tool_result");
    if (toolRes) {
      const out = typeof toolRes.content === "string" ? toolRes.content : JSON.stringify(toolRes.content);
      return {
        role: "tool",
        tool_call_id: toolRes.tool_use_id || "call_1",
        content: out.slice(0, 600),
      };
    }

    const toolUse = content.find((c) => c.type === "tool_use");
    if (toolUse && role === "assistant") {
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: toolUse.id,
            type: "function",
            function: {
              name: toolUse.name,
              arguments: JSON.stringify(toolUse.input || {}),
            },
          },
        ],
      };
    }

    const text = content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text)
      .join("\n")
      .slice(-1000);
    if (text) return { role, content: text };
  }
  return null;
}

function buildAnthropicReply({ text, toolCalls = [] }, isStream, modelName) {
  const id = "msg_" + Date.now();
  const model = modelName || "claude-3-5-sonnet-20241022";
  const contentBlocks = [];

  if (text) {
    contentBlocks.push({ type: "text", text });
  }

  for (const tc of toolCalls) {
    let parsedArgs = {};
    try {
      parsedArgs = JSON.parse(tc.function.arguments || "{}");
    } catch {
      parsedArgs = {};
    }
    contentBlocks.push({
      type: "tool_use",
      id: tc.id || "toolu_" + Date.now(),
      name: tc.function.name,
      input: parsedArgs,
    });
  }

  if (contentBlocks.length === 0) {
    contentBlocks.push({ type: "text", text: "Done." });
  }

  const stopReason = toolCalls.length > 0 ? "tool_use" : "end_turn";

  if (isStream) {
    const encoder = new TextEncoder();
    let sse = `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: { id, type: "message", role: "assistant", content: [], model, stop_reason: null, usage: { input_tokens: 450, output_tokens: 1 } },
    })}\n\n`;

    contentBlocks.forEach((block, idx) => {
      if (block.type === "text") {
        sse += `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: idx, content_block: { type: "text", text: "" } })}\n\n`;
        sse += `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: idx, delta: { type: "text_delta", text: block.text } })}\n\n`;
        sse += `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: idx })}\n\n`;
      } else if (block.type === "tool_use") {
        sse += `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: idx, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } })}\n\n`;
        sse += `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } })}\n\n`;
        sse += `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: idx })}\n\n`;
      }
    });

    sse += `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 150 } })}\n\n`;
    sse += `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;

    return new Response(encoder.encode(sse), {
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
    content: contentBlocks,
    stop_reason: stopReason,
    usage: { input_tokens: 450, output_tokens: 150 },
  });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function anthropicError(message, status = 400) {
  return jsonResponse({ type: "error", error: { type: "api_error", message } }, status);
}
