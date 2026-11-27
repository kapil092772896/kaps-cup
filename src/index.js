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

    // 2. Anthropic /v1/models & /v1/models/:id Validation
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

      // 4. Background Noise Blocker (Title generation, summary, ping -> 0 Groq tokens)
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

      // 5. Project & Workspace Detection
      const projectInfo = detectActiveProject(rawSysText, allMsgs);
      const activeProjectName = projectInfo.name;
      const activeProjectRoot = projectInfo.root;
      const isWorkspaceParent = /^(project|projects|htdocs|www)$/i.test(activeProjectName);

      // 6. Full Session State Analysis (Clean, Ignores <system-reminder>)
      const readFiles = new Set();
      const modifiedFiles = new Set();
      const ranCommands = new Set();
      const cleanUserPrompts = [];
      let lastUserIdx = 0;

      for (let i = 0; i < allMsgs.length; i++) {
        if (allMsgs[i].role === "user") {
          const pure = extractPureUserPrompt(allMsgs[i].content);
          if (pure) {
            cleanUserPrompts.push(pure);
            lastUserIdx = i;
          }
        }
      }

      let detectedSubProject = "";
      let hasPromptTxt = false;
      let promptTxtRead = false;
      let memoryChecked = false;
      let memoryMissing = false;
      let memoryUpdatedThisTurn = false;
      let codeWorkThisTurn = 0;
      let bashWorkThisTurn = 0;

      for (let i = 0; i < allMsgs.length; i++) {
        const m = allMsgs[i];
        const isCurrentTurn = i >= lastUserIdx;

        // Inspect tool_results for directory listings, prompt.txt, or missing PROJECT_MEMORY.md
        if (m.role === "user" && Array.isArray(m.content)) {
          for (const block of m.content) {
            if (block.type === "tool_result") {
              const resStr = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
              const lowerRes = resStr.toLowerCase();

              if (lowerRes.includes("prompt.txt")) {
                hasPromptTxt = true;
              }
              if (
                memoryChecked &&
                !memoryUpdatedThisTurn &&
                (lowerRes.includes("does not exist") || lowerRes.includes("no such file") || lowerRes.includes("enoent"))
              ) {
                memoryMissing = true;
              }
              // Agar workspace parent mein ls chala toh subfolder name pakdein (e.g., AI-Shop-Platform/)
              if (isWorkspaceParent && !detectedSubProject) {
                const dirMatch = resStr.match(/([A-Za-z0-9._-]+)\//);
                if (dirMatch && !/^(node_modules|\.git|\.claude)$/i.test(dirMatch[1])) {
                  detectedSubProject = dirMatch[1];
                }
              }
            }
          }
        }

        // Inspect assistant tool_use history
        if (m.role === "assistant" && Array.isArray(m.content)) {
          for (const block of m.content) {
            if (block.type === "tool_use") {
              const rawFp = (block.input?.file_path || "").replace(/\\/g, "/");
              const normFp = rawFp.toLowerCase();
              const isMem = normFp.endsWith("project_memory.md");

              if (block.name === "Read" && normFp) {
                if (isMem) {
                  memoryChecked = true;
                } else {
                  readFiles.add(normFp);
                  if (normFp.endsWith("prompt.txt")) promptTxtRead = true;
                  if (isCurrentTurn) codeWorkThisTurn++;
                }
              } else if ((block.name === "Edit" || block.name === "Write") && normFp) {
                if (isMem) {
                  memoryMissing = false;
                  memoryChecked = true;
                  if (isCurrentTurn) memoryUpdatedThisTurn = true;
                } else {
                  modifiedFiles.add(`${block.name}:${rawFp}`);
                  if (isCurrentTurn) {
                    codeWorkThisTurn++;
                    memoryUpdatedThisTurn = false;
                  }
                }
              } else if (block.name === "Bash" && block.input?.command) {
                ranCommands.add(block.input.command.trim());
                if (isCurrentTurn) bashWorkThisTurn++;
              }
            }
          }
        }
      }

      // Resolve final target folder & memory path
      const targetProjectName = detectedSubProject || activeProjectName;
      const targetRoot =
        detectedSubProject && activeProjectRoot
          ? `${activeProjectRoot.replace(/[\\/]+$/, "")}/${detectedSubProject}`
          : activeProjectRoot;

      const memoryFilePath = targetRoot
        ? `${targetRoot.replace(/[\\/]+$/, "")}/PROJECT_MEMORY.md`
        : "PROJECT_MEMORY.md";

      const promptTxtPath = targetRoot
        ? `${targetRoot.replace(/[\\/]+$/, "")}/prompt.txt`
        : "prompt.txt";

      const latestUserPrompt = cleanUserPrompts[cleanUserPrompts.length - 1] || "Build and run the project";

      // 7. Step-by-Step Non-Stopping Execution Plan
      let stepInstruction = "";
      let toolChoiceMode = "auto";

      if (isWorkspaceParent && !detectedSubProject && ranCommands.size === 0) {
        stepInstruction =
          `You are in parent folder "${activeProjectRoot || "d:/project"}". Run Bash with "ls -d */" to locate the active project folder.`;
        toolChoiceMode = "required";
      } else if (memoryMissing && !memoryUpdatedThisTurn) {
        stepInstruction =
          `Create "${memoryFilePath}" using Write with:\n` +
          `# Project: ${targetProjectName}\n\n## Completed Tasks\n- Initialized project memory\n\n## Pending Tasks\n- ${latestUserPrompt}\n\n## Recent Changes\n- Created PROJECT_MEMORY.md\n` +
          `Also check "${targetRoot || "."}" files using Bash ("ls -la ${targetRoot || "."}") in the same turn.`;
        toolChoiceMode = "required";
      } else if (!memoryChecked) {
        stepInstruction =
          `Read "${memoryFilePath}" using Read (only once) and list files in "${targetRoot || "."}" using Bash ("ls -la ${targetRoot || "."}").`;
        toolChoiceMode = "required";
      } else if (hasPromptTxt && !promptTxtRead) {
        stepInstruction =
          `Read "${promptTxtPath}" ONCE using Read to understand full project specifications, then start building/updating the project.`;
        toolChoiceMode = "required";
      } else if (codeWorkThisTurn === 0 && bashWorkThisTurn === 0) {
        stepInstruction =
          `Execute the user's request ("${latestUserPrompt}") inside "${targetRoot || targetProjectName}" right now! ` +
          `Use Write/Edit to build or fix UI/code files, or Bash to test/run the server (e.g. php -S localhost:8000 or npm run dev). ` +
          `Do NOT re-read: [${Array.from(readFiles).join(", ")}, project_memory.md].`;
        toolChoiceMode = "required";
      } else if (modifiedFiles.size > 0 && !memoryUpdatedThisTurn) {
        stepInstruction =
          `Update "${memoryFilePath}" using Write or Edit to log completed changes (${Array.from(modifiedFiles).slice(-4).join(", ")}) and remaining pending tasks.`;
        toolChoiceMode = "required";
      } else {
        stepInstruction =
          `Summarize clearly in 2-3 lines what files were created/updated, what was run/verified in "${targetProjectName}", and any local URL if started.`;
        toolChoiceMode = "auto";
      }

      // 8. Compact Messages Payload (~550-650 tokens)
      const groqMessages = [
        {
          role: "system",
          content:
            `You are Claude Code working in project "${targetProjectName}" (Path: "${targetRoot || "."}"). ` +
            `Work efficiently: execute multiple file operations in parallel, never repeat Read/ls commands, and always update PROJECT_MEMORY.md after edits.\n` +
            stepInstruction,
        },
        {
          role: "user",
          content: `CURRENT REQUEST: ${latestUserPrompt}`,
        },
      ];

      // Convert last 2 messages properly (preserving ALL parallel tool_uses and tool_results)
      const recentMsgs = allMsgs.slice(-2);
      for (const m of recentMsgs) {
        const mappedList = mapAnthropicToGroqMessages(m);
        for (const item of mappedList) {
          if (item.role === "user" && item.content.includes(latestUserPrompt.slice(0, 50))) {
            continue;
          }
          groqMessages.push(item);
        }
      }

      // 9. Compact Core Tools
      const compactTools = [
        {
          type: "function",
          function: {
            name: "Write",
            description: "Create or overwrite a file with complete code",
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
            description: "Replace exact string in an existing file",
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
            description: "Read an unread file ONCE",
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
            description: "Run shell command (list files, start PHP/Node server, verify app)",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        },
      ];

      // 10. Smart Model Routing & Safe Fallback
      const isBackgroundModel = requestedModel.toLowerCase().includes("haiku");
      const mainModel = request.headers.get("X-Target-Model") || env.TARGET_MODEL || "llama-3.3-70b-versatile";
      const fastModel = "llama-3.1-8b-instant";
      const chosenModel = isBackgroundModel ? fastModel : mainModel;

      let groqRes = await callGroq(apiKey, chosenModel, groqMessages, compactTools, toolChoiceMode);

      // Agar tool_choice: "required" par koi error aaye toh "auto" ke saath retry karein
      if (!groqRes.ok && toolChoiceMode === "required") {
        groqRes = await callGroq(apiKey, chosenModel, groqMessages, compactTools, "auto");
      }

      if (!groqRes.ok && chosenModel !== fastModel) {
        groqRes = await callGroq(apiKey, fastModel, groqMessages, compactTools, "auto");
      }

      if (!groqRes.ok) {
        const errText = await groqRes.text();
        return anthropicError(`Groq (${groqRes.status}): ${errText.slice(0, 200)}`, 502);
      }

      const groqData = await groqRes.json();
      const choice = groqData.choices?.[0]?.message || {};
      let toolCalls = choice.tool_calls || [];

      // 11. Duplicate Read & Duplicate Command Blocker
      toolCalls = toolCalls.filter((tc) => {
        if (tc.function?.name === "Read") {
          try {
            const args = JSON.parse(tc.function.arguments || "{}");
            const normFp = (args.file_path || "").replace(/\\/g, "/").toLowerCase();
            if (!normFp) return false;
            if (normFp.endsWith("project_memory.md")) return !memoryChecked;
            if (readFiles.has(normFp)) return false;
          } catch {
            return false;
          }
        }
        if (tc.function?.name === "Bash") {
          try {
            const args = JSON.parse(tc.function.arguments || "{}");
            const cmd = (args.command || "").trim();
            if (ranCommands.has(cmd)) return false;
          } catch {
            return false;
          }
        }
        return true;
      });

      const finalReplyText =
        choice.content ||
        (toolCalls.length === 0 ? `Completed task in [${targetProjectName}].` : "");

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
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        const fp = (block.input?.file_path || "").replace(/\\/g, "/");
        if (fp && fp.includes("/") && !fp.toLowerCase().endsWith("project_memory.md")) {
          const parts = fp.split("/").filter(Boolean);
          if (parts.length >= 2) {
            return { name: parts[parts.length - 2], root: parts.slice(0, -1).join("/") };
          }
        }
      }
    }
  }

  const cwdMatch = sysText.match(/working directory:\s*([^\r\n]+)/i);
  if (cwdMatch && cwdMatch[1]) {
    const cleanRoot = cwdMatch[1].trim().replace(/[\\/]+$/, "").replace(/\\/g, "/");
    const folderName = cleanRoot.split("/").pop();
    if (folderName) {
      return { name: folderName, root: cleanRoot };
    }
  }

  return { name: "default", root: "" };
}

function extractPureUserPrompt(content) {
  if (!content) return "";
  if (typeof content === "string") {
    return content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim().slice(0, 220);
  }
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim())
      .filter(Boolean)
      .join(" ")
      .slice(0, 220);
  }
  return "";
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

// Properly maps ALL parallel tool_uses and tool_results (prevents 400 mismatch errors)
function mapAnthropicToGroqMessages(msg) {
  const role = msg.role === "assistant" ? "assistant" : "user";
  const content = msg.content;

  if (typeof content === "string") {
    const clean = content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim();
    return clean ? [{ role, content: clean.slice(-1100) }] : [];
  }

  if (Array.isArray(content)) {
    // 1. Handle multiple tool_result blocks from user message
    const toolResults = content.filter((c) => c.type === "tool_result");
    if (toolResults.length > 0) {
      return toolResults.map((tr) => {
        const out = typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content);
        return {
          role: "tool",
          tool_call_id: tr.tool_use_id || "call_1",
          content: out.slice(0, 1200),
        };
      });
    }

    // 2. Handle multiple parallel tool_use blocks from assistant message
    const toolUses = content.filter((c) => c.type === "tool_use");
    if (toolUses.length > 0 && role === "assistant") {
      return [
        {
          role: "assistant",
          content: null,
          tool_calls: toolUses.map((tu) => ({
            id: tu.id,
            type: "function",
            function: {
              name: tu.name,
              arguments: JSON.stringify(tu.input || {}),
            },
          })),
        },
      ];
    }

    // 3. Normal text blocks
    const text = content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim())
      .filter(Boolean)
      .join("\n")
      .slice(-1100);

    return text ? [{ role, content: text }] : [];
  }

  return [];
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
    usage: { input_tokens: 550, output_tokens: 200 },
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
