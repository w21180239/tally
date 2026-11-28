// The desktop app's info row above the prompt: cost, subagents, cache timer and context on one quiet row.
// Pointing at it shows a card with the figures behind them; `details` opens the window.
import type { EngineInterface, RenderElement, RenderInput } from "claude-code";
import { HINT_MARK, SEP, svgBar, toneOfShare, toneProps } from "./theme.ts";
import type { Tone } from "./theme.ts";
import { cacheWords, contextShare, leftText, limitName, moneyOf, percentText, tokensText, untilText } from "./data.ts";
import type { WindowData } from "./data.ts";
import { tableOf } from "./table.ts";

/** Address of the row's `details` Button. */
export const INFO_KEY = "tally-details";

/** The row's one way into the figures behind it; the hover card needs a pointer. */
export const DETAILS_LABEL = "details \u{25b8}";

const LOW_SHARE = 0.2;
const BAR_PX = 72;
const BAR_H = 8;
const LABEL_CELLS = 8;

export type Run = { text: string; tone?: Tone; bold?: boolean };
export type Section = { label: string; lines: Array<Run[] | { name: string; share: number; tone: Tone; alt: string; words: Run[] }> };

/** Main's cache timer as the row says it: warm with its time left, or expired. */
export function cacheRun(d: WindowData): Run | null {
  if (d.cache === null) return null;
  if (d.cache.isExpired) return { text: "expired", tone: "error" };
  return { text: leftText(d.cache.leftMs), tone: d.cache.leftMs / d.cache.lifeMs < LOW_SHARE ? "warning" : "success" };
}

/** The row's runs. */
export function rowRuns(d: WindowData): Run[] {
  const cache = cacheRun(d);
  const share = contextShare(d);
  return [
    { text: moneyOf(d, d.costUsd), bold: true },
    { text: " session", tone: "dim" },
    ...(d.agents > 0 ? [{ text: `${SEP}${d.agents} sub-agent${d.agents === 1 ? "" : "s"}`, tone: "dim" as const }] : []),
    { text: `${SEP}cache `, tone: "dim" },
    cache ?? { text: "-", tone: "dim" },
    ...(d.context.tokens === null ? [] : [{ text: `${SEP}ctx ${tokensText(d.context.tokens)} `, tone: "dim" as const }]),
    ...(share === null ? [] : [{ text: `(${percentText(share)})`, tone: toneOfShare(share) }]),
  ];
}

/** The hover card's sections; a short band drops them from the last. */
export function cardSections(d: WindowData): Section[] {
  const out: Section[] = [
    {
      label: "Cost",
      lines: [
        [
          { text: moneyOf(d, d.costUsd), bold: true },
          ...(d.hourly == null ? [] : [{ text: `${SEP}${moneyOf(d, d.hourly)} an hour while working`, tone: "dim" as const }]),
          ...(d.cache === null ? [] : [{ text: `${SEP}${cacheWords(d) ?? ""}`, tone: "dim" as const }]),
        ],
      ],
    },
  ];
  if (d.models.length > 0) {
    out.push({ label: "Models", lines: [d.models.flatMap(([name, usd], i): Run[] => [...(i === 0 ? [] : [{ text: "  \u{b7}  ", tone: "dim" as const }]), { text: name }, { text: ` ${moneyOf(d, usd)}` }])] });
  }
  if (d.past != null) {
    out.push({ label: "Days", lines: [[{ text: `today ${moneyOf(d, d.past.today)}` }, { text: `${SEP}30 days ${moneyOf(d, d.past.month)}`, tone: "dim" as const }]] });
  }
  if (d.hint !== null) {
    out.push({ label: "Hint", lines: [[{ text: `${HINT_MARK} `, tone: "accent", bold: true }, { text: d.hint.found }, ...(d.hint.saving === null ? [] : [{ text: `${SEP}save ${d.hint.saving}`, tone: "success" as const }])]] });
  }
  if (d.limits.length > 0) {
    out.push({
      label: "Limits",
      lines: d.limits.map((l) => {
        const share = l.percentUsed / 100;
        const reset = untilText(l.resetsAt, d.now);
        return {
          name: limitName(l.kind, true),
          share,
          tone: toneOfShare(share),
          alt: `${Math.round(l.percentUsed)}% used`,
          words: [{ text: `${Math.round(l.percentUsed)}%`, tone: toneOfShare(share) }, ...(reset === null ? [] : [{ text: `${SEP}resets in ${reset}`, tone: "dim" as const }])],
        };
      }),
    });
  }
  return out;
}

/** The info row for the band, with `onDetails` run by the Button. The card keeps to the rows the band has. */
export function drawInfoRow($: EngineInterface, e: RenderInput<"AbovePrompt">, d: WindowData, onDetails: () => void): RenderElement {
  const { Box, Text, Button, Svg } = tableOf($, e);
  // The row takes 1, its card's border 2 and margin 1; whole sections go from the end.
  let room = e.props.maxRows - 4;
  const sections = cardSections(d).filter((s) => {
    room -= s.lines.length;
    return room >= 0;
  });
  const runs = (parts: Run[]): RenderElement => (
    <Text wrap="truncate-end">
      {parts.map((r, i) => (
        <Text key={`run-${i}`} {...toneProps(r.tone, r.bold === true)}>{r.text}</Text>
      ))}
    </Text>
  );
  return (
    <Box key="tally-info" flexDirection="column">
      {sections.length > 0 && (
        <Box display="none" hover={{ display: "flex" }} flexDirection="column" borderStyle="round" borderDimColor paddingX={1} marginBottom={1}>
          {sections.flatMap((s, si) =>
            s.lines.map((line, li) => (
              <Box key={`card-${si}-${li}`} flexDirection="row">
                <Box width={LABEL_CELLS} flexShrink={0}>
                  <Text dimColor>{li === 0 ? s.label : ""}</Text>
                </Box>
                {Array.isArray(line) ? (
                  runs(line)
                ) : (
                  <Box flexDirection="row" alignItems="center" gap={1}>
                    <Text weight="bold">{line.name}</Text>
                    {Svg === null ? null : <Svg source={svgBar(line.share, BAR_PX, BAR_H, line.tone)} alt={line.alt} width={BAR_PX} height={BAR_H} />}
                    {runs(line.words)}
                  </Box>
                )}
              </Box>
            )),
          )}
        </Box>
      )}
      <Box flexDirection="row" gap={1}>
        {runs(rowRuns(d))}
        <Button key={INFO_KEY} label={DETAILS_LABEL} plain dimColor onPress={onDetails} />
      </Box>
    </Box>
  );
}
