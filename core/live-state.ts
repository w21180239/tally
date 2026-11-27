// Live session accounting: pure reducers over the state the engine adapter keeps in an atom.
import { cacheLife } from "./cache-life.ts";
import type { CacheLife } from "./cache-life.ts";
import { costOf, memoResolver } from "./pricing.ts";
import type { PriceTable } from "./pricing.ts";
import type { Shard } from "./shard.ts";
import { STEP_ROWS } from "./steps.ts";
import type { Steps } from "./steps.ts";
import type { Money } from "./summary.ts";
import type { Tokens, UsageRow } from "./types.ts";

export type AgentLive = {
  id: string;
  type: string;
  description: string;
  model: string;
  /** Prompt tokens of its latest request. */
  context: number;
  peak: number;
  firstPrompt: string;
  tools: Record<string, number>;
  usd: number;
  /** When its latest request was made; its cache lives from there. */
  lastTs: number;
};

export type LiveState = {
  sessionId: string;
  /** When this launch's tally began; rows of the session before it are "restored". */
  startedAt: number;
  /** What the session spent before this launch, from the index. */
  restoredUsd: number;
  main: Tokens & { usd: number };
  agents: Record<string, AgentLive>;
  /** What the cost ledger holds beyond the requests tallied here (titles, permission checks, ...). `requests` is a lower bound. */
  other: Money;
  /** This launch's tallied requests by model, main thread and subagents together. */
  stepped: Record<string, Money>;
  messageCount: number;
  compactions: number;
  /** The main thread's latest cache write and the life it had. */
  lastWrite?: { ts: number; ttl: CacheLife };
  /** Calls and result characters by tool, across every loop. */
  toolCalls: Record<string, number>;
  toolChars: Record<string, number>;
  /** Wall-clock time this launch's main turns ran, summed. */
  activeMs: number;
  /** This launch's main-thread spend by model. */
  mainModels: Record<string, number>;
  /** This launch's main-thread requests by model. */
  mainRequests: Record<string, number>;
  /** Requests, tokens and spend of the session's earlier launches, by model. */
  restored: Record<string, Money>;
  /** What earlier launches' sub-agents spent, by agent type; the rest of `restoredUsd` is the main thread's. */
  restoredSub: Record<string, number>;
  /** `other.usd` split by the model the ledger charged it to; key "" when the ledger names none. */
  otherByModel: Record<string, number>;
};

export const ZERO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0 };
export const MAX_AGENTS = 200;
export const TEXT_MAX = 200;
/** Ledger differences below this many dollars are float noise and count as nothing. */
export const NOISE_USD = 0.0001;
/** A launch's ledger line may be stamped up to this long before the tally's own start. */
export const LEDGER_LEAD_MS = 120_000;
/** Most characters one tool result is counted as, whatever its real size. */
export const CHARS_CAP = 4_000_000;
const SIZE_NODES = 5_000;
const SIZE_DEPTH = 24;

export function emptyLive(sessionId: string, startedAt: number, restoredUsd = 0): LiveState {
  return {
    sessionId,
    startedAt,
    restoredUsd,
    main: { ...ZERO_TOKENS, usd: 0 },
    agents: {},
    other: { usd: 0, tokens: { ...ZERO_TOKENS }, requests: 0 },
    stepped: {},
    messageCount: 0,
    compactions: 0,
    toolCalls: {},
    toolChars: {},
    activeMs: 0,
    mainModels: {},
    mainRequests: {},
    restored: {},
    restoredSub: {},
    otherByModel: {},
  };
}

const cut = (s: string): string => (s.length > TEXT_MAX ? s.slice(0, TEXT_MAX) : s);

/** The usage a `turn.step` reports. */
export type StepUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  ephemeral_5m_input_tokens?: number;
  ephemeral_1h_input_tokens?: number;
  model: string;
};

/** Cache life to price an unlabelled write at: what the main thread last showed (1h before any); a subagent gets 5m. */
export function lifeFor(s: LiveState, agentId: string | undefined): CacheLife {
  return agentId === undefined ? (s.lastWrite?.ttl ?? "1h") : "5m";
}

/**
 * A request's tokens with its cache write divided by life. A reported split stands (any remainder counts as 5m,
 * like /cost) and `seen` is the life it reveals; an unlabelled write goes whole to `ttl`.
 */
export function stepTokens(u: StepUsage, ttl: CacheLife, ts: number): { tokens: Tokens; seen?: CacheLife } {
  const n = u.cache_creation_input_tokens;
  const e5 = u.ephemeral_5m_input_tokens;
  const e1 = u.ephemeral_1h_input_tokens;
  const base = { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens };
  if (e5 !== undefined && e1 !== undefined) {
    const tokens = { ...base, cw5m: e5 + Math.max(0, n - e5 - e1), cw1h: e1 };
    return { tokens, ...(n > 0 && { seen: cacheLife([{ ts, cw5m: tokens.cw5m, cw1h: tokens.cw1h }]) }) };
  }
  return { tokens: { ...base, cw5m: ttl === "5m" ? n : 0, cw1h: ttl === "1h" ? n : 0 } };
}

export function stepRow(sessionId: string, ts: number, agentId: string | undefined, model: string, tokens: Tokens): UsageRow {
  return { requestId: "live", sessionId, ts, model, tokens, fast: false, sidechain: agentId !== undefined, synthetic: false, thinkingChars: 0, replyChars: 0, tools: [] };
}

/**
 * Characters a tool result feeds back. A result's own text decides when there is one; otherwise the value is
 * sized by a walk bounded in nodes, depth and total (cycles and bigints included), and any failure reads as 0.
 * Never throws.
 */
export function resultChars(text: string | undefined, result: unknown): number {
  try {
    if (typeof text === "string") return text.length;
    return result === undefined ? 0 : Math.min(CHARS_CAP, roughSize(result));
  } catch {
    return 0;
  }
}

function roughSize(root: unknown): number {
  let total = 0;
  let visited = 0;
  const seen = new WeakSet<object>();
  const todo: [unknown, number][] = [[root, 0]];
  while (todo.length > 0 && visited < SIZE_NODES && total < CHARS_CAP) {
    const [v, depth] = todo.pop()!;
    visited++;
    if (typeof v === "string") total += v.length + 2;
    else if (typeof v === "number" || typeof v === "bigint" || typeof v === "boolean") total += String(v).length;
    else if (typeof v === "object" && v !== null) {
      if (seen.has(v) || depth >= SIZE_DEPTH) continue;
      seen.add(v);
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length && todo.length < SIZE_NODES; i++) todo.push([v[i], depth + 1]);
      } else {
        for (const k in v) {
          if (todo.length >= SIZE_NODES) break;
          total += k.length + 3;
          todo.push([(v as Record<string, unknown>)[k], depth + 1]);
        }
      }
    } else total += 4;
  }
  return total;
}

export type Step = { agentId?: string; ts: number; messageCount: number; model: string; tokens: Tokens; usd: number; seen?: CacheLife };

const addTokens = (a: Tokens, b: Tokens): Tokens => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cw5m: a.cw5m + b.cw5m,
  cw1h: a.cw1h + b.cw1h,
});

function withAgent(s: LiveState, id: string, patch: (a: AgentLive) => AgentLive, seed: Partial<AgentLive> = {}): LiveState {
  const cur = s.agents[id] ?? { id, type: "unknown", description: "", model: "", context: 0, peak: 0, firstPrompt: "", tools: {}, usd: 0, lastTs: 0, ...seed };
  const agents = { ...s.agents, [id]: patch(cur) };
  const ids = Object.keys(agents);
  // Past the cap the earliest-inserted entries are dropped.
  for (let i = 0; i < ids.length - MAX_AGENTS; i++) delete agents[ids[i]!];
  return { ...s, agents };
}

function noteModel(s: LiveState, st: Step): LiveState {
  const cur = s.stepped[st.model] ?? { usd: 0, tokens: { ...ZERO_TOKENS }, requests: 0 };
  return { ...s, stepped: { ...s.stepped, [st.model]: { usd: cur.usd + st.usd, tokens: addTokens(cur.tokens, st.tokens), requests: cur.requests + 1 } } };
}

/** One request's tokens and cost into the main thread or the subagent that made it. */
export function applyStep(s0: LiveState, st: Step): LiveState {
  const s = noteModel(s0, st);
  const t = st.tokens;
  if (st.agentId !== undefined) {
    const prompt = t.input + t.cacheRead + t.cw5m + t.cw1h;
    return withAgent(s, st.agentId, (a) => ({ ...a, model: st.model, context: prompt, peak: Math.max(a.peak, prompt), usd: a.usd + st.usd, lastTs: st.ts }));
  }
  const written = t.cw5m + t.cw1h > 0;
  const life = st.seen ?? s.lastWrite?.ttl;
  const lastWrite = written && life !== undefined ? { ts: st.ts, ttl: life } : s.lastWrite;
  const dropped = s.messageCount > 0 && st.messageCount < s.messageCount;
  return {
    ...s,
    main: { ...addTokens(s.main, t), usd: s.main.usd + st.usd },
    mainModels: { ...s.mainModels, [st.model]: (s.mainModels[st.model] ?? 0) + st.usd },
    mainRequests: { ...s.mainRequests, [st.model]: (s.mainRequests[st.model] ?? 0) + 1 },
    messageCount: st.messageCount,
    compactions: s.compactions + (dropped ? 1 : 0),
    ...(lastWrite && { lastWrite }),
  };
}

/** A main turn's wall-clock length into the launch's active time. */
export function addActive(s: LiveState, ms: number): LiveState {
  return Number.isFinite(ms) && ms > 0 ? { ...s, activeMs: s.activeMs + ms } : s;
}

export function addAgent(s: LiveState, id: string, type: string, description: string, model: string, firstPrompt: string): LiveState {
  return withAgent(s, id, (a) => ({ ...a, type, description: cut(description), model, firstPrompt: cut(firstPrompt) }));
}

/** A tool call and the characters its result fed back, into the session and (for a subagent) its loop. */
export function addTool(s: LiveState, agentId: string | undefined, tool: string, chars: number): LiveState {
  const out: LiveState = {
    ...s,
    toolCalls: { ...s.toolCalls, [tool]: (s.toolCalls[tool] ?? 0) + 1 },
    toolChars: { ...s.toolChars, [tool]: (s.toolChars[tool] ?? 0) + chars },
  };
  return agentId === undefined ? out : withAgent(out, agentId, (a) => ({ ...a, tools: { ...a.tools, [tool]: (a.tools[tool] ?? 0) + 1 } }));
}

/** What the index knows of the session: its ledger line, and the cost, tokens and cache write from before this launch. */
export type Earlier = {
  restoredUsd: number;
  /** Tokens, request counts and spend by model from before this launch. */
  restored?: Record<string, Money>;
  /** Sub-agent spend from before this launch, by agent type. */
  restoredSub?: Record<string, number>;
  lastWrite?: { ts: number; ttl: CacheLife };
  /** The ledger's total and its per-model token counts (`modelUsage`). */
  ledger?: { startTime: number; totalCostUSD: number; models?: Record<string, Tokens>; costs?: Record<string, number> };
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// modelUsage as the ledger writes it: per model input, output, cache-read and cache-creation counts. The ledger
// does not split a cache write by life, so it is carried whole in cw5m and compared by sum.
function ledgerModels(v: unknown): Record<string, Tokens> {
  const out: Record<string, Tokens> = {};
  if (typeof v !== "object" || v === null) return out;
  for (const [model, u] of Object.entries(v)) {
    if (typeof u !== "object" || u === null) continue;
    const x = u as Record<string, unknown>;
    out[model] = { input: num(x.inputTokens), output: num(x.outputTokens), cacheRead: num(x.cacheReadInputTokens), cw5m: num(x.cacheCreationInputTokens), cw1h: 0 };
  }
  return out;
}

// What the ledger charged each model (`costUSD`); a model that names none is left out.
function ledgerCosts(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof v !== "object" || v === null) return out;
  for (const [model, u] of Object.entries(v)) {
    const c = typeof u === "object" && u !== null ? (u as Record<string, unknown>).costUSD : undefined;
    if (typeof c === "number" && Number.isFinite(c)) out[model] = c;
  }
  return out;
}

/** `Earlier` for `sessionId` from its project's shard; `beforeMs` is this launch's start. */
export function* earlierSteps(shard: Shard, sessionId: string, beforeMs: number, prices: PriceTable): Steps<Earlier> {
  const resolve = memoResolver(prices);
  let usd = 0;
  const restored: Record<string, Money> = {};
  const restoredSub: Record<string, number> = {};
  let write: { ts: number; cw5m: number; cw1h: number } | undefined;
  for (let i = 0; i < shard.usage.length; i++) {
    if (i % STEP_ROWS === STEP_ROWS - 1) yield;
    const r = shard.usage[i]!;
    if (r.sessionId !== sessionId) continue;
    if (r.ts < beforeMs) {
      const cost = costOf(r, prices, resolve).usd;
      usd += cost;
      if (r.sidechain) restoredSub[r.agentType ?? "unknown"] = (restoredSub[r.agentType ?? "unknown"] ?? 0) + cost;
      const m = restored[r.model] ?? { usd: 0, tokens: { ...ZERO_TOKENS }, requests: 0 };
      restored[r.model] = { usd: m.usd + cost, tokens: addTokens(m.tokens, r.tokens), requests: m.requests + 1 };
    }
    if (!r.sidechain && !r.synthetic && r.tokens.cw5m + r.tokens.cw1h > 0 && (!write || r.ts > write.ts)) write = { ts: r.ts, cw5m: r.tokens.cw5m, cw1h: r.tokens.cw1h };
  }
  const out: Earlier = { restoredUsd: usd, restored, restoredSub };
  if (write) out.lastWrite = { ts: write.ts, ttl: cacheLife([write]) };
  for (const m of shard.metas) {
    if (m.sessionId !== sessionId || m.key !== "cost-state") continue;
    const v = m.value as { startTime?: unknown; totalCostUSD?: unknown; modelUsage?: unknown } | null;
    if (v && typeof v.startTime === "number" && typeof v.totalCostUSD === "number") out.ledger = { startTime: v.startTime, totalCostUSD: v.totalCostUSD, models: ledgerModels(v.modelUsage), costs: ledgerCosts(v.modelUsage) };
  }
  return out;
}

// Per model, the ledger's counts less those already explained (restored rows, live requests), floored at 0.
function unexplained(ledger: Record<string, Tokens>, restored: NonNullable<Earlier["restored"]>, stepped: LiveState["stepped"]): { tokens: Tokens; requests: number } {
  const sum: Tokens = { ...ZERO_TOKENS };
  let requests = 0;
  const left = (l: number, a: number, b: number) => Math.max(0, l - a - b);
  for (const [model, l] of Object.entries(ledger)) {
    const r = restored[model]?.tokens ?? ZERO_TOKENS;
    const t = stepped[model]?.tokens ?? ZERO_TOKENS;
    const d: Tokens = {
      input: left(l.input, r.input, t.input),
      output: left(l.output, r.output, t.output),
      cacheRead: left(l.cacheRead, r.cacheRead, t.cacheRead),
      cw5m: left(l.cw5m + l.cw1h, r.cw5m + r.cw1h, t.cw5m + t.cw1h),
      cw1h: 0,
    };
    if (d.input + d.output + d.cacheRead + d.cw5m === 0) continue;
    // One request at least stands behind a model's leftover tokens; how many more is not recorded.
    requests++;
    Object.assign(sum, addTokens(sum, d));
  }
  return { tokens: sum, requests };
}

// `usd` shared out by the models the ledger charged more than the earlier launches and live requests explain.
// No per-model charge to go by: the whole under the key "".
function splitOther(usd: number, costs: Record<string, number>, restored: NonNullable<Earlier["restored"]>, stepped: LiveState["stepped"]): Record<string, number> {
  const gaps: Record<string, number> = {};
  let sum = 0;
  for (const [model, c] of Object.entries(costs)) {
    const g = c - (restored[model]?.usd ?? 0) - (stepped[model]?.usd ?? 0);
    if (g > NOISE_USD) {
      gaps[model] = g;
      sum += g;
    }
  }
  if (sum <= 0) return { "": usd };
  const out: Record<string, number> = {};
  for (const [model, g] of Object.entries(gaps)) out[model] = (g * usd) / sum;
  return out;
}

/**
 * Folds what the index knows into the state. `other` is this launch's ledger less what the earlier launches and the
 * live requests account for, in dollars and (per model) in tokens; a ledger line from an earlier launch leaves it as it was.
 */
export function applyEarlier(s: LiveState, e: Earlier): LiveState {
  let out: LiveState = { ...s, restoredUsd: e.restoredUsd, restored: e.restored ?? {}, restoredSub: e.restoredSub ?? {} };
  // The index's latest write is older than the live ones, or the only one before any request of this launch.
  if (e.lastWrite && (!s.lastWrite || e.lastWrite.ts > s.lastWrite.ts)) out = { ...out, lastWrite: e.lastWrite };
  const l = e.ledger;
  if (l && l.startTime >= s.startedAt - LEDGER_LEAD_MS) {
    const accounted = e.restoredUsd + Object.values(s.stepped).reduce((a, m) => a + m.usd, 0);
    const gap = l.totalCostUSD - accounted;
    const usd = gap >= NOISE_USD ? gap : 0;
    const extra = usd > 0 ? unexplained(l.models ?? {}, e.restored ?? {}, s.stepped) : { tokens: { ...ZERO_TOKENS }, requests: 0 };
    const byModel = usd > 0 ? splitOther(usd, l.costs ?? {}, e.restored ?? {}, s.stepped) : {};
    out = { ...out, other: { usd, tokens: extra.tokens, requests: usd > 0 ? Math.max(1, extra.requests) : 0 }, otherByModel: byModel };
  }
  return out;
}
