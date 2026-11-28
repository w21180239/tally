import type { On, RenderInput } from "claude-code";
import { describe, expect, mock, test } from "claude-code/testing";
import { BAR_CELLS, COMPACT_BAR_CELLS, LABEL_MIN, MONEY_CELLS, TOKENS_FROM, TOKEN_CELLS, cut, figureCell, gridOf, rowLine, titleParts } from "../view/grid.ts";
import { textBar } from "../view/theme.ts";
import { worldOf } from "./world.ts";
import { linesOf } from "./render.ts";
import type { Node } from "./render.ts";

const NOW = Date.UTC(2026, 10, 27, 12);
const WIDTHS = [48, 54, 63, 80, 120, 144];

describe("grid", () => {
  test("the label gets what the columns leave, at every width the window draws", () => {
    for (const cols of WIDTHS) {
      const g = gridOf(cols, { tokens: true, money: true, bar: true });
      const columns = [g.tokens, g.money, g.bar].filter((w) => w > 0);
      expect(g.label + columns.reduce((a, b) => a + b + 1, 0)).toBe(cols);
      expect(g.label).toBeGreaterThanOrEqual(LABEL_MIN);
      expect(g.money).toBe(MONEY_CELLS);
      expect(g.bar).toBe(BAR_CELLS);
    }
  });

  test("a tab with money and tokens shows both from 52 columns, money alone under", () => {
    expect(gridOf(TOKENS_FROM - 1, { tokens: true, money: true, bar: true }).tokens).toBe(0);
    expect(gridOf(TOKENS_FROM, { tokens: true, money: true, bar: true }).tokens).toBe(TOKEN_CELLS);
    // A tab whose only figure is tokens keeps them.
    expect(gridOf(44, { tokens: true, bar: true }).tokens).toBe(TOKEN_CELLS);
  });

  test("the bar narrows under 40 columns and goes before the label drops under its minimum", () => {
    expect(gridOf(39, { money: true, bar: true }).bar).toBe(COMPACT_BAR_CELLS);
    const tight = gridOf(30, { tokens: true, money: true, bar: true });
    expect(tight.label).toBeGreaterThanOrEqual(LABEL_MIN);
  });

  test("a lead column takes its width and a gap", () => {
    const g = gridOf(54, { money: true, bar: true, lead: 9 });
    expect(g.lead + 1 + g.label + 1 + g.money + 1 + g.bar).toBe(54);
  });

  test("figures end on the same cell in rows with and without a bar, estimated or not", () => {
    for (const cols of WIDTHS) {
      const g = gridOf(cols, { tokens: true, money: true, bar: true });
      const rows = [
        { label: "Output", tokens: "1.26M", money: "$18.39", share: 0.5 },
        { label: "Thinking", tokens: "6k", money: "$0.13", est: true, share: 1 },
        { label: "  $ git fetch -q origin master 'refs/heads/*:refs/remotes/origin/*'", tokens: "153", money: "<$0.01", est: true },
        { label: "Totals", tokens: "329M", money: "$1,235" },
      ];
      const lines = rows.map((r) => rowLine(g, r, textBar));
      for (const line of lines) expect(line.length).toBe(cols);
      // The money column's right edge is the same cell in every row.
      const edge = cols - g.bar - 2;
      for (const line of lines) expect(line[edge]).toMatch(/[0-9a-z]/);
      for (const line of lines) expect(line[edge + 1]).toBe(" ");
    }
  });

  test("a label too long for its cell is cut with an ellipsis, a figure that cannot fit is too", () => {
    expect(cut("abcdef", 4)).toBe("abc\u{2026}");
    expect(cut("abc", 3)).toBe("abc");
    expect(figureCell("$18.39", true, 8)).toBe("~$18.39");
    expect(figureCell(undefined, true, 8)).toBe("");
  });

  test("a section title is the name, a note while there is room, then a rule to the edge", () => {
    const wide = titleParts("Spend per day", "newest first", 40);
    expect(wide.name.length + 1 + wide.note.length + 1 + wide.rule.length).toBe(40);
    expect(wide.note).toBe("newest first");
    expect(wide.rule).toMatch(/^\u{2500}+$/u);
    const narrow = titleParts("Spend per day", "newest first and a very long note", 24);
    // Too long for the width: the note goes whole, leaving the name, a gap and the rule.
    expect(narrow.note).toBe("");
    expect(narrow.name.length + 1 + narrow.rule.length).toBe(24);
    expect(narrow.rule.length).toBeGreaterThanOrEqual(2);
    // No note: the name, a gap and the rule.
    const bare = titleParts("Where it went", undefined, 30);
    expect(bare.name.length + 1 + bare.rule.length).toBe(30);
    expect(titleParts("A long section name", "note", 10).note).toBe("");
    // A note that does not fit whole is dropped, never cut mid-phrase.
    const cutNote = titleParts("Largest sessions", "press a row to resume", 28);
    expect(cutNote.note).toBe("");
    expect(cutNote.name.length + 1 + cutNote.rule.length).toBe(28);
    expect(titleParts("Largest sessions", "press a row to resume", 44).note).toBe("press a row to resume");
    expect(titleParts("A long section name", undefined, 10).name).toBe("A long se\u{2026}");
  });
});

const LIMITS = [
  { kind: "five_hour", percentUsed: 83, resetsAt: new Date(NOW + 130 * 60_000).toISOString() },
  { kind: "seven_day", percentUsed: 55, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() },
];

const PANE = (cols: number, rows = 80): Omit<RenderInput<"Pane">, "surface"> => ({
  component: "Pane",
  requestId: "tally",
  viewport: { columns: 200, rows: rows + 20, isFullscreen: true },
  props: { title: "tally", isFocused: true, bodyColumns: cols, placement: "dock", scroll: { offset: 0, bodyRows: rows }, view: {} },
});

function rig(on: On): ReturnType<typeof mock.clock> {
  const world = worldOf();
  const clock = mock.clock(on, { now: NOW });
  mock.env(on, { HOME: "/home/u" });
  const stored = new Map<string, unknown>();
  on("store.get", (_, e) => ({ value: stored.get(e.key) }));
  on("store.set", (_, e) => {
    stored.set(e.key, e.value);
    return { value: undefined };
  });
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("command.register", (_, e) => ({ value: { command: e.name } }));
  on("session.id", () => ({ value: "s-1" }));
  on("session.cwd", () => ({ value: "/work/demo" }));
  on("session.info", () => ({ value: { platform: "linux" } }));
  on("session.measure", (_, e) => ({ changed: e.changed }));
  on("ui.toast", () => ({ value: undefined }));
  on("session.usage", () => ({ value: { startedAt: NOW, context: { tokens: 236_000, window: 1_000_000, percent: 24 }, rateLimits: LIMITS, cost: { usd: 0 } } as never }));
  on("fs.read", async (_, e) => ({ value: await world.$.fs.read(e.path, { as: e.as, offset: e.offset, length: e.length } as never) }));
  on("fs.write", async (_, e) => ({ value: await world.$.fs.write(e.path, e.text) }));
  on("fs.list", async (_, e) => ({ value: await world.$.fs.list(e.path) }));
  on("fs.exists", async (_, e) => ({ value: await world.$.fs.exists(e.path) }));
  on("fs.stat", async (_, e) => ({ value: await world.$.fs.stat(e.path) }));
  on("ui.invalidate", () => ({ value: undefined }));
  on("ui.panes", () => ({ value: [] }));
  on("config.list", () => ({ value: [] }));
  return clock;
}

const find = (n: Node, key: string): Node | undefined => {
  if (typeof n !== "object" || n === null) return undefined;
  if (n.props?.key === key) return n;
  for (const c of (n.children ?? []).flat() as Node[]) {
    const hit = find(c, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
};

describe("foot on the grid", () => {
  for (const cols of WIDTHS) {
    test(`at ${cols} columns every foot row is one line, aligned, with its figure and bar`, async ($, on) => {
      const clock = rig(on);
      await $.session.start({ cwd: "/work/demo", surface: "terminal", isInteractive: true });
      await clock.settle();
      await $.session.measure({ context: { tokens: 236_000, window: 1_000_000, percent: 24 }, rateLimits: LIMITS, changed: ["rateLimits", "context"] } as never);
      await clock.settle();
      const ui = await $.ui.mount({ plugin: "tally", surface: "terminal", ...PANE(cols) });
      const tree = (await ui.drawn()) as Node;
      const rows = [0, 1, 2, 3, 4].map((i) => find(tree, `foot-${i}`)).filter((n): n is Exclude<Node, string> => n !== undefined);
      expect(rows).toHaveLength(3);
      const g = gridOf(cols, { money: true, bar: true, lead: cols < 40 ? 5 : 9 });
      const lines = rows.map((r) => {
        const out = linesOf(r, cols);
        expect(out).toHaveLength(1);
        expect(out[0]!.length).toBeLessThanOrEqual(cols);
        return out[0]!;
      });
      // Context, then the two limits: each with a figure ending on the money column's edge and a bar of 8 cells.
      const edge = cols - g.bar - 2;
      for (const line of lines.filter((l) => l.includes("%"))) {
        expect(line.length).toBe(cols);
        expect(line[edge]).toBe("%");
        expect(line.slice(cols - g.bar)).toMatch(/^[\u{2588}\u{2591}]+$/u);
      }
      // An 83% limit is red: a figure that leads with a mark, so colour is not the only signal.
      expect(lines.some((l) => l.includes("! 83%"))).toBe(true);
      // An amber limit says so in a word while it fits (the word outranks the reset time when the row is tight).
      expect(lines.find((l) => /55%/.test(l))).toContain("near limit");
      await ui.unmount();
    });
  }
});

// Every row the primitives draw is one line high, whatever the width, and the settings' values end on the right edge.
const rowsOf = (n: Node, out: Array<Exclude<Node, string>> = []): Array<Exclude<Node, string>> => {
  if (typeof n !== "object" || n === null) return out;
  if (n.props?.height === 1) out.push(n);
  for (const c of (n.children ?? []).flat() as Node[]) rowsOf(c, out);
  return out;
};

describe("tabs on the grid", () => {
  for (const cols of WIDTHS) {
    for (const tab of ["session", "usage", "context", "history", "hints", "help"]) {
      test(`${tab} at ${cols} columns: every grid row is one line and nothing is wider than the body`, async ($, on) => {
        const clock = rig(on);
        await $.session.start({ cwd: "/work/demo", surface: "terminal", isInteractive: true });
        await clock.settle();
        const ui = await $.ui.mount({ plugin: "tally", surface: "terminal", ...PANE(cols, 400) });
        await ui.press({ key: `tab-${tab}` });
        await clock.settle();
        const body = find((await ui.drawn()) as Node, `body-${tab}`);
        expect(body).toBeDefined();
        const rows = rowsOf(body!);
        // A tab with nothing to show draws a status block, which has no grid rows.
        if (tab === "help") expect(rows.length).toBeGreaterThan(0);
        for (const r of rows) {
          const out = linesOf(r, cols);
          expect(out.length).toBeLessThanOrEqual(1);
          for (const line of out) expect(line.length).toBeLessThanOrEqual(cols);
        }
        if (tab === "help") {
          const settings = rows.filter((r) => String(r.props.key).startsWith("setting-"));
          expect(settings).toHaveLength(11);
          for (const r of settings) expect(linesOf(r, cols)[0]!.length).toBe(cols);
        }
        await ui.unmount();
      });
    }
  }
});
