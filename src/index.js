export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Models List Endpoint
    if (request.method === "GET" && url.pathname.endsWith("/v1/models")) {
      return new Response(
        JSON.stringify({
          data: [
            { id: "claude-sonnet-4-5-20250929", object: "model", created: 1735689600, owned_by: "anthropic" },
            { id: "claude-3-5-sonnet-20241022", object: "model", created: 1735689600, owned_by: "anthropic" },
            { id: "claude-haiku-4-5-20251001", object: "model", created: 1735689600, owned_by: "anthropic" }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2. Token Count Endpoint (POST)
    if (request.method === "POST" && url.pathname.endsWith("/v1/messages/count_tokens")) {
      return new Response(
        JSON.stringify({ input_tokens: 100 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 3. Health Check Endpoint (GET)
    if (request.method === "GET") {
      return new Response(
        JSON.stringify({
          status: "running",
          project: "kaps-cup smart auto-slimming AI proxy v2",
          usage: "Set X-Target-Model header in settings.json to use ANY model"
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 4. Claude Code Messages Endpoint (POST)
    if (request.method === "POST" && url.pathname.endsWith("/v1/messages")) {
      let anthropicReq = {};
      let rawBodyText = "";
      let wantsStream = false;
      let reqModel = "claude-sonnet-4-5";
      let finalModel = "unknown";
      let targetUrl = "unknown";
      let tokenInfo = { rawEstTokens: 0, sentEstTokens: 0, trimmed: false };

      try {
        rawBodyText = await request.text();
        const payloadBytes = new TextEncoder().encode(rawBodyText).length;
        const payloadMB = (payloadBytes / (1024 * 1024)).toFixed(2);
        tokenInfo.rawEstTokens = Math.ceil(rawBodyText.length / 4);

        try {
          anthropicReq = JSON.parse(rawBodyText);
        } catch (parseErr) {
          return formatChatDiagnostic({
            stream: false,
            reqModel,
            title: "Invalid JSON Request Body",
            statusCode: 400,
            provider: "Client / Proxy",
            model: "N/A",
            payloadMB,
            tokenInfo,
            rawError: parseErr.message,
            cause: "Client se bheja gaya request JSON valid nahi hai.",
            solution: "Ek naya session/prompt try karein."
          });
        }

        wantsStream = Boolean(anthropicReq.stream);
        reqModel = anthropicReq.model || "claude-sonnet-4-5";

        const stats = inspectPayloadStats(anthropicReq, payloadBytes, payloadMB);
        const rawAuth = request.headers.get("x-api-key") || request.headers.get("authorization") || "";
        const apiKey = rawAuth.replace(/^Bearer\s+/i, "").trim();

        const customModelHeader = request.headers.get("x-target-model")?.trim();
        const selectedModel = customModelHeader || (!reqModel.startsWith("claude-") ? reqModel : "");

        if (!apiKey) {
          return formatChatDiagnostic({
            stream: wantsStream,
            reqModel,
            title: "Missing API Key",
            statusCode: 401,
            provider: "Auth Check",
            model: selectedModel || reqModel,
            payloadMB: stats.payloadMB,
            tokenInfo,
            rawError: "No x-api-key or Authorization header received.",
            cause: "Claude Code se proxy ko API key nahi mil rahi hai.",
            solution: "settings.json ya env mein ANTHROPIC_API_KEY set karein aur terminal restart karein."
          });
        }

        // Convert Anthropic messages to OpenAI-compatible format
        let openAiMessages = [];
        if (anthropicReq.system) {
          const sysText = Array.isArray(anthropicReq.system)
            ? anthropicReq.system.map((s) => s.text || "").join("\n")
            : String(anthropicReq.system);
          openAiMessages.push({ role: "system", content: sysText });
        }

        for (const msg of anthropicReq.messages || []) {
          if (typeof msg.content === "string") {
            openAiMessages.push({ role: msg.role, content: msg.content });
          } else if (Array.isArray(msg.content)) {
            const parts = [];
            const toolCalls = [];

            for (const block of msg.content) {
              if (!block) continue;
              if (block.type === "text") {
                parts.push({ type: "text", text: block.text || "" });
              } else if (block.type === "image" && block.source?.type === "base64") {
                parts.push({
                  type: "image_url",
                  image_url: {
                    url: `data:${block.source.media_type || "image/png"};base64,${block.source.data}`
                  }
                });
              } else if (block.type === "tool_use") {
                toolCalls.push({
                  id: block.id,
                  type: "function",
                  function: {
                    name: block.name,
                    arguments: JSON.stringify(block.input || {})
                  }
                });
              } else if (block.type === "tool_result") {
                openAiMessages.push({
                  role: "tool",
                  tool_call_id: block.tool_use_id,
                  content: typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "")
                });
              }
            }

            if (parts.length > 0 || toolCalls.length > 0) {
              const onlyText = parts.every((p) => p.type === "text");
              const contentValue =
                parts.length === 0
                  ? null
                  : onlyText
                  ? parts.map((p) => p.text).join("\n")
                  : parts;

              const outMsg = { role: msg.role, content: contentValue };
              if (toolCalls.length > 0) outMsg.tool_calls = toolCalls;
              openAiMessages.push(outMsg);
            }
          }
        }

        let openAiTools = (anthropicReq.tools || []).map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description || "",
            parameters: t.input_schema
          }
        }));

        // Smart Provider & Model Routing
        let providerName = "OpenRouter (Fallback)";
        finalModel = selectedModel;
        const headers = {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        };

        if (apiKey.startsWith("gsk_")) {
          providerName = "Groq";
          targetUrl = "https://api.groq.com/openai/v1/chat/completions";
          finalModel = (selectedModel || "llama-3.1-8b-instant").replace(/^groq\//, "");
        } else if (apiKey.startsWith("AIza")) {
          providerName = "Google Gemini";
          targetUrl = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
          finalModel = (selectedModel || "gemini-2.5-flash-lite").replace(/^google\//, "");
          headers["x-goog-api-key"] = apiKey;
        } else if (apiKey.startsWith("sk-or-")) {
          providerName = "OpenRouter";
          targetUrl = "https://openrouter.ai/api/v1/chat/completions";
          finalModel = selectedModel || "cohere/north-mini-code:free";
          headers["HTTP-Referer"] = "https://kaps-cup.workers.dev";
          headers["X-Title"] = "kaps-cup-proxy";
        } else if (apiKey.startsWith("sk-")) {
          providerName = "OpenAI";
          targetUrl = "https://api.openai.com/v1/chat/completions";
          finalModel = (selectedModel || "gpt-4o-mini").replace(/^openai\//, "");
        } else {
          providerName = "OpenRouter (Default)";
          targetUrl = "https://openrouter.ai/api/v1/chat/completions";
          finalModel = selectedModel || "openrouter/free";
        }

        // Hard Token Budget Enforcement for Groq (7000 ITPM limit -> target <= 4500 tokens)
        if (providerName === "Groq") {
          const slimmed = enforceTokenBudget(openAiMessages, openAiTools, 14000);
          openAiMessages = slimmed.messages;
          openAiTools = slimmed.tools;
          tokenInfo.trimmed = true;
        } else {
          openAiMessages = ensureUserMessage(openAiMessages);
        }

        const providerPayload = {
          model: finalModel,
          messages: openAiMessages,
          max_tokens: Math.min(anthropicReq.max_tokens || 2048, providerName === "Groq" ? 1500 : 4096),
          temperature: anthropicReq.temperature ?? 0.2,
          stream: false
        };

        if (openAiTools.length > 0) {
          providerPayload.tools = openAiTools;
        }

        const finalPayloadStr = JSON.stringify(providerPayload);
        tokenInfo.sentEstTokens = Math.ceil(finalPayloadStr.length / 4);

        let aiRes = await fetch(targetUrl, {
          method: "POST",
          headers,
          body: finalPayloadStr
        });

        // Auto-retry without tools if Groq still hits 413 TPM limit
        if (aiRes.status === 413 && providerName === "Groq" && providerPayload.tools) {
          delete providerPayload.tools;
          providerPayload.messages = enforceTokenBudget(openAiMessages, [], 10000).messages;
          const retryStr = JSON.stringify(providerPayload);
          tokenInfo.sentEstTokens = Math.ceil(retryStr.length / 4);
          aiRes = await fetch(targetUrl, {
            method: "POST",
            headers,
            body: retryStr
          });
        }

        const rawText = await aiRes.text();
        let aiData = null;
        try {
          aiData = JSON.parse(rawText);
        } catch {
          const diag = diagnoseBug({
            statusCode: aiRes.status || 502,
            rawMessage: `Non-JSON response: ${rawText.slice(0, 400)}`,
            provider: providerName,
            model: finalModel,
            stats,
            tokenInfo
          });
          return formatChatDiagnostic({
            stream: wantsStream,
            reqModel,
            statusCode: aiRes.status || 502,
            provider: providerName,
            model: finalModel,
            payloadMB: stats.payloadMB,
            tokenInfo,
            ...diag
          });
        }

        if (!aiRes.ok) {
          const upstreamErrMsg =
            aiData?.error?.message ||
            (typeof aiData?.error === "string" ? aiData.error : "") ||
            JSON.stringify(aiData).slice(0, 500);

          const diag = diagnoseBug({
            statusCode: aiRes.status,
            rawMessage: upstreamErrMsg,
            provider: providerName,
            model: finalModel,
            stats,
            tokenInfo
          });

          return formatChatDiagnostic({
            stream: wantsStream,
            reqModel,
            statusCode: aiRes.status,
            provider: providerName,
            model: finalModel,
            payloadMB: stats.payloadMB,
            tokenInfo,
            ...diag
          });
        }

        // Convert Response back to Anthropic Format
        const choice = aiData.choices?.[0]?.message || {};
        const contentBlocks = [];
        const promptTokens = aiData.usage?.prompt_tokens ?? tokenInfo.sentEstTokens;
        const completionTokens = aiData.usage?.completion_tokens ?? 0;
        const totalTokens = aiData.usage?.total_tokens ?? promptTokens + completionTokens;

        if (choice.content) {
          const usageBadge = `\n\n---\n> **Proxy Token Stats** | Model: \`${finalModel}\` (${providerName}) | Raw Est: \`~${tokenInfo.rawEstTokens}\` → Sent: \`${promptTokens}\` in + \`${completionTokens}\` out = **\`${totalTokens}\` tokens**`;
          contentBlocks.push({ type: "text", text: choice.content + usageBadge });
        }

        if (choice.tool_calls) {
          for (const tc of choice.tool_calls) {
            let parsedArgs = {};
            try {
              parsedArgs = JSON.parse(tc.function.arguments || "{}");
            } catch {}
            contentBlocks.push({
              type: "tool_use",
              id: tc.id,
              name: tc.function.name,
              input: parsedArgs
            });
          }
        }

        const anthropicResponse = {
          id: "msg_" + Date.now(),
          type: "message",
          role: "assistant",
          model: reqModel || "claude-sonnet-4-5",
          content: contentBlocks.length > 0 ? contentBlocks : [{ type: "text", text: "" }],
          stop_reason: choice.tool_calls?.length > 0 ? "tool_use" : "end_turn",
          usage: {
            input_tokens: promptTokens,
            output_tokens: completionTokens || 10
          }
        };

        if (wantsStream) {
          return buildAnthropicSSE(anthropicResponse, contentBlocks);
        }

        return new Response(JSON.stringify(anthropicResponse), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        const payloadBytes = new TextEncoder().encode(rawBodyText || "").length;
        const payloadMB = (payloadBytes / (1024 * 1024)).toFixed(2);
        const diag = diagnoseBug({
          statusCode: 500,
          rawMessage: err.message || "Unknown proxy exception",
          provider: targetUrl,
          model: finalModel,
          stats: { payloadMB, images: 0, base64MB: "0.00", msgCount: 0 },
          tokenInfo
        });

        return formatChatDiagnostic({
          stream: wantsStream,
          reqModel,
          statusCode: 500,
          provider: targetUrl,
          model: finalModel,
          payloadMB,
          tokenInfo,
          ...diag
        });
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};

function ensureUserMessage(messages) {
  const hasUser = messages.some((m) => m.role === "user");
  if (hasUser) return messages;

  const sysIdx = messages.findIndex((m) => m.role === "system");
  const fallbackUser = {
    role: "user",
    content: "Continue executing the coding task based on the latest tool outputs."
  };

  if (sysIdx >= 0) {
    const copy = [...messages];
    copy.splice(sysIdx + 1, 0, fallbackUser);
    return copy;
  }
  return [fallbackUser, ...messages];
}

function enforceTokenBudget(messages, tools, maxCharsBudget = 14000) {
  const shrinkContent = (content, limit) => {
    if (typeof content === "string") {
      return content.length > limit
        ? content.slice(0, Math.floor(limit * 0.6)) + "\n...[trimmed]...\n" + content.slice(-Math.floor(limit * 0.35))
        : content;
    }
    if (Array.isArray(content)) {
      return content.map((part) => {
        if (part?.type === "text" && typeof part.text === "string" && part.text.length > limit) {
          return {
            ...part,
            text: part.text.slice(0, Math.floor(limit * 0.6)) + "\n...[trimmed]...\n" + part.text.slice(-Math.floor(limit * 0.35))
          };
        }
        return part;
      });
    }
    return content;
  };

  // 1. Compact system & user/tool messages
  const compactMsgs = messages.map((m) => {
    if (m.role === "system") {
      const rawSys = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
      return {
        role: "system",
        content: "You are an expert AI coding assistant in Claude Code. Be concise.\n" + rawSys.slice(0, 700)
      };
    }
    return {
      ...m,
      content: shrinkContent(m.content, 4000)
    };
  });

  // 2. Keep only 5 core tools with minimal schema
  const coreTools = new Set(["Read", "Write", "Edit", "Bash", "Grep"]);
  const slimTools = tools
    .filter((t) => coreTools.has(t.function?.name))
    .map((t) => {
      const cleanProps = {};
      const props = t.function.parameters?.properties || {};
      for (const [k, v] of Object.entries(props)) {
        cleanProps[k] = { type: v.type || "string" };
      }
      return {
        type: "function",
        function: {
          name: t.function.name,
          description: (t.function.description || "").slice(0, 50),
          parameters: {
            type: "object",
            properties: cleanProps,
            required: t.function.parameters?.required || []
          }
        }
      };
    });

  // 3. Always preserve the latest user message so Qwen/Groq templates never fail
  const sys = compactMsgs.filter((m) => m.role === "system");
  const nonSys = compactMsgs.filter((m) => m.role !== "system");
  const lastUserIdx = nonSys.map((m) => m.role).lastIndexOf("user");
  const lastUserMsg = lastUserIdx >= 0 ? nonSys[lastUserIdx] : null;

  let rest = nonSys.slice(-4);
  if (lastUserMsg && !rest.some((m) => m.role === "user")) {
    rest = [lastUserMsg, ...rest.slice(-3)];
  }

  while (rest.length > 1 && JSON.stringify({ sys, rest, slimTools }).length > maxCharsBudget) {
    // Drop oldest non-user message first, never drop the last user message
    const dropIdx = rest.findIndex((m) => m !== lastUserMsg);
    if (dropIdx >= 0) {
      rest.splice(dropIdx, 1);
    } else {
      break;
    }
  }

  const finalMsgs = ensureUserMessage([...sys, ...rest]);
  const finalTools = JSON.stringify({ finalMsgs, slimTools }).length <= maxCharsBudget ? slimTools : [];
  return { messages: finalMsgs, tools: finalTools };
}

function inspectPayloadStats(reqObj, payloadBytes, payloadMB) {
  const msgs = Array.isArray(reqObj.messages) ? reqObj.messages : [];
  let images = 0;
  let base64Bytes = 0;

  for (const m of msgs) {
    if (Array.isArray(m?.content)) {
      for (const b of m.content) {
        if (b?.type === "image" && typeof b?.source?.data === "string") {
          images += 1;
          base64Bytes += new TextEncoder().encode(b.source.data).length;
        }
      }
    }
  }

  return {
    payloadBytes,
    payloadMB,
    msgCount: msgs.length,
    images,
    base64MB: (base64Bytes / (1024 * 1024)).toFixed(2)
  };
}

function diagnoseBug({ statusCode, rawMessage, provider, model, stats, tokenInfo }) {
  const msgLower = (rawMessage || "").toLowerCase();

  if (msgLower.includes("no user query found in messages")) {
    return {
      title: "Qwen Chat Template Bug (Missing User Turn)",
      rawError: rawMessage,
      cause: "Tool execution ke baad history trim hone par user message array se hat gaya tha, jise Qwen ka template reject karta hai.",
      solution: "Is updated proxy version mein latest 'user' message ko automatically preserve kar diya gaya hai—ab ye error nahi aayega."
    };
  }

  if (statusCode === 401 || statusCode === 403 || msgLower.includes("api key") || msgLower.includes("unauthorized") || msgLower.includes("invalid key")) {
    return {
      title: "API Key / Authentication Bug",
      rawError: rawMessage,
      cause: `${provider} ne API key reject kar di.`,
      solution: "Sahi provider ki valid key use karein (OpenRouter: sk-or-..., Groq: gsk_..., Gemini: AIza..., OpenAI: sk-...)."
    };
  }

  if (
    statusCode === 404 ||
    (msgLower.includes("model") &&
      (msgLower.includes("not found") || msgLower.includes("does not exist") || msgLower.includes("no endpoints")))
  ) {
    return {
      title: "Model Not Found / Unavailable Bug",
      rawError: rawMessage,
      cause: `Model "${model}" ${provider} par available nahi hai.`,
      solution: "X-Target-Model header ko apne account ke active model ID mein badlein."
    };
  }

  if (
    statusCode === 413 ||
    msgLower.includes("tokens per minute") ||
    msgLower.includes("tpm") ||
    msgLower.includes("too large") ||
    msgLower.includes("context length")
  ) {
    return {
      title: "Groq / Provider TPM Token Limit Bug",
      rawError: rawMessage,
      cause: `Raw request ~${tokenInfo?.rawEstTokens || 0} tokens ka tha; trim ke baad ~${tokenInfo?.sentEstTokens || 0} tokens bheje gaye, jo ${provider} (${model}) ke limit se zyada hain.`,
      solution: "/clear chalayein ya chhota prompt bhejein."
    };
  }

  if (statusCode === 429 || msgLower.includes("rate limit") || msgLower.includes("quota")) {
    return {
      title: "Rate Limit / Quota Exceeded Bug",
      rawError: rawMessage,
      cause: `${provider} par requests/tokens limit hit ho gayi hai.`,
      solution: "30–60 seconds ruk kar dubara try karein."
    };
  }

  return {
    title: "Model / Request Processing Bug",
    rawError: rawMessage,
    cause: `Model "${model}" (${provider}) ne request process karte waqt error diya.`,
    solution: "Upar 'Raw Error' mein diya gaya exact message dekhein."
  };
}

function formatChatDiagnostic({
  stream,
  reqModel,
  title,
  statusCode,
  provider,
  model,
  payloadMB,
  tokenInfo,
  rawError,
  cause,
  solution
}) {
  const tokenLine = `- **Token Usage (Est):** Raw \`~${tokenInfo?.rawEstTokens ?? 0}\` tokens → Sent \`~${tokenInfo?.sentEstTokens ?? 0}\` tokens (${tokenInfo?.trimmed ? "Auto-Trimmed" : "Full"})\n`;

  const reportText =
    `### Proxy Bug Alert: ${title}\n\n` +
    `- **Status:** HTTP ${statusCode}\n` +
    `- **Provider:** ${provider}\n` +
    `- **Model:** \`${model}\` (Requested: \`${reqModel}\`)\n` +
    `- **Payload Size:** ${payloadMB} MB\n` +
    tokenLine +
    `- **Raw Error:** \`${rawError}\`\n\n` +
    `**Kya Problem Hai:**\n${cause}\n\n` +
    `**Solution:**\n${solution}`;

  const anthropicErrorBody = {
    type: "error",
    error: {
      type: "api_error",
      message: reportText
    }
  };

  if (stream) {
    const msgId = "msg_diag_" + Date.now();
    const baseMsg = {
      id: msgId,
      type: "message",
      role: "assistant",
      model: reqModel,
      content: [],
      stop_reason: null,
      usage: { input_tokens: tokenInfo?.sentEstTokens || 10, output_tokens: 20 }
    };

    const sse =
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: baseMsg })}\n\n` +
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      })}\n\n` +
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: reportText }
      })}\n\n` +
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 20 }
      })}\n\n` +
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;

    return new Response(sse, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache"
      }
    });
  }

  return new Response(JSON.stringify(anthropicErrorBody), {
    status: statusCode >= 400 ? statusCode : 500,
    headers: { "Content-Type": "application/json" }
  });
}

function buildAnthropicSSE(anthropicResponse, contentBlocks) {
  const sse = [
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: { ...anthropicResponse, content: [] }
    })}\n\n`,
    ...contentBlocks.map((block, idx) => {
      if (block.type === "text") {
        return (
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: idx,
            content_block: { type: "text", text: "" }
          })}\n\n` +
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: idx,
            delta: { type: "text_delta", text: block.text }
          })}\n\n` +
          `event: content_block_stop\ndata: ${JSON.stringify({
            type: "content_block_stop",
            index: idx
          })}\n\n`
        );
      }
      return (
        `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: idx,
          content_block: { type: "tool_use", id: block.id, name: block.name, input: {} }
        })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: idx,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
        })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: idx
        })}\n\n`
      );
    }),
    `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: anthropicResponse.stop_reason },
      usage: { output_tokens: anthropicResponse.usage.output_tokens }
    })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
  ].join("");

  return new Response(sse, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache"
    }
  });
}
