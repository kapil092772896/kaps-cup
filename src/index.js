export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check endpoint
    if (request.method === "GET") {
      // 1. Models List Endpoint (Claude Code startup validation ke liye zaroori)
    if (request.method === "GET" && url.pathname.endsWith("/v1/models")) {
      return new Response(JSON.stringify({
        data: [
          { id: "claude-sonnet-4-5-20250929", object: "model", created: 1735689600, owned_by: "anthropic" },
          { id: "claude-3-5-sonnet-20241022", object: "model", created: 1735689600, owned_by: "anthropic" },
          { id: "claude-haiku-4-5-20251001", object: "model", created: 1735689600, owned_by: "anthropic" }
        ]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    // 2. Token Count Endpoint (Claude Code context check ke liye)
    if (request.method === "POST" && url.pathname.endsWith("/v1/messages/count_tokens")) {
      return new Response(JSON.stringify({ input_tokens: 100 }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    // 3. Health check endpoint
    if (request.method === "GET") {
      return new Response(JSON.stringify({
        status: "running",
        project: "kaps-cup universal smart AI proxy",
        usage: "Set X-Target-Model header in settings.json to use ANY model"
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    }

    // Claude Code Messages Endpoint
    if (request.method === "POST" && url.pathname.endsWith("/v1/messages")) {
      try {
        const anthropicReq = await request.json();
        const rawAuth = request.headers.get("x-api-key") || request.headers.get("authorization") || "";
        const apiKey = rawAuth.replace("Bearer ", "").trim();

        // 1. Custom Header se Model padhein (agar nahi diya to key ke hisaab se default chunein)
        const customModelHeader = request.headers.get("x-target-model")?.trim();
        const reqModel = anthropicReq.model || "";
        const selectedModel = customModelHeader || (!reqModel.startsWith("claude-") ? reqModel : "");

        // 2. Convert Anthropic messages to OpenAI-compatible format
        const openAiMessages = [];

        if (anthropicReq.system) {
          const sysText = Array.isArray(anthropicReq.system)
            ? anthropicReq.system.map(s => s.text).join("\n")
            : anthropicReq.system;
          openAiMessages.push({ role: "system", content: sysText });
        }

        for (const msg of anthropicReq.messages || []) {
          if (typeof msg.content === "string") {
            openAiMessages.push({ role: msg.role, content: msg.content });
          } else if (Array.isArray(msg.content)) {
            let textParts = [];
            let toolCalls = [];

            for (const block of msg.content) {
              if (block.type === "text") {
                textParts.push(block.text);
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
                  content: typeof block.content === "string" ? block.content : JSON.stringify(block.content)
                });
              }
            }

            if (textParts.length > 0 || toolCalls.length > 0) {
              const outMsg = { role: msg.role, content: textParts.join("\n") || null };
              if (toolCalls.length > 0) outMsg.tool_calls = toolCalls;
              openAiMessages.push(outMsg);
            }
          }
        }

        // Convert Tools
        const openAiTools = (anthropicReq.tools || []).map(t => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description || "",
            parameters: t.input_schema
          }
        }));

        // 3. Smart Provider & Model Routing (Key + Selected Model ke base par)
        let targetUrl = "";
        let finalModel = selectedModel;
        const headers = {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        };

        if (apiKey.startsWith("gsk_")) {
          // GROQ Provider
          targetUrl = "https://api.groq.com/openai/v1/chat/completions";
          finalModel = (selectedModel || "llama-3.3-70b-versatile").replace(/^groq\//, "");
        } else if (apiKey.startsWith("AIza")) {
          // GOOGLE GEMINI Provider
          targetUrl = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
          finalModel = (selectedModel || "gemini-2.5-flash-lite").replace(/^google\//, "");
          headers["x-goog-api-key"] = apiKey;
        } else if (apiKey.startsWith("sk-or-")) {
          // OPENROUTER Provider (Koi bhi free/paid model chalayein)
          targetUrl = "https://openrouter.ai/api/v1/chat/completions";
          finalModel = selectedModel || "cohere/north-mini-code:free";
          headers["HTTP-Referer"] = "https://kaps-cup.workers.dev";
          headers["X-Title"] = "kaps-cup-proxy";
        } else if (apiKey.startsWith("sk-")) {
          // OFFICIAL OPENAI Provider
          targetUrl = "https://api.openai.com/v1/chat/completions";
          finalModel = (selectedModel || "gpt-4o-mini").replace(/^openai\//, "");
        } else {
          // Fallback: OpenAI-compatible custom endpoint (e.g., Requesty, Together, DeepSeek)
          targetUrl = "https://openrouter.ai/api/v1/chat/completions";
          finalModel = selectedModel || "openrouter/free";
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

        // 4. Call Target AI API
        const aiRes = await fetch(targetUrl, {
          method: "POST",
          headers: headers,
          body: JSON.stringify(providerPayload)
        });

        const aiData = await aiRes.json();

        if (!aiRes.ok) {
          return new Response(JSON.stringify({
            type: "error",
            error: {
              type: "api_error",
              message: `[${finalModel}] ${aiData.error?.message || JSON.stringify(aiData)}`
            }
          }), { status: aiRes.status, headers: { "Content-Type": "application/json" } });
        }

        // 5. Convert Response back to Anthropic Format
        const choice = aiData.choices?.[0]?.message || {};
        const contentBlocks = [];

        if (choice.content) {
          contentBlocks.push({ type: "text", text: choice.content });
        }

        if (choice.tool_calls) {
          for (const tc of choice.tool_calls) {
            let parsedArgs = {};
            try { parsedArgs = JSON.parse(tc.function.arguments || "{}"); } catch (e) {}
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

        // Handle Streaming (SSE)
        if (anthropicReq.stream) {
          const sse = [
            `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { ...anthropicResponse, content: [] } })}\n\n`,
            ...contentBlocks.map((block, idx) => {
              if (block.type === "text") {
                return `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: idx, content_block: { type: "text", text: "" } })}\n\n` +
                       `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: idx, delta: { type: "text_delta", text: block.text } })}\n\n` +
                       `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: idx })}\n\n`;
              } else {
                return `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: idx, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } })}\n\n` +
                       `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } })}\n\n` +
                       `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: idx })}\n\n`;
              }
            }),
            `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: anthropicResponse.stop_reason }, usage: { output_tokens: anthropicResponse.usage.output_tokens } })}\n\n`,
            `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
          ].join("");

          return new Response(sse, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache"
            }
          });
        }

        return new Response(JSON.stringify(anthropicResponse), {
          headers: { "Content-Type": "application/json" }
        });

      } catch (err) {
        return new Response(JSON.stringify({
          type: "error",
          error: { type: "proxy_error", message: err.message }
        }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};
