// A docked tab taller than its dock: the rows are windowed here (the engine clips a tree it has no window over), so
// the draw needs each row's height before layout. The heights are estimates from the plain-data tree; they err on
// the tall side so the last row shows whole at the last offset.
import type { RenderElement } from "claude-code";
import { SEP } from "./theme.ts";

type El = { type?: string; props?: Record<string, unknown>; children?: unknown[] };
type Child = El | string;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const asEl = (x: unknown): El | undefined => (typeof x === "object" && x !== null ? (x as El) : undefined);

/** The text a Text or Button holds, nested inline elements joined in. */
function textOf(x: Child | undefined): string {
  if (x === undefined) return "";
  if (typeof x === "string") return x;
  const kids = x.children ?? [];
  const own = kids.map((k) => textOf(k as Child)).join("");
  return own;
}

/** A Button's drawn face: `1: Label` when plain with a hotkey, else `[ Label ]`. */
function faceOf(b: El): string {
  const text = textOf(b);
  const label = text === "" ? String(b.props?.label ?? "") : text;
  if (b.props?.plain === true) return typeof b.props.hotkey === "string" ? `${b.props.hotkey}: ${label}` : label;
  return `[ ${label} ]`;
}

/** Lines `text` takes in `width` cells when wrapped at word breaks; a word longer than the width is broken. */
export function wrapLines(text: string, width: number): number {
  const w = Math.max(1, Math.floor(width));
  let lines = 0;
  for (const seg of text.split(/\r?\n/)) {
    if (seg.length <= w) {
      lines++;
      continue;
    }
    let used = 0;
    let n = 1;
    for (const word of seg.split(" ")) {
      let len = word.length;
      if (used > 0 && used + 1 + len <= w) {
        used += 1 + len;
        continue;
      }
      if (used > 0) {
        n++;
        used = 0;
      }
      while (len > w) {
        n++;
        len -= w;
      }
      used = len;
    }
    lines += n;
  }
  return lines;
}

const isTruncating = (wrap: unknown): boolean => typeof wrap === "string" && wrap.startsWith("truncate");

/** The widest line a child wants, in cells. */
function naturalWidth(x: Child | undefined): number {
  if (x === undefined) return 0;
  if (typeof x === "string") return Math.max(0, ...x.split(/\r?\n/).map((l) => l.length));
  const fixed = num(x.props?.width);
  if (x.type === "Button") return fixed ?? faceOf(x).length;
  if (x.type === "Text") return fixed ?? naturalWidth(textOf(x));
  const kids = (x.children ?? []).filter((k) => !isHidden(k));
  const p = x.props ?? {};
  const pad = (num(p.paddingLeft) ?? num(p.paddingX) ?? num(p.padding) ?? 0) + (num(p.paddingRight) ?? num(p.paddingX) ?? num(p.padding) ?? 0);
  const margin = (num(p.marginLeft) ?? num(p.marginX) ?? num(p.margin) ?? 0) + (num(p.marginRight) ?? num(p.marginX) ?? num(p.margin) ?? 0);
  const gap = num(p.columnGap) ?? num(p.gap) ?? 0;
  const widths = kids.map((k) => naturalWidth(k as Child));
  const inner = p.flexDirection === "column" ? Math.max(0, ...widths) : widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, widths.length - 1);
  return fixed ?? inner + pad + margin;
}

function isHidden(x: unknown): boolean {
  const e = asEl(x);
  return e !== undefined && e.props?.display === "none";
}

/** Rows `x` takes when laid out `width` cells wide. */
export function heightOf(x: RenderElement | string, width: number): number {
  return heightIn(x as Child, Math.max(1, Math.floor(width)));
}

function heightIn(x: Child | undefined, width: number): number {
  if (x === undefined) return 0;
  if (typeof x === "string") return wrapLines(x, width);
  if (isHidden(x)) return 0;
  const p = x.props ?? {};
  if (x.type === "Svg") return Math.max(1, Math.ceil((num(p.height) ?? 8) / 16));
  if (x.type === "Text") {
    const text = textOf(x);
    return isTruncating(p.wrap) ? text.split(/\r?\n/).length : wrapLines(text, width);
  }
  if (x.type === "Button") return wrapLines(faceOf(x), width);
  const fixedH = num(p.height);
  const padL = num(p.paddingLeft) ?? num(p.paddingX) ?? num(p.padding) ?? 0;
  const padR = num(p.paddingRight) ?? num(p.paddingX) ?? num(p.padding) ?? 0;
  const padV = (num(p.paddingTop) ?? num(p.paddingY) ?? num(p.padding) ?? 0) + (num(p.paddingBottom) ?? num(p.paddingY) ?? num(p.padding) ?? 0);
  const marV = (num(p.marginTop) ?? num(p.marginY) ?? num(p.margin) ?? 0) + (num(p.marginBottom) ?? num(p.marginY) ?? num(p.margin) ?? 0);
  const border = p.borderStyle !== undefined ? 2 : 0;
  const inner = Math.max(1, (num(p.width) ?? width) - padL - padR - (p.borderStyle !== undefined ? 2 : 0));
  const kids = (x.children ?? []).filter((k) => !isHidden(k)) as Child[];
  const rowGap = num(p.rowGap) ?? num(p.gap) ?? 0;
  const colGap = num(p.columnGap) ?? num(p.gap) ?? 0;
  let h: number;
  if (kids.length === 0) h = 0;
  else if (p.flexDirection === "column" || p.flexDirection === "column-reverse") {
    h = kids.reduce((s, k) => s + heightIn(k, inner), 0) + rowGap * (kids.length - 1);
  } else if (p.flexWrap === "wrap") {
    // Children packed left to right; a line breaks when the next does not fit.
    let lines = 1;
    let used = 0;
    for (const k of kids) {
      const w = Math.min(naturalWidth(k), inner);
      if (used > 0 && used + colGap + w > inner) {
        lines++;
        used = 0;
      }
      used += (used > 0 ? colGap : 0) + w;
    }
    h = lines + rowGap * (lines - 1);
  } else {
    h = Math.max(...rowWidths(kids, inner, colGap).map((w, i) => heightIn(kids[i], w)));
  }
  return (fixedH ?? h + padV + border) + marV;
}

// The width each child of a no-wrap row gets: natural when all fit, else the shrinkable ones give up the deficit by size.
function rowWidths(kids: Child[], inner: number, gap: number): number[] {
  const natural = kids.map((k) => naturalWidth(k));
  const fixed = kids.map((k) => num(asEl(k)?.props?.width) !== undefined || num(asEl(k)?.props?.flexShrink) === 0 || (typeof k !== "string" && k.type === "Box" && asEl(k)?.props?.flexShrink === undefined && false));
  const total = natural.reduce((a, b) => a + b, 0) + gap * Math.max(0, kids.length - 1);
  if (total <= inner) return natural.map((w) => Math.max(1, w));
  const deficit = total - inner;
  const pool = natural.reduce((s, w, i) => s + (fixed[i] ? 0 : w), 0);
  return natural.map((w, i) => Math.max(1, fixed[i] || pool === 0 ? w : Math.floor(w - (deficit * w) / pool)));
}

export type Windowed = {
  /** The rows to draw, from `offset`. */
  rows: RenderElement[];
  /** Index of the first row drawn, clamped. */
  offset: number;
  /** The last offset that still shows the final row whole. */
  maxOffset: number;
  /** Lines above and below the window. */
  above: number;
  below: number;
  /** True when the rows do not fit: a hint line is drawn and `rows` is a slice. */
  overflows: boolean;
  /** Each row's height, and the lines the window may fill. */
  heights: number[];
  capacity: number;
};

/**
 * The slice of `rows` shown from `offset` in `room` lines at `cols` wide. When everything fits it is all of them; else
 * one line of `room` is kept for the hint, and the offset is clamped so the last row can be reached whole.
 */
export function windowOf(rows: RenderElement[], cols: number, room: number, offset: number): Windowed {
  const heights = rows.map((r) => heightOf(r, cols));
  const total = heights.reduce((a, b) => a + b, 0);
  if (total <= room || rows.length === 0) return { rows, offset: 0, maxOffset: 0, above: 0, below: 0, overflows: false, heights, capacity: Math.max(room, 0) };
  const capacity = Math.max(1, room - 1);
  let maxOffset = rows.length - 1;
  let tail = heights[maxOffset] ?? 0;
  while (maxOffset > 0 && tail + (heights[maxOffset - 1] ?? 0) <= capacity) {
    maxOffset--;
    tail += heights[maxOffset] ?? 0;
  }
  const from = Math.min(Math.max(0, Math.floor(offset)), maxOffset);
  let used = 0;
  let to = from;
  while (to < rows.length && (to === from || used + (heights[to] ?? 0) <= capacity)) {
    used += heights[to] ?? 0;
    to++;
  }
  const above = heights.slice(0, from).reduce((a, b) => a + b, 0);
  return { rows: rows.slice(from, to), offset: from, maxOffset, above, below: total - above - used, overflows: true, heights, capacity };
}

/** Where the window starts after moving `lines` (signed) over rows of `heights`; at least one row per nonzero move. */
export function moveLines(heights: number[], offset: number, lines: number, maxOffset: number): number {
  let at = Math.min(Math.max(0, offset), maxOffset);
  if (lines > 0) {
    let spent = 0;
    while (spent < lines && at < maxOffset) spent += heights[at++] ?? 1;
  } else if (lines < 0) {
    let spent = 0;
    while (spent < -lines && at > 0) spent += heights[--at] ?? 1;
  }
  return at;
}

/** Where the window starts a page on: down starts at the first row not shown, up at the row that ends where this one starts. */
export function movePage(heights: number[], capacity: number, offset: number, maxOffset: number, dir: 1 | -1): number {
  let at = Math.min(Math.max(0, offset), maxOffset);
  if (dir > 0) {
    let used = 0;
    let to = at;
    while (to < heights.length && (to === at || used + (heights[to] ?? 0) <= capacity)) used += heights[to++] ?? 0;
    return Math.min(to, maxOffset);
  }
  let used = 0;
  while (at > 0 && used + (heights[at - 1] ?? 0) <= capacity) used += heights[--at] ?? 0;
  return at;
}

/** The hint line: how much lies above and below, and how to scroll; cut to `cols`. */
export function hintLine(w: Pick<Windowed, "above" | "below">, cols: number): string {
  const parts: string[] = [];
  if (w.above > 0) parts.push(`\u{2191} ${w.above} above`);
  if (w.below > 0) parts.push(`\u{2193} ${w.below} more`);
  const head = parts.join(SEP);
  const full = `${head}${SEP}scroll or pgup/pgdn`;
  return full.length <= cols ? full : head;
}

/** Copy of `x` with `autoFocus` on its first Button, else null when it holds none. */
export function withAutoFocus(x: RenderElement): RenderElement | null {
  const walk = (e: El): El | null => {
    if (e.type === "Button") return { ...e, props: { ...(e.props ?? {}), autoFocus: true } };
    const kids = e.children ?? [];
    for (let i = 0; i < kids.length; i++) {
      const k = asEl(kids[i]);
      const hit = k === undefined ? null : walk(k);
      if (hit !== null) return { ...e, children: [...kids.slice(0, i), hit, ...kids.slice(i + 1)] };
    }
    return null;
  };
  return walk(x as El) as RenderElement | null;
}
