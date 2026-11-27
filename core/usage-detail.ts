// The Usage tab's figures: where each billed kind of token went. Input and output are split by the text that came
// with or went out in each request (characters / 4, scaled to the tokens the request reported), so those rows are
// estimates; cache writes are the reported tokens, each with the reason that most likely caused it. Pure.
import type { BreakdownSnapshot } from "./breakdown.ts";
import { dict } from "./dict.ts";
import { CARRIED, NOTICES } from "./flow.ts";
import type { FlowItem, FlowSource, Piece, RequestSeen } from "./flow.ts";
import { resolvePrice, unitPrices } from "./pricing.ts";
import type { PriceTable, Resolver } from "./pricing.ts";
import { MAIN_AGENT } from "./stream.ts";
import type { Summary } from "./summary.ts";
import type { UsageRow } from "./types.ts";

export type UsageKind = "input" | "output" | "cacheRead" | "cacheWrite";
export const USAGE_KINDS: readonly UsageKind[] = ["input", "output", "cacheRead", "cacheWrite"];

/** One line of a section; an item under a group has its label indented by two spaces. `full` is the whole text a label cut short. */
export type DetailRow = { label: string; tokens: number; usd: number; estimated: boolean; full?: string };

export type Amount = { tokens: number; usd: number };

/** Why a request wrote to the cache. */
export type WriteWhy = "first" | "compaction" | "pause" | "prompt" | "message" | "tool" | "reply";

export type BigWrite = { ts: number; model: string; tokens: number; usd: number; why: WriteWhy; pauseMs?: number; detail?: string };
export type UsageItem = { label: string; tokens: number; usd: number; count: number; full?: string };
export type UsageGroup = { key: string; tokens: number; usd: number; count: number; items: UsageItem[] };
export type UsageSlice = {
  totals: Record<UsageKind, Amount>;
  /** Input by where it came from; key is a `SourceKey`. */
  input: UsageGroup[];
  /** Output by kind; key is an `OutputKey`. */
  output: UsageGroup[];
  /** Cache writes by model. */
  writes: UsageGroup[];
  /** The largest single writes, biggest first. */
  big: BigWrite[];
};
/** Per agent (`main`, `sub:<type>`). */
export type UsageDetail = { slices: Record<string, UsageSlice> };

export type SourceKey = FlowSource | "notice" | "carried";
export type OutputKey = "thinking" | "reply" | "write" | "command" | "agent" | "other";

/** Most items kept under a group, most big writes kept per agent. */
export const ITEMS_KEPT = 8;
export const BIG_WRITES = 12;
/** Full texts are cut here. */
export const FULL_CAP = 2000;
const CHARS_PER_TOKEN = 4;
const ITEM_LABEL = 70;
const ITEM_POOL = 800;
const PAUSE_FACTOR = 2;
const LIFE_MS = { "5m": 300_000, "1h": 3_600_000 } as const;

const WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const AGENT_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);

const text = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const zero = (): Amount => ({ tokens: 0, usd: 0 });
const byUsd = <T extends Amount & { label?: string; key?: string }>(a: T, b: T): number => b.usd - a.usd || b.tokens - a.tokens || text(a.label ?? a.key ?? "", b.label ?? b.key ?? "");

export const INPUT_LABEL: Record<SourceKey, string> = {
  fixed: "Startup context",
  prompt: "Typed messages",
  notice: "Harness notices",
  carried: "Earlier chat (resume)",
  read: "File reads",
  bash: "Shell output",
  mcp: "MCP tool output",
  tool: "Other tool output",
  compaction: "Compaction recap",
};

export const OUTPUT_LABEL: Record<OutputKey, string> = {
  thinking: "Thinking",
  reply: "Reply text",
  write: "File writes and edits",
  command: "Shell commands",
  agent: "Sub-agent briefs",
  other: "Other tool calls",
};

export const KIND_LABEL: Record<UsageKind, string> = { input: "Input", output: "Output", cacheRead: "Cache read", cacheWrite: "Cache write" };
export const KIND_NOTE: Record<UsageKind, string> = { input: "full price, by source", output: "by what was written", cacheRead: "by content", cacheWrite: "per agent and model" };

/** A model id without its `claude-` prefix. */
export const shortModel = (model: string): string => model.replace(/^claude-/, "");

/** An agent key as a label: the main thread, or the sub-agent's type. */
export function agentLabel(key: string): string {
  if (key === MAIN_AGENT) return "Main conversation";
  return key.startsWith("sub:") ? key.slice(4) : key;
}

// First line, whitespace collapsed, cut to `max` code points.
function clip(s: string, max: number): string {
  const first = s.trim().split(/\r?\n/, 1)[0]!.replace(/\s+/g, " ");
  const points = Array.from(first);
  return points.length <= max ? first : `${points.slice(0, max - 1).join("")}\u{2026}`;
}

const sourceKeyOf = (p: Piece): SourceKey => (p.source === "prompt" && p.label === NOTICES ? "notice" : p.source);

type Acc = { key: string; tokens: number; usd: number; count: number; items: Map<string, UsageItem> };

function accOf(map: Map<string, Acc>, key: string): Acc {
  let a = map.get(key);
  if (!a) map.set(key, (a = { key, tokens: 0, usd: 0, count: 0, items: new Map() }));
  return a;
}

function bumpItem(a: Acc, label: string, tokens: number, usd: number, full?: string): void {
  let it = a.items.get(label);
  if (!it) {
    a.items.set(label, (it = { label, tokens: 0, usd: 0, count: 0 }));
    // A long run keeps the costliest items only, so the pool stays small.
    if (a.items.size > ITEM_POOL * 2) {
      const keep = [...a.items.values()].sort(byUsd).slice(0, ITEM_POOL);
      a.items = new Map(keep.map((i) => [i.label, i]));
      a.items.set(label, it);
    }
  }
  it.tokens += tokens;
  it.usd += usd;
  it.count++;
  if (full !== undefined && it.full === undefined) it.full = full.length > FULL_CAP ? full.slice(0, FULL_CAP) : full;
}

type SliceAcc = { totals: Record<UsageKind, Amount>; input: Map<string, Acc>; output: Map<string, Acc>; writes: Map<string, Acc>; big: BigWrite[] };

const sliceAcc = (): SliceAcc => ({
  totals: { input: zero(), output: zero(), cacheRead: zero(), cacheWrite: zero() },
  input: new Map(),
  output: new Map(),
  writes: new Map(),
  big: [],
});

const groupsOf = (m: Map<string, Acc>, items: boolean): UsageGroup[] =>
  [...m.values()].sort(byUsd).map((a) => ({ key: a.key, tokens: a.tokens, usd: a.usd, count: a.count, items: items ? [...a.items.values()].sort(byUsd).slice(0, ITEMS_KEPT) : [] }));

type OutPart = { key: OutputKey; item?: { label: string; full?: string }; tokens: number };

// What a request's tool calls wrote, by kind of call.
function outputParts(r: UsageRow): OutPart[] {
  const parts: OutPart[] = [];
  if (r.replyChars > 0) parts.push({ key: "reply", tokens: r.replyChars / CHARS_PER_TOKEN });
  for (const t of r.tools) {
    const tokens = t.inputChars / CHARS_PER_TOKEN;
    if (WRITE_TOOLS.has(t.name)) parts.push({ key: "write", tokens, item: { label: t.target ?? t.name, ...(t.target !== undefined && { full: t.target }) } });
    else if (t.name === "Bash") parts.push({ key: "command", tokens, item: { label: clip(t.command ?? "", ITEM_LABEL) || "Bash", ...(t.command !== undefined && { full: t.command }) } });
    else if (AGENT_TOOLS.has(t.name)) parts.push({ key: "agent", tokens });
    else parts.push({ key: "other", tokens, item: { label: t.name } });
  }
  return parts;
}

// The cause of a write: the piece that brought most text in, unless the request began a stream, followed a compaction or a long pause.
function whyOf(seen: RequestSeen, tokens: number, ttl: "5m" | "1h"): { why: WriteWhy; pauseMs?: number; detail?: string } {
  if (seen.afterCompact) return { why: "compaction" };
  if (seen.opening) return { why: "first" };
  const fresh = seen.pieces.reduce((n, p) => n + p.chars / CHARS_PER_TOKEN, 0);
  const gap = seen.prevTs === null ? 0 : seen.row.ts - seen.prevTs;
  if (gap > LIFE_MS[ttl] && tokens > PAUSE_FACTOR * fresh) return { why: "pause", pauseMs: gap };
  let big: Piece | undefined;
  for (const p of seen.pieces) if (big === undefined || p.chars > big.chars) big = p;
  if (big === undefined) return { why: "reply" };
  const body = big.text ?? big.label;
  if (big.source === "prompt" && big.label !== NOTICES) return { why: "prompt", detail: body };
  if (big.source === "prompt" || big.source === "compaction") return { why: "message", detail: body };
  return { why: "tool", detail: big.tool !== undefined && !body.startsWith(big.tool) ? `${big.tool} ${body}` : body };
}

/** Collects the Usage tab's figures from the requests the context replay sees; `add` is O(pieces) per request. */
export function usageCollector(prices: PriceTable): { add: (seen: RequestSeen) => void; done: () => UsageDetail } {
  const slices = new Map<string, SliceAcc>();
  const priceCache = new Map<string, ReturnType<Resolver>>();
  const resolve: Resolver = (m) => {
    if (!priceCache.has(m)) priceCache.set(m, resolvePrice(m, prices));
    return priceCache.get(m) ?? null;
  };

  const add = (seen: RequestSeen): void => {
    if (!seen.counted) return;
    const r = seen.row;
    const agent = r.sidechain || r.agentId !== undefined ? `sub:${r.agentType ?? "sub-agent"}` : MAIN_AGENT;
    let s = slices.get(agent);
    if (!s) slices.set(agent, (s = sliceAcc()));
    const u = unitPrices(r, prices, resolve);
    const t = r.tokens;
    const wrote = t.cw5m + t.cw1h;
    s.totals.input.tokens += t.input;
    s.totals.input.usd += t.input * u.input;
    s.totals.output.tokens += t.output;
    s.totals.output.usd += t.output * u.output;
    s.totals.cacheRead.tokens += t.cacheRead;
    s.totals.cacheRead.usd += t.cacheRead * u.read;
    s.totals.cacheWrite.tokens += wrote;
    s.totals.cacheWrite.usd += t.cw5m * u.cw5m + t.cw1h * u.cw1h;

    // Input: shared among the parts that arrived with the request by their size.
    if (t.input > 0) {
      const size = seen.pieces.reduce((n, p) => n + p.chars, 0);
      if (size === 0) {
        const a = accOf(s.input, seen.opening ? "fixed" : "prompt");
        a.tokens += t.input;
        a.usd += t.input * u.input;
        a.count++;
      } else {
        const here = new Map<string, number>();
        for (const p of seen.pieces) here.set(sourceKeyOf(p), (here.get(sourceKeyOf(p)) ?? 0) + p.chars);
        for (const [key, chars] of here) {
          const tokens = (t.input * chars) / size;
          const a = accOf(s.input, key);
          a.tokens += tokens;
          a.usd += tokens * u.input;
          a.count++;
        }
      }
    }

    // Output: the written parts by size, the rest of the reported tokens thinking.
    if (t.output > 0) {
      const parts = outputParts(r);
      const visible = parts.reduce((n, p) => n + p.tokens, 0);
      const scale = visible > t.output ? t.output / visible : 1;
      const thinking = Math.max(0, t.output - visible);
      if (thinking > 0) {
        const a = accOf(s.output, "thinking");
        a.tokens += thinking;
        a.usd += thinking * u.output;
        a.count++;
      }
      for (const p of parts) {
        const tokens = p.tokens * scale;
        const a = accOf(s.output, p.key);
        a.tokens += tokens;
        a.usd += tokens * u.output;
        a.count++;
        if (p.item !== undefined) bumpItem(a, p.item.label, tokens, tokens * u.output, p.item.full);
      }
    }

    if (wrote > 0) {
      const usd = t.cw5m * u.cw5m + t.cw1h * u.cw1h;
      const a = accOf(s.writes, r.model);
      a.tokens += wrote;
      a.usd += usd;
      a.count++;
      const why = whyOf(seen, wrote, t.cw1h > t.cw5m ? "1h" : "5m");
      s.big.push({ ts: r.ts, model: r.model, tokens: wrote, usd, ...why });
      if (s.big.length > BIG_WRITES * 4) s.big = s.big.sort((x, y) => y.tokens - x.tokens || x.ts - y.ts).slice(0, BIG_WRITES);
    }
  };

  const done = (): UsageDetail => {
    const out: UsageDetail = { slices: dict<UsageSlice>() };
    for (const [agent, s] of slices) {
      out.slices[agent] = {
        totals: s.totals,
        input: groupsOf(s.input, false),
        output: groupsOf(s.output, true),
        writes: groupsOf(s.writes, false),
        big: s.big.sort((x, y) => y.tokens - x.tokens || x.ts - y.ts).slice(0, BIG_WRITES),
      };
    }
    return out;
  };
  return { add, done };
}

// ---- Reading the figures back ----

/** The agents with spend, the main thread first, then sub-agent types by cost. */
export function usageAgents(src: Pick<Summary, "usage">): Array<{ key: string; usd: number }> {
  const out: Array<{ key: string; usd: number }> = [];
  for (const [key, s] of Object.entries(src.usage?.slices ?? {})) out.push({ key, usd: USAGE_KINDS.reduce((n, k) => n + s.totals[k].usd, 0) });
  return out.sort((a, b) => (a.key === MAIN_AGENT ? -1 : b.key === MAIN_AGENT ? 1 : b.usd - a.usd || text(a.key, b.key)));
}

const slicesOf = (src: Pick<Summary, "usage">, agent: string | undefined): Array<[string, UsageSlice]> => {
  const all = Object.entries(src.usage?.slices ?? {});
  return agent === undefined ? all : all.filter(([k]) => k === agent);
};

/** A kind's total over the chosen agent, or over every agent. */
export function usageTotals(src: Pick<Summary, "usage">, kind: UsageKind, agent?: string): Amount {
  const sum = zero();
  for (const [, s] of slicesOf(src, agent)) {
    sum.tokens += s.totals[kind].tokens;
    sum.usd += s.totals[kind].usd;
  }
  return sum;
}

function mergeGroups(lists: UsageGroup[][]): UsageGroup[] {
  const by = new Map<string, UsageGroup>();
  for (const list of lists) {
    for (const g of list) {
      let m = by.get(g.key);
      if (!m) by.set(g.key, (m = { key: g.key, tokens: 0, usd: 0, count: 0, items: [] }));
      m.tokens += g.tokens;
      m.usd += g.usd;
      m.count += g.count;
      for (const it of g.items) {
        const have = m.items.find((x) => x.label === it.label);
        if (have) {
          have.tokens += it.tokens;
          have.usd += it.usd;
          have.count += it.count;
        } else m.items.push({ ...it });
      }
    }
  }
  return [...by.values()].sort(byUsd);
}

export type DetailOpts = {
  /** The context breakdown that sizes the fixed part's pieces; none leaves the fixed part whole. */
  snap?: BreakdownSnapshot | null;
  /** Minutes east of UTC, for the times in big-write labels. */
  tzOffsetMin?: number;
  /** Items listed under a group. */
  items?: number;
};

const sum = (o: Record<string, number>): number => Object.values(o).reduce((a, b) => a + b, 0);

// The fixed part's re-read split by what the breakdown says it holds; what the breakdown does not account for stays one row.
function fixedSplit(item: FlowItem, snap: BreakdownSnapshot): DetailRow[] {
  let resident = 0;
  for (const m of Object.values(snap.mcp)) resident += Math.max(0, m.tokens - m.deferred);
  const parts: Array<[string, number]> = [
    ["Base instructions", snap.system],
    ["Built-in tool schemas", snap.tools],
    ["Memory notes", sum(snap.memory)],
    ["Skill listing", sum(snap.skills)],
    ["MCP server schemas", resident],
    ["Custom agent list", sum(snap.agents)],
  ];
  const known = parts.reduce((n, [, t]) => n + t, 0);
  const whole = Math.max(known, item.tokens);
  if (known <= 0 || whole <= 0) return [];
  const rows: DetailRow[] = [];
  for (const [label, tokens] of parts) {
    if (tokens > 0) rows.push({ label: `  ${label}`, tokens: (item.rereadTokens * tokens) / whole, usd: (item.rereadUsd * tokens) / whole, estimated: true });
  }
  if (item.tokens > known) rows.push({ label: "  Other startup context", tokens: (item.rereadTokens * (item.tokens - known)) / whole, usd: (item.rereadUsd * (item.tokens - known)) / whole, estimated: true });
  return rows.sort((a, b) => b.usd - a.usd || b.tokens - a.tokens);
}

const flowKeyOf = (f: FlowItem): SourceKey => (f.source === "prompt" ? (f.label === NOTICES ? "notice" : f.label === CARRIED ? "carried" : "prompt") : f.source);

// Groups whose parts are named things worth listing; notices, a resumed chat and a recap are one part each.
const LISTED: ReadonlySet<SourceKey> = new Set(["fixed", "prompt", "read", "bash", "mcp", "tool"]);

// Cache read: the context's parts by where they came from, each group's costliest items beneath.
function readRows(src: Summary, agent: string | undefined, opts: DetailOpts): DetailRow[] {
  const list = agent === undefined ? src.flow : (src.flowByAgent[agent] ?? []);
  const limit = opts.items ?? ITEMS_KEPT;
  const groups = new Map<SourceKey, { tokens: number; usd: number; items: FlowItem[] }>();
  for (const f of list) {
    const key = flowKeyOf(f);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { tokens: 0, usd: 0, items: [] }));
    g.tokens += f.rereadTokens;
    g.usd += f.rereadUsd;
    g.items.push(f);
  }
  const rows: DetailRow[] = [];
  for (const [key, g] of [...groups.entries()].sort((a, b) => b[1].usd - a[1].usd || b[1].tokens - a[1].tokens || text(a[0], b[0]))) {
    rows.push({ label: INPUT_LABEL[key], tokens: g.tokens, usd: g.usd, estimated: true });
    if (!LISTED.has(key)) continue;
    const items = g.items.sort((a, b) => b.rereadUsd - a.rereadUsd || b.rereadTokens - a.rereadTokens || text(a.label, b.label));
    // The main thread's own fixed part is the one the context breakdown describes.
    const main = key === "fixed" && opts.snap != null && (agent === undefined || agent === MAIN_AGENT) ? items.find((f) => f.label === "fixed part") : undefined;
    const shown: DetailRow[] = main === undefined ? [] : fixedSplit(main, opts.snap!);
    for (const f of items) {
      // A part re-read less than once in all is noise.
      if ((shown.length > 0 && f === main) || f.rereadTokens < 1) continue;
      shown.push({ label: `  ${key === "fixed" ? itemName(f) : f.label}`, tokens: f.rereadTokens, usd: f.rereadUsd, estimated: true });
    }
    rows.push(...shown.slice(0, limit));
  }
  return rows;
}

// A fixed part's label as shown: `fixed part (Explore)` is that sub-agent's own startup context.
const itemName = (f: FlowItem): string => {
  const m = /^fixed part \((.*)\)$/.exec(f.label);
  return m ? `${m[1]} startup` : "Main startup";
};

const pad = (n: number): string => String(n).padStart(2, "0");

/** `11-27 14:05` in the zone `tzOffsetMin` east of UTC. */
export function stamp(ts: number, tzOffsetMin = 0): string {
  const d = new Date(ts + tzOffsetMin * 60_000);
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

const spanText = (ms: number): string => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
};

/** A write's cause in words. */
export function whyText(w: Pick<BigWrite, "why" | "pauseMs" | "detail">): string {
  switch (w.why) {
    case "first":
      return "first request of the conversation";
    case "compaction":
      return "after compacting";
    case "pause":
      return `cache lapsed after a ${spanText(w.pauseMs ?? 0)} pause`;
    case "prompt":
      return `message: ${clip(w.detail ?? "", 40)}`;
    case "message":
      return `incoming notice: ${clip(w.detail ?? "", 40)}`;
    case "tool":
      return `tool output: ${clip(w.detail ?? "", 40)}`;
    case "reply":
      return "the previous reply";
  }
}

/** Cache write as two parts: the agent-and-model groups, then the largest single writes. */
export function writeParts(src: Pick<Summary, "usage">, agent: string | undefined, opts: DetailOpts = {}): { groups: DetailRow[]; largest: DetailRow[] } {
  const groups: DetailRow[] = [];
  const big: Array<BigWrite & { agent: string }> = [];
  const rows: Array<{ agent: string; g: UsageGroup }> = [];
  for (const [key, s] of slicesOf(src, agent)) {
    for (const g of s.writes) rows.push({ agent: key, g });
    for (const b of s.big) big.push({ ...b, agent: key });
  }
  for (const { agent: key, g } of rows.sort((a, b) => byUsd(a.g, b.g))) {
    groups.push({ label: `${agentLabel(key)} \u{b7} ${shortModel(g.key)} \u{b7} ${g.count} ${g.count === 1 ? "write" : "writes"}`, tokens: g.tokens, usd: g.usd, estimated: false });
  }
  const largest = big
    .sort((a, b) => b.tokens - a.tokens || a.ts - b.ts)
    .slice(0, opts.items ?? ITEMS_KEPT)
    .map((b): DetailRow => {
      const who = agent === undefined && b.agent !== MAIN_AGENT ? ` ${agentLabel(b.agent)}` : "";
      return {
        label: `${stamp(b.ts, opts.tzOffsetMin ?? 0)}${who} \u{b7} ${whyText(b)}`,
        tokens: b.tokens,
        usd: b.usd,
        estimated: false,
        ...(b.detail !== undefined && { full: b.detail.length > FULL_CAP ? b.detail.slice(0, FULL_CAP) : b.detail }),
      };
    });
  return { groups, largest };
}

/**
 * The rows of one kind for the summary's span (built with `usage: true`), over one agent or all of them: input and
 * output are estimates split by source; cache read is the context flow, its fixed part split by `opts.snap`;
 * cache write is the reported tokens by agent and model, then the largest writes with their causes.
 */
export function usageDetail(src: Summary, kind: UsageKind, agent?: string, opts: DetailOpts = {}): DetailRow[] {
  const limit = opts.items ?? ITEMS_KEPT;
  const slices = slicesOf(src, agent);
  if (kind === "input") {
    return mergeGroups(slices.map(([, s]) => s.input)).map((g) => ({ label: INPUT_LABEL[g.key as SourceKey] ?? g.key, tokens: g.tokens, usd: g.usd, estimated: true }));
  }
  if (kind === "output") {
    const rows: DetailRow[] = [];
    for (const g of mergeGroups(slices.map(([, s]) => s.output))) {
      rows.push({ label: OUTPUT_LABEL[g.key as OutputKey] ?? g.key, tokens: g.tokens, usd: g.usd, estimated: true });
      for (const it of g.items.sort(byUsd).slice(0, limit)) rows.push({ label: `  ${it.label}`, tokens: it.tokens, usd: it.usd, estimated: true, ...(it.full !== undefined && it.full !== it.label && { full: it.full }) });
    }
    return rows;
  }
  if (kind === "cacheRead") return readRows(src, agent, opts);
  const w = writeParts(src, agent, opts);
  return [...w.groups, ...w.largest];
}

/** The tab's rows as plain text, headed by `head` and a column head: what the copy button puts on the clipboard. */
export function usageText(head: string, sections: Array<{ title: string; total: Amount; rows: DetailRow[] }>, fmt: { tokens: (n: number) => string; money: (usd: number) => string }): string {
  const cell = (label: string, tokens: string, money: string): string => `${label.padEnd(48)}${tokens.padStart(9)}${money.padStart(9)}`;
  const lines = [head, cell("what", "tokens", "cost")];
  for (const s of sections) {
    lines.push("", cell(s.title, fmt.tokens(s.total.tokens), fmt.money(s.total.usd)));
    for (const r of s.rows) lines.push(cell(r.label, `${r.estimated ? "~" : ""}${fmt.tokens(r.tokens)}`, `${r.estimated ? "~" : ""}${fmt.money(r.usd)}`));
  }
  return lines.join("\n");
}
