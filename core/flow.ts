// What fills each conversation's context, and what keeping it there cost.
// A conversation is replayed in time order: a prompt, tool result or compaction summary stays in the
// context until a compaction, and every counted request re-reads the cached share of it. A part's re-read
// cost is its tokens times the cache-read spend of the requests made while it was there.
import { dictOf } from "./dict.ts";
import { streamOf } from "./stream.ts";
import type { CompactRow, UsageRow, UserRow } from "./types.ts";

export type FlowSource = "prompt" | "read" | "bash" | "mcp" | "tool" | "compaction" | "fixed";
export type FlowItem = { label: string; source: FlowSource; tokens: number; rereadUsd: number };
export type Paste = { sessionId: string; tokens: number; rereadUsd: number };

export type FlowInput = {
  /** Every non-synthetic request, any order. */
  rows: UsageRow[];
  users: UserRow[];
  compacts: CompactRow[];
  /** Whether a request is inside the span and repo being summarized. Uncounted requests still fill the context. */
  counted: (r: UsageRow) => boolean;
  /** USD per token of the request's cache read. */
  cacheReadUsd: (r: UsageRow) => number;
};
export type FlowOut = {
  flow: FlowItem[];
  /** Prompts of PASTE_MIN_TOKENS or more, in any conversation. */
  pastes: Paste[];
  /** File to the most whole reads of it within one conversation; only files read whole more than once. */
  wholeReads: Record<string, number>;
  /** Tool name to the tokens its results put into context. */
  toolFill: Record<string, number>;
  /** Session to the largest prompt of any of its conversations. */
  peakContext: Record<string, number>;
};

export const FLOW_ITEMS = 40;
export const PASTE_MIN_TOKENS = 5000;
/** A first request may hold this many times the typical fixed part before the rest counts as carried-over conversation. */
export const FIXED_CAP_FACTOR = 2;
const CHARS_PER_TOKEN = 4;
const SCALE_MIN = 0.25;
const SCALE_MAX = 4;
const PROMPT_LABEL = 60;
const COMMAND_LABEL = 80;

const FIXED = "fixed part";
const CARRIED = "carried over";
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
// A chunk of text that entered the context, sized in chars until a request tells its token count.
type Piece = { source: FlowSource; label: string; chars: number; paste: boolean; tool?: string };

function pieceOfResult(tool: Tool | undefined, chars: number): Piece {
  if (!tool) return { source: "tool", label: "tool result", chars, paste: false };
  const p = { chars, paste: false, tool: tool.name };
  if (tool.name === "Read") return { ...p, source: "read", label: tool.target ?? "Read" };
  if (tool.name === "Bash") return { ...p, source: "bash", label: clip(tool.command ?? "", COMMAND_LABEL) || "Bash" };
  return { ...p, source: tool.mcpServer ? "mcp" : "tool", label: tool.name };
}

function piecesOf(u: UserRow, tools: Map<string, Tool>): Piece[] {
  if (u.kind === "prompt") return [{ source: "prompt", label: clip(u.text ?? "", PROMPT_LABEL) || "prompt", chars: u.chars, paste: true }];
  if (u.kind === "notice") return [{ source: "prompt", label: "notices", chars: u.chars, paste: false }];
  if (u.kind === "compaction") return [{ source: "compaction", label: SUMMARY, chars: u.chars, paste: false }];
  const blocks = u.results ?? [{ toolUseId: u.toolUseId ?? "", chars: u.chars }];
  return blocks.map((b) => pieceOfResult(tools.get(b.toolUseId), b.chars));
}

type Conv = { sessionId: string; sub: boolean; fixedLabel: string; rows: UsageRow[]; users: UserRow[]; compacts: number[] };

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
  const tools = new Map<string, Tool>();
  const convs = new Map<string, Conv>();
  for (const r of input.rows) {
    for (const t of r.tools) if (t.id !== undefined) tools.set(t.id, t);
    const key = streamOf(r);
    let c = convs.get(key);
    if (!c) {
      const sub = r.sidechain || r.agentId !== undefined;
      c = { sessionId: r.sessionId, sub, fixedLabel: sub ? `${FIXED} (${r.agentType ?? "sub-agent"})` : FIXED, rows: [], users: [], compacts: [] };
      convs.set(key, c);
    }
    c.rows.push(r);
  }
  for (const u of input.users) convs.get(streamOf(u))?.users.push(u);
  for (const k of input.compacts) convs.get(streamOf(k))?.compacts.push(k.ts);
  for (const c of convs.values()) {
    c.rows.sort((a, b) => a.ts - b.ts);
    c.users.sort((a, b) => a.ts - b.ts);
    c.compacts.sort((a, b) => a - b);
  }

  // The largest fixed part a first request may keep, for main and sub-agent conversations separately.
  const caps = { main: 0, sub: 0 };
  for (const sub of [false, true]) {
    const rests = [...convs.values()].filter((c) => c.sub === sub).map(openingRest);
    caps[sub ? "sub" : "main"] = median(rests) * FIXED_CAP_FACTOR;
  }

  const items = new Map<string, FlowItem>();
  const itemFor = (source: FlowSource, label: string): FlowItem => {
    const key = `${source}\u0000${label}`;
    let it = items.get(key);
    if (!it) items.set(key, (it = { label, source, tokens: 0, rereadUsd: 0 }));
    return it;
  };
  const pastes: Paste[] = [];
  const toolFill = new Map<string, number>();
  const peak = new Map<string, number>();
  const wholeBest = new Map<string, number>();

  type Stay = { source: FlowSource; label: string; tokens: number; counted: boolean; listed: boolean; paste: boolean; from: number; item: FlowItem | null };

  const replay = (c: Conv, cap: number): void => {
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
    const wholes = new Map<string, number>();

    const admit = (source: FlowSource, label: string, tokens: number, counted: boolean, flags: { paste?: boolean; listed?: boolean } = {}): void => {
      if (tokens <= 0) return;
      const listed = flags.listed !== false;
      const item = listed && counted ? itemFor(source, label) : null;
      if (item) item.tokens += tokens;
      stays.push({ source, label, tokens, counted, listed, paste: flags.paste === true, from: shares.length - 1, item });
      held += tokens;
    };
    const dropAll = (): void => {
      const end = shares.length - 1;
      for (const s of stays) {
        if (!s.listed || (!s.counted && shares[end] === shares[s.from])) continue;
        const usd = s.tokens * (spend[end] - spend[s.from]);
        (s.item ?? itemFor(s.source, s.label)).rereadUsd += usd;
        if (s.paste && s.counted && s.tokens >= PASTE_MIN_TOKENS) pastes.push({ sessionId: c.sessionId, tokens: s.tokens, rereadUsd: usd });
      }
      stays = [];
      held = 0;
      shares = [0];
      spend = [0];
    };

    const { rows, users, compacts } = c;
    let ri = 0;
    let ui = 0;
    let ci = 0;
    // Wake order at one instant: compaction, then arrivals, then the request that read them.
    while (ri < rows.length || ui < users.length || ci < compacts.length) {
      const tc = ci < compacts.length ? compacts[ci] : Infinity;
      const tu = ui < users.length ? users[ui].ts : Infinity;
      const tr = ri < rows.length ? rows[ri].ts : Infinity;
      if (tc <= tu && tc <= tr) {
        ci++;
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
        admit(p.source, p.label, tokens, counted, { paste: p.paste });
        if (counted && p.tool !== undefined) toolFill.set(p.tool, (toolFill.get(p.tool) ?? 0) + tokens);
      }
      waiting = [];
      // The previous reply is in this prompt too, unlisted: later requests re-read it.
      admit("prompt", "", prevOutput, counted, { listed: false });
      prevPrompt = prompt;
      prevOutput = row.tokens.output;
    }
    dropAll();
    for (const [file, n] of wholes) if (n > (wholeBest.get(file) ?? 0)) wholeBest.set(file, n);
  };

  for (const c of convs.values()) if (c.rows.length > 0) replay(c, c.sub ? caps.sub : caps.main);

  const repeated = [...wholeBest].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1] || text(a[0], b[0]));
  const flow = [...items.values()]
    .filter((f) => f.tokens > 0 || f.rereadUsd > 0)
    .sort((a, b) => b.rereadUsd - a.rereadUsd || b.tokens - a.tokens || text(a.source, b.source) || text(a.label, b.label))
    .slice(0, FLOW_ITEMS);
  pastes.sort((a, b) => b.rereadUsd - a.rereadUsd || b.tokens - a.tokens || text(a.sessionId, b.sessionId));
  return { flow, pastes: pastes.slice(0, FLOW_ITEMS), wholeReads: dictOf(repeated.slice(0, FLOW_ITEMS)), toolFill: dictOf(toolFill), peakContext: dictOf(peak) };
}
