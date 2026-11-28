// A small stand-in for the terminal's layout, enough to read a drawn tree as lines of text at a width: column and
// row Boxes with fixed widths, grow and shrink, gaps, padding and right-justify; Text that wraps or truncates; a
// Button as its label. The kit exercises hooks and never paints, so a width test needs this.
export type Node = string | { type: string; props: Record<string, unknown>; children?: Node[] };

const INF = Number.POSITIVE_INFINITY;
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/** The text a node holds, nested Text and Button children joined. */
export function textOf(n: Node): string {
  if (typeof n === "string") return n;
  if (n.type === "Svg") return "";
  return ((n.children ?? []).flat() as Node[]).filter((c) => typeof c === "string" || (typeof c === "object" && c !== null)).map(textOf).join("");
}

function wrapLines(s: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of s.split("\n")) {
    let line = raw;
    if (width === INF || line.length <= width) {
      out.push(line);
      continue;
    }
    while (line.length > width) {
      const at = line.lastIndexOf(" ", width);
      const cutAt = at > 0 ? at : width;
      out.push(line.slice(0, cutAt));
      line = line.slice(cutAt).replace(/^ /, "");
    }
    out.push(line);
  }
  return out;
}

const fitEnd = (s: string, width: number): string => (width === INF || s.length <= width ? s : width <= 0 ? "" : `${s.slice(0, width - 1)}\u{2026}`);

function renderText(n: Exclude<Node, string>, width: number): string[] {
  const s = textOf(n);
  const wrap = n.props?.wrap;
  const max = num(n.props?.maxLines);
  if (typeof wrap === "string" && wrap !== "wrap") return s.split("\n").map((l) => fitEnd(l, width));
  const lines = wrapLines(s, width);
  if (max !== undefined && lines.length > max) return [...lines.slice(0, max - 1), fitEnd(`${lines[max - 1]}\u{2026}`, width)];
  return lines;
}

const widest = (lines: string[]): number => lines.reduce((m, l) => Math.max(m, l.length), 0);

/** The lines of `n` laid out in `width` cells (INF for its natural size). */
export function render(node: Node, width: number): string[] {
  if (typeof node === "string") return wrapLines(node, width);
  const n = node.props === undefined ? { ...node, props: {} } : node;
  if (n.type === "Text" || n.type === "Button") return renderText(n, width);
  if (n.type === "Svg") return [];
  if (n.props.display === "none") return [];
  const pad = num(n.props.paddingLeft) ?? num(n.props.paddingX) ?? num(n.props.padding) ?? 0;
  const inner = width === INF ? INF : Math.max(0, width - pad);
  const kids = ((n.children ?? []).flat() as Node[]).filter((c) => typeof c === "string" || (typeof c === "object" && c !== null));
  let lines: string[];
  if (n.props.flexDirection === "row") lines = renderRow(n, kids, inner);
  else lines = kids.flatMap((c) => render(c, inner));
  const height = num(n.props.height);
  if (height !== undefined && lines.length > height) lines = lines.slice(0, height);
  return lines.map((l) => " ".repeat(pad) + l);
}

function renderRow(n: Exclude<Node, string>, kids: Node[], width: number): string[] {
  const gap = num(n.props.columnGap) ?? num(n.props.gap) ?? 0;
  const items = kids.map((c) => {
    const p = typeof c === "string" ? {} : (c.props ?? {});
    const natural = widest(render(c, INF));
    return { c, base: num(p.width) ?? natural, grow: num(p.flexGrow) ?? 0, shrink: num(p.flexShrink) ?? 1, min: num(p.minWidth) ?? 0 };
  });
  const sizes = items.map((i) => i.base);
  if (width !== INF) {
    const free = width - sizes.reduce((a, b) => a + b, 0) - gap * Math.max(0, items.length - 1);
    if (free > 0) {
      const grow = items.reduce((a, i) => a + i.grow, 0);
      if (grow > 0) items.forEach((i, k) => (sizes[k] = sizes[k]! + Math.floor((free * i.grow) / grow)));
    } else if (free < 0) {
      const weight = items.reduce((a, i) => a + i.shrink * i.base, 0);
      let over = -free;
      if (weight > 0) {
        items.forEach((i, k) => {
          const take = Math.min(Math.ceil((over * i.shrink * i.base) / weight), Math.max(0, sizes[k]! - i.min));
          sizes[k] = sizes[k]! - take;
        });
      }
      over = 0;
    }
  }
  const cols = items.map((i, k) => {
    const w = sizes[k]!;
    let lines = render(i.c, w);
    const p = typeof i.c === "string" ? {} : (i.c.props ?? {});
    if (p.justifyContent === "flex-end") lines = lines.map((l) => l.padStart(w));
    return { lines, w };
  });
  const rows = cols.reduce((m, c) => Math.max(m, c.lines.length), 0);
  const out: string[] = [];
  for (let r = 0; r < rows; r++) out.push(cols.map((c) => (c.lines[r] ?? "").padEnd(c.w)).join(" ".repeat(gap)).trimEnd());
  return out;
}

/** A tree as text lines at `cols` cells. */
export const linesOf = (tree: Node, cols: number): string[] => render(tree, cols);
