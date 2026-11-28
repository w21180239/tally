// What fills each conversation's context, and what keeping it there cost.
// A conversation is replayed in time order: a prompt, tool result or compaction summary stays in the
// context until a compaction, and every counted request re-reads the cached share of it. A part's re-read
// cost is its tokens times the cache-read spend of the requests made while it was there.
import { dict, dictOf } from "./dict.ts";
import { drain, STEP_ROWS } from "./steps.ts";
import type { Steps } from "./steps.ts";
import { mcpServerOf } from "./breakdown.ts";
import { agentKeyOf, streamOf } from "./stream.ts";
import type { CompactRow, UsageRow, UserRow } from "./types.ts";
import { cacheLife, FIVE_MIN_MS } from "./cache-life.ts";
import type { CacheLife } from "./cache-life.ts";
import { HOUR_MS } from "./time.ts";

export type FlowSource = "prompt" | "read" | "bash" | "mcp" | "tool" | "compaction" | "fixed";
/** `rereadTokens`: the tokens of the part times the requests that re-read it (its cached share). */
export type FlowItem = { label: string; source: FlowSource; tokens: number; rereadTokens: number; rereadUsd: number };
export type Paste = { sessionId: string; tokens: number; rereadUsd: number };
/** A tool result of HUGE_RESULT_MIN_TOKENS or more: the tool, the part it became (`source`, `label`) and what re-reading it cost. */
export type BigResult = { sessionId: string; tool: string; source: FlowSource; label: string; tokens: number; rereadUsd: number };

/** A chunk of text that entered the context, sized in chars until a request tells its token count. `text` is the full text where one is known. */
export type Piece = { source: FlowSource; label: string; chars: number; paste: boolean; tool?: string; text?: string };

/**
 * What one main-thread compaction did to the context. `preTokens` is the context before it (the host's figure, else the
 * last request before the boundary; 0 when neither is known), `postTokens` the first request after it (null when none followed).
 * `requests`: main-thread requests until the next compaction. `savedTokens` and `savedUsd`: per counted request until the next
 * compaction, the context it did not carry compared with before the compaction (max(0, pre - request context)), priced at that
 * request's cache-read rate; a lower bound, since the context would have kept growing. `ineffective`: the context stayed at
 * EFFECTIVE_SHARE of its old size or more, another compaction followed within QUICK_REPEAT requests (`repeated`), or it began after the cache expired (`cold`).
 * `keptTokens`/`keptUsd`: the part of the post-compaction context above the EFFECTIVE_SHARE line, and its cache-read cost over the counted requests until the next compaction.
 */
export type CompactionEffect = {
  sessionId: string;
  ts: number;
  trigger?: "manual" | "auto";
  preTokens: number;
  postTokens: number | null;
  requests: number;
  savedTokens: number;
  savedUsd: number;
  keptTokens: number;
  keptUsd: number;
  ineffective: boolean;
  repeated: boolean;
  /** Time between the last request before the compaction and the compaction's start (0 when no request came before). */
  idleMs: number;
  /** `idleMs` is longer than the cache lives (1 hour after 1-hour writes, else 5 minutes): the compaction's own request read the prefix uncached. Its cost is not in the transcript, so it adds no amount. */
  cold: boolean;
};

/** A compaction that leaves at least this share of the old context in place did not shed enough. */
export const EFFECTIVE_SHARE = 0.6;
/** A compaction followed by another within this many main-thread requests counts as ineffective. */
export const QUICK_REPEAT = 3;

/** What the replay shows an observer for each request, before the request's parts are admitted. */
export type RequestSeen = {
  row: UsageRow;
  counted: boolean;
  /** The parts that arrived since the previous request of the stream. */
  pieces: Piece[];
  /** The stream's first request, or the first after a compaction. */
  opening: boolean;
  afterCompact: boolean;
  /** Time of the stream's previous request; null for the first. */
  prevTs: number | null;
};

export type FlowInput = {
  /** Every non-synthetic request, any order. */
  rows: UsageRow[];
  users: UserRow[];
  compacts: CompactRow[];
  /** Whether a request is inside the span and repo being summarized. Uncounted requests still fill the context. */
  counted: (r: UsageRow) => boolean;
  /** USD per token of the request's cache read. */
  cacheReadUsd: (r: UsageRow) => number;
  /** Called once per request in replay order, counted or not. */
  onRequest?: (seen: RequestSeen) => void;
};
export type FlowOut = {
  flow: FlowItem[];
  /** The same parts per agent (`main`, `sub:<type>`), each list cut like `flow`. */
  byAgent: Record<string, FlowItem[]>;
  /** Prompts of PASTE_MIN_TOKENS or more, in any conversation. */
  pastes: Paste[];
  /** Tool results of HUGE_RESULT_MIN_TOKENS or more that a counted request took in, in any conversation; costliest first, cut to FLOW_ITEMS. */
  bigResults: BigResult[];
  /** File to the most whole reads of it within one conversation; only files read whole more than once. */
  wholeReads: Record<string, number>;
  /** Tool name to the tokens its results put into context. */
  toolFill: Record<string, number>;
  /** Session to the largest prompt of any of its conversations. */
  peakContext: Record<string, number>;
  /** MCP server to the re-read cost of every tool result it returned, over all agents and before the lists are cut to FLOW_ITEMS. */
  mcpReread: Record<string, number>;
  /** Every main-thread compaction, oldest first, whether or not it is in the span; the caller filters. */
  compactionEffects: CompactionEffect[];
};

export const FLOW_ITEMS = 40;
export const PASTE_MIN_TOKENS = 5000;
/** A tool result this large (5 pastes) is listed in `bigResults`. */
export const HUGE_RESULT_MIN_TOKENS = 5 * PASTE_MIN_TOKENS;
/** A first request may hold this many times the typical fixed part before the rest counts as carried-over conversation. */
export const FIXED_CAP_FACTOR = 2;
const CHARS_PER_TOKEN = 4;
const SCALE_MIN = 0.25;
const SCALE_MAX = 4;
const PROMPT_LABEL = 60;
const COMMAND_LABEL = 80;

const FIXED = "fixed part";
/** Labels of the flow parts that are not one prompt or result: harness notices, a resumed conversation, a compaction summary. */
export const NOTICES = "notices";
export const CARRIED = "carried over";
const SUMMARY = "compaction";

const promptOf = (t: UsageRow["tokens"]): number => t.input + t.cacheRead + t.cw5m + t.cw1h;
const text = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// First line, whitespace collapsed, cut to `max` code points.
function clip(s: string, max: number): string {
  const first = s.trim().split(/\r?\n/, 1)[0].replace(/\s+/g, " ");
  if (first.length <= max) return first;
  const points = Array.from(first);
  return points.length <= max ? first : points.slice(0, max).join("");
}

type Tool = UsageRow["tools"][number];

function pieceOfResult(tool: Tool | undefined, chars: number): Piece {
  if (!tool) return { source: "tool", label: "tool result", chars, paste: false };
  const p = { chars, paste: false, tool: tool.name };
  if (tool.name === "Read") return { ...p, source: "read", label: tool.target ?? "Read" };
  if (tool.name === "Bash") return { ...p, source: "bash", label: clip(tool.command ?? "", COMMAND_LABEL) || "Bash", ...(tool.command !== undefined && { text: tool.command }) };
  return { ...p, source: tool.mcpServer ? "mcp" : "tool", label: tool.name };
}

function piecesOf(u: UserRow, tools: Map<string, Tool>): Piece[] {
  if (u.kind === "prompt") return [{ source: "prompt", label: clip(u.text ?? "", PROMPT_LABEL) || "prompt", chars: u.chars, paste: true, ...(u.text !== undefined && { text: u.text }) }];
  if (u.kind === "notice") return [{ source: "prompt", label: NOTICES, chars: u.chars, paste: false }];
  if (u.kind === "compaction") return [{ source: "compaction", label: SUMMARY, chars: u.chars, paste: false }];
  const blocks = u.results ?? [{ toolUseId: u.toolUseId ?? "", chars: u.chars }];
  return blocks.map((b) => pieceOfResult(tools.get(b.toolUseId), b.chars));
}

type Conv = { sessionId: string; sub: boolean; agent: string; fixedLabel: string; rows: UsageRow[]; users: UserRow[]; compacts: CompactRow[] };

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// What a conversation's first request carries beyond what arrived with it.
function openingRest(c: Conv): number {
  const first = c.rows[0];
  let chars = 0;
  for (const u of c.users) if (u.ts <= first.ts) chars += u.chars;
  return Math.max(0, promptOf(first.tokens) - chars / CHARS_PER_TOKEN);
}

export function analyzeFlow(input: FlowInput): FlowOut {
  return drain(analyzeFlowSteps(input));
}

/** `analyzeFlow` in steps: yields every STEP_ROWS rows of a pass and before each conversation's replay. */
export function* analyzeFlowSteps(input: FlowInput): Steps<FlowOut> {
  let n = 0;
  const tools = new Map<string, Tool>();
  const convs = new Map<string, Conv>();
  for (const r of input.rows) {
    if (++n % STEP_ROWS === 0) yield;
    for (const t of r.tools) if (t.id !== undefined) tools.set(t.id, t);
    const key = streamOf(r);
    let c = convs.get(key);
    if (!c) {
      const sub = r.sidechain || r.agentId !== undefined;
      c = { sessionId: r.sessionId, sub, agent: agentKeyOf(r), fixedLabel: sub ? `${FIXED} (${r.agentType ?? "sub-agent"})` : FIXED, rows: [], users: [], compacts: [] };
      convs.set(key, c);
    }
    c.rows.push(r);
  }
  for (const u of input.users) {
    if (++n % STEP_ROWS === 0) yield;
    convs.get(streamOf(u))?.users.push(u);
  }
  for (const k of input.compacts) convs.get(streamOf(k))?.compacts.push(k);
  for (const c of convs.values()) {
    n += c.rows.length + c.users.length;
    if (n >= STEP_ROWS) {
      n = 0;
      yield;
    }
    c.rows.sort((a, b) => a.ts - b.ts);
    c.users.sort((a, b) => a.ts - b.ts);
    c.compacts.sort((a, b) => a.ts - b.ts);
  }

  // The largest fixed part a first request may keep, for main and sub-agent conversations separately.
  const caps = { main: 0, sub: 0 };
  for (const sub of [false, true]) {
    const rests = [...convs.values()].filter((c) => c.sub === sub).map(openingRest);
    caps[sub ? "sub" : "main"] = median(rests) * FIXED_CAP_FACTOR;
  }

  // Parts are kept per agent and summed at the end, so each agent's list and the whole list come from one replay.
  const items = new Map<string, Map<string, FlowItem>>();
  const itemFor = (agent: string, source: FlowSource, label: string): FlowItem => {
    const key = `${source}\u0000${label}`;
    let mine = items.get(agent);
    if (!mine) items.set(agent, (mine = new Map()));
    let it = mine.get(key);
    if (!it) mine.set(key, (it = { label, source, tokens: 0, rereadTokens: 0, rereadUsd: 0 }));
    return it;
  };
  const pastes: Paste[] = [];
  const bigResults: BigResult[] = [];
  const toolFill = new Map<string, number>();
  const peak = new Map<string, number>();
  const wholeBest = new Map<string, number>();
  const effects: CompactionEffect[] = [];

  type Stay = { source: FlowSource; label: string; tokens: number; counted: boolean; listed: boolean; paste: boolean; tool?: string; from: number; item: FlowItem | null };

  const replay = function* (c: Conv, cap: number): Steps<void> {
    // Running totals after each counted request since the last compaction: re-read tokens share and USD.
    let shares = [0];
    let spend = [0];
    let stays: Stay[] = [];
    let held = 0;
    let waiting: Piece[] = [];
    let opening = true;
    let afterCompact = false;
    let ownFixed: number | null = null;
    let prevPrompt = 0;
    let prevOutput = 0;
    let prevTs: number | null = null;
    // Life of the cache the stream's latest cache write went to.
    let life: CacheLife = "5m";
    const wholes = new Map<string, number>();

    const admit = (source: FlowSource, label: string, tokens: number, counted: boolean, flags: { paste?: boolean; listed?: boolean; tool?: string } = {}): void => {
      if (tokens <= 0) return;
      const listed = flags.listed !== false;
      const item = listed && counted ? itemFor(c.agent, source, label) : null;
      if (item) item.tokens += tokens;
      stays.push({ source, label, tokens, counted, listed, paste: flags.paste === true, ...(flags.tool !== undefined && { tool: flags.tool }), from: shares.length - 1, item });
      held += tokens;
    };
    const dropAll = (): void => {
      const end = shares.length - 1;
      for (const s of stays) {
        if (!s.listed || (!s.counted && shares[end] === shares[s.from])) continue;
        const usd = s.tokens * (spend[end] - spend[s.from]);
        const it = s.item ?? itemFor(c.agent, s.source, s.label);
        it.rereadUsd += usd;
        it.rereadTokens += s.tokens * (shares[end] - shares[s.from]);
        if (s.paste && s.counted && s.tokens >= PASTE_MIN_TOKENS) pastes.push({ sessionId: c.sessionId, tokens: s.tokens, rereadUsd: usd });
        if (s.tool !== undefined && s.counted && s.tokens >= HUGE_RESULT_MIN_TOKENS) bigResults.push({ sessionId: c.sessionId, tool: s.tool, source: s.source, label: s.label, tokens: s.tokens, rereadUsd: usd });
      }
      stays = [];
      held = 0;
      shares = [0];
      spend = [0];
    };

    // The main-thread compaction whose requests are being tallied, and the sum of their cache-read rates.
    let cur: CompactionEffect | null = null;
    let curRate = 0;
    const finish = (followed: boolean): void => {
      if (cur === null) return;
      const e = cur;
      cur = null;
      e.repeated = followed && e.requests <= QUICK_REPEAT;
      // Integer arithmetic keeps the 60 percent edge exact.
      const stayed = e.postTokens !== null && e.preTokens > 0 && e.postTokens * 10 >= e.preTokens * 6;
      if (stayed) {
        e.keptTokens = (e.postTokens! * 10 - e.preTokens * 6) / 10;
        e.keptUsd = e.keptTokens * curRate;
      }
      e.ineffective = stayed || e.repeated || e.cold;
      effects.push(e);
    };

    const { rows, users, compacts } = c;
    let ri = 0;
    let ui = 0;
    let ci = 0;
    // Wake order at one instant: compaction, then arrivals, then the request that read them.
    while (ri < rows.length || ui < users.length || ci < compacts.length) {
      if (++n % STEP_ROWS === 0) yield;
      const tc = ci < compacts.length ? compacts[ci].ts : Infinity;
      const tu = ui < users.length ? users[ui].ts : Infinity;
      const tr = ri < rows.length ? rows[ri].ts : Infinity;
      if (tc <= tu && tc <= tr) {
        const k = compacts[ci++];
        if (!c.sub) {
          finish(true);
          const pre = k.preTokens !== undefined && k.preTokens > 0 ? k.preTokens : prevPrompt;
          // Idle time before the compaction began (the boundary is written when it ends); a compaction after the cache expired re-reads the whole prefix uncached.
          const idleMs = prevTs === null ? 0 : Math.max(0, k.ts - (k.durationMs ?? 0) - prevTs);
          const cold = idleMs > (life === "1h" ? HOUR_MS : FIVE_MIN_MS);
          cur = { sessionId: c.sessionId, ts: k.ts, ...(k.trigger !== undefined && { trigger: k.trigger }), preTokens: pre, postTokens: null, requests: 0, savedTokens: 0, savedUsd: 0, keptTokens: 0, keptUsd: 0, ineffective: false, repeated: false, idleMs, cold };
          curRate = 0;
        }
        dropAll();
        opening = true;
        afterCompact = true;
        prevPrompt = 0;
        prevOutput = 0;
        continue;
      }
      if (tu <= tr) {
        waiting.push(...piecesOf(users[ui++], tools));
        continue;
      }
      const row = rows[ri++];
      const counted = input.counted(row);
      const prompt = promptOf(row.tokens);
      input.onRequest?.({ row, counted, pieces: waiting, opening, afterCompact, prevTs });
      prevTs = row.ts;
      if (row.tokens.cw5m + row.tokens.cw1h > 0) life = cacheLife([{ ts: row.ts, cw5m: row.tokens.cw5m, cw1h: row.tokens.cw1h }]);
      if (cur !== null) {
        const e: CompactionEffect = cur;
        e.requests++;
        e.postTokens ??= prompt;
        if (counted) {
          const rate = input.cacheReadUsd(row);
          const gone = Math.max(0, e.preTokens - prompt);
          e.savedTokens += gone;
          e.savedUsd += gone * rate;
          curRate += rate;
        }
      }
      if (counted) {
        const share = held <= 0 ? 1 : Math.min(1, row.tokens.cacheRead / held);
        shares.push(shares[shares.length - 1] + share);
        spend.push(spend[spend.length - 1] + share * input.cacheReadUsd(row));
        if (prompt > (peak.get(c.sessionId) ?? 0)) peak.set(c.sessionId, prompt);
        for (const t of row.tools) if (t.whole && t.target !== undefined) wholes.set(t.target, (wholes.get(t.target) ?? 0) + 1);
      }
      const arrived = waiting.reduce((n, p) => n + p.chars / CHARS_PER_TOKEN, 0);
      let scale = 1;
      if (opening) {
        const rest = Math.max(0, prompt - arrived);
        if (arrived > prompt) scale = prompt / arrived;
        const fixed = Math.min(rest, ownFixed ?? cap);
        ownFixed ??= fixed;
        admit("fixed", c.fixedLabel, fixed, counted);
        if (afterCompact) admit("compaction", SUMMARY, rest - fixed, counted);
        else admit("prompt", CARRIED, rest - fixed, counted);
        opening = false;
        afterCompact = false;
      } else {
        const growth = prompt - prevPrompt - prevOutput;
        if (growth > 0 && arrived > 0) scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, growth / arrived));
      }
      for (const p of waiting) {
        const tokens = (p.chars / CHARS_PER_TOKEN) * scale;
        admit(p.source, p.label, tokens, counted, { paste: p.paste, ...(p.tool !== undefined && { tool: p.tool }) });
        if (counted && p.tool !== undefined) toolFill.set(p.tool, (toolFill.get(p.tool) ?? 0) + tokens);
      }
      waiting = [];
      // The previous reply is in this prompt too, unlisted: later requests re-read it.
      admit("prompt", "", prevOutput, counted, { listed: false });
      prevPrompt = prompt;
      prevOutput = row.tokens.output;
    }
    finish(false);
    dropAll();
    for (const [file, n] of wholes) if (n > (wholeBest.get(file) ?? 0)) wholeBest.set(file, n);
  };

  for (const c of convs.values()) {
    if (c.rows.length === 0) continue;
    n += c.rows.length;
    if (n >= STEP_ROWS) {
      n = 0;
      yield;
    }
    yield* replay(c, c.sub ? caps.sub : caps.main);
  }

  const repeated = [...wholeBest].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1] || text(a[0], b[0]));
  const ranked = (list: Iterable<FlowItem>): FlowItem[] =>
    [...list]
      .filter((f) => f.tokens > 0 || f.rereadUsd > 0)
      .sort((a, b) => b.rereadUsd - a.rereadUsd || b.tokens - a.tokens || text(a.source, b.source) || text(a.label, b.label))
      .slice(0, FLOW_ITEMS);
  const whole = new Map<string, FlowItem>();
  const byAgent = dict<FlowItem[]>();
  for (const [agent, mine] of items) {
    byAgent[agent] = ranked(mine.values());
    for (const [key, it] of mine) {
      const sum = whole.get(key);
      if (!sum) whole.set(key, { ...it });
      else {
        sum.tokens += it.tokens;
        sum.rereadTokens += it.rereadTokens;
        sum.rereadUsd += it.rereadUsd;
      }
    }
  }
  // Per server, over every part: the lists below keep only the costliest.
  const mcpReread = dict<number>();
  for (const it of whole.values()) {
    const server = it.source === "mcp" ? mcpServerOf(it.label) : null;
    if (server !== null) mcpReread[server] = (mcpReread[server] ?? 0) + it.rereadUsd;
  }
  const flow = ranked(whole.values());
  effects.sort((a, b) => a.ts - b.ts || text(a.sessionId, b.sessionId));
  pastes.sort((a, b) => b.rereadUsd - a.rereadUsd || b.tokens - a.tokens || text(a.sessionId, b.sessionId));
  bigResults.sort((a, b) => b.rereadUsd - a.rereadUsd || b.tokens - a.tokens || text(a.sessionId, b.sessionId) || text(a.label, b.label));
  return { flow, byAgent, pastes: pastes.slice(0, FLOW_ITEMS), bigResults: bigResults.slice(0, FLOW_ITEMS), wholeReads: dictOf(repeated.slice(0, FLOW_ITEMS)), toolFill: dictOf(toolFill), peakContext: dictOf(peak), mcpReread, compactionEffects: effects };
}
