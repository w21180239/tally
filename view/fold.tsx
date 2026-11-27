// A folded window is one faint line in the band over the prompt; pressing it opens the window again.
import type { EngineInterface, RenderElement, RenderInput } from "claude-code";
import { HINT_MARK, SEP, toneProps } from "./theme.ts";
import type { Tone } from "./theme.ts";
import { cacheWords, contextWords, moneyOf } from "./data.ts";
import type { WindowData } from "./data.ts";
import { tableOf } from "./table.ts";

/** Address of the line's Button. */
export const FOLD_KEY = "tally-fold";

export type FoldPart = { text: string; role: "hint" | "chart" | "cost" | "context" | "cache" | "cold" };

/**
 * The line's parts, in the order they are shown: top hint with its saving, the 8-hour chart, cost, context,
 * cache timer. Narrower, the cache timer goes first, then the chart, then the hint's saving, then the hint,
 * then the context; the cost alone is cut to fit. The first try that fits `cols` wins.
 */
export function foldParts(d: WindowData, cols: number): FoldPart[] {
  const cost: FoldPart = { text: moneyOf(d, d.costUsd), role: "cost" };
  const context: FoldPart = { text: contextWords(d), role: "context" };
  const cacheText = cacheWords(d);
  const cache: FoldPart[] = cacheText === null ? [] : [{ text: cacheText, role: d.cache?.isExpired === true ? "cold" : "cache" }];
  const chart: FoldPart[] = d.chart === null ? [] : [{ text: d.chart, role: "chart" }];
  const found: FoldPart[] = d.hint === null ? [] : [{ text: `${HINT_MARK} ${d.hint.found}`, role: "hint" }];
  const whole: FoldPart[] = d.hint === null ? [] : [{ text: `${HINT_MARK} ${d.hint.found}${d.hint.saving === null ? "" : `${SEP}${d.hint.saving}`}`, role: "hint" }];
  const tries: FoldPart[][] = [
    [...whole, ...chart, cost, context, ...cache],
    [...whole, ...chart, cost, context],
    [...whole, cost, context],
    [...found, cost, context],
    [cost, context],
    [cost],
  ];
  const width = (parts: FoldPart[]): number => parts.reduce((n, p, i) => n + p.text.length + (i === 0 ? 0 : SEP.length), 0);
  const fits = tries.find((parts) => width(parts) <= cols);
  return fits ?? [{ text: cost.text.slice(0, Math.max(0, cols)), role: "cost" }];
}

/** The folded line as text, at most `cols` wide. */
export const foldLine = (d: WindowData, cols: number): string => foldParts(d, cols).map((p) => p.text).join(SEP);

const ROLE_TONE: Record<FoldPart["role"], { tone?: Tone; bold?: boolean }> = {
  hint: { tone: "accent", bold: true },
  chart: { tone: "dim" },
  cost: { bold: true },
  context: { tone: "dim" },
  cache: { tone: "dim" },
  cold: { tone: "error" },
};

/** The band's folded line: right-aligned, one Button whose press runs `onOpen`. */
export function drawFold($: EngineInterface, e: RenderInput<"AbovePrompt">, d: WindowData, onOpen: () => void): RenderElement {
  const { Box, Text, Button } = tableOf($, e);
  const cols = e.props.bodyColumns;
  const parts = foldParts(d, cols);
  return (
    <Box width={cols} justifyContent="flex-end">
      <Button key={FOLD_KEY} autoFocus label={parts.map((p) => p.text).join(SEP)} onPress={onOpen}>
        {parts.map((p, i) => (
          <Text key={`fold-${i}`} {...toneProps(ROLE_TONE[p.role].tone, ROLE_TONE[p.role].bold === true)}>
            {i === 0 ? p.text : `${SEP}${p.text}`}
          </Text>
        ))}
      </Button>
    </Box>
  );
}
