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
};

export type LiveState = {
  sessionId: string;
  /** When this launch's tally began; rows of the session before it are "restored". */
  startedAt: number;
  /** What the session spent before this launch, from the index. */
  restoredUsd: number;
  main: Tokens & { usd: number };
  agents: Record<string, AgentLive>;
  /** Spend the ledger shows beyond the steps seen (titles, permission checks, ...). */
  other: Money;
  messageCount: number;
  compactions: number;
  /** The main thread's latest cache write and the life it had. */
  lastWrite?: { ts: number; ttl: CacheLife };
  /** Calls and result characters by tool, across every loop. */
  toolCalls: Record<string, number>;
  toolChars: Record<string, number>;
};

export const ZERO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0 };
export const MAX_AGENTS = 200;
export const TEXT_MAX = 200;
/** A ledger gap under this many dollars is rounding, not a request. */
export const LEDGER_MIN = 0.0001;
/** A launch's cost-state line starts at or a little before session start. */
export const LAUNCH_SLACK_MS = 120_000;

export function emptyLive(sessionId: string, startedAt: number, restoredUsd = 0): LiveState {
  return {
    sessionId,
    startedAt,
    restoredUsd,
    main: { ...ZERO_TOKENS, usd: 0 },
    agents: {},
    other: { usd: 0, tokens: { ...ZERO_TOKENS }, requests: 0 },
    messageCount: 0,
    compactions: 0,
    toolCalls: {},
    toolChars: {},
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

/** The life a cache write is priced at when its request names none: the loop's known life, else 1h for main and 5m for a subagent. */
export function ttlFor(s: LiveState, agentId: string | undefined): CacheLife {
  return agentId === undefined ? (s.lastWrite?.ttl ?? "1h") : "5m";
}

/**
 * The step's tokens with the cache write split by life. A request that names the split is taken as
 * reported (the rest, as /cost does, is 5m) and `seen` is the life it shows; one that does not goes whole under `ttl`.
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

export type Step = { agentId?: string; ts: number; messageCount: number; model: string; tokens: Tokens; usd: number; seen?: CacheLife };

const addTokens = (a: Tokens, b: Tokens): Tokens => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cw5m: a.cw5m + b.cw5m,
  cw1h: a.cw1h + b.cw1h,
});

function withAgent(s: LiveState, id: string, patch: (a: AgentLive) => AgentLive, seed: Partial<AgentLive> = {}): LiveState {
  const cur = s.agents[id] ?? { id, type: "unknown", description: "", model: "", context: 0, peak: 0, firstPrompt: "", tools: {}, usd: 0, ...seed };
  const agents = { ...s.agents, [id]: patch(cur) };
  const ids = Object.keys(agents);
  // Oldest entries (insertion order) go first once the cap is passed.
  for (let i = 0; i < ids.length - MAX_AGENTS; i++) delete agents[ids[i]!];
  return { ...s, agents };
}

/** One request's tokens and cost into the main thread or the subagent that made it. */
export function applyStep(s: LiveState, st: Step): LiveState {
  const t = st.tokens;
  if (st.agentId !== undefined) {
    const prompt = t.input + t.cacheRead + t.cw5m + t.cw1h;
    return withAgent(s, st.agentId, (a) => ({ ...a, model: st.model, context: prompt, peak: Math.max(a.peak, prompt), usd: a.usd + st.usd }));
  }
  const written = t.cw5m + t.cw1h > 0;
  const ttl = st.seen ?? s.lastWrite?.ttl;
  const lastWrite = written && ttl !== undefined ? { ts: st.ts, ttl } : s.lastWrite;
  const dropped = s.messageCount > 0 && st.messageCount < s.messageCount;
  return {
    ...s,
    main: { ...addTokens(s.main, t), usd: s.main.usd + st.usd },
    messageCount: st.messageCount,
    compactions: s.compactions + (dropped ? 1 : 0),
    ...(lastWrite && { lastWrite }),
  };
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

/** What the index knows of the session: the ledger line and the cost and cache write from before this launch. */
export type Earlier = {
  restoredUsd: number;
  lastWrite?: { ts: number; ttl: CacheLife };
  ledger?: { startTime: number; totalCostUSD: number };
};

/** `Earlier` for `sessionId` from its project's shard; `beforeMs` is this launch's start. */
export function* earlierSteps(shard: Shard, sessionId: string, beforeMs: number, prices: PriceTable): Steps<Earlier> {
  const resolve = memoResolver(prices);
  let usd = 0;
  let write: { ts: number; cw5m: number; cw1h: number } | undefined;
  for (let i = 0; i < shard.usage.length; i++) {
    if (i % STEP_ROWS === STEP_ROWS - 1) yield;
    const r = shard.usage[i]!;
    if (r.sessionId !== sessionId) continue;
    if (r.ts < beforeMs) usd += costOf(r, prices, resolve).usd;
    if (!r.sidechain && !r.synthetic && r.tokens.cw5m + r.tokens.cw1h > 0 && (!write || r.ts > write.ts)) write = { ts: r.ts, cw5m: r.tokens.cw5m, cw1h: r.tokens.cw1h };
  }
  const out: Earlier = { restoredUsd: usd };
  if (write) out.lastWrite = { ts: write.ts, ttl: cacheLife([write]) };
  for (const m of shard.metas) {
    if (m.sessionId !== sessionId || m.key !== "cost-state") continue;
    const v = m.value as { startTime?: unknown; totalCostUSD?: unknown } | null;
    if (v && typeof v.startTime === "number" && typeof v.totalCostUSD === "number") out.ledger = { startTime: v.startTime, totalCostUSD: v.totalCostUSD };
  }
  return out;
}

/**
 * Folds what the index knows into the state. `other` is this launch's ledger total less what the steps and the
 * earlier launches priced; a ledger line from an earlier launch leaves it as it was.
 */
export function applyEarlier(s: LiveState, e: Earlier): LiveState {
  let out: LiveState = { ...s, restoredUsd: e.restoredUsd };
  // The index's latest write is older than the live ones, or the only one before any request of this launch.
  if (e.lastWrite && (!s.lastWrite || e.lastWrite.ts > s.lastWrite.ts)) out = { ...out, lastWrite: e.lastWrite };
  const l = e.ledger;
  if (l && l.startTime >= s.startedAt - LAUNCH_SLACK_MS) {
    const priced = e.restoredUsd + s.main.usd + Object.values(s.agents).reduce((a, g) => a + g.usd, 0);
    const gap = l.totalCostUSD - priced;
    out = { ...out, other: { ...s.other, usd: gap >= LEDGER_MIN ? gap : 0 } };
  }
  return out;
}
