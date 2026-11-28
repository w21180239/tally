// The Hints tab: rule findings for the live session, then for the selected span over all repositories or the live
// session's. A hint draws as a titled block: its saving, a summary that wraps, the action to take, a toggle that
// reveals its evidence and a button that adopts it. Adopting takes two presses: the first arms the hint and says so,
// the second adopts (`y` goes to the armed hint, else to the first one not yet adopted). With a sync folder, `t` adds
// the hints other computers shared, each under its machine name. `drawHints` returns the rows and the keys they add.
import type { RenderElement } from "claude-code";
import { redact } from "../../core/hint.ts";
import type { Hint } from "../../core/hint.ts";
import type { Span } from "../../core/summary.ts";
import { hintsKeyOf } from "../../engine/hints-view.ts";
import type { HintsData, HintsWant } from "../../engine/hints-view.ts";
import type { RemotesView } from "../../engine/sync.ts";
import { moneyColumn } from "../data.ts";
import type { WindowData } from "../data.ts";
import { TERM_SHORT, gridOf } from "../grid.ts";
import type { KeyCtx } from "../keys.ts";
import { blank, hanging, row, section, status, textLines, wrapped } from "../rows.tsx";
import type { Table } from "../table.ts";
import { SEP } from "../theme.ts";

const SUMMARY_LINES = 3;
const EVIDENCE_LINES = 12;
/** `save ~$1,235` is the longest figure a hint carries. */
const SAVING_CELLS = 12;

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
  /** Rule ids already adopted, and the adopt press. Without `onAdopt` no adopt button is drawn. */
  adopted?: string[];
  onAdopt?: (hint: Hint) => void;
};

export type HintsDrawing = { rows: RenderElement[]; ctx: KeyCtx };

/** A hint's open key names its scope and rule, so an open row stays open when the span, repo or order changes. */
export const hintRowKey = (scope: string, rule: string): string => `hint|${scope}|${rule}`;
/** A hint that has been pressed once to adopt, and waits for the second press. */
export const armKeyOf = (rowKey: string): string => `arm|${rowKey}`;
export const ONLY_HERE = "This computer only";

const SPAN_WORDS: Record<Span, string> = { session: "this session", "24h": "the past 24 hours", "30d": "the past 30 days" };
const SPAN_TITLE: Record<Span, string> = { session: "This session", "24h": "24 hours", "30d": "30 days" };

export function drawHints(t: Table, i: HintsInput): HintsDrawing {
  const { Box, Text, Button } = t;
  const { d, data, view } = i;
  const ctx: KeyCtx = {};
  const want = hintsKeyOf(i.want);

  if (data.key !== want) {
    if (data.failure?.key === want) return { rows: [status(t, "failed", `Could not look for hints: ${data.failure.why}`, "tally looks again on the next refresh.")], ctx };
    return { rows: [status(t, "loading", "Looking for ways to spend less...", "Hints fill in once the transcripts are read.")], ctx };
  }
  const span = SPAN_WORDS[i.want.span];
  const where = i.want.repoOnly ? ` in ${data.repo}` : "";
  if (data.requests === 0 && data.unread > 0) {
    // No index yet means unknown, not zero.
    return { rows: [status(t, "unknown", `No hints for ${span}${where} yet: the transcripts are not indexed.`, "Hints fill in as projects finish. It is safe to keep working.")], ctx };
  }

  const g = gridOf(t.cols, { money: true, moneyCells: SAVING_CELLS });
  const everyHint = [...data.session, ...data.span, ...(i.machines?.mode === "all" ? i.machines.remote.machines.flatMap((m) => m.hints ?? []) : [])];
  const money = moneyColumn(d, everyHint.map((h) => h.usd));
  const savingOf = (h: Hint): string => `save ${h.projected === true ? "~" : ""}${money(h.usd)}`;

  // The `y` key goes to one button: the armed hint, else the first not yet adopted. The `e` key to the first evidence toggle.
  const adoptable = (scope: string): boolean => i.onAdopt !== undefined && (scope === "session" || scope === "span");
  const isAdopted = (h: Hint): boolean => i.adopted?.includes(h.rule) === true;
  const armed = (scope: string, h: Hint): boolean => view.shown.includes(armKeyOf(hintRowKey(scope, h.rule)));
  const queue = [
    ...[["session", data.session], ["span", data.span]].flatMap(([scope, hints]) => (hints as Hint[]).map((h) => ({ scope: scope as string, h }))),
  ].filter(({ scope, h }) => adoptable(scope) && !isAdopted(h));
  const yTarget = queue.find(({ scope, h }) => armed(scope, h)) ?? queue[0];
  let evidenceKeyTaken = false;

  const out: RenderElement[] = [];
  const block = (scope: string, name: string, note: string | undefined, hints: Hint[], none: string): void => {
    out.push(section(t, g, { key: scope, name, ...(note !== undefined && { note }) }));
    if (hints.length === 0) out.push(<Text key={`none-${scope}`} dimColor wrap="truncate-end">{none}</Text>);
    for (const hint of hints) {
      const key = hintRowKey(scope, hint.rule);
      out.push(
        row(t, g, {
          key: `title-${key}`,
          label: hint.confidence === "low" ? `${hint.title}${SEP}low confidence` : hint.title,
          bold: true,
          ...(hint.usd > 0 && { money: savingOf(hint), moneyTone: "success" as const }),
        }),
      );
      out.push(wrapped(t, `${key}-summary`, hint.summary, { max: SUMMARY_LINES, quiet: false }));
      out.push(hanging(t, `${key}-action`, "Do", hint.action, { cells: TERM_SHORT, quiet: false }));
      const isOpen = hint.evidence.length > 0 && view.shown.includes(key);
      const done = isAdopted(hint);
      const isArmed = armed(scope, hint);
      const keyed = !done && yTarget !== undefined && yTarget.scope === scope && yTarget.h.rule === hint.rule;
      const evidenceKeyed = hint.evidence.length > 0 && !evidenceKeyTaken;
      if (evidenceKeyed) evidenceKeyTaken = true;
      if (hint.evidence.length > 0 || adoptable(scope)) {
        const face = `evidence (${hint.evidence.length})`;
        const adoptFace = done ? "adopted" : isArmed ? "press y again to adopt" : "adopt";
        if (hint.evidence.length > 0) ctx.evidence = true;
        if (keyed) ctx.adopt = true;
        out.push(
          <Box key={`${key}-actions`} flexDirection="row" columnGap={2} paddingLeft={2}>
            {hint.evidence.length > 0 && (
              <Button key={`open-${key}`} label={`${isOpen ? "hide" : "show"} ${face}`} plain dimColor {...(evidenceKeyed && { hotkey: "e" })} onPress={() => i.onShown(key)}>
                {`${isOpen ? "hide" : "show"} ${face}`}
              </Button>
            )}
            {adoptable(scope) && (
              <Button
                key={`adopt-${key}`}
                label={adoptFace}
                plain
                dimColor={!isArmed}
                {...(keyed && { hotkey: "y" })}
                onPress={() => {
                  if (done) return undefined;
                  // The first press arms the hint; the second adopts it.
                  return isArmed ? i.onAdopt?.(hint) : i.onShown(armKeyOf(key));
                }}
              >
                {adoptFace}
              </Button>
            )}
            {done && <Text dimColor wrap="truncate-end">tally rechecks the saving later</Text>}
          </Box>,
        );
      }
      if (isOpen) {
        const lines = hint.evidence.map((e) => redact(e, i.redact)).map((e) => (e.detail === "" ? e.label : `${e.label}${SEP}${e.detail}`));
        out.push(textLines(t, `${key}-evidence`, lines.join("\n"), EVIDENCE_LINES));
      }
      out.push(blank(t, key));
    }
  };

  // Other computers' files carry no per-repo split, so one repo never shows them.
  const all = i.machines?.mode === "all" && !i.want.repoOnly;
  block("session", SPAN_TITLE.session, all ? ONLY_HERE : undefined, data.session, "No hints for this session.");
  out.push(blank(t, "session"));
  const spanNote = where === "" ? "all repos" : data.repo;
  block("span", SPAN_TITLE[i.want.span], all ? `${spanNote}${SEP}${ONLY_HERE}` : spanNote, data.span, `No hints for ${span}${where}.`);
  if (i.machines?.mode === "all") {
    out.push(blank(t, "span"));
    out.push(section(t, g, { key: "remote", name: "Other computers", ...(all && { note: "shared in their files, past 30 days" }) }));
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
