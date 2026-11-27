// The Context tab: what every request carries (the system prompt, tool schemas, messages, and the skills, MCP
// servers, agents and memory files the engine lists), estimated first and counted once the full count lands. A
// sub-agent can be picked for its own detail and transcript. `drawContext` returns the rows and the keys they add.
import type { RenderElement } from "claude-code";
import { unusedIn, usedShare } from "../../core/context.ts";
import type { ContextData, ContextRow } from "../../core/context.ts";
import type { AgentLive, LiveState } from "../../core/live-state.ts";
import { baseName } from "../../core/path.ts";
import { isActive } from "../../engine/context-view.ts";
import type { AgentStates } from "../../engine/context-view.ts";
import type { TranscriptEntry } from "../../engine/subagent-transcript.ts";
import { moneyOf, percentText, tokensText } from "../data.ts";
import type { WindowData } from "../data.ts";
import type { KeyCtx } from "../keys.ts";
import { amountRow, blank, textLines, title } from "../rows.tsx";
import type { Table } from "../table.ts";
import { SEP } from "../theme.ts";
import { drawTranscript } from "../transcript.tsx";
import { stepAgent } from "./usage.tsx";

/** Entries listed in each list before the rest fold under `m`. */
export const LIST_ROWS = 6;
const PROMPT_LINES = 6;

export type ContextView = { ctxAgent: string; listing: boolean; more: boolean; transcript: boolean };

export type ContextInput = {
  d: WindowData;
  live: LiveState;
  data: ContextData;
  states: AgentStates;
  transcripts: Record<string, TranscriptEntry>;
  view: ContextView;
  onAgent: (id: string) => void;
  onListing: (listing: boolean) => void;
  onMore: (more: boolean) => void;
  onTranscript: (on: boolean) => void;
};

export type ContextDrawing = { rows: RenderElement[]; ctx: KeyCtx };

/** The agents of the session in picker order: running ones first, then by their latest request, newest first. */
export function agentOrderOf(live: Pick<LiveState, "agents">, states: Pick<AgentStates, "byId">): AgentLive[] {
  return Object.values(live.agents).sort((a, b) => {
    const live_a = isActive(states.byId[a.id]?.status) ? 1 : 0;
    const live_b = isActive(states.byId[b.id]?.status) ? 1 : 0;
    return live_b - live_a || b.lastTs - a.lastTs || (a.id < b.id ? -1 : 1);
  });
}

const statusWord = (states: Pick<AgentStates, "byId">, id: string): string => {
  const s = states.byId[id]?.status;
  return s === undefined ? "finished" : isActive(s) ? s : "finished";
};

const agentLabel = (a: AgentLive, states: Pick<AgentStates, "byId">): string => `${a.type}${SEP}${statusWord(states, a.id)}`;

// A memory file as its folder and name: the whole path is long and the same for every file of a project.
function pathLabel(path: string): string {
  const parts = path.split(/[\\/]+/).filter((p) => p !== "");
  return parts.length <= 2 ? baseName(path) : `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

// The cut applied to one list.
const cutOf = <T,>(rows: T[], more: boolean): T[] => (more ? rows : rows.slice(0, LIST_ROWS));

type ListSpec = { key: string; heading: string; rows: ContextRow[]; unused: Set<string>; label: (r: ContextRow) => string };

function drawList(t: Table, mark: string, spec: ListSpec, more: boolean, top: number): { rows: RenderElement[]; hidden: number } {
  if (spec.rows.length === 0) return { rows: [], hidden: 0 };
  const loaded = spec.rows.reduce((n, r) => n + r.tokens, 0);
  const deferred = spec.rows.reduce((n, r) => n + r.deferred, 0);
  const note = deferred > 0 ? `${tokensText(deferred)} deferred until searched for` : `${spec.rows.length}${spec.unused.size > 0 ? `${SEP}${spec.unused.size} unused` : ""}`;
  const out: RenderElement[] = [title(t, spec.key, spec.heading, note, `${mark}${tokensText(loaded)}`)];
  const shown = cutOf(spec.rows, more);
  for (const r of shown) {
    const marks = [...(spec.unused.has(r.name) ? ["unused"] : []), ...(r.deferred > 0 ? [r.tokens > 0 ? "part deferred" : "deferred"] : [])];
    const weight = r.tokens + r.deferred;
    out.push(
      amountRow(t, {
        key: `${spec.key}-${r.name}`,
        label: marks.length === 0 ? spec.label(r) : `${spec.label(r)}${SEP}${marks.join(", ")}`,
        amount: `${mark}${tokensText(weight)}`,
        share: top > 0 ? weight / top : 0,
        quiet: spec.unused.has(r.name) || r.tokens === 0,
      }),
    );
  }
  return { rows: out, hidden: spec.rows.length - shown.length };
}

function drawMain(t: Table, i: ContextInput, ctx: KeyCtx): RenderElement[] {
  const { Text, Button } = t;
  const { data, view } = i;
  const out: RenderElement[] = [];
  const mark = data.precision === "estimated" ? "~" : "";
  const share = usedShare(data);
  const note = [data.precision === "estimated" ? "estimated, counting follows" : "counted", ...(data.deferred > 0 ? [`${tokensText(data.deferred)} also deferred`] : [])].join(SEP);
  out.push(title(t, "context", "In every request", note, `${mark}${tokensText(data.total)}`));
  if (share !== null) out.push(<Text key="context-share" dimColor>{`${percentText(share)} of the ${tokensText(data.max)} window`}</Text>);

  const lists: ListSpec[] = [
    { key: "skill", heading: "Skills", rows: data.skills, unused: unusedIn("skills", data.skills, data.used), label: (r) => r.name },
    { key: "mcp", heading: "MCP servers", rows: data.mcp, unused: unusedIn("mcp", data.mcp, data.used), label: (r) => r.name },
    { key: "agent", heading: "Agents", rows: data.agents, unused: unusedIn("agents", data.agents, data.used), label: (r) => r.name },
    { key: "memory", heading: "Memory files", rows: data.memory, unused: new Set(), label: (r) => pathLabel(r.name) },
  ];
  const fixed: Array<[string, string, number]> = [
    ["system", "System prompt", data.system],
    ["tools", "System tools", data.tools],
    ["messages", "Messages", data.messages],
  ];
  const top = Math.max(...fixed.map(([, , n]) => n), ...lists.flatMap((l) => l.rows.map((r) => r.tokens + r.deferred)), 0);
  for (const [key, label, n] of fixed) {
    if (n > 0) out.push(amountRow(t, { key: `part-${key}`, label, amount: `${mark}${tokensText(n)}`, share: top > 0 ? n / top : 0 }));
  }
  let hidden = 0;
  for (const spec of lists) {
    const drawn = drawList(t, mark, spec, view.more, top);
    if (drawn.rows.length === 0) continue;
    out.push(blank(t, `list-${spec.key}`), ...drawn.rows);
    hidden += drawn.hidden;
  }
  if (hidden > 0 || (view.more && lists.some((l) => l.rows.length > LIST_ROWS))) {
    ctx.more = true;
    out.push(
      <Button key="lists-more" plain dimColor hotkey="m" onPress={() => i.onMore(!view.more)}>
        {view.more ? "fold lists" : `${hidden} more`}
      </Button>,
    );
  }
  if (data.max > 0) out.push(blank(t, "free"), amountRow(t, { key: "part-free", label: "Free space", amount: `${mark}${tokensText(Math.max(0, data.max - data.total))}`, quiet: true }));
  out.push(blank(t, "foot"));
  out.push(
    <Text key="context-note" dimColor wrap="truncate-end">
      {data.used === null ? "unused: shown after the project index loads" : "unused: no call in this project in the past 30 days"}
    </Text>,
  );
  return out;
}

// The agent switch: previous, the one shown, next and the list; the keys follow the Usage tab's.
function drawSwitch(t: Table, i: ContextInput, agents: AgentLive[], ctx: KeyCtx): RenderElement[] {
  const { Box, Text, Button } = t;
  const { view } = i;
  ctx.agents = true;
  const order = ["", ...agents.map((a) => a.id)];
  const chosen = agents.find((a) => a.id === view.ctxAgent);
  const nameOf = (id: string): string => (id === "" ? "Main thread" : agentLabel(agents.find((a) => a.id === id)!, i.states));
  const out: RenderElement[] = [
    <Box key="agents" flexDirection="row" columnGap={1} flexWrap="wrap">
      <Text dimColor>Viewing</Text>
      <Button key="agent-prev" label="prev" hotkey="p" dimColor onPress={() => i.onAgent(stepAgent(order, chosen?.id ?? "", -1))}>
        prev
      </Button>
      <Text weight="bold">{nameOf(chosen?.id ?? "")}</Text>
      <Button key="agent-next" label="next" hotkey="n" dimColor onPress={() => i.onAgent(stepAgent(order, chosen?.id ?? "", 1))}>
        next
      </Button>
      <Button key="agent-list" label="list" hotkey="a" dimColor onPress={() => i.onListing(!view.listing)}>
        {view.listing ? "close list" : "list"}
      </Button>
    </Box>,
  ];
  if (view.listing) {
    out.push(
      <Box key="agent-choices" flexDirection="row" columnGap={1} flexWrap="wrap">
        {order.map((id) => (
          <Button key={`agent-${id === "" ? "main" : id}`} label={nameOf(id)} {...(id === (chosen?.id ?? "") ? { variant: "primary" as const } : { dimColor: true })} onPress={() => i.onAgent(id)}>
            {nameOf(id)}
          </Button>
        ))}
      </Box>,
    );
  }
  return out;
}

function drawAgent(t: Table, i: ContextInput, a: AgentLive, ctx: KeyCtx): RenderElement[] {
  const { Text, Button } = t;
  const out: RenderElement[] = [];
  const own = i.states.byId[a.id]?.window;
  const window = own !== undefined && own > 0 ? own : i.d.context.window;
  const note = [a.description, statusWord(i.states, a.id), a.model === "" ? "" : a.model.replace(/^claude-/, "")].filter((s) => s !== "").join(SEP);
  out.push(title(t, "agent-head", a.type, note));
  out.push(
    a.context > 0
      ? amountRow(t, { key: "agent-context", label: `Current context${window > 0 ? `${SEP}${percentText(a.context / window)} of its window` : ""}`, amount: tokensText(a.context), share: window > 0 ? a.context / window : null })
      : amountRow(t, { key: "agent-context", label: "Current context, no request yet", amount: "", quiet: true }),
  );
  out.push(amountRow(t, { key: "agent-peak", label: `Highest context${window > 0 ? `${SEP}${percentText(a.peak / window)} of its window` : ""}`, amount: tokensText(a.peak), share: null }));
  out.push(amountRow(t, { key: "agent-cost", label: "Spent so far", amount: moneyOf(i.d, a.usd), quiet: true }));

  out.push(blank(t, "agent-prompt"));
  out.push(
    <Text key="agent-prompt-head" dimColor>
      First prompt
    </Text>,
  );
  out.push(a.firstPrompt.trim() === "" ? <Text key="agent-prompt-none" dimColor>{"  (no prompt recorded)"}</Text> : textLines(t, "agent-prompt", a.firstPrompt, PROMPT_LINES));

  const tools = Object.entries(a.tools).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
  out.push(blank(t, "agent-tools"));
  out.push(title(t, "agent-tools", "Tools used", `${tools.reduce((n, [, c]) => n + c, 0)}`));
  if (tools.length === 0) out.push(<Text key="agent-tools-none" dimColor>No tool calls yet.</Text>);
  for (const [tool, n] of cutOf(tools, i.view.more)) out.push(amountRow(t, { key: `agent-tool-${tool}`, label: tool, amount: String(n), quiet: true }));
  if (tools.length > LIST_ROWS) {
    ctx.more = true;
    out.push(
      <Button key="lists-more" plain dimColor hotkey="m" onPress={() => i.onMore(!i.view.more)}>
        {i.view.more ? "fold lists" : `${tools.length - LIST_ROWS} more`}
      </Button>,
    );
  }
  out.push(blank(t, "agent-foot"));
  ctx.canView = true;
  out.push(
    <Button key="agent-transcript" plain dimColor hotkey="v" onPress={() => i.onTranscript(true)}>
      open transcript
    </Button>,
  );
  out.push(
    <Text key="agent-note" dimColor wrap="truncate-end">
      The Skills, MCP and Memory lists cover the main thread, not its sub-agents.
    </Text>,
  );
  return out;
}

export function drawContext(t: Table, i: ContextInput): ContextDrawing {
  const { Text, Button } = t;
  const ctx: KeyCtx = {};
  const { live, data, view } = i;
  if (live.sessionId === "") return { rows: [<Text key="none" dimColor>No session yet.</Text>], ctx };

  const agents = agentOrderOf(live, i.states);
  const chosen = agents.find((a) => a.id === view.ctxAgent);

  // A transcript takes the whole body: its own keys, and `b` back to the agent.
  if (chosen !== undefined && view.transcript) {
    const drawn = drawTranscript(t, { agent: chosen, entry: i.transcripts[chosen.id], more: view.more, onMore: i.onMore, onBack: () => i.onTranscript(false) });
    return { rows: drawn.rows, ctx: drawn.ctx };
  }

  const out: RenderElement[] = [];
  if (agents.length > 0) out.push(...drawSwitch(t, i, agents, ctx));
  if (chosen !== undefined) {
    ctx.canGoBack = true;
    out.push(
      <Button key="agent-back" plain dimColor hotkey="b" onPress={() => i.onAgent("")}>
        return to the main view
      </Button>,
      blank(t, "agent-top"),
      ...drawAgent(t, i, chosen, ctx),
    );
    return { rows: out, ctx };
  }
  if (agents.length > 0) out.push(blank(t, "switch"));

  if (data.sessionId !== live.sessionId) {
    const why = data.failure?.sessionId === live.sessionId ? `Could not read the context: ${data.failure.why}` : "Reading the context breakdown...";
    out.push(
      <Text key="loading" dimColor wrap="truncate-end">
        {why}
      </Text>,
    );
    return { rows: out, ctx };
  }
  out.push(...drawMain(t, i, ctx));
  return { rows: out, ctx };
}
