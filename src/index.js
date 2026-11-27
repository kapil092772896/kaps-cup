/**
 * =====================================================================
 *  Claude Code  ->  Groq   proxy   (Cloudflare Worker)   v2.0
 * =====================================================================
 *  Claude Code (Anthropic API format) ko Groq (OpenAI format) me translate karta hai.
 *
 *  SECRETS / VARS (wrangler secret put ... / dashboard > Settings > Variables)
 *    GROQ_API_KEY      (ya GROQ_API_KEYS="k1,k2,k3" -> rate limit par auto-rotate)
 *    PROXY_TOKEN       (optional) - set karoge to sirf wahi client use kar sakega
 *                      (Claude Code me ANTHROPIC_AUTH_TOKEN = PROXY_TOKEN)
 *    TARGET_MODEL      default llama-3.3-70b-versatile
 *    FAST_MODEL        default llama-3.1-8b-instant   (haiku/background calls)
 *    FALLBACK_MODELS   default llama-3.1-8b-instant   (comma separated)
 *    ALLOWED_TOOLS     default Bash,Read,Write,Edit,Glob,Grep,LS
 *    HISTORY_CHARS     default 16000  (Groq ko bheji jaane wali history ka budget)
 *    TOOL_RESULT_CHARS default 2500
 *    MAX_OUTPUT_TOKENS default 6000
 *    MAX_CONTINUES     default 3      (model ruke to kitni baar force-continue)
 *    MAX_TOOL_CALLS    default 80     (ek task me max tool calls - safety valve)
 *    ENFORCE_MEMORY    "0" = PROJECT_MEMORY.md workflow band
 *    WORKSPACE_DIRS    default project,projects,htdocs,www
 *    DEBUG             "1" = wrangler tail me logs
 *  Per-request override: header  X-Target-Model: <groq-model-id>
 * =====================================================================
 */

const VERSION = "2.0.0";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};
const MOD_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const EXPLORE_TOOLS = new Set(["Read", "Glob", "Grep", "LS"]);
const PATH_KEYS = ["file_path", "path", "notebook_path"];
const BASH_ERR_RE = /(parse error|syntax error|fatal error|traceback \(most recent|cannot find module|npm err!|command not found|unexpected token)/i;
const INTENT_RE = /\b(let me|i(?:'|’)ll|i will|i am going to|i(?:'|’)m going to|now i|next,? i|let(?:'|’)s|going to|first,? i|ab main|ab hum|chalo)\b/i;
const DONE_RE = /\b(done|completed|finished|ready|all set|created|updated|fixed|implemented|working|successfully|ban gaya|ho gaya|complete)\b/i;
const ACTION_RE = /\b(build|create|make|add|fix|update|change|edit|modify|implement|write|generate|run|start|install|setup|set up|refactor|rename|delete|remove|deploy|debug|improve|optimi[sz]e|convert|migrate|integrate|connect|design|continue|resume|finish|complete|test|bana|banao|banado|kar|karo|kro|kardo|jodo|badlo|badal|theek|thik|sahi|hatao|hata|chalu|chalao|pura|poora|aage|badho|lagao|likho)\b/i;
const QUESTION_RE = /^(what|why|how|when|where|who|which|explain|describe|tell me|is |are |does |do |kya|kyu|kyun|kaise|kaun|kab|kahan|samjhao|batao)\b/i;
const GENERIC_RE = /^(continue|resume|go on|keep going|finish|complete it|done\??|aage badho|pura kro|pura karo|chalu rakho|retry|try again|ok|okay|haan|yes)\b/i;

// ---------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------
class ProxyError extends Error {
  constructor(status, message, type, retryAfter) {
    super(message);
    this.status = status;
    this.type = type || errType(status);
    this.retryAfter = retryAfter;
  }
}
function errType(s) {
  if (s === 401) return "authentication_error";
  if (s === 403) return "permission_error";
  if (s === 404) return "not_found_error";
  if (s === 429) return "rate_limit_error";
  if (s === 529) return "overloaded_error";
  if (s >= 500) return "api_error";
  return "invalid_request_error";
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = (p = "toolu_") => p + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
const safeJson = (s, d = null) => { try { return JSON.parse(s); } catch { return d; } };
const norm = (p) => String(p || "").replace(/\\/g, "/");
const isAbs = (p) => /^(?:[A-Za-z]:)?\//.test(p) || p.startsWith("~");
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const stripReminders = (s) => String(s || "").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "");
const stripLineNos = (s) => String(s || "").replace(/^\s*\d+[→\t|]\s?/gm, "");
const log = (C, ...a) => { if (C.debug) console.log("[proxy]", ...a); };

function clip(s, max) {
  s = String(s ?? "");
  if (s.length <= max) return s;
  const h = Math.floor(max * 0.65);
  return s.slice(0, h) + `\n...[${s.length - max} chars omitted]...\n` + s.slice(-(max - h));
}

function extractText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c?.type === "image") return "[image]";
        if (typeof c?.text === "string") return c.text;
        if (typeof c?.content === "string") return c.content;
        if (Array.isArray(c?.content)) return extractText(c.content);
        return "";
      })
      .join("\n");
  }
  return "";
}

function pureUserPrompt(content, max = 4000) {
  if (!content) return "";
  const txt =
    typeof content === "string"
      ? content
      : Array.isArray(content)
      ? content.filter((c) => c.type === "text" && c.text).map((c) => c.text).join(" ")
      : "";
  return stripReminders(txt).trim().slice(0, max);
}

const estimateTokens = (obj) => Math.ceil(JSON.stringify(obj || {}).length / 3.6);

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, "x-proxy-version": VERSION, ...extra },
  });
}
function anthropicError(message, status = 400, type, extra = {}) {
  return json({ type: "error", error: { type: type || errType(status), message } }, status, extra);
}
function errorFrom(e) {
  if (e instanceof ProxyError) {
    const extra = e.retryAfter ? { "retry-after": String(Math.ceil(e.retryAfter / 1000)) } : {};
    return anthropicError(e.message, e.status, e.type, extra);
  }
  return anthropicError(`Proxy Error: ${e?.message || e}`, 500, "api_error");
}

// ---------------------------------------------------------------------
// Worker entry
// ---------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const C = cfg(env);
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    // /v1/models and /v1/models/:id  (Claude Code model validation)
    if (path.includes("/v1/models")) return handleModels(path);

    // token counter (no Groq tokens used)
    if (path.includes("/count_tokens")) {
      let b = {};
      try { b = await request.json(); } catch {}
      return json({ input_tokens: estimateTokens(b) });
    }

    if (request.method !== "POST") {
      return json({ status: "ok", service: "claude-code-groq-proxy", version: VERSION });
    }

    const clientKey =
      request.headers.get("x-api-key") ||
      (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");

    if (env.PROXY_TOKEN && clientKey !== env.PROXY_TOKEN) {
      return anthropicError("Invalid proxy token.", 401);
    }

    const keys = [
      ...String(env.GROQ_API_KEYS || "").split(","),
      env.GROQ_API_KEY || "",
    ].map((s) => s.trim()).filter(Boolean);
    if (!keys.length && !env.PROXY_TOKEN && clientKey) keys.push(clientKey);
    if (!keys.length) return anthropicError("GROQ_API_KEY missing in Worker secrets.", 401);

    let body;
    try { body = await request.json(); } catch { return anthropicError("Invalid JSON body.", 400); }

    const requestedModel = body.model || "claude-3-5-sonnet-20241022";
    const targetOverride = request.headers.get("X-Target-Model") || "";
    const job = () => runProxy({ body, env, C, keys, requestedModel, targetOverride });

    if (body.stream) return streamResponse(job, requestedModel, ctx, body);

    try {
      const r = await job();
      return json(buildMessage(r, requestedModel));
    } catch (e) {
      return errorFrom(e);
    }
  },
};

function cfg(env) {
  const num = (v, d) => (v !== undefined && v !== null && v !== "" && Number.isFinite(+v) ? +v : d);
  const list = (v, d) => String(v ?? d).split(",").map((s) => s.trim()).filter(Boolean);
  return {
    mainModel: env.TARGET_MODEL || "llama-3.3-70b-versatile",
    fastModel: env.FAST_MODEL || "llama-3.1-8b-instant",
    fallbackModels: list(env.FALLBACK_MODELS, "llama-3.1-8b-instant"),
    allowedTools: new Set(list(env.ALLOWED_TOOLS, "Bash,Read,Write,Edit,Glob,Grep,LS")),
    workspaceDirs: list(env.WORKSPACE_DIRS, "project,projects,htdocs,www"),
    maxOut: num(env.MAX_OUTPUT_TOKENS, 6000),
    historyChars: num(env.HISTORY_CHARS, 16000),
    toolResultChars: num(env.TOOL_RESULT_CHARS, 2500),
    blueprintChars: num(env.BLUEPRINT_CHARS, 2500),
    claudeMdChars: num(env.CLAUDE_MD_CHARS, 1200),
    maxContinues: num(env.MAX_CONTINUES, 3),
    maxToolCalls: num(env.MAX_TOOL_CALLS, 80),
    maxWaitMs: num(env.MAX_WAIT_MS, 25000),
    temperature: num(env.TEMPERATURE, 0.1),
    enforceMemory: env.ENFORCE_MEMORY !== "0",
    debug: env.DEBUG === "1",
  };
}

function handleModels(path) {
  const parts = path.split("/v1/models/");
  const mk = (id, name, at) => ({ type: "model", id, display_name: name, created_at: at });
  if (parts[1]) {
    const id = decodeURIComponent(parts[1]).replace(/\/+$/, "");
    return json(mk(id, id, "2024-10-22T00:00:00Z"));
  }
  const data = [
    mk("claude-3-5-sonnet-20241022", "Claude 3.5 Sonnet", "2024-10-22T00:00:00Z"),
    mk("claude-3-5-haiku-20241022", "Claude 3.5 Haiku", "2024-10-22T00:00:00Z"),
    mk("claude-sonnet-4-20250514", "Claude Sonnet 4", "2025-05-14T00:00:00Z"),
    mk("claude-opus-4-1-20250805", "Claude Opus 4.1", "2025-08-05T00:00:00Z"),
    mk("claude-sonnet-4-5-20250929", "Claude Sonnet 4.5", "2025-09-29T00:00:00Z"),
    mk("claude-haiku-4-5-20251001", "Claude Haiku 4.5", "2025-10-01T00:00:00Z"),
  ];
  return json({ data, has_more: false, first_id: data[0].id, last_id: data[data.length - 1].id });
}

// ---------------------------------------------------------------------
// Response building (JSON + SSE)
// ---------------------------------------------------------------------
const textResult = (t) => ({ text: t, calls: [], stop: "end_turn", usage: { input: 0, output: Math.ceil(t.length / 4) } });

function buildMessage(r, model) {
  const content = [];
  if (r.text) content.push({ type: "text", text: r.text });
  for (const c of r.calls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
  if (!content.length) content.push({ type: "text", text: "Done." });
  return {
    id: "msg_" + uid(""),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: r.calls.length ? "tool_use" : r.stop || "end_turn",
    stop_sequence: null,
    usage: { input_tokens: r.usage.input || 0, output_tokens: r.usage.output || 0 },
  };
}

function streamResponse(job, model, ctx, body) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = async (event, data) => {
    try { await writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch {}
  };
  const run = (async () => {
    let timer;
    try {
      await send("message_start", {
        type: "message_start",
        message: {
          id: "msg_" + uid(""), type: "message", role: "assistant", content: [], model,
          stop_reason: null, stop_sequence: null,
          usage: { input_tokens: estimateTokens(body), output_tokens: 1 },
        },
      });
      // keep-alive: lambe tasks / retries me connection zinda rahe
      timer = setInterval(() => { send("ping", { type: "ping" }); }, 4000);
      const r = await job();
      clearInterval(timer);
      await emitBlocks(send, r);
      await send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: r.calls.length ? "tool_use" : r.stop || "end_turn", stop_sequence: null },
        usage: { output_tokens: r.usage.output || 1 },
      });
      await send("message_stop", { type: "message_stop" });
    } catch (e) {
      clearInterval(timer);
      const type = e instanceof ProxyError ? e.type : "api_error";
      await send("error", { type: "error", error: { type, message: e?.message || String(e) } });
    } finally {
      clearInterval(timer);
      try { await writer.close(); } catch {}
    }
  })();
  if (ctx?.waitUntil) ctx.waitUntil(run);
  return new Response(readable, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", ...CORS },
  });
}

async function emitBlocks(send, r) {
  let idx = 0;
  const text = r.text || (r.calls.length ? "" : "Done.");
  if (text) {
    await send("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "text", text: "" } });
    for (let k = 0; k < text.length; k += 120) {
      await send("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: text.slice(k, k + 120) } });
    }
    await send("content_block_stop", { type: "content_block_stop", index: idx });
    idx++;
  }
  for (const c of r.calls) {
    await send("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "tool_use", id: c.id, name: c.name, input: {} } });
    await send("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: JSON.stringify(c.input) } });
    await send("content_block_stop", { type: "content_block_stop", index: idx });
    idx++;
  }
}

// ---------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------
function detectNoise(sysLower, lowerLast) {
  const wantsJson = sysLower.includes("json");
  if (sysLower.includes("new conversation topic") || sysLower.includes("isnewtopic")) {
    return JSON.stringify({ isNewTopic: false, title: null });
  }
  if (
    sysLower.includes("5-10 word title") || sysLower.includes("concise title") ||
    sysLower.includes("summarize this coding session") || sysLower.includes("sentence-case title") ||
    lowerLast.includes("please write a 5-10 word title") || lowerLast.includes("generate a concise title")
  ) {
    return wantsJson ? JSON.stringify({ title: "Coding Task" }) : "Coding Task";
  }
  if (lowerLast === "ping" || lowerLast === "test") return "OK";
  return null;
}

async function runProxy({ body, env, C, keys, requestedModel, targetOverride }) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const rawSys = extractText(body.system);
  const lastText = stripReminders(extractText(msgs[msgs.length - 1]?.content)).trim().toLowerCase();

  // 0 Groq tokens: background noise
  const noise = detectNoise(rawSys.toLowerCase(), lastText);
  if (noise) return textResult(noise);

  const isHaiku = /haiku/i.test(requestedModel);
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const mainModel = targetOverride || C.mainModel;
  const chosen = isHaiku ? C.fastModel : mainModel;
  const models = [chosen, ...C.fallbackModels.filter((m) => m !== chosen)];
  const maxTokens = Math.min(Number(body.max_tokens) || C.maxOut, C.maxOut);

  if (!hasTools) return plainChat({ msgs, rawSys, C, keys, models, maxTokens, body });
  return runAgent({ body, msgs, rawSys, C, keys, models, maxTokens });
}

// tools nahi hain (title, summary, compaction, normal SDK use) -> seedha chat
async function plainChat({ msgs, rawSys, C, keys, models, maxTokens, body }) {
  const groups = toGroups(msgs);
  const build = (scale) => {
    const { messages } = buildHistory(groups, C.historyChars * 1.5 * scale, C.toolResultChars * scale, "");
    const sys = clip(rawSys, 6000);
    return sys ? [{ role: "system", content: sys }, ...messages] : messages;
  };
  const temperature = typeof body.temperature === "number" ? Math.min(body.temperature, 1) : 0.3;
  const { data } = await groqChat({ C, keys, models, build, tools: null, toolChoice: "none", maxTokens, temperature });
  const p = parseChoice(data, []);
  return {
    text: p.text || "Done.", calls: [], stop: p.finish === "length" ? "max_tokens" : "end_turn",
    usage: { input: p.usage.prompt_tokens || 0, output: p.usage.completion_tokens || 0 },
  };
}

async function runAgent({ body, msgs, rawSys, C, keys, models, maxTokens }) {
  const S = scan(msgs);
  const prompt = S.prompts[S.prompts.length - 1] || "Build and run the project";
  const taskPrompt = GENERIC_RE.test(prompt.trim())
    ? [...S.prompts].reverse().find((p) => p.length >= 25 && !GENERIC_RE.test(p)) || prompt
    : prompt;
  const isAction = classifyIntent(prompt);

  const proj = detectProject(rawSys, S, C, taskPrompt);
  const memPath = `${proj.target ? proj.target + "/" : ""}PROJECT_MEMORY.md`;
  const promptPath = `${proj.target ? proj.target + "/" : ""}prompt.txt`;
  const claudeMd = extractClaudeMd(rawSys, msgs, C);

  const step = planStep({ S, proj, C, isAction, memPath, promptPath, taskPrompt });
  const defs = buildTools(body.tools, C);
  const defsByName = new Map(defs.map((d) => [d.name, d]));
  const gTools = defs.map((d) => ({ type: "function", function: { name: d.name, description: d.description, parameters: d.schema } }));

  let toolChoice = step.toolChoice;
  const tcl = body.tool_choice;
  if (tcl?.type === "none") toolChoice = "none";
  else if (tcl?.type === "tool" && tcl.name && defsByName.has(tcl.name)) toolChoice = { type: "function", function: { name: tcl.name } };
  else if (tcl?.type === "any" && toolChoice === "auto") toolChoice = "required";

  const system = buildSystem({ proj, step, S, claudeMd, C, isAction });
  const groups = toGroups(msgs);
  const build = (scale, nudges) => {
    const { messages } = buildHistory(groups, C.historyChars * scale, C.toolResultChars * scale, taskPrompt);
    return [{ role: "system", content: system }, ...messages, ...(nudges || [])];
  };

  log(C, "step", step.kind, "| project", proj.name, "| action", isAction, "| calls", S.turn.calls);

  const usage = { input: 0, output: 0 };
  const nudges = [];
  let curChoice = toolChoice;
  let carry = "";
  let attempts = 0;
  let lastInvalid = [];

  while (true) {
    const { data } = await groqChat({
      C, keys, models,
      build: (scale, extra) => build(scale, [...nudges, ...(extra ? [{ role: "user", content: extra }] : [])]),
      tools: gTools, toolChoice: curChoice, maxTokens, temperature: C.temperature,
    });
    usage.input += data.usage?.prompt_tokens || 0;
    usage.output += data.usage?.completion_tokens || 0;

    const p = parseChoice(data, defs.map((d) => d.name));
    const { calls, invalid, dropped } = processCalls(p.raw, defsByName, S, proj, msgs.length);
    lastInvalid = invalid;

    if (calls.length) {
      return { text: (carry + p.text).trim(), calls, stop: "tool_use", usage };
    }

    // ---- model ne koi valid tool call nahi diya: kya ruk sakte hain? ----
    let nudge = null;
    if (invalid.length) {
      nudge = { reason: `Tool call problem: ${invalid.join(" | ")} Call the tool again, correctly.`, choice: "required" };
    } else if (dropped.length && step.kind !== "final") {
      nudge = { reason: `Skipped (already done): ${dropped.join(" | ")} Move on to the NEXT step, do not repeat.`, choice: "required" };
    } else if (!dropped.length) {
      nudge = needsMore({ text: p.text, finish: p.finish, S, step, isAction });
    }

    if (!nudge || attempts >= C.maxContinues || toolChoice === "none") {
      let text = (carry + p.text).trim();
      if (!text && lastInvalid.length) {
        text = `Model valid tool call nahi bana paya (${lastInvalid[0].slice(0, 160)}). "continue" likh kar dobara try karo.`;
      }
      if (!text) text = summaryText(S, proj);
      return { text, calls: [], stop: p.finish === "length" ? "max_tokens" : "end_turn", usage };
    }

    attempts++;
    if (p.finish === "length") carry += p.text + "\n";
    else if (p.text) nudges.push({ role: "assistant", content: p.text });
    nudges.push({ role: "user", content: `[SYSTEM] ${nudge.reason}` });
    curChoice = nudge.choice;
    log(C, "nudge", attempts, nudge.reason.slice(0, 120));
  }
}

// ---------------------------------------------------------------------
// History scan  (flags, ledger, loop detection)
// ---------------------------------------------------------------------
function scan(msgs) {
  const S = {
    idToCall: new Map(), prompts: [], lastUserIdx: 0,
    touched: [], readAt: new Map(), modAt: new Map(), written: new Set(),
    cmds: [], lastModIdx: -1, lastBashAnyIdx: -1, lastBashIdx: -1,
    mem: { checked: false, missing: false, updatedTurn: false },
    hasPromptTxt: false, promptTxtRead: false, promptContent: "", memContent: "",
    turn: { files: 0, bash: 0, explore: 0, calls: 0, verifyRuns: 0 },
    lsResults: [], lastResult: null, sig: new Map(), modified: [],
  };

  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === "user") {
      const p = pureUserPrompt(msgs[i].content);
      if (p) { S.prompts.push(p); S.lastUserIdx = i; }
    }
  }

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const cur = i >= S.lastUserIdx;
    if (!Array.isArray(m.content)) continue;

    if (m.role === "user") {
      for (const b of m.content) {
        if (b.type !== "tool_result") continue;
        const text = extractText(b.content);
        const lower = text.toLowerCase();
        const call = S.idToCall.get(b.tool_use_id) || {};
        const p = (call.path || "").toLowerCase();

        if (lower.includes("prompt.txt")) S.hasPromptTxt = true;
        if (p.endsWith("prompt.txt") && call.name === "Read" && !b.is_error && text.length > 50) {
          S.promptContent = stripLineNos(text).replace(/\s+/g, " ").slice(0, 4000);
        }
        if (p.endsWith("project_memory.md") && call.name === "Read") {
          const missing = (b.is_error || text.length < 300) && /does not exist|no such file|enoent|not found/i.test(lower.slice(0, 200));
          if (missing) S.mem.missing = true;
          else { S.mem.missing = false; S.memContent = stripLineNos(text).replace(/\s+/g, " ").slice(0, 700); }
        }
        if (call.name === "Bash" && /^\s*(?:cd\s+[^&;]+(?:&&|;)\s*)?(?:ls|dir)\b/i.test(call.input?.command || "")) {
          S.lsResults.push(text);
        }
        S.lastResult = { isError: !!b.is_error, text, name: call.name, path: call.path || "", idx: i };
      }
    } else if (m.role === "assistant") {
      for (const b of m.content) {
        if (b.type !== "tool_use") continue;
        const input = b.input || {};
        const raw = norm(input.file_path || input.notebook_path || "");
        const low = raw.toLowerCase();
        const isMem = low.endsWith("project_memory.md");
        S.idToCall.set(b.id, { name: b.name, input, path: raw });
        if (raw) S.touched.push(raw);
        if (cur) {
          const sig = b.name + JSON.stringify(input);
          S.sig.set(sig, (S.sig.get(sig) || 0) + 1);
          S.turn.calls++;
        }

        if (b.name === "Read" && low) {
          S.readAt.set(low, i);
          if (isMem) S.mem.checked = true;
          else {
            if (low.endsWith("prompt.txt")) S.promptTxtRead = true;
            if (cur) S.turn.explore++;
          }
        } else if (MOD_TOOLS.has(b.name) && low) {
          S.modAt.set(low, i);
          S.written.add(low);
          if (isMem) {
            S.mem.missing = false; S.mem.checked = true;
            if (cur) S.mem.updatedTurn = true;
          } else {
            S.lastModIdx = i;
            S.modified.push(raw);
            if (cur) { S.turn.files++; S.mem.updatedTurn = false; }
          }
        } else if (b.name === "Bash" && input.command) {
          const cmd = String(input.command).trim();
          const listing = /^(cd\s+[^&;]+(&&|;)\s*)?(ls|dir|wc|pwd|cat|head|tail)\b/i.test(cmd);
          S.cmds.push({ cmd, idx: i, listing });
          S.lastBashAnyIdx = i;
          if (!listing) {
            S.lastBashIdx = i;
            if (cur) { S.turn.bash++; if (S.turn.files > 0) S.turn.verifyRuns++; }
          }
        } else if (EXPLORE_TOOLS.has(b.name) && cur) {
          S.turn.explore++;
        }
      }
    }
  }
  return S;
}

function classifyIntent(prompt) {
  const p = (prompt || "").trim();
  if (!p) return true;
  if (GENERIC_RE.test(p)) return true;
  if (QUESTION_RE.test(p) || p.endsWith("?")) return false;
  if (ACTION_RE.test(p) || /\.(php|js|ts|jsx|tsx|py|html|css|json|md|java|go|rs|sql)\b/i.test(p)) return true;
  return p.length >= 25;
}

// ---------------------------------------------------------------------
// Project / workspace detection
// ---------------------------------------------------------------------
function commonDir(paths) {
  const lists = paths.filter((p) => isAbs(p)).map((p) => p.split("/").slice(0, -1));
  if (!lists.length) return "";
  let pre = lists[0];
  for (const l of lists.slice(1)) {
    let k = 0;
    while (k < pre.length && k < l.length && pre[k] === l[k]) k++;
    pre = pre.slice(0, k);
  }
  return pre.join("/");
}

function detectProject(sysText, S, C, prompt) {
  let root = "";
  const m = sysText.match(/(?:primary )?working directory:\s*([^\r\n]+)/i);
  if (m) root = norm(m[1]).trim().replace(/\/+$/, "");
  if (!root) root = commonDir(S.touched.filter((p) => !/project_memory\.md$/i.test(p)));
  const baseName = root ? root.split("/").pop() : "default";
  const parentRe = new RegExp("^(" + C.workspaceDirs.map(escRe).join("|") + ")$", "i");
  const isParent = parentRe.test(baseName);
  const sub = isParent ? detectSub(root, S, prompt) : "";
  return {
    root, isParent, sub,
    target: sub ? `${root}/${sub}` : root,
    name: sub || baseName,
    noSub: isParent && !sub && S.lsResults.length > 0,
  };
}

function detectSub(root, S, prompt) {
  if (!root) return "";
  const base = root + "/";
  const lowBase = base.toLowerCase();
  for (let i = S.touched.length - 1; i >= 0; i--) {
    const p = S.touched[i];
    if (p.toLowerCase().startsWith(lowBase)) {
      const rest = p.slice(base.length).split("/");
      if (rest.length >= 2 && rest[0] && !/^(node_modules|\.git|\.claude)$/i.test(rest[0])) return rest[0];
    }
  }
  const words = prompt.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  for (const res of S.lsResults) {
    const lines = res.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const dirs = lines.filter((l) => l.endsWith("/")).map((l) => l.slice(0, -1));
    const folders = (dirs.length ? dirs : lines.filter((l) => !/\./.test(l)))
      .filter((f) => /^[A-Za-z0-9._-]+$/.test(f) && !/^(node_modules|\.git|\.claude|\.+)$/i.test(f));
    if (!folders.length) continue;
    const hit = folders.find((f) => words.some((w) => f.toLowerCase().includes(w) || (f.length >= 3 && w.includes(f.toLowerCase()))));
    if (hit) return hit;
    if (folders.length === 1) return folders[0];
  }
  return "";
}

function extractClaudeMd(rawSys, msgs, C) {
  try {
    const hay = rawSys + "\n" + extractText(msgs[0]?.content);
    const m = hay.match(/Contents of [^\n]*CLAUDE\.md[^\n]*:\s*([\s\S]*?)(?=\n\s*Contents of |<\/system-reminder>|$)/i);
    return m ? m[1].trim().replace(/\s+/g, " ").slice(0, C.claudeMdChars) : "";
  } catch { return ""; }
}

// ---------------------------------------------------------------------
// Workflow planner  (har request ke liye "agla kaam" decide karta hai)
// ---------------------------------------------------------------------
function planStep({ S, proj, C, isAction, memPath, promptPath, taskPrompt }) {
  const T = proj.target || ".";
  const act = (instruction) => ({ kind: "act", toolChoice: "required", hint: instruction, instruction });

  if (!isAction) {
    return { kind: "chat", toolChoice: "auto", hint: "", instruction: "Answer the user's message directly. Use tools only if you need to inspect files." };
  }
  if (S.turn.calls >= C.maxToolCalls) {
    return { kind: "final", toolChoice: "none", hint: "", instruction: "Tool budget for this task is used up. Do NOT call tools. Summarize what is done and exactly what remains." };
  }
  if (proj.isParent && !proj.sub && S.lsResults.length === 0 && S.cmds.length === 0) {
    return act(`Run Bash with "ls -1p ${proj.root || "."}" to find the matching project folder in "${proj.root || "."}".`);
  }
  if (C.enforceMemory) {
    if (S.mem.missing && !S.mem.updatedTurn) {
      return act(
        `Create "${memPath}" using Write with:\n# Project: ${proj.name}\n\n## Completed Tasks\n- Initialized memory\n\n## Pending Tasks\n- ${clip(taskPrompt, 200)}\n\n## Recent Changes\n- Created PROJECT_MEMORY.md\nAlso list files with Bash ("ls -1p ${T}").`
      );
    }
    if (!S.mem.checked) {
      return act(`Read "${memPath}" ONCE using Read and list files in "${T}" using Bash ("ls -1p ${T}").`);
    }
  }
  if (S.hasPromptTxt && !S.promptTxtRead) {
    return act(`Read "${promptPath}" ONCE using Read to get the project blueprint. Do NOT run ls.`);
  }

  const t = S.turn;
  const lr = S.lastResult;
  const errNow =
    lr && lr.idx > S.lastUserIdx &&
    (lr.isError || (lr.name === "Bash" && BASH_ERR_RE.test(lr.text))) &&
    !/project_memory\.md$|prompt\.txt$/i.test(lr.path || "");
  const mod = t.files > 0;

  if (!mod && t.bash === 0) {
    const stop = t.explore >= 6 ? " You already explored enough: STOP reading and Write/Edit/Bash NOW." : "";
    const hintNew = proj.noSub ? ` If this is a NEW project, first create a short-named folder inside "${proj.root}" and put ALL files there.` : "";
    return act(
      `MANDATORY ACTION: do the user's request inside "${T}" NOW. Read/Glob/Grep only if truly needed (few calls), then create/modify files with Write/Edit (several in parallel) and verify with Bash. Do NOT reply with text only.${stop}${hintNew}`
    );
  }
  if (errNow) {
    return act(
      `FIX NOW: the last step failed:\n${clip(lr.text, 500)}\nFind the root cause, fix it with Edit/Write (Read the file first if the tool says it must be read), then re-run the check. If the failure was only a missing optional file, continue with the next step.`
    );
  }
  if (mod && S.lastBashAnyIdx < S.lastModIdx && t.verifyRuns < 5) {
    return act(
      `VERIFY NOW: run a quick check on what you built using Bash (e.g. php -l <file>, node --check <file>, python -m py_compile <file>, npm run build, or start the server and curl it). Pick what fits the stack; for static sites, list the files.`
    );
  }
  if (C.enforceMemory && mod && !S.mem.updatedTurn) {
    const recent = [...new Set(S.modified)].slice(-5).map((f) => f.split("/").pop()).join(", ");
    return act(`Update "${memPath}" using Write (full content) or Edit to log completed changes (${recent}) and the remaining pending tasks.`);
  }
  return {
    kind: "final", toolChoice: "auto", hint: "",
    instruction: `Everything is done and checked. Reply with a clear 2-4 line summary: files created/updated in "${proj.name}", how to run it (command / local URL / port) and the next pending step if any. Do NOT call more tools unless something is actually still broken.`,
  };
}

function needsMore({ text, finish, S, step, isAction }) {
  if (!isAction || step.kind === "chat") return null;
  if (finish === "length") {
    return { reason: "Your reply was cut off. Continue exactly where you stopped and call the next tool.", choice: "auto" };
  }
  const t = (text || "").trim();
  if (step.kind !== "final") {
    return { reason: `You must ACT with tools, not talk or ask. Make reasonable assumptions. ${step.hint}`, choice: "required" };
  }
  if (INTENT_RE.test(t.slice(-400)) && !DONE_RE.test(t)) {
    return { reason: "You described what you will do but did not do it. Call the tool NOW and finish the task.", choice: "required" };
  }
  return null;
}

function summaryText(S, proj) {
  const files = [...new Set(S.modified)].slice(-8).map((f) => f.split("/").pop());
  return files.length
    ? `Done in "${proj.name}". Files: ${files.join(", ")}`
    : `Completed task in [${proj.name}].`;
}

// ---------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------
function buildSystem({ proj, step, S, claudeMd, C, isAction }) {
  const L = [];
  L.push(`You are Claude Code, an autonomous senior software engineer working inside the user's project "${proj.name}" (ROOT: "${proj.target || proj.root || "."}").`);
  if (/^[A-Za-z]:/.test(proj.root)) L.push("Paths are Windows-style: always use forward slashes.");
  L.push(
    "RULES:",
    "1. Act, don't narrate. Use tools to read, write, edit and run. Never paste code in chat when it belongs in a file.",
    "2. Use ABSOLUTE paths under ROOT. Read a file before editing it. If a tool says the file must be read first, Read it and retry.",
    "3. Finish the WHOLE task end-to-end: create every needed file (complete working code, no placeholders/TODO), wire them together, run/verify (syntax check, build, server), fix errors, repeat until it works.",
    "4. Never stop to ask permission or to share a plan. Make reasonable assumptions. Never end your turn after saying what you 'will' do.",
    "5. Keep PROJECT_MEMORY.md updated (completed / pending / recent changes).",
    "6. Final reply: 2-4 lines (what was done, how to run, URL/port, what's left). Reply in the user's language (Hindi/Hinglish/English)."
  );
  if (claudeMd) L.push(`PROJECT INSTRUCTIONS (CLAUDE.md): ${claudeMd}`);
  if (isAction) {
    if (S.memContent) L.push(`MEMORY: ${S.memContent}`);
    if (S.promptContent) L.push(`BLUEPRINT (prompt.txt): ${S.promptContent.slice(0, C.blueprintChars)}`);
  }
  const files = [...new Set(S.modified)].slice(-12).map((f) => f.split("/").pop());
  const cmds = S.cmds.filter((c) => !c.listing).slice(-5).map((c) => clip(c.cmd, 80));
  if (files.length || cmds.length) {
    L.push(`PROGRESS SO FAR: files written/edited: ${files.join(", ") || "-"}; commands run: ${cmds.join(" ; ") || "-"}`);
  }
  L.push(`CURRENT STEP: ${step.instruction}`);
  return L.join("\n");
}

// ---------------------------------------------------------------------
// Tools: Anthropic -> OpenAI schema
// ---------------------------------------------------------------------
const DROP_KEYS = new Set(["$schema", "$id", "additionalProperties", "examples", "default", "title", "format"]);
function slimSchema(s) {
  const walk = (n) => {
    if (Array.isArray(n)) return n.map(walk);
    if (!n || typeof n !== "object") return n;
    const o = {};
    for (const [k, v] of Object.entries(n)) {
      if (DROP_KEYS.has(k)) continue;
      if (k === "properties" && v && typeof v === "object") {
        o.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, walk(pv)]));
      } else if (k === "description" && typeof v === "string") o.description = v.slice(0, 100);
      else o[k] = walk(v);
    }
    return o;
  };
  const out = s && typeof s === "object" ? walk(s) : {};
  if (!out.type) out.type = "object";
  if (!out.properties) out.properties = {};
  return out;
}

function buildTools(clientTools, C) {
  const all = (clientTools || []).filter((t) => t?.name);
  let picked = all.filter((t) => C.allowedTools.has(t.name));
  if (!picked.length) picked = all;
  return picked.map((t) => ({
    name: t.name,
    description: String(t.description || t.name).split("\n")[0].slice(0, 180),
    schema: slimSchema(t.input_schema),
  }));
}

function coerceArgs(args, schema) {
  const props = schema?.properties || {};
  for (const [k, def] of Object.entries(props)) {
    let v = args[k];
    if (v === undefined || v === null) continue;
    if ((def.type === "number" || def.type === "integer") && typeof v === "string" && v.trim() !== "" && !isNaN(+v)) args[k] = +v;
    else if (def.type === "boolean" && typeof v === "string") args[k] = v.toLowerCase() === "true";
    else if (def.type === "string" && (typeof v === "number" || typeof v === "boolean")) args[k] = String(v);
    else if ((def.type === "array" || def.type === "object") && typeof v === "string") {
      const parsed = safeJson(v);
      if (parsed !== null) args[k] = parsed;
    }
  }
  return args;
}

function absPath(p, root) {
  p = norm(p);
  if (!root || isAbs(p)) return p;
  if (p === "." || p === "./") return root;
  return root.replace(/\/+$/, "") + "/" + p.replace(/^\.\//, "");
}

// validate / repair / de-duplicate tool calls from the model
function processCalls(raw, defsByName, S, proj, msgsLen) {
  const calls = [], invalid = [], dropped = [];
  const seen = new Set();
  for (const tc of raw || []) {
    const name = tc.function?.name;
    const def = defsByName.get(name);
    if (!def) { invalid.push(`Unknown tool "${name}". Available: ${[...defsByName.keys()].join(", ")}.`); continue; }
    let args = safeJson(tc.function?.arguments || "{}", null);
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      invalid.push(`Arguments of ${name} were not valid JSON (probably cut off because the content was too long). Write smaller files (split into several Write calls).`);
      continue;
    }
    args = coerceArgs(args, def.schema);
    for (const k of PATH_KEYS) if (typeof args[k] === "string" && args[k]) args[k] = absPath(args[k], proj.target);
    const missing = (def.schema.required || []).filter((k) => args[k] === undefined || args[k] === null || (k === "file_path" && !args[k]));
    if (missing.length) { invalid.push(`${name} is missing required argument(s): ${missing.join(", ")}.`); continue; }

    let call = { name, input: args };
    const fp = typeof args.file_path === "string" ? args.file_path : "";
    const low = fp.toLowerCase();

    // Claude Code: Edit se pehle Read zaroori hai
    if ((name === "Edit" || name === "MultiEdit") && fp && !S.readAt.has(low) && !S.written.has(low) && defsByName.has("Read")) {
      call = { name: "Read", input: { file_path: fp } };
    }

    const sig = call.name + JSON.stringify(call.input);
    if (seen.has(sig)) { dropped.push("duplicate call in same reply."); continue; }
    seen.add(sig);

    if (call.name === "Read" && !call.input.offset && !call.input.limit) {
      const at = S.readAt.get(call.input.file_path.toLowerCase());
      if (at !== undefined && (S.modAt.get(call.input.file_path.toLowerCase()) ?? -1) < at && msgsLen - at <= 6) {
        dropped.push(`${call.input.file_path} was already read (content is above).`);
        continue;
      }
    }
    if (call.name === "Bash") {
      const cmd = String(call.input.command || "").trim();
      const prev = [...S.cmds].reverse().find((c) => c.cmd === cmd);
      if (prev && S.lastModIdx < prev.idx && msgsLen - prev.idx <= 6) {
        dropped.push(`command already ran with no file changes since: ${clip(cmd, 60)}.`);
        continue;
      }
    } else {
      const prior = S.sig.get(sig) || 0;
      if (prior >= (MOD_TOOLS.has(call.name) ? 1 : 2)) {
        dropped.push(`${call.name} with identical arguments was already done.`);
        continue;
      }
    }
    calls.push({ id: uid(), name: call.name, input: call.input });
  }
  return { calls, invalid, dropped };
}

// ---------------------------------------------------------------------
// History: Anthropic messages -> OpenAI messages (groups, budget, trimming)
// ---------------------------------------------------------------------
function toGroups(msgs) {
  const groups = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const role = m.role === "assistant" ? "assistant" : "user";
    if (typeof m.content === "string") {
      const t = stripReminders(m.content).trim();
      if (t) groups.push({ msgs: [{ role, content: t }], ids: [], results: new Set() });
      continue;
    }
    if (!Array.isArray(m.content)) continue;

    if (role === "assistant") {
      const text = m.content.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n").trim();
      const uses = m.content.filter((b) => b.type === "tool_use");
      if (!text && !uses.length) continue;
      const msg = { role: "assistant", content: text || null };
      if (uses.length) {
        msg.tool_calls = uses.map((u) => ({
          id: u.id, type: "function", function: { name: u.name, arguments: JSON.stringify(u.input || {}) },
        }));
      }
      groups.push({ msgs: [msg], ids: uses.map((u) => u.id), results: new Set() });
    } else {
      const prev = groups[groups.length - 1];
      for (const r of m.content.filter((b) => b.type === "tool_result")) {
        if (!prev || !prev.ids.includes(r.tool_use_id)) continue;
        const body = extractText(r.content) || "(empty)";
        prev.msgs.push({ role: "tool", tool_call_id: r.tool_use_id, content: (r.is_error ? "ERROR: " : "") + body });
        prev.results.add(r.tool_use_id);
      }
      const text = stripReminders(m.content.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n")).trim();
      if (text) groups.push({ msgs: [{ role: "user", content: text }], ids: [], results: new Set() });
    }
  }
  // har tool_call ka result hona chahiye warna Groq 400 deta hai
  for (const g of groups) {
    for (const id of g.ids) {
      if (!g.results.has(id)) g.msgs.push({ role: "tool", tool_call_id: id, content: "(no output)" });
    }
  }
  return groups;
}

function clipGroup(g, toolLim, old) {
  return {
    msgs: g.msgs.map((m) => {
      if (m.role === "tool") return { ...m, content: clip(m.content, toolLim) };
      if (m.role === "assistant") {
        const out = { ...m, content: m.content ? clip(m.content, old ? 1200 : 3000) : m.content };
        if (m.tool_calls && old) {
          out.tool_calls = m.tool_calls.map((tc) => {
            const a = safeJson(tc.function.arguments, null);
            if (!a) return tc;
            for (const k of Object.keys(a)) {
              if (typeof a[k] === "string" && a[k].length > 500) a[k] = a[k].slice(0, 400) + `...[+${a[k].length - 400} chars]`;
            }
            return { ...tc, function: { ...tc.function, arguments: JSON.stringify(a) } };
          });
        }
        return out;
      }
      return { ...m, content: clip(m.content, 4000) };
    }),
  };
}

function groupSize(g) {
  let n = 0;
  for (const m of g.msgs) n += (m.content ? m.content.length : 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
  return n;
}

function buildHistory(groups, budget, toolLim, prompt) {
  const n = groups.length;
  const clipped = groups.map((g, k) => clipGroup(g, k >= n - 2 ? toolLim : Math.floor(toolLim / 2), k < n - 2));
  const chosen = [];
  let used = 0;
  for (let k = clipped.length - 1; k >= 0; k--) {
    const sz = groupSize(clipped[k]);
    if (chosen.length && used + sz > budget) break;
    chosen.unshift(clipped[k]);
    used += sz;
  }
  const out = chosen.flatMap((g) => g.msgs);
  if (prompt && !out.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes(prompt.slice(0, 50)))) {
    out.unshift({ role: "user", content: `REQUEST: ${prompt}` });
  }
  if (!out.length) out.push({ role: "user", content: prompt ? `REQUEST: ${prompt}` : "Continue." });
  if (out[out.length - 1].role === "assistant") out.push({ role: "user", content: "Continue." });
  return { messages: out, dropped: clipped.length - chosen.length };
}

// ---------------------------------------------------------------------
// Groq call (retry, key-rotation, fallback, shrink, tool_use_failed rescue)
// ---------------------------------------------------------------------
function parseRetry(header, msg) {
  if (header && !isNaN(+header)) return Math.ceil(+header * 1000);
  const m = String(msg || "").match(/try again in\s+((?:\d+(?:\.\d+)?\s*(?:h|m|s|ms)\s*)+)/i);
  if (!m) return null;
  let ms = 0;
  for (const x of m[1].matchAll(/(\d+(?:\.\d+)?)\s*(ms|h|m|s)/gi)) {
    const v = +x[1], u = x[2].toLowerCase();
    ms += u === "h" ? v * 3600000 : u === "m" ? v * 60000 : u === "s" ? v * 1000 : v;
  }
  return ms || null;
}

function extractJsonObject(s) {
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  return a >= 0 && b > a ? safeJson(s.slice(a, b + 1)) : null;
}

// Llama kabhi tool call text me likh deta hai: <function=Write>{...}</function>
function parseFailedGeneration(fg, names) {
  const calls = [];
  const mk = (name, args) => ({ id: uid("call_"), type: "function", function: { name, arguments: JSON.stringify(args) } });
  if (!fg) return calls;
  for (const m of String(fg).matchAll(/<function=([\w.-]+)\s*([\s\S]*?)<\/function>/g)) {
    const args = extractJsonObject(m[2]);
    if (args && (!names.length || names.includes(m[1]))) calls.push(mk(m[1], args));
  }
  if (!calls.length) {
    const m = String(fg).match(/<function=([\w.-]+)\s*(\{[\s\S]*\})/);
    if (m) { const args = safeJson(m[2]); if (args && (!names.length || names.includes(m[1]))) calls.push(mk(m[1], args)); }
  }
  if (!calls.length) {
    for (const m of String(fg).matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) {
      const o = extractJsonObject(m[1]);
      const name = o?.name, args = o?.arguments || o?.parameters;
      if (name && args && (!names.length || names.includes(name))) calls.push(mk(name, typeof args === "string" ? safeJson(args, {}) : args));
    }
  }
  return calls;
}

async function groqChat({ C, keys, models, build, tools, toolChoice, maxTokens, temperature }) {
  const deadline = Date.now() + C.maxWaitMs;
  const toolNames = (tools || []).map((t) => t.function.name);
  let scale = 1, keyIdx = 0, nudge = null, last = null;

  for (const model of models) {
    let rotated = 0;
    for (let attempt = 0; attempt < 7; attempt++) {
      const messages = build(scale, nudge);
      const payload = { model, messages, temperature: attempt > 1 ? 0 : temperature, max_tokens: maxTokens };
      if (tools?.length && toolChoice !== "none") {
        payload.tools = tools;
        payload.tool_choice = toolChoice;
        payload.parallel_tool_calls = true;
      }
      let res;
      try {
        res = await fetch(GROQ_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${keys[keyIdx % keys.length]}` },
          body: JSON.stringify(payload),
        });
      } catch (e) {
        last = { status: 502, message: `Network error: ${e.message}` };
        await sleep(400);
        continue;
      }
      if (res.ok) return { data: await res.json(), model };

      const txt = await res.text();
      const err = safeJson(txt, {})?.error || {};
      const msg = err.message || txt.slice(0, 300);
      last = { status: res.status, message: msg };

      if (res.status === 401 || res.status === 403) {
        if (keyIdx < keys.length - 1) { keyIdx++; continue; }
        throw new ProxyError(401, `Groq auth failed: ${msg}`);
      }
      if (err.code === "tool_use_failed" || /tool_use_failed|failed to call a function/i.test(txt)) {
        const calls = parseFailedGeneration(err.failed_generation || "", toolNames);
        if (calls.length) {
          return { data: { choices: [{ message: { content: "", tool_calls: calls }, finish_reason: "tool_calls" }], usage: {} }, model };
        }
        nudge = "[SYSTEM] Your previous tool call was malformed. Call the tool again with valid JSON arguments only (no XML tags, no markdown). Keep each file small.";
        continue;
      }
      if (res.status === 413 || (res.status === 400 && /context|too large|too long|reduce/i.test(msg))) {
        scale *= 0.5;
        if (scale < 0.2) break;
        continue;
      }
      if (res.status === 429) {
        if (keys.length > 1 && rotated < keys.length - 1) { rotated++; keyIdx = (keyIdx + 1) % keys.length; continue; }
        const wait = parseRetry(res.headers.get("retry-after"), msg);
        if (wait !== null && Date.now() + wait < deadline) { await sleep(wait + 100); continue; }
        last.retryAfter = wait;
        break; // next model
      }
      if (res.status >= 500) { await sleep(500); continue; }
      break;
    }
  }
  const st = last?.status;
  throw new ProxyError(
    st === 429 ? 429 : 502,
    `Groq (${st}): ${String(last?.message || "unknown error").slice(0, 300)}`,
    st === 429 ? "rate_limit_error" : "api_error",
    last?.retryAfter
  );
}

function parseChoice(data, names) {
  const ch = data?.choices?.[0] || {};
  const msg = ch.message || {};
  let text = String(msg.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  let raw = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  if (!raw.length && /<function=|<tool_call>/.test(text)) {
    const parsed = parseFailedGeneration(text, names);
    if (parsed.length) {
      raw = parsed;
      text = text.replace(/<function=[\s\S]*?<\/function>/g, "").replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();
    }
  }
  return { text, raw, finish: ch.finish_reason, usage: data?.usage || {} };
}
