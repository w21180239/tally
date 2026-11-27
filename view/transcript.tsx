// A sub-agent's transcript inside the window: the task it was given, the latest tool calls with the size of what
// each returned, and its last words. `drawTranscript` returns the rows and the keys they add.
import type { RenderElement } from "claude-code";
import type { AgentLive } from "../core/live-state.ts";
import { tokensText } from "./data.ts";
import type { KeyCtx } from "./keys.ts";
import { amountRow, blank, textLines, title } from "./rows.tsx";
import type { Table } from "./table.ts";
import { SEP } from "./theme.ts";
import type { TranscriptEntry } from "../engine/subagent-transcript.ts";

/** Calls listed before the rest fold under `m`. */
export const CALL_ROWS = 40;
const PROMPT_LINES = 4;
const ANSWER_LINES = 8;
const CHARS_PER_TOKEN = 4;

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
  out.push(title(t, "transcript", "Transcript", `${i.agent.type}${entry?.status === "ready" ? `${SEP}${bytesText(entry.bytes)}${SEP}latest last` : ""}`));
  if (entry === undefined || entry.status === "loading") {
    out.push(
      <Text key="transcript-loading" dimColor>
        Loading the transcript...
      </Text>,
    );
    return { rows: out, ctx };
  }
  if (entry.status === "failed" || entry.view === null) {
    out.push(
      <Text key="transcript-failed" dimColor wrap="truncate-end">
        {entry.message === "" ? "Its transcript could not be read." : entry.message}
      </Text>,
    );
    return { rows: out, ctx };
  }
  const v = entry.view;
  const prompt = v.prompt.trim() === "" ? i.agent.firstPrompt : v.prompt;
  out.push(
    <Text key="transcript-prompt-head" dimColor>
      Opening prompt
    </Text>,
  );
  out.push(prompt.trim() === "" ? <Text key="transcript-prompt-none" dimColor>{"  (not recorded)"}</Text> : textLines(t, "transcript-prompt", prompt, PROMPT_LINES));
  out.push(blank(t, "transcript-prompt"));

  const shown = i.more ? v.calls : v.calls.slice(-CALL_ROWS);
  const before = v.total - shown.length;
  out.push(title(t, "transcript-calls", "Tools used", `${v.total} ${v.total === 1 ? "call" : "calls"}`));
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
    out.push(amountRow(t, { key: `call-${at}`, label: `${c.tool.padEnd(8)} ${c.item}`, amount: c.resultChars === null ? "" : `~${tokensText(c.resultChars / CHARS_PER_TOKEN)}`, quiet: true }));
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
      Final reply
    </Text>,
  );
  out.push(v.answer === "" ? <Text key="transcript-answer-none" dimColor>{"  (nothing said yet)"}</Text> : textLines(t, "transcript-answer", v.answer, ANSWER_LINES));
  if (v.total > 0) {
    out.push(
      <Text key="transcript-note" dimColor wrap="truncate-end">
        ~ tokens estimated from the length of each result
      </Text>,
    );
  }
  return { rows: out, ctx };
}
