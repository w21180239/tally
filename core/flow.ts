// Where the context came from and what re-reading it cost, per main-thread conversation.
// Every part that enters the context (prompt, tool result, compaction summary, fixed system part) is held
// until a compaction drops it; each counted request re-reads the held parts, so a part's re-read cost is
// its tokens times the cache-read price of the requests that followed it.
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
  /** Same for a sub-agent's tool result, which has no request of its own in the flow. */
  countedUser: (u: UserRow) => boolean;
  /** USD per token of the request's cache read. */
  cacheReadUsd: (r: UsageRow) => number;
};
export type FlowOut = {
  flow: FlowItem[];
  pastes: Paste[];
  /** File path to the most whole reads of it in one conversation; only files read whole more than once. */
  wholeReads: Record<string, number>;
  /** Tool name to the tokens its results put into context. */
  toolFill: Record<string, number>;
  /** Session to its largest main-thread prompt. */
  peakContext: Record<string, number>;
};

export const FLOW_ITEMS = 40;
/** A prompt of at least this many tokens is a paste. */
export const PASTE_MIN_TOKENS = 5000;
const CHARS_PER_TOKEN = 4;
const SCALE_MIN = 0.25;
const SCALE_MAX = 4;
const PROMPT_LABEL = 60;
const COMMAND_LABEL = 80;

const FIXED = "fixed part";
const COMPACTION = "compaction";

type Part = { source: FlowSource; label: string; chars: number; paste: boolean; tool?: string };
// The model's own earlier output is held (the next prompt re-reads it) but is not listed: `visible` is false.
type Held = { tokens: number; visible: boolean; counted: boolean; source: FlowSource; label: string; paste: boolean; acc: FlowItem | null; readsAt: number; priceAt: number };

const line = (s: string, max: number): string => {
  const first = s.trim().split(/\r?\n/, 1)[0].replace(/\s+/g, " ");
  return first.length > max ? first.slice(0, max) : first;
};
const bump = (rec: Record<string, number>, key: string, n: number): void => {
  rec[key] = (Object.prototype.hasOwnProperty.call(rec, key) ? rec[key] : 0) + n;
};
const promptOf = (t: UsageRow["tokens"]): number => t.input + t.cacheRead + t.cw5m + t.cw1h;

type Tool = UsageRow["tools"][number];
function partOfTool(tool: Tool | undefined, chars: number): Part {
  if (!tool) return { source: "tool", label: "tool result", chars, paste: false };
  const base = { chars, paste: false, tool: tool.name };
  if (tool.name === "Read") return { ...base, source: "read", label: tool.target ?? "Read" };
  if (tool.name === "Bash") return { ...base, source: "bash", label: line(tool.command ?? "", COMMAND_LABEL) || "Bash" };
  if (tool.mcpServer) return { ...base, source: "mcp", label: tool.name };
  return { ...base, source: "tool", label: tool.name };
}

function partsOfUser(u: UserRow, toolById: Map<string, Tool>): Part[] {
  switch (u.kind) {
    case "prompt":
      return [{ source: "prompt", label: line(u.text ?? "", PROMPT_LABEL) || "prompt", chars: u.chars, paste: true }];
    case "notice":
      return [{ source: "prompt", label: "notices", chars: u.chars, paste: false }];
    case "compaction":
      return [{ source: "compaction", label: COMPACTION, chars: u.chars, paste: false }];
    default: {
      const blocks = u.results ?? [{ toolUseId: u.toolUseId ?? "", chars: u.chars }];
      return blocks.map((b) => partOfTool(toolById.get(b.toolUseId), b.chars));
    }
  }
}

type Ev = { ts: number; ord: number; row?: UsageRow; user?: UserRow };

export function analyzeFlow(input: FlowInput): FlowOut {
  const toolById = new Map<string, Tool>();
  const mainRows = new Map<string, UsageRow[]>();
  const peakContext: Record<string, number> = {};
  const readsBySession = new Map<string, Map<string, number>>();
  for (const r of input.rows) {
    for (const t of r.tools) if (t.id !== undefined) toolById.set(t.id, t);
    if (r.sidechain) continue;
    let list = mainRows.get(r.sessionId);
    if (!list) mainRows.set(r.sessionId, (list = []));
    list.push(r);
    if (!input.counted(r)) continue;
    const p = promptOf(r.tokens);
    if (p > (peakContext[r.sessionId] ?? 0)) peakContext[r.sessionId] = p;
    for (const t of r.tools) {
      if (!t.whole || t.target === undefined) continue;
      let m = readsBySession.get(r.sessionId);
      if (!m) readsBySession.set(r.sessionId, (m = new Map()));
      m.set(t.target, (m.get(t.target) ?? 0) + 1);
    }
  }
  const mainUsers = new Map<string, UserRow[]>();
  const subResults: UserRow[] = [];
  for (const u of input.users) {
    if (u.sidechain) {
      if (u.kind === "toolResult") subResults.push(u);
      continue;
    }
    let list = mainUsers.get(u.sessionId);
    if (!list) mainUsers.set(u.sessionId, (list = []));
    list.push(u);
  }
  const mainCompacts = new Map<string, number[]>();
  for (const c of input.compacts) {
    let list = mainCompacts.get(c.sessionId);
    if (!list) mainCompacts.set(c.sessionId, (list = []));
    list.push(c.ts);
  }

  const accs = new Map<string, FlowItem>();
  const acc = (source: FlowSource, label: string): FlowItem => {
    const key = `${source}\u0000${label}`;
    let a = accs.get(key);
    if (!a) accs.set(key, (a = { label, source, tokens: 0, rereadUsd: 0 }));
    return a;
  };
  const pastes: Paste[] = [];
  const toolFill: Record<string, number> = {};
  const ratio = new Map<string, { scaled: number; raw: number }>();

  for (const [sessionId, rows] of mainRows) {
    const evs: Ev[] = [];
    for (const r of rows) evs.push({ ts: r.ts, ord: 2, row: r });
    for (const u of mainUsers.get(sessionId) ?? []) evs.push({ ts: u.ts, ord: 1, user: u });
    for (const ts of mainCompacts.get(sessionId) ?? []) evs.push({ ts, ord: 0 });
    // At one instant: the compaction first, then what came in, then the request that read it.
    evs.sort((a, b) => a.ts - b.ts || a.ord - b.ord);

    const rat = { scaled: 0, raw: 0 };
    ratio.set(sessionId, rat);
    let held: Held[] = [];
    let heldTokens = 0;
    let pending: Part[] = [];
    // Each counted request adds the share of the held parts it read from the cache, and that share of its price.
    let reads = 0;
    let price = 0;
    let first = true;
    let compacted = false;
    let fixedRef: number | null = null;
    let prevPrompt = 0;
    let prevOutput = 0;
    let lastOutput = 0;

    const hold = (source: FlowSource, label: string, tokens: number, counted: boolean, opts: { paste?: boolean; visible?: boolean } = {}): void => {
      if (tokens <= 0) return;
      const visible = opts.visible !== false;
      let a: FlowItem | null = null;
      if (visible && counted) {
        a = acc(source, label);
        a.tokens += tokens;
      }
      held.push({ tokens, visible, counted, source, label, paste: opts.paste === true, acc: a, readsAt: reads, priceAt: price });
      heldTokens += tokens;
    };
    const release = (): void => {
      for (const h of held) {
        if (!h.visible) continue;
        const reread = h.tokens * (reads - h.readsAt);
        if (reread === 0 && !h.counted) continue;
        const cost = h.tokens * (price - h.priceAt);
        (h.acc ?? acc(h.source, h.label)).rereadUsd += cost;
        if (h.paste && h.counted && h.tokens >= PASTE_MIN_TOKENS) pastes.push({ sessionId, tokens: h.tokens, rereadUsd: cost });
      }
      held = [];
      heldTokens = 0;
    };

    for (const ev of evs) {
      if (ev.user) {
        pending.push(...partsOfUser(ev.user, toolById));
        continue;
      }
      if (!ev.row) {
        release();
        lastOutput = 0;
        first = true;
        compacted = true;
        prevPrompt = 0;
        prevOutput = 0;
        continue;
      }
      const row = ev.row;
      const counted = input.counted(row);
      const prompt = promptOf(row.tokens);
      if (counted) {
        const share = heldTokens <= 0 ? 1 : Math.min(1, row.tokens.cacheRead / heldTokens);
        reads += share;
        price += share * input.cacheReadUsd(row);
      }
      const estimate = pending.reduce((n, p) => n + p.chars / CHARS_PER_TOKEN, 0);
      let scale = 1;
      if (first) {
        // The first request (or the first after a compaction) carries the fixed part, and after a compaction the carried summary.
        const rest = Math.max(0, prompt - estimate);
        if (estimate > prompt && estimate > 0) scale = prompt / estimate;
        if (fixedRef === null) fixedRef = rest;
        const fixed = compacted ? Math.min(rest, fixedRef) : rest;
        hold("fixed", FIXED, fixed, counted);
        if (rest > fixed) hold("compaction", COMPACTION, rest - fixed, counted);
        first = false;
      } else {
        const delta = prompt - prevPrompt - prevOutput;
        if (delta > 0 && estimate > 0) scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, delta / estimate));
      }
      for (const p of pending) {
        const tokens = (p.chars / CHARS_PER_TOKEN) * scale;
        hold(p.source, p.label, tokens, counted, { paste: p.paste });
        rat.scaled += tokens;
        rat.raw += p.chars / CHARS_PER_TOKEN;
        if (counted && p.tool !== undefined) bump(toolFill, p.tool, tokens);
      }
      pending = [];
      // What the previous request wrote is part of this prompt: from the next request on it is re-read.
      hold("prompt", "", lastOutput, counted, { visible: false });
      lastOutput = row.tokens.output;
      compacted = false;
      prevPrompt = prompt;
      prevOutput = row.tokens.output;
    }
    release();
  }

  // A sub-agent's results have no flow of their own here; their size is scaled by the session's main-thread ratio.
  for (const u of subResults) {
    if (!input.countedUser(u)) continue;
    const r = ratio.get(u.sessionId);
    const k = r && r.raw > 0 ? r.scaled / r.raw : 1;
    for (const p of partsOfUser(u, toolById)) if (p.tool !== undefined) bump(toolFill, p.tool, (p.chars / CHARS_PER_TOKEN) * k);
  }

  const whole = new Map<string, number>();
  for (const m of readsBySession.values()) for (const [file, n] of m) whole.set(file, Math.max(whole.get(file) ?? 0, n));
  const wholeReads: Record<string, number> = {};
  [...whole].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, FLOW_ITEMS).forEach(([file, n]) => (wholeReads[file] = n));

  const flow = [...accs.values()]
    .filter((f) => f.tokens > 0 || f.rereadUsd > 0)
    .sort((a, b) => b.rereadUsd - a.rereadUsd || b.tokens - a.tokens || (a.source < b.source ? -1 : a.source > b.source ? 1 : a.label < b.label ? -1 : 1))
    .slice(0, FLOW_ITEMS);
  pastes.sort((a, b) => b.rereadUsd - a.rereadUsd || b.tokens - a.tokens || (a.sessionId < b.sessionId ? -1 : 1));
  return { flow, pastes: pastes.slice(0, FLOW_ITEMS), wholeReads, toolFill, peakContext };
}
