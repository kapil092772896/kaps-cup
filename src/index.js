export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    // 2. Exact Anthropic /v1/models & /v1/models/:id Response
    if (url.pathname.includes("/v1/models")) {
      const parts = url.pathname.split("/v1/models/");
      if (parts[1]) {
        const modelId = decodeURIComponent(parts[1]).replace(/\/+$/, "");
        return jsonResponse({
          type: "model",
          id: modelId,
          display_name: modelId,
          created_at: "2024-10-22T00:00:00Z",
        });
      }
      return jsonResponse({
        data: [
          { type: "model", id: "claude-3-5-sonnet-20241022", display_name: "Claude 3.5 Sonnet", created_at: "2024-10-22T00:00:00Z" },
          { type: "model", id: "claude-3-5-haiku-20241022", display_name: "Claude 3.5 Haiku", created_at: "2024-10-22T00:00:00Z" },
          { type: "model", id: "claude-sonnet-4-5-20250929", display_name: "Claude Sonnet 4.5", created_at: "2025-09-29T00:00:00Z" },
          { type: "model", id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", created_at: "2025-10-01T00:00:00Z" },
        ],
        has_more: false,
        first_id: "claude-3-5-sonnet-20241022",
        last_id: "claude-haiku-4-5-20251001",
      });
    }

    // 3. Token Counter Bypass
    if (url.pathname.includes("/count_tokens")) {
      return jsonResponse({ input_tokens: 550 });
    }

    if (request.method !== "POST") {
      return new Response("OK", { status: 200 });
    }

    try {
      const body = await request.json();
      const requestedModel = body.model || "claude-3-5-sonnet-20241022";

      const apiKey =
        env.GROQ_API_KEY ||
        request.headers.get("x-api-key") ||
        (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");

      if (!apiKey) {
        return anthropicError("GROQ_API_KEY missing in Worker secrets.", 401);
      }

      // 4. Background Noise Blocker (0 Groq tokens)
      const rawSysText = extractText(body.system);
      const sysTextLower = rawSysText.toLowerCase();
      const allMsgs = body.messages || [];
      const lastMsg = allMsgs[allMsgs.length - 1];
      const rawText = extractText(lastMsg?.content);
      const lowerRaw = rawText.toLowerCase().trim();

      if (
        sysTextLower.includes("5-10 word title") ||
        sysTextLower.includes("concise title") ||
        sysTextLower.includes("summarize this coding session") ||
        lowerRaw.includes("please write a 5-10 word title") ||
        lowerRaw.includes("generate a concise title") ||
        lowerRaw === "ping" ||
        lowerRaw === "test"
      ) {
        return buildAnthropicReply({ text: "Coding Task" }, body.stream, requestedModel);
      }

      // 5. ACTIVE PROJECT DETECTOR (Har project ke root mein apni PROJECT_MEMORY.md banegi)
      const projectInfo = detectActiveProject(rawSysText, allMsgs);
      const activeProjectName = projectInfo.name;
      const activeProjectRoot = projectInfo.root;
      const memoryFilePath = activeProjectRoot
        ? `${activeProjectRoot.replace(/[\\/]+$/, "")}/PROJECT_MEMORY.md`
        : "PROJECT_MEMORY.md";

      // 6. SESSION STATE TRACKER (Check karein ki is turn mein PROJECT_MEMORY.md padhi/update hui ya nahi)
      let startIdx = 0;
      if (activeProjectName !== "default") {
        for (let i = allMsgs.length - 1; i >= 0; i--) {
          const msgStr = JSON.stringify(allMsgs[i]);
          if (msgStr.includes("Working directory:") && !msgStr.toLowerCase().includes(activeProjectName.toLowerCase())) {
            startIdx = i + 1;
            break;
          }
        }
      }

      const activeMsgs = allMsgs.slice(startIdx);
      const readFiles = new Set();
      const modifiedFiles = new Set();
      const userTasks = [];
      let memoryReadInSession = false;
      let memoryUpdatedAfterWork = false;
      let codeModifiedCount = 0;

      for (const m of activeMsgs) {
        if (m.role === "user") {
          const t = extractText(m.content).trim();
          if (t && !t.startsWith("<system-reminder>") && !t.startsWith("[")) {
            userTasks.push(t.replace(/\s+/g, " ").slice(0, 140));
          }
        }
        if (m.role === "assistant" && Array.isArray(m.content)) {
          for (const block of m.content) {
            if (block.type === "tool_use") {
              const fp = (block.input?.file_path || "").replace(/\\/g, "/");
              const isMemFile = fp.toLowerCase().endsWith("project_memory.md");

              if (block.name === "Read" && fp) {
                if (isMemFile) {
                  memoryReadInSession = true;
                } else {
                  readFiles.add(fp);
                }
              } else if ((block.name === "Edit" || block.name === "Write") && fp) {
                if (isMemFile) {
                  memoryUpdatedAfterWork = true;
                } else {
                  modifiedFiles.add(`${block.name}:${fp}`);
                  codeModifiedCount++;
                  memoryUpdatedAfterWork = false; // Har naye code change ke baad memory update zaroori hai
                }
              }
            }
          }
        }
      }

      const latestUserPrompt = userTasks[userTasks.length - 1] || "";

      // 7. STRICT WORKFLOW ENFORCEMENT (Read PROJECT_MEMORY.md First -> Do Task -> Update PROJECT_MEMORY.md)
      let workflowInstruction = "";

      if (!memoryReadInSession) {
        workflowInstruction =
          `MANDATORY STEP 1: Before doing anything else, call Read on "${memoryFilePath}" to check project history, completed tasks, and pending tasks. ` +
          `If Read fails because the file does not exist yet, create "${memoryFilePath}" using Write with sections: "# Project: ${activeProjectName}", "## Completed Tasks", "## Pending Tasks", "## Recent Changes".`;
      } else if (codeModifiedCount > 0 && !memoryUpdatedAfterWork) {
        workflowInstruction =
          `MANDATORY FINAL STEP: You just modified code (${Array.from(modifiedFiles).slice(-3).join(", ")}). ` +
          `Now immediately update "${memoryFilePath}" using Edit or Write to move finished items to "## Completed Tasks", update "## Pending Tasks", and log what changed under "## Recent Changes". Then finish.`;
      } else {
        workflowInstruction =
          `STEP 2 (EXECUTION): Execute the user's current/pending task in "${activeProjectName}". ` +
          `Do NOT re-read already read files: [${Array.from(readFiles).join(", ")}]. ` +
          `After modifying any code file, you MUST update "${memoryFilePath}" with the new progress.`;
      }

      // 8. Build Compact Context (~550 tokens max)
      const groqMessages = [
        {
          role: "system",
          content:
            `You are Claude Code in project "${activeProjectName}" (Memory File: "${memoryFilePath}"). ` +
            `STRICT WORKFLOW: 1) Always read "${memoryFilePath}" first before starting work. 2) Execute next/pending task without unnecessary file reads. 3) Always update "${memoryFilePath}" with newly completed work and remaining pending tasks before finishing.\n` +
            workflowInstruction,
        },
      ];

      if (latestUserPrompt) {
        groqMessages.push({
          role: "user",
          content: `CURRENT USER REQUEST [${activeProjectName}]: ${latestUserPrompt}`,
        });
      }

      // Sirf aakhiri 2 messages (latest tool call + tool result) rakhein
      const recentMsgs = activeMsgs.slice(-2);
      for (const m of recentMsgs) {
        const mapped = mapAnthropicToGroqMsg(m);
        if (mapped) {
          if (mapped.role === "user" && latestUserPrompt && mapped.content.includes(latestUserPrompt.slice(0, 60))) {
            continue;
          }
          groqMessages.push(mapped);
        }
      }

      // 9. Compact Tools (Read hamesha available rahega PROJECT_MEMORY.md ke liye, baaki files max 3)
      const compactTools = [
        {
          type: "function",
          function: {
            name: "Read",
            description: `Read "${memoryFilePath}" first, or read an unread project file ONLY when needed`,
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
            name: "Edit",
            description: "Replace exact text in a file or update PROJECT_MEMORY.md",
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
            name: "Write",
            description: "Create or overwrite a file (including PROJECT_MEMORY.md)",
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
            name: "Bash",
            description: "Run shell command in active project",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        },
      ];

      // 10. Smart Model Routing & Auto-Fallback
      const isBackgroundModel = requestedModel.toLowerCase().includes("haiku");
      const mainModel = request.headers.get("X-Target-Model") || env.TARGET_MODEL || "llama-3.3-70b-versatile";
      const fastModel = "llama-3.1-8b-instant";
      const chosenModel = isBackgroundModel ? fastModel : mainModel;

      let groqRes = await callGroq(apiKey, chosenModel, groqMessages, compactTools);

      if (!groqRes.ok && chosenModel !== fastModel) {
        groqRes = await callGroq(apiKey, fastModel, groqMessages, compactTools);
      }

      if (!groqRes.ok) {
        const errText = await groqRes.text();
        return anthropicError(`Groq (${groqRes.status}): ${errText.slice(0, 180)}`, 502);
      }

      const groqData = await groqRes.json();
      const choice = groqData.choices?.[0]?.message || {};
      let toolCalls = choice.tool_calls || [];

      // 11. Hard Duplicate-Read Blocker (PROJECT_MEMORY.md ke ilawa kisi bhi file ko dubara read nahi karne dega)
      toolCalls = toolCalls.filter((tc) => {
        if (tc.function?.name === "Read") {
          try {
            const args = JSON.parse(tc.function.arguments || "{}");
            const fp = (args.file_path || "").replace(/\\/g, "/");
            if (!fp) return false;
            if (fp.toLowerCase().endsWith("project_memory.md")) return true;
            if (readFiles.has(fp) || readFiles.size >= 3) return false;
          } catch {
            return false;
          }
        }
        return true;
      });

      const finalReplyText =
        !choice.content && toolCalls.length === 0
          ? `Updated [${activeProjectName}] and synced PROJECT_MEMORY.md. Ready for the next task.`
          : choice.content || "";

      return buildAnthropicReply(
        {
          text: finalReplyText,
          toolCalls,
        },
        body.stream,
        requestedModel
      );
    } catch (err) {
      return anthropicError(`Proxy Error: ${err.message}`, 500);
    }
  },
};

// --- Helpers ---

function detectActiveProject(sysText, messages) {
  const cwdMatch = sysText.match(/working directory:\s*([^\r\n]+)/i);
  if (cwdMatch && cwdMatch[1]) {
    const cleanRoot = cwdMatch[1].trim().replace(/[\\/]+$/, "").replace(/\\/g, "/");
    const folderName = cleanRoot.split("/").pop();
    if (folderName) {
      return { name: folderName, root: cleanRoot };
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        const fp = (block.input?.file_path || "").replace(/\\/g, "/");
        if (fp && fp.includes("/")) {
          const parts = fp.split("/").filter(Boolean);
          if (parts.length >= 2) {
            return { name: parts[parts.length - 2], root: parts.slice(0, -1).join("/") };
          }
        }
      }
    }
  }

  return { name: "default", root: "" };
}

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
    return { role, content: content.slice(-900) };
  }

  if (Array.isArray(content)) {
    const toolRes = content.find((c) => c.type === "tool_result");
    if (toolRes) {
      const out = typeof toolRes.content === "string" ? toolRes.content : JSON.stringify(toolRes.content);
      return {
        role: "tool",
        tool_call_id: toolRes.tool_use_id || "call_1",
        content: out.slice(0, 900),
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
      .slice(-900);
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
      message: {
        id,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        usage: { input_tokens: 550, output_tokens: 1 },
      },
    })}\n\n`;

    contentBlocks.forEach((block, idx) => {
      if (block.type === "text") {
        sse += `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: idx,
          content_block: { type: "text", text: "" },
        })}\n\n`;
        sse += `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: idx,
          delta: { type: "text_delta", text: block.text },
        })}\n\n`;
        sse += `event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: idx,
        })}\n\n`;
      } else if (block.type === "tool_use") {
        sse += `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: idx,
          content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
        })}\n\n`;
        sse += `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: idx,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
        })}\n\n`;
        sse += `event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: idx,
        })}\n\n`;
      }
    });

    sse += `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 150 },
    })}\n\n`;
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
    usage: { input_tokens: 550, output_tokens: 150 },
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
