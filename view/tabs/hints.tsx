// The Hints tab: rule findings for the live session, then for the selected span over all repositories or the live
// session's. A hint draws as a titled block: amount, summary, recommended action, and a toggle that reveals its
// evidence. With a sync folder, `t` adds the hints other computers shared, each under its machine name. `drawHints`
// returns the rows and the keys they add.
import type { RenderElement } from "claude-code";
import { redact } from "../../core/hint.ts";
import type { Hint } from "../../core/hint.ts";
import type { Span } from "../../core/summary.ts";
import { hintsKeyOf } from "../../engine/hints-view.ts";
import type { HintsData, HintsWant } from "../../engine/hints-view.ts";
import type { RemotesView } from "../../engine/sync.ts";
import { amountText } from "../data.ts";
import type { WindowData } from "../data.ts";
import type { KeyCtx } from "../keys.ts";
import { blank, textLines, title } from "../rows.tsx";
import type { Table } from "../table.ts";
import { SEP } from "../theme.ts";

const SUMMARY_LINES = 3;
const EVIDENCE_LINES = 12;

export type HintsView = { shown: string[] };

export type HintsInput = {
  d: Pick<WindowData, "money" | "decimals">;
  data: HintsData;
  want: HintsWant;
  view: HintsView;
  /** Evidence is shown stripped (the `redactEvidence` setting). */
  redact: boolean;
  /** With a sync folder: this computer's hints or every computer's (the `t` key), and what the other computers' files hold. */
  machines?: { mode: "this" | "all"; remote: RemotesView };
  onShown: (key: string) => void;
};

export type HintsDrawing = { rows: RenderElement[]; ctx: KeyCtx };

/** A hint's open key names its scope and rule, so an open row stays open when the span, repo or order changes. */
export const hintRowKey = (scope: string, rule: string): string => `hint|${scope}|${rule}`;
export const ONLY_HERE = "This computer only";

const SPAN_WORDS: Record<Span, string> = { session: "this session", "24h": "the past 24 hours", "30d": "the past 30 days" };
const SPAN_TITLE: Record<Span, string> = { session: "Current session", "24h": "Past 24 hours", "30d": "Past 30 days" };

export function drawHints(t: Table, i: HintsInput): HintsDrawing {
  const { Box, Text, Button } = t;
  const { d, data, view } = i;
  const ctx: KeyCtx = {};
  const want = hintsKeyOf(i.want);

  if (data.key !== want) {
    if (data.failure?.key === want) return { rows: [<Text key="failed" dimColor wrap="truncate-end">{`Could not look for hints: ${data.failure.why}`}</Text>], ctx };
    return { rows: [<Text key="loading" dimColor>Looking for ways to spend less...</Text>], ctx };
  }
  const span = SPAN_WORDS[i.want.span];
  const where = i.want.repoOnly ? ` in ${data.repo}` : "";
  if (data.requests === 0 && data.unread > 0) {
    // No index yet means unknown, not zero.
    return { rows: [<Text key="unknown" dimColor>{`No hints for ${span}${where} yet: the transcripts are not indexed.`}</Text>], ctx };
  }

  const out: RenderElement[] = [];
  const block = (scope: string, name: string, note: string | undefined, hints: Hint[], none: string): void => {
    out.push(title(t, scope, name, note));
    if (hints.length === 0) out.push(<Text key={`none-${scope}`} dimColor wrap="truncate-end">{none}</Text>);
    for (const hint of hints) {
      const key = hintRowKey(scope, hint.rule);
      out.push(title(t, key, hint.title, hint.confidence === "low" ? "low confidence" : undefined, hint.usd > 0 ? amountText(hint, d) : undefined));
      out.push(textLines(t, `${key}-summary`, hint.summary, SUMMARY_LINES));
      out.push(
        <Box key={`${key}-action`} flexDirection="row" columnGap={1} paddingLeft={2}>
          <Text dimColor>Action</Text>
          <Box flexGrow={1} flexShrink={1}>
            <Text>{hint.action}</Text>
          </Box>
        </Box>,
      );
      if (hint.evidence.length > 0) {
        const isOpen = view.shown.includes(key);
        const face = `${isOpen ? "hide" : "show"} evidence (${hint.evidence.length})`;
        ctx.evidence = true;
        out.push(
          <Box key={`${key}-evidence-row`} paddingLeft={2}>
            <Button key={`open-${key}`} label={face} plain dimColor onPress={() => i.onShown(key)}>
              {face}
            </Button>
          </Box>,
        );
        if (isOpen) {
          const lines = hint.evidence.map((e) => redact(e, i.redact)).map((e) => (e.detail === "" ? e.label : `${e.label}${SEP}${e.detail}`));
          out.push(textLines(t, `${key}-evidence`, lines.join("\n"), EVIDENCE_LINES));
        }
      }
      out.push(blank(t, key));
    }
  };

  // Other computers' files carry no per-repo split, so one repo never shows them.
  const all = i.machines?.mode === "all" && !i.want.repoOnly;
  block("session", "Current session", all ? ONLY_HERE : undefined, data.session, "No hints for this session.");
  out.push(blank(t, "session"));
  const spanNote = where === "" ? "all repos" : data.repo;
  block("span", SPAN_TITLE[i.want.span], all ? `${spanNote}${SEP}${ONLY_HERE}` : spanNote, data.span, `No hints for ${span}${where}.`);
  if (i.machines?.mode === "all") {
    out.push(blank(t, "span"));
    out.push(title(t, "remote", "Other computers", all ? "shared in their files, past 30 days" : undefined));
    if (!all) out.push(<Text key="remote-repo" dimColor wrap="truncate-end">Other computers are not shown for one repo: their files cannot be cut to it.</Text>);
    else if (i.machines.remote.machines.length === 0) out.push(<Text key="remote-none" dimColor wrap="truncate-end">No other computer has shared a file yet.</Text>);
    else {
      for (const m of i.machines.remote.machines) {
        if (m.hints !== undefined) {
          block(`m:${m.machine}`, m.machine, undefined, m.hints, "No hints in its file.");
          continue;
        }
        const why = m.detail !== "full" ? `shares ${m.detail} only, so no hints` : m.hintsDropped ? "hints left out to fit its file" : "no hints in its file yet";
        out.push(<Text key={`remote-${m.machine}`} dimColor wrap="truncate-end">{`${m.machine}${SEP}${why}`}</Text>);
      }
    }
  }
  if (data.unread > 0) {
    out.push(
      <Text key="unread" dimColor wrap="truncate-end">
        {`${data.unread} ${data.unread === 1 ? "project is" : "projects are"} not indexed yet; hints may be missing.`}
      </Text>,
    );
  }
  return { rows: out, ctx };
}
