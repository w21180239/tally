import { agentIdOfPath } from "./path.ts";
import type { CompactRow, FileCtx, MetaRow, Parsed, ToolUse, UsageRow, UserRow } from "./types.ts";
import { tokensOf } from "./usage.ts";

type Rec = Record<string, any>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

const NOTICE_PREFIXES = ["<task-notification", "<system-reminder", "<local-command-", "<command-", "<teammate-message", "<agent-message", "<channel"];
const TEXT_CAP = 4000;
const AGENT_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);
const TARGET_FIELDS = ["file_path", "notebook_path", "path", "pattern", "url", "query"];

const META: Record<string, (l: Rec) => unknown> = {
  "custom-title": (l) => nonEmpty(l.customTitle),
  "ai-title": (l) => nonEmpty(l.aiTitle),
  "agent-name": (l) => nonEmpty(l.agentName),
  "last-prompt": (l) => nonEmpty(l.lastPrompt),
  "pr-link": (l) => nonEmpty(l.prUrl),
  "cost-state": (l) => (typeof l.startTime === "number" ? { startTime: l.startTime, totalCostUSD: l.totalCostUSD, modelUsage: l.modelUsage } : undefined),
};

function sessionOf(l: Rec, ctx: FileCtx): string {
  const s = nonEmpty(l.sessionId);
  if (s) return s;
  const base = ctx.path.split(/[\\/]/).pop() ?? "";
  return base.replace(/\.jsonl$/, "") || "?";
}

const agentOf = (ctx: FileCtx): string | undefined => (ctx.isSub ? agentIdOfPath(ctx.path) : undefined);

function toolOf(block: Rec): ToolUse {
  const name = nonEmpty(block.name) ?? "?";
  const input = isRec(block.input) ? block.input : {};
  const t: ToolUse = { name, inputChars: JSON.stringify(block.input ?? {}).length };
  const id = nonEmpty(block.id);
  if (id) t.id = id;
  if (name === "Read" && input.offset === undefined && input.limit === undefined && input.pages === undefined) t.whole = true;
  if (name.startsWith("mcp__")) {
    const srv = name.split("__")[1];
    if (srv) t.mcpServer = srv;
  }
  const target = TARGET_FIELDS.map((f) => nonEmpty(input[f])).find((v) => v !== undefined);
  if (target) t.target = target;
  const command = nonEmpty(input.command);
  if (command) t.command = command;
  if (AGENT_TOOLS.has(name)) {
    const prompt = nonEmpty(input.prompt);
    if (prompt) t.prompt = prompt.slice(0, TEXT_CAP);
  }
  return t;
}

function assistantRow(l: Rec, ctx: FileCtx): Parsed | null {
  const msg = isRec(l.message) ? l.message : {};
  const requestId = nonEmpty(l.requestId) ?? nonEmpty(msg.id);
  const ts = Date.parse(nonEmpty(l.timestamp) ?? "");
  if (!requestId || Number.isNaN(ts)) return null;
  const usage = isRec(msg.usage) ? msg.usage : {};
  const model = nonEmpty(msg.model) ?? "?";
  let thinkingChars = 0;
  let replyChars = 0;
  const tools: ToolUse[] = [];
  const seen = new Set<string>();
  for (const b of Array.isArray(msg.content) ? msg.content : []) {
    if (!isRec(b)) continue;
    if (b.type === "thinking" && typeof b.thinking === "string") thinkingChars += b.thinking.length;
    else if (b.type === "text" && typeof b.text === "string") replyChars += b.text.length;
    else if (b.type === "tool_use") {
      const id = nonEmpty(b.id);
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      tools.push(toolOf(b));
    }
  }
  const row: UsageRow = {
    requestId,
    sessionId: sessionOf(l, ctx),
    ts,
    model,
    tokens: tokensOf(usage),
    fast: usage.speed === "fast",
    synthetic: model === "<synthetic>",
    thinkingChars,
    replyChars,
    tools,
    sidechain: l.isSidechain === true || ctx.isSub,
  };
  const skill = nonEmpty(l.attributionSkill);
  const plugin = nonEmpty(l.attributionPlugin);
  const effort = nonEmpty(l.perTurnEffort) ?? nonEmpty(l.effort);
  const cwd = nonEmpty(l.cwd);
  if (skill) row.skill = skill;
  if (plugin) row.plugin = plugin;
  if (effort) row.effort = effort;
  if (cwd) row.cwd = cwd;
  if (ctx.isSub && ctx.agentType) row.agentType = ctx.agentType;
  const agentId = agentOf(ctx);
  if (agentId) row.agentId = agentId;
  return { t: "usage", row };
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((b) => (isRec(b) && b.type === "text" && typeof b.text === "string" ? b.text : "")).join("")
      : "";

const charsOf = (c: unknown): number => (c === undefined || c === null ? 0 : typeof c === "string" ? c.length : JSON.stringify(c).length);

function userRow(l: Rec, ctx: FileCtx): Parsed | null {
  const ts = Date.parse(nonEmpty(l.timestamp) ?? "");
  if (Number.isNaN(ts)) return null;
  const content = isRec(l.message) ? l.message.content : undefined;
  const sessionId = sessionOf(l, ctx);
  const sidechain = ctx.isSub || l.isSidechain === true;
  const results = Array.isArray(content) ? content.filter((b) => isRec(b) && b.type === "tool_result") : [];
  if (results.length > 0) {
    // One row per line: chars sums all blocks, toolUseId is the first, results lists every block.
    // Any text beside tool_result blocks is dropped on purpose.
    const row: UserRow = { sessionId, ts, kind: "toolResult", chars: results.reduce((n, b) => n + charsOf(b.content), 0) };
    if (sidechain) row.sidechain = true;
    const agentId = agentOf(ctx);
    if (agentId) row.agentId = agentId;
    const id = nonEmpty(results[0].tool_use_id);
    if (id) row.toolUseId = id;
    const per = results.flatMap((b) => { const i = nonEmpty(b.tool_use_id); return i ? [{ toolUseId: i, chars: charsOf(b.content) }] : []; });
    if (per.length > 0) row.results = per;
    const errors = results.filter((b) => b.is_error === true).length;
    if (errors > 0) row.errors = errors;
    return { t: "user", row };
  }
  const text = textOf(content);
  if (text === "") return null;
  const start = text.trimStart();
  const kind: UserRow["kind"] =
    l.isCompactSummary === true ? "compaction" : l.isMeta === true || NOTICE_PREFIXES.some((p) => start.startsWith(p)) ? "notice" : "prompt";
  const row: UserRow = { sessionId, ts, kind, chars: text.length };
  if (sidechain) row.sidechain = true;
  const agentId = agentOf(ctx);
  if (agentId) row.agentId = agentId;
  if (kind === "prompt") row.text = text.slice(0, TEXT_CAP);
  return { t: "user", row };
}

// Returns null for lines tally ignores and for corrupt JSON.
export function parseLine(line: string, ctx: FileCtx): Parsed | null {
  let l: unknown;
  try {
    l = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRec(l) || typeof l.type !== "string") return null;
  switch (l.type) {
    case "assistant":
      return assistantRow(l, ctx);
    case "user":
      return userRow(l, ctx);
    case "system": {
      const ts = Date.parse(nonEmpty(l.timestamp) ?? "");
      if (l.subtype !== "compact_boundary" || Number.isNaN(ts)) return null;
      const row: CompactRow = { sessionId: sessionOf(l, ctx), ts };
      const agentId = agentOf(ctx);
      if (agentId) row.agentId = agentId;
      const meta = l.compactMetadata;
      if (isRec(meta)) {
        if (meta.trigger === "manual" || meta.trigger === "auto") row.trigger = meta.trigger;
        if (typeof meta.preTokens === "number" && Number.isFinite(meta.preTokens) && meta.preTokens >= 0) row.preTokens = meta.preTokens;
      }
      return { t: "compact", row };
    }
    default: {
      const pick = META[l.type];
      if (!pick || ctx.isSub) return null;
      const value = pick(l);
      if (value === undefined) return null;
      const row: MetaRow = { sessionId: sessionOf(l, ctx), key: l.type as MetaRow["key"], value };
      return { t: "meta", row };
    }
  }
}
