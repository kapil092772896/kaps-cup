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
      return jsonResponse({ input_tokens: 600 });
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

      // 5. ACTIVE PROJECT DETECTOR
      const projectInfo = detectActiveProject(rawSysText, allMsgs);
      const activeProjectName = projectInfo.name;
      const activeProjectRoot = projectInfo.root;
      const memoryFilePath = activeProjectRoot
        ? `${activeProjectRoot.replace(/[\\/]+$/, "")}/PROJECT_MEMORY.md`
        : "PROJECT_MEMORY.md";

      // 6. FULL-HISTORY STATE TRACKER (Kabhi reset nahi hoga)
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
      const readFiles = new Set(); // Normalized lowercase paths
      const modifiedFiles = new Set();
      const ranCommands = new Set();
      const userTasks = [];

      let memoryReadEver = false;
      let memoryMissing = false;
      let memoryUpdatedThisTurn = false;
      let codeModifiedThisTurn = 0;
      let bashRanThisTurn = 0;
      let hasPromptTxt = false;
      let promptTxtRead = false;

      let lastUserTurnIdx = 0;
      for (let i = activeMsgs.length - 1; i >= 0; i--) {
        if (activeMsgs[i].role === "user") {
          const t = extractText(activeMsgs[i].content).trim();
          if (t && !t.startsWith("<system-reminder>") && !t.startsWith("[")) {
            lastUserTurnIdx = i;
            break;
          }
        }
      }

      for (let i = 0; i < activeMsgs.length; i++) {
        const m = activeMsgs[i];
        const isCurrentTurn = i >= lastUserTurnIdx;

        if (m.role === "user") {
          const t = extractText(m.content).trim();
          if (t && !t.startsWith("<system-reminder>") && !t.startsWith("[")) {
            userTasks.push(t.replace(/\s+/g, " ").slice(0, 180));
          }
          if (Array.isArray(m.content)) {
            for (const block of m.content) {
              if (block.type === "tool_result") {
                const resStr = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
                const lowerRes = resStr.toLowerCase();
                if (lowerRes.includes("prompt.txt")) {
                  hasPromptTxt = true;
                }
                if (
                  memoryReadEver &&
                  (lowerRes.includes("does not exist") || lowerRes.includes("no such file") || lowerRes.includes("enoent"))
                ) {
                  memoryMissing = true;
                }
              }
            }
          }
        }

        if (m.role === "assistant" && Array.isArray(m.content)) {
          for (const block of m.content) {
            if (block.type === "tool_use") {
              const rawFp = (block.input?.file_path || "").replace(/\\/g, "/");
              const normFp = rawFp.toLowerCase();
              const isMemFile = normFp.endsWith("project_memory.md");

              if (block.name === "Read" && normFp) {
                if (isMemFile) {
                  memoryReadEver = true;
                } else {
                  readFiles.add(normFp);
                  if (normFp.endsWith("prompt.txt")) promptTxtRead = true;
                }
              } else if ((block.name === "Edit" || block.name === "Write") && normFp) {
                if (isMemFile) {
                  memoryMissing = false;
                  if (isCurrentTurn) memoryUpdatedThisTurn = true;
                } else {
                  modifiedFiles.add(`${block.name}:${rawFp}`);
                  if (isCurrentTurn) {
                    codeModifiedThisTurn++;
                    memoryUpdatedThisTurn = false;
                  }
                }
              } else if (block.name === "Bash" && block.input?.command) {
                ranCommands.add(block.input.command.trim());
                if (isCurrentTurn) bashRanThisTurn++;
              }
            }
          }
        }
      }

      const latestUserPrompt = userTasks[userTasks.length - 1] || "";
      const promptFilePath = activeProjectRoot
        ? `${activeProjectRoot.replace(/[\\/]+$/, "")}/prompt.txt`
        : "prompt.txt";

      // 7. STRICT NON-REPEATING PIPELINE
      let workflowInstruction = "";
      let forceToolChoice = "auto";

      if (memoryMissing) {
        workflowInstruction =
          `"${memoryFilePath}" does NOT exist. Call Write NOW to create "${memoryFilePath}" with "# Project: ${activeProjectName}\n\n## Completed Tasks\n- Initialized\n\n## Pending Tasks\n- ${latestUserPrompt}\n\n## Recent Changes\n- Created memory file".`;
        forceToolChoice = "required";
      } else if (!memoryReadEver) {
        workflowInstruction = `Call Read ONCE on "${memoryFilePath}". NEVER read it again after this.`;
        forceToolChoice = "required";
      } else if (hasPromptTxt && !promptTxtRead) {
        workflowInstruction =
          `PROJECT_MEMORY.md is already read. Folder has "prompt.txt". Call Read ONCE on "${promptFilePath}" to get project specs, then immediately build the files.`;
        forceToolChoice = "required";
      } else if (codeModifiedThisTurn === 0) {
        workflowInstruction =
          `STOP running ls or reading PROJECT_MEMORY.md! Start building the project files NOW using Write or Edit in "${activeProjectName}". ` +
          `Create multiple files in parallel if needed. Already read (DO NOT READ AGAIN): [${Array.from(readFiles).join(", ")}, project_memory.md].`;
        forceToolChoice = "required";
      } else if (codeModifiedThisTurn > 0 && !memoryUpdatedThisTurn) {
        workflowInstruction =
          `Files created/updated (${Array.from(modifiedFiles).slice(-4).join(", ")}). Now update "${memoryFilePath}" using Write or Edit with completed work and remaining tasks.`;
        forceToolChoice = "required";
      } else {
        workflowInstruction =
          `Work completed and PROJECT_MEMORY.md updated. Give a short 2-line summary of files created/updated in "${activeProjectName}".`;
        forceToolChoice = "auto";
      }

      // 8. Build Compact Context (~600 tokens max)
      const groqMessages = [
        {
          role: "system",
          content:
            `You are Claude Code in project "${activeProjectName}". Execute multiple file creations/edits in parallel in one turn.\n` +
            workflowInstruction,
        },
      ];

      if (latestUserPrompt) {
        groqMessages.push({
          role: "user",
          content: `TASK [${activeProjectName}]: ${latestUserPrompt}`,
        });
      }

      // Aakhiri 2 messages add karein (tool_result ko 1200 chars tak rakhein taaki prompt.txt ke specs aa sakein)
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

      // 9. Dynamic Tools (Read tool ko tab hata dein jab PROJECT_MEMORY.md aur prompt.txt dono read ho chuke hon)
      const compactTools = [
        {
          type: "function",
          function: {
            name: "Write",
            description: "Create or overwrite a file with full code",
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
            description: "Replace exact text in a file",
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
      ];

      // Read sirf tab dein jab PROJECT_MEMORY.md ya koi unread file bachi ho
      if (!memoryReadEver || (hasPromptTxt && !promptTxtRead) || readFiles.size < 2) {
        compactTools.push({
          type: "function",
          function: {
            name: "Read",
            description: "Read an unread file ONCE",
            parameters: {
              type: "object",
              properties: { file_path: { type: "string" } },
              required: ["file_path"],
            },
          },
        });
      }

      // Bash sirf tab dein jab pehle ls na chala ho
      if (bashRanThisTurn === 0 && ranCommands.size < 2) {
        compactTools.push({
          type: "function",
          function: {
            name: "Bash",
            description: "Run shell command (never repeat ls)",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        });
      }

      // 10. Smart Model Routing & Auto-Fallback
      const isBackgroundModel = requestedModel.toLowerCase().includes("haiku");
      const mainModel = request.headers.get("X-Target-Model") || env.TARGET_MODEL || "llama-3.3-70b-versatile";
      const fastModel = "llama-3.1-8b-instant";
      const chosenModel = isBackgroundModel ? fastModel : mainModel;

      let groqRes = await callGroq(apiKey, chosenModel, groqMessages, compactTools, forceToolChoice);

      if (!groqRes.ok && chosenModel !== fastModel) {
        groqRes = await callGroq(apiKey, fastModel, groqMessages, compactTools, forceToolChoice);
      }

      if (!groqRes.ok) {
        const errText = await groqRes.text();
        return anthropicError(`Groq (${groqRes.status}): ${errText.slice(0, 180)}`, 502);
      }

      const groqData = await groqRes.json();
      const choice = groqData.choices?.[0]?.message || {};
      let toolCalls = choice.tool_calls || [];

      // 11. Hard Blocker: Duplicate Read & Duplicate ls Commands
      toolCalls = toolCalls.filter((tc) => {
        if (tc.function?.name === "Read") {
          try {
            const args = JSON.parse(tc.function.arguments || "{}");
            const normFp = (args.file_path || "").replace(/\\/g, "/").toLowerCase();
            if (!normFp) return false;
            if (normFp.endsWith("project_memory.md")) return !memoryReadEver;
            if (readFiles.has(normFp)) return false;
          } catch {
            return false;
          }
        }
        if (tc.function?.name === "Bash") {
          try {
            const args = JSON.parse(tc.function.arguments || "{}");
            const cmd = (args.command || "").trim();
            if (ranCommands.has(cmd) || cmd.startsWith("ls ")) return false;
          } catch {
            return false;
          }
        }
        return true;
      });

      const finalReplyText =
        choice.content ||
        (toolCalls.length === 0 ? `Completed updates in [${activeProjectName}].` : "");

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

async function callGroq(apiKey, model, messages, tools, toolChoice = "auto") {
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
      tool_choice: toolChoice,
      parallel_tool_calls: true,
      max_tokens: 2048,
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
    return { role, content: content.slice(-1100) };
  }

  if (Array.isArray(content)) {
    const toolRes = content.find((c) => c.type === "tool_result");
    if (toolRes) {
      const out = typeof toolRes.content === "string" ? toolRes.content : JSON.stringify(toolRes.content);
      return {
        role: "tool",
        tool_call_id: toolRes.tool_use_id || "call_1",
        content: out.slice(0, 1200),
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
      .slice(-1100);
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
      id: tc.id || "toolu_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
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
        usage: { input_tokens: 600, output_tokens: 1 },
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
      usage: { output_tokens: 200 },
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
    usage: { input_tokens: 600, output_tokens: 200 },
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
