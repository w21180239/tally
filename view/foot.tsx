// The foot under every tab: main's cache timer, the context fill and the rate limits.
import type { RenderElement } from "claude-code";
import { CACHE_MARK, svgBar, textBar, toneOfShare } from "./theme.ts";
import type { Tone } from "./theme.ts";
import { contextShare, leftText, limitName, moneyOf, percentText, tokensText, untilText } from "./data.ts";
import type { WindowData } from "./data.ts";
import type { Table } from "./table.ts";

const LABEL_CELLS = 9;
const SHORT_LABEL_CELLS = 5;
const FIGURE_CELLS = 7;
const SVG_BAR_PX = 80;
const SVG_BAR_H = 8;

type Row = { label: string; words: string[]; figure: string; share?: number; tone?: Tone; quiet?: boolean };

// The first words that fit `room`, else the last (the shortest).
const fitting = (words: string[], room: number): string => words.find((w) => w.length <= room) ?? words[words.length - 1] ?? "";

/** The foot's rows as data: label, candidate words from long to short, the right-hand figure and the bar. */
export function footRows(d: WindowData, isShort: boolean): Row[] {
  const rows: Row[] = [];
  if (d.cache !== null) {
    const c = d.cache;
    const left = `${CACHE_MARK} ${leftText(c.leftMs)}`;
    rows.push({
      label: isShort ? "cache" : "Cache",
      words: c.isExpired ? ["main \u{b7} expired \u{b7} next request rewrites it", "main \u{b7} expired", "expired"] : [`main \u{b7} ${left} left`, `main \u{b7} ${left}`, left],
      figure: c.refillUsd === null ? "" : moneyOf(d, c.refillUsd),
      share: c.isExpired ? 0 : c.leftMs / c.lifeMs,
      tone: c.isExpired ? "error" : "success",
    });
  }
  const share = contextShare(d);
  if (d.context.tokens === null) {
    rows.push({ label: isShort ? "ctx" : "Context", words: ["awaiting first reply", "idle", "-"], figure: "", quiet: true });
  } else {
    rows.push({
      label: isShort ? "ctx" : "Context",
      words: d.context.window > 0 ? [`${tokensText(d.context.tokens)} of a ${tokensText(d.context.window)} window`, `${tokensText(d.context.tokens)} of ${tokensText(d.context.window)}`, tokensText(d.context.tokens)] : [tokensText(d.context.tokens)],
      figure: share === null ? "" : percentText(share),
      ...(share !== null && { share, tone: toneOfShare(share) }),
    });
    if (d.context.compactAt !== null && d.context.window > 0) {
      rows.push({ label: "", words: [`compact at ${tokensText(d.context.compactAt)}`, "compact"], figure: percentText(d.context.compactAt / d.context.window), quiet: true });
    }
  }
  d.limits.forEach((l, i) => {
    const reset = untilText(l.resetsAt, d.now);
    const name = limitName(l.kind, isShort);
    rows.push({
      label: isShort ? limitName(l.kind, true) : i === 0 ? "Limits" : "",
      words: isShort ? [reset ?? ""] : reset === null ? [name] : [`${name} \u{b7} resets in ${reset}`, `${limitName(l.kind, true)} \u{b7} in ${reset}`],
      figure: `${Math.round(l.percentUsed)}%`,
      share: l.percentUsed / 100,
      tone: toneOfShare(l.percentUsed / 100),
    });
  });
  return rows;
}

/** The foot drawn in `cols` cells: one row each, the bar at the end (text on the terminal, Svg elsewhere). */
export function drawFoot(t: Table, d: WindowData, cols: number): RenderElement[] {
  const { Box, Text, Svg } = t;
  const isShort = cols < 40;
  const label = isShort ? SHORT_LABEL_CELLS : LABEL_CELLS;
  const barCells = Svg === null ? (cols < 50 ? 6 : 10) : 0;
  const bar = t.Svg === null ? barCells + 1 : 1 + Math.ceil(SVG_BAR_PX / 8) + 1;
  const room = Math.max(0, cols - label - FIGURE_CELLS - bar - 1);
  return footRows(d, isShort).map((r, i) => (
    <Box key={`foot-${i}`} flexDirection="row" columnGap={1}>
      <Box width={label} flexShrink={0}>
        <Text weight="bold" wrap="truncate-end">{r.label}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="truncate-end" dimColor={r.quiet === true}>{fitting(r.words, room)}</Text>
      </Box>
      <Box width={FIGURE_CELLS} flexShrink={0} justifyContent="flex-end">
        <Text dimColor={r.quiet === true}>{r.figure}</Text>
      </Box>
      {r.share === undefined ? (
        <Box width={t.Svg === null ? barCells : Math.ceil(SVG_BAR_PX / 8)} flexShrink={0} />
      ) : t.Svg === null ? (
        <Text {...(r.tone !== undefined && r.tone !== "dim" ? { color: r.tone } : { dimColor: true })}>{textBar(r.share, barCells)}</Text>
      ) : (
        <Svg source={svgBar(r.share, SVG_BAR_PX, SVG_BAR_H, r.tone ?? "dim")} alt={`${Math.round(r.share * 100)}%`} width={SVG_BAR_PX} height={SVG_BAR_H} />
      )}
    </Box>
  ));
}
