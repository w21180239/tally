// The foot under every tab: main's cache timer, the context fill and the rate limits, on the grid of grid.ts.
import type { RenderElement } from "claude-code";
import { CACHE_MARK, CRIT_MARK, SEP, toneOfCache, toneOfShare } from "./theme.ts";
import type { Tone } from "./theme.ts";
import { contextShare, headlineOf, leftText, limitName, percentText, tokensText, untilText } from "./data.ts";
import type { WindowData } from "./data.ts";
import { gridOf } from "./grid.ts";
import { row } from "./rows.tsx";
import type { Table } from "./table.ts";

const LABEL_CELLS = 9;
const SHORT_LABEL_CELLS = 5;
/** Under this many columns the foot uses the short labels. */
const SHORT_COLS = 40;

type Row = { label: string; words: string[]; figure: string; share?: number; tone?: Tone; quiet?: boolean };

// The first words that fit `room`, else the last (the shortest).
const fitting = (words: string[], room: number): string => words.find((w) => w.length <= room) ?? words[words.length - 1] ?? "";

// A red figure leads with `!`, so the colour is never the only sign.
const figureOf = (percent: number, tone: Tone | undefined): string => `${tone === "error" ? `${CRIT_MARK} ` : ""}${percent}%`;

/** The foot's rows as data: label, candidate words from long to short, the right-hand figure and the bar. */
export function footRows(d: WindowData, isShort: boolean): Row[] {
  const rows: Row[] = [];
  if (d.cache !== null) {
    const c = d.cache;
    const left = `${CACHE_MARK} ${leftText(c.leftMs)}`;
    const share = c.isExpired ? 0 : c.leftMs / c.lifeMs;
    rows.push({
      label: isShort ? "cache" : "Cache",
      words: c.isExpired
        ? [`${CRIT_MARK} main \u{b7} expired \u{b7} next request rewrites`, `${CRIT_MARK} main \u{b7} expired`, `${CRIT_MARK} expired`]
        : [`main \u{b7} ${left} left \u{b7} rewrite`, `main \u{b7} ${left} left`, `main \u{b7} ${left}`, left],
      figure: c.refillUsd === null ? "" : headlineOf(d, c.refillUsd),
      share,
      tone: toneOfCache(share, c.isExpired),
    });
  }
  const share = contextShare(d);
  if (d.context.tokens === null) {
    rows.push({ label: isShort ? "ctx" : "Context", words: ["awaiting first reply", "idle", "-"], figure: "", quiet: true });
  } else {
    const tone = share === null ? undefined : toneOfShare(share);
    rows.push({
      label: isShort ? "ctx" : "Context",
      words: d.context.window > 0 ? [`${tokensText(d.context.tokens)} of a ${tokensText(d.context.window)} window`, `${tokensText(d.context.tokens)} of ${tokensText(d.context.window)}`, tokensText(d.context.tokens)] : [tokensText(d.context.tokens)],
      figure: share === null ? "" : tone === "error" ? figureOf(Math.round(share * 100), tone) : percentText(share),
      ...(share !== null && { share, tone: tone! }),
    });
    if (d.context.compactAt !== null && d.context.window > 0) {
      rows.push({ label: "", words: [`compact at ${tokensText(d.context.compactAt)}`, "compact"], figure: percentText(d.context.compactAt / d.context.window), quiet: true });
    }
  }
  d.limits.forEach((l, i) => {
    const reset = untilText(l.resetsAt, d.now);
    const tone = toneOfShare(l.percentUsed / 100);
    const name = limitName(l.kind, isShort);
    const near = tone === "warning" ? `${SEP}near limit` : "";
    rows.push({
      label: isShort ? limitName(l.kind, true) : i === 0 ? "Limits" : "",
      words: isShort ? [reset ?? ""] : reset === null ? [`${name}${near}`, name] : [`${name}${near} \u{b7} resets in ${reset}`, `${limitName(l.kind, true)}${near} \u{b7} in ${reset}`, ...(near === "" ? [] : [`${limitName(l.kind, true)}${near}`]), `${limitName(l.kind, true)} \u{b7} in ${reset}`],
      figure: figureOf(Math.round(l.percentUsed), tone),
      share: l.percentUsed / 100,
      tone,
    });
  });
  return rows;
}

/** The foot drawn in `cols` cells: one row each on the grid, the bar at the end (text on the terminal, Svg elsewhere). */
export function drawFoot(t: Table, d: WindowData, cols: number): RenderElement[] {
  const isShort = cols < SHORT_COLS;
  const g = gridOf(cols, { money: true, bar: true, lead: isShort ? SHORT_LABEL_CELLS : LABEL_CELLS });
  return footRows(d, isShort).map((r, i) =>
    row(t, g, {
      key: `foot-${i}`,
      lead: r.label,
      label: fitting(r.words, g.label),
      money: r.figure,
      ...(r.share !== undefined && { share: r.share }),
      ...(r.tone !== undefined && { tone: r.tone }),
      ...(r.quiet === true && { quiet: true }),
    }),
  );
}
