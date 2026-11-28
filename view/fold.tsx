// A folded window is one faint line in the band over the prompt; pressing it opens the window again.
import type { EngineInterface, RenderElement, RenderInput } from "claude-code";
import { HINT_MARK, SEP, toneProps } from "./theme.ts";
import type { Tone } from "./theme.ts";
import { contextShare, leftText, moneyOf, percentText, tokensText } from "./data.ts";
import type { WindowData } from "./data.ts";
import { tableOf } from "./table.ts";

/** Address of the line's Button. */
export const FOLD_KEY = "tally-fold";

export type FoldPart = { text: string; role: "hint" | "chart" | "cost" | "context" | "cache" | "expired" | "entry" };

/** How the main screen, which reports no clicks, reaches the line: full, then the command alone. */
export const ENTRY_FULL = "ctrl+x tab, enter or /tally: open";
export const ENTRY_SHORT = "/tally: open";

const context = (d: WindowData): string => {
  const share = contextShare(d);
  if (d.context.tokens === null) return "ctx -";
  return share === null ? `ctx ${tokensText(d.context.tokens)}` : `ctx ${percentText(share)}`;
};

const cacheText = (d: WindowData): string | null => (d.cache === null ? null : d.cache.isExpired ? "cache expired" : `cache ${leftText(d.cache.leftMs)}`);

/**
 * The line's parts, most important first: spend, context, cache, the 8-hour chart, the top hint, and (on the main
 * screen, until used once) how to open the window. Every amount carries its word: `session`, `save`. Narrower, the
 * entry words go first (full, then `/tally` alone), then the chart, the hint's saving, the cache, the hint down to its
 * marker, the context; the cost alone is cut to fit. The first try that fits `cols` wins.
 */
export function foldParts(d: WindowData, cols: number, entry = false): FoldPart[] {
  const cost: FoldPart = { text: `session ${moneyOf(d, d.costUsd)}`, role: "cost" };
  const ctx: FoldPart = { text: context(d), role: "context" };
  const ct = cacheText(d);
  const cache: FoldPart[] = ct === null ? [] : [{ text: ct, role: d.cache?.isExpired === true ? "expired" : "cache" }];
  const chart: FoldPart[] = d.chart === null ? [] : [{ text: `8h ${d.chart}`, role: "chart" }];
  const hintOf = (text: string | null): FoldPart[] => (d.hint === null || text === null ? [] : [{ text: `${HINT_MARK} ${text}`, role: "hint" }]);
  const whole = d.hint === null ? null : `${d.hint.found}${d.hint.saving === null ? "" : `, save ${d.hint.saving}`}`;
  const found = d.hint?.found ?? null;
  const marker = d.hint === null ? null : "hint";
  const via = (text: string): FoldPart[] => [{ text, role: "entry" }];
  const tries: FoldPart[][] = [
    ...(entry ? [[cost, ctx, ...cache, ...chart, ...hintOf(whole), ...via(ENTRY_FULL)], [cost, ctx, ...cache, ...chart, ...hintOf(whole), ...via(ENTRY_SHORT)]] : []),
    [cost, ctx, ...cache, ...chart, ...hintOf(whole)],
    [cost, ctx, ...cache, ...hintOf(whole)],
    [cost, ctx, ...cache, ...hintOf(found)],
    [cost, ctx, ...hintOf(found)],
    [cost, ctx, ...hintOf(marker)],
    [cost, ctx],
    [cost],
  ];
  const width = (parts: FoldPart[]): number => parts.reduce((n, p, i) => n + p.text.length + (i === 0 ? 0 : SEP.length), 0);
  const fits = tries.find((parts) => width(parts) <= cols);
  return fits ?? [{ text: moneyOf(d, d.costUsd).slice(0, Math.max(0, cols)), role: "cost" }];
}

/** The folded line as text, at most `cols` wide. */
export const foldLine = (d: WindowData, cols: number, entry = false): string => foldParts(d, cols, entry).map((p) => p.text).join(SEP);

const ROLE_TONE: Record<FoldPart["role"], { tone?: Tone; bold?: boolean }> = {
  hint: { tone: "accent", bold: true },
  chart: { tone: "dim" },
  cost: { bold: true },
  context: { tone: "dim" },
  cache: { tone: "dim" },
  expired: { tone: "error" },
  entry: { tone: "dim" },
};

const SEEN_KEY = "fold-entry-seen";

/** True once the person has opened the window from the line: the entry words have done their job. Drawing only reads. */
async function entrySeen($: EngineInterface): Promise<boolean> {
  return (await $.store.get(SEEN_KEY).catch(() => undefined)) === true;
}

async function markSeen($: EngineInterface): Promise<void> {
  await $.store.set(SEEN_KEY, true).catch(() => {});
}

/**
 * The band's folded line: right-aligned, one Button whose press runs `onOpen`. On the main screen (no fullscreen) a
 * click does not reach the Button, so until the line has been used once it ends with how to reach it; Enter on the
 * focused band presses it either way.
 */
export async function drawFold($: EngineInterface, e: RenderInput<"AbovePrompt">, d: WindowData, onOpen: () => void): Promise<RenderElement> {
  const { Box, Text, Button } = tableOf($, e);
  const cols = e.props.bodyColumns;
  const mainScreen = e.surface === "terminal" && e.viewport?.isFullscreen === false;
  const entry = mainScreen && !(await entrySeen($));
  const parts = foldParts(d, cols, entry);
  // A focused Button is drawn inverse; colour on top of that makes patches, so the parts go plain.
  const focused = (e.props as { isFocused?: boolean }).isFocused === true;
  const press = () => {
    void markSeen($);
    onOpen();
  };
  return (
    <Box width={cols} justifyContent="flex-end">
      <Button key={FOLD_KEY} autoFocus plain label={parts.filter((p) => p.role !== "entry").map((p) => p.text).join(SEP)} onPress={press}>
        {parts.map((p, i) => (
          <Text key={`fold-${i}`} {...(focused ? {} : toneProps(ROLE_TONE[p.role].tone, ROLE_TONE[p.role].bold === true))}>
            {i === 0 ? p.text : `${SEP}${p.text}`}
          </Text>
        ))}
      </Button>
    </Box>
  );
}
