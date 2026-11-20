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
          project: "kaps-cup smart bug-reporting AI proxy",
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

      try {
        rawBodyText = await request.text();
        const payloadBytes = new TextEncoder().encode(rawBodyText).length;
        const payloadMB = (payloadBytes / (1024 * 1024)).toFixed(2);

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
            rawError: parseErr.message,
            cause: "Client se bheja gaya request JSON valid nahi hai ya beech mein cut gaya hai.",
            solution: "1. Ek naya session/prompt try karein.\n2. Agar badi file/image paste ki hai toh chhote chunks mein bhejein."
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
            rawError: "No x-api-key or Authorization header received.",
            cause: "Claude Code se proxy ko API key nahi mil rahi hai.",
            solution: "1. Environment ya settings.json mein ANTHROPIC_API_KEY (ya provider key) set karein.\n2. Terminal restart karke dubara claude chalayein."
          });
        }

        // Convert Anthropic messages to OpenAI-compatible format
        const openAiMessages = [];
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

        const openAiTools = (anthropicReq.tools || []).map((t) => ({
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
          finalModel = (selectedModel || "llama-3.3-70b-versatile").replace(/^groq\//, "");
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
        // Groq Free/On-Demand ITPM Limit (7k-8k tokens) ke liye smart payload compression
        if (providerName === "Groq") {
          // 1. System prompt ko compact karein (max 1800 chars)
          for (const m of openAiMessages) {
            if (m.role === "system" && typeof m.content === "string" && m.content.length > 1800) {
              m.content =
                "You are Claude Code, an expert AI coding assistant. Use available tools accurately and concisely.\n\n" +
                m.content.slice(0, 1500);
            }
          }
        
          // 2. Sirf core coding tools rakhein aur unke heavy descriptions trim karein
          const coreTools = new Set(["Read", "Write", "Edit", "MultiEdit", "Bash", "Glob", "Grep", "LS"]);
          const slimTools = openAiTools
            .filter((t) => coreTools.has(t.function.name))
            .map((t) => {
              const cleanProps = {};
              const props = t.function.parameters?.properties || {};
              for (const [k, v] of Object.entries(props)) {
                cleanProps[k] = {
                  type: v.type || "string",
                  ...(v.enum ? { enum: v.enum } : {}),
                  ...(v.items ? { items: { type: v.items.type || "string" } } : {})
                };
              }
              return {
                type: "function",
                function: {
                  name: t.function.name,
                  description: (t.function.description || "").slice(0, 100),
                  parameters: {
                    type: "object",
                    properties: cleanProps,
                    required: t.function.parameters?.required || []
                  }
                }
              };
            });
        
          openAiTools.length = 0;
          openAiTools.push(...slimTools);
        
          // 3. Agar conversation history bahut badi ho gayi hai toh sirf aakhiri 6 messages rakhein
          const sysMsgs = openAiMessages.filter((m) => m.role === "system");
          const chatMsgs = openAiMessages.filter((m) => m.role !== "system");
          if (chatMsgs.length > 6) {
            openAiMessages.length = 0;
            openAiMessages.push(...sysMsgs, ...chatMsgs.slice(-6));
          }
        }
        const providerPayload = {
          model: finalModel,
          messages: openAiMessages,
          max_tokens: anthropicReq.max_tokens || 4096,
          temperature: anthropicReq.temperature ?? 0.2,
          stream: false
        };

        if (openAiTools.length > 0) {
          providerPayload.tools = openAiTools;
        }

        const aiRes = await fetch(targetUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(providerPayload)
        });

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
            stats
          });
          return formatChatDiagnostic({
            stream: wantsStream,
            reqModel,
            statusCode: aiRes.status || 502,
            provider: providerName,
            model: finalModel,
            payloadMB: stats.payloadMB,
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
            stats
          });

          return formatChatDiagnostic({
            stream: wantsStream,
            reqModel,
            statusCode: aiRes.status,
            provider: providerName,
            model: finalModel,
            payloadMB: stats.payloadMB,
            ...diag
          });
        }

        // Convert Response back to Anthropic Format
        const choice = aiData.choices?.[0]?.message || {};
        const contentBlocks = [];

        if (choice.content) {
          contentBlocks.push({ type: "text", text: choice.content });
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
            input_tokens: aiData.usage?.prompt_tokens || 10,
            output_tokens: aiData.usage?.completion_tokens || 10
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
          stats: { payloadMB, images: 0, base64MB: "0.00", msgCount: 0 }
        });

        return formatChatDiagnostic({
          stream: wantsStream,
          reqModel,
          statusCode: 500,
          provider: targetUrl,
          model: finalModel,
          payloadMB,
          ...diag
        });
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};

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

function diagnoseBug({ statusCode, rawMessage, provider, model, stats }) {
  const msgLower = (rawMessage || "").toLowerCase();

  // 1. Auth / API Key errors
  if (statusCode === 401 || statusCode === 403 || msgLower.includes("api key") || msgLower.includes("unauthorized") || msgLower.includes("invalid key")) {
    return {
      title: "API Key / Authentication Bug",
      rawError: rawMessage,
      cause: `${provider} ne API key reject kar di. Key invalid/expired ho sakti hai ya key ka prefix (${provider}) se match nahi kar raha.`,
      solution:
        "1. Check karein ki aap sahi provider ki key use kar rahe hain (OpenRouter: sk-or-..., Groq: gsk_..., Gemini: AIza..., OpenAI: sk-...).\n" +
        "2. Key expire ya revoke hui ho toh nayi key generate karke update karein."
    };
  }

  // 2. Model not found / unavailable
  if (statusCode === 404 || msgLower.includes("model") && (msgLower.includes("not found") || msgLower.includes("does not exist") || msgLower.includes("no endpoints"))) {
    return {
      title: "Model Not Found / Unavailable Bug",
      rawError: rawMessage,
      cause: `Model "${model}" ${provider} par available nahi hai, ya free/paid access restricted hai.`,
      solution:
        "1. X-Target-Model header ya model name ko ek valid active model mein badlein (jaise OpenRouter ke liye 'openrouter/free' ya 'cohere/north-mini-code:free', Groq ke liye 'llama-3.3-70b-versatile').\n" +
        "2. Agar free model temporary down hai toh doosra working model try karein."
    };
  }

  // 3. Payload / Context / Size / 32MB limit issues
  // diagnoseBug ke andar "3. Payload / Context / Size / 32MB limit issues" wale block ko isse replace karein:
if (
  statusCode === 413 ||
  msgLower.includes("tokens per minute") ||
  msgLower.includes("tpm") ||
  msgLower.includes("32mb") ||
  msgLower.includes("too large") ||
  msgLower.includes("context length") ||
  msgLower.includes("max_tokens") ||
  msgLower.includes("payload")
) {
  const isTpmError = msgLower.includes("tokens per minute") || msgLower.includes("tpm");
  return {
    title: isTpmError ? "Groq / Provider TPM Token Limit Bug" : "Payload / Context Size Limit Bug",
    rawError: rawMessage,
    cause: isTpmError
      ? `Payload size sirf ${stats.payloadMB} MB hai, lekin Claude Code ke system prompt + tools ki wajah se request mein ~34k+ tokens ban rahe hain, jo ${provider} (${model}) ke TPM limit se zyada hain.`
      : `Request ka size ~${stats.payloadMB} MB hai (Messages: ${stats.msgCount}, Images: ${stats.images}, Base64: ${stats.base64MB} MB). Input ya image/context size limit se zyada ja raha hai.`,
    solution: isTpmError
      ? "1. Model badlein (X-Target-Model mein zyada TPM/context wala model set karein) ya Groq billing/tier check karein.\n2. Claude Code mein heavy MCP servers/tools kam karein ya OpenRouter/Gemini/OpenAI provider try karein."
      : "1. Naya session shuru karein ya /clear chalayein taaki purani context/attachments hat jayein.\n2. Badi images/screenshots compress karein ya poore file paste karne ke bajay sirf relevant lines/file path dein."
  };
}

  // 4. Rate limit / Quota
  if (statusCode === 429 || msgLower.includes("rate limit") || msgLower.includes("quota") || msgLower.includes("too many requests")) {
    return {
      title: "Rate Limit / Quota Exceeded Bug",
      rawError: rawMessage,
      cause: `${provider} par requests/tokens/credits ki limit (RPM/TPM/free quota) hit ho gayi hai.`,
      solution:
        "1. 30–60 seconds ruk kar dubara try karein.\n" +
        "2. Free tier ya rate-limited model ke bajay doosra model ya billing/credits wala account use karein."
    };
  }

  // 5. Upstream server / timeout / gateway error
  if (statusCode >= 500 || msgLower.includes("timeout") || msgLower.includes("fetch failed") || msgLower.includes("bad gateway")) {
    return {
      title: "Upstream Model / Server Error",
      rawError: rawMessage,
      cause: `${provider} (${model}) side par temporary server error, timeout, ya invalid response aaya hai.`,
      solution:
        "1. Thodi der baad retry karein—upstream provider par temporary glitch ho sakta hai.\n" +
        "2. Agar ek particular model baar-baar fail ho raha hai toh X-Target-Model se model switch karke test karein."
    };
  }

  // 6. Generic / Schema / Tool call bug
  return {
    title: "Model / Request Processing Bug",
    rawError: rawMessage,
    cause: `Model "${model}" (${provider}) ne request process karte waqt error diya (Payload: ${stats.payloadMB} MB).`,
    solution:
      "1. Upar 'Raw Error' mein diya gaya exact message dekhein ki kaunsa field/parameter reject hua.\n" +
      "2. Pehle ek chhote prompt ('hi') se test karein taaki pata chale issue prompt/tools ka hai ya model ka."
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
  rawError,
  cause,
  solution
}) {
  const reportText =
    `### Proxy Bug Alert: ${title}\n\n` +
    `- **Status:** HTTP ${statusCode}\n` +
    `- **Provider:** ${provider}\n` +
    `- **Model:** \`${model}\` (Requested: \`${reqModel}\`)\n` +
    `- **Payload Size:** ${payloadMB} MB\n` +
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
      usage: { input_tokens: 10, output_tokens: 20 }
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
