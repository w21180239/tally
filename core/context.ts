// The Context tab's figures: what the engine's /context breakdown says each request carries, as rows the tab draws,
// and which entries nothing has called lately. Pure.
import { dict } from "./dict.ts";
import { mcpServerOf } from "./breakdown.ts";

/** The parts of the engine's breakdown the tab reads. */
export type ContextInput = {
  categories?: Array<{ name: string; tokens: number; kind?: string; isDeferred?: boolean }>;
  mcpTools?: Array<{ name: string; serverName: string; tokens: number; isLoaded: boolean }>;
  agents?: Array<{ agentType: string; tokens: number }>;
  memoryFiles?: Array<{ path: string; tokens: number }>;
  skills?: { skillFrontmatter: Array<{ name: string; tokens: number; pluginName?: string }> };
  totalTokens?: number;
  rawMaxTokens?: number;
};

/** One entry of a list. `tokens` sit in the window; `deferred` ones are sent only once the tool is searched for. */
export type ContextRow = { name: string; tokens: number; deferred: number };

/** Names that something called within the index's window (and in the live tally). */
export type UsedNames = { skills: string[]; mcp: string[]; agents: string[] };

export type ContextData = {
  /** Whose figures these are: drawn only while that session is the live one. */
  sessionId: string;
  at: number;
  /** `estimated` is the engine's local count; `counted` comes back from the token-count API. */
  precision: "estimated" | "counted";
  total: number;
  /** The window the figures are measured against; 0 when unknown. */
  max: number;
  system: number;
  tools: number;
  messages: number;
  /** Tokens of tool schemas kept out of the window until used. */
  deferred: number;
  skills: ContextRow[];
  mcp: ContextRow[];
  agents: ContextRow[];
  memory: ContextRow[];
  /** What was called in the project over the last 30 days; null until the index has been read. */
  used: UsedNames | null;
  /** Set when the last read for `sessionId` failed and none has worked since. */
  failure?: { sessionId: string; why: string };
};

export const EMPTY_CONTEXT: ContextData = { sessionId: "", at: 0, precision: "estimated", total: 0, max: 0, system: 0, tools: 0, messages: 0, deferred: 0, skills: [], mcp: [], agents: [], memory: [], used: null };

const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

const byWeight = (a: ContextRow, b: ContextRow): number => b.tokens + b.deferred - (a.tokens + a.deferred) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// A used row of the named category; the engine's kind says which rows are the window's own.
const categoryTokens = (b: ContextInput, name: RegExp): number => {
  let n = 0;
  for (const c of b.categories ?? []) if (c.kind !== "deferred" && c.kind !== "free" && c.kind !== "buffer" && c.isDeferred !== true && name.test(c.name)) n += count(c.tokens);
  return n;
};

/** The rows of `b`, costliest first in each list. */
export function contextOf(sessionId: string, at: number, precision: ContextData["precision"], b: ContextInput): ContextData {
  const skills = dict<ContextRow>();
  for (const s of b.skills?.skillFrontmatter ?? []) {
    // A plugin's skill reads `plugin:name` wherever the engine gave only the bare name.
    const name = s.pluginName !== undefined && !s.name.includes(":") ? `${s.pluginName}:${s.name}` : s.name;
    const cur = (skills[name] ??= { name, tokens: 0, deferred: 0 });
    cur.tokens += count(s.tokens);
  }
  const mcp = dict<ContextRow>();
  for (const t of b.mcpTools ?? []) {
    const name = mcpServerOf(t.name) ?? t.serverName;
    const cur = (mcp[name] ??= { name, tokens: 0, deferred: 0 });
    if (t.isLoaded) cur.tokens += count(t.tokens);
    else cur.deferred += count(t.tokens);
  }
  const agents = dict<ContextRow>();
  for (const a of b.agents ?? []) {
    const cur = (agents[a.agentType] ??= { name: a.agentType, tokens: 0, deferred: 0 });
    cur.tokens += count(a.tokens);
  }
  const memory = dict<ContextRow>();
  for (const m of b.memoryFiles ?? []) {
    const cur = (memory[m.path] ??= { name: m.path, tokens: 0, deferred: 0 });
    cur.tokens += count(m.tokens);
  }
  const rows = (d: Record<string, ContextRow>): ContextRow[] => Object.values(d).sort(byWeight);
  const mcpRows = rows(mcp);
  let deferred = 0;
  for (const c of b.categories ?? []) if (c.kind === "deferred" || c.isDeferred === true) deferred += count(c.tokens);
  if (deferred === 0) deferred = mcpRows.reduce((n, r) => n + r.deferred, 0);
  return {
    sessionId,
    at,
    precision,
    total: count(b.totalTokens),
    max: count(b.rawMaxTokens),
    system: categoryTokens(b, /^system prompt/i),
    tools: categoryTokens(b, /^system tools/i),
    messages: categoryTokens(b, /^messages/i),
    deferred,
    skills: rows(skills),
    mcp: mcpRows,
    agents: rows(agents),
    memory: rows(memory),
    used: null,
  };
}

/** A skill's or agent's name without its plugin prefix. */
export const bareName = (name: string): string => name.split(":").pop() ?? name;

/** True when `name` was called: whole or by its bare name, since a plugin's entry is listed under either. */
function isCalled(names: ReadonlySet<string>, name: string): boolean {
  return names.has(name) || names.has(bareName(name));
}

/** The names in `rows` that `used` leaves out. Null `used` (index not read) marks nothing. */
export function unusedIn(kind: keyof UsedNames, rows: ContextRow[], used: UsedNames | null): Set<string> {
  const out = new Set<string>();
  if (used === null) return out;
  const names = new Set(used[kind]);
  for (const r of rows) if (!isCalled(names, r.name)) out.add(r.name);
  return out;
}

/** The share of the window used, 0 to 1; null when the window is unknown. */
export const usedShare = (c: Pick<ContextData, "total" | "max">): number | null => (c.max > 0 ? Math.min(1, c.total / c.max) : null);
