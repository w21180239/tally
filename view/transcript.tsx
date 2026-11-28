// A sub-agent's transcript inside the window: the task it was given, the latest tool calls with the size of what
// each returned, and its last words. `drawTranscript` returns the rows and the keys they add.
import type { RenderElement } from "claude-code";
import type { AgentLive } from "../core/live-state.ts";
import { tokensText } from "./data.ts";
import type { KeyCtx } from "./keys.ts";
import { gridOf } from "./grid.ts";
import { blank, row, section, status, wrapped } from "./rows.tsx";
import type { Table } from "./table.ts";
import { SEP } from "./theme.ts";
import type { TranscriptEntry } from "../engine/subagent-transcript.ts";

/** Calls listed before the rest fold under `m`. */
export const CALL_ROWS = 40;
const PROMPT_LINES = 4;
const ANSWER_LINES = 8;
const CHARS_PER_TOKEN = 4;
/** Width of the column that holds a call's tool name. */
const TOOL_CELLS = 8;

export type TranscriptInput = {
  agent: AgentLive;
  entry: TranscriptEntry | undefined;
  more: boolean;
  onMore: (more: boolean) => void;
  onBack: () => void;
};

export type TranscriptDrawing = { rows: RenderElement[]; ctx: KeyCtx };

const bytesText = (n: number): string => (n < 1024 ? `${n} B` : n < 1_048_576 ? `${Math.round(n / 1024)} KiB` : `${(n / 1_048_576).toFixed(1)} MiB`);

export function drawTranscript(t: Table, i: TranscriptInput): TranscriptDrawing {
  const { Text, Button } = t;
  const out: RenderElement[] = [];
  const ctx: KeyCtx = { canGoBack: true };
  out.push(
    <Button key="transcript-back" plain dimColor hotkey="b" onPress={i.onBack}>
      back to the agent
    </Button>,
  );
  const { entry } = i;
  // A call's tool name leads its row in a column of its own; the estimated size of its result is the figure.
  const g = gridOf(t.cols, { tokens: true, lead: TOOL_CELLS });
  const plain = gridOf(t.cols, { tokens: true });
  out.push(section(t, plain, { key: "transcript", name: "Transcript", note: `${i.agent.type}${entry?.status === "ready" ? `${SEP}${bytesText(entry.bytes)}${SEP}latest last` : ""}` }));
  if (entry === undefined || entry.status === "loading") {
    out.push(status(t, "transcript-loading", "Loading the transcript...", "It opens as soon as the file is read."));
    return { rows: out, ctx };
  }
  if (entry.status === "failed" || entry.view === null) {
    out.push(status(t, "transcript-failed", entry.message === "" ? "Its transcript could not be read." : entry.message, "Press b to go back to the agent."));
    return { rows: out, ctx };
  }
  const v = entry.view;
  const prompt = v.prompt.trim() === "" ? i.agent.firstPrompt : v.prompt;
  out.push(
    <Text key="transcript-prompt-head" dimColor>
      Opening prompt
    </Text>,
  );
  out.push(prompt.trim() === "" ? <Text key="transcript-prompt-none" dimColor>{"  (not recorded)"}</Text> : wrapped(t, "transcript-prompt", prompt, { max: PROMPT_LINES, quiet: true }));
  out.push(blank(t, "transcript-prompt"));

  const shown = i.more ? v.calls : v.calls.slice(-CALL_ROWS);
  const before = v.total - shown.length;
  out.push(section(t, plain, { key: "transcript-calls", name: "Tools used", note: `${v.total} ${v.total === 1 ? "call" : "calls"}` }));
  if (before > 0) {
    out.push(
      <Text key="transcript-before" dimColor>
        {`${before} older ${before === 1 ? "call" : "calls"} hidden`}
      </Text>,
    );
  }
  // The row's key is its place in the whole transcript, so it keeps its identity as newer calls arrive.
  const first = v.total - shown.length;
  for (const [n, c] of shown.entries()) {
    const at = first + n;
    out.push(row(t, g, { key: `call-${at}`, lead: c.tool, label: c.item, ...(c.resultChars !== null && { tokens: tokensText(c.resultChars / CHARS_PER_TOKEN), est: true }), quiet: true }));
  }
  if (v.total === 0) {
    out.push(
      <Text key="transcript-no-calls" dimColor>
        No tool calls yet.
      </Text>,
    );
  }
  if (v.calls.length > CALL_ROWS) {
    ctx.more = true;
    out.push(
      <Button key="transcript-more" plain dimColor hotkey="m" onPress={() => i.onMore(!i.more)}>
        {i.more ? "fold" : `${v.calls.length - CALL_ROWS} more kept`}
      </Button>,
    );
  }
  out.push(blank(t, "transcript-calls"));
  out.push(
    <Text key="transcript-answer-head" dimColor>
      Latest reply
    </Text>,
  );
  out.push(v.answer === "" ? <Text key="transcript-answer-none" dimColor>{"  (nothing said yet)"}</Text> : wrapped(t, "transcript-answer", v.answer, { max: ANSWER_LINES, quiet: true }));
  if (v.total > 0) {
    out.push(
      <Text key="transcript-note" dimColor wrap="truncate-end">
        ~ tokens estimated from the length of each result
      </Text>,
    );
  }
  return { rows: out, ctx };
}
