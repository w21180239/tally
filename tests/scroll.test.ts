import type { RenderElement } from "claude-code";
import { describe, expect, test } from "claude-code/testing";
import { targetOffset } from "../engine/scroll.ts";
import { INITIAL_VIEW, closeListFirst, readView } from "../engine/window.ts";
import { heightOf, hintLine, moveLines, movePage, windowOf, withAutoFocus, wrapLines } from "../view/scroll.ts";
import { tabFaces } from "../view/tabbar.ts";
import { TABS } from "../view/keys.ts";

const text = (s: string, props: Record<string, unknown> = {}): RenderElement => ({ type: "Text", props, children: [s] }) as unknown as RenderElement;
const box = (children: unknown[], props: Record<string, unknown> = {}): RenderElement => ({ type: "Box", props, children }) as unknown as RenderElement;
const button = (label: string, props: Record<string, unknown> = {}): RenderElement => ({ type: "Button", props: { key: label, label, ...props }, children: [label] }) as unknown as RenderElement;

describe("view/scroll: heights", () => {
  test("wrapLines breaks at spaces and splits a word longer than the width", () => {
    expect(wrapLines("one two three", 20)).toBe(1);
    expect(wrapLines("one two three", 7)).toBe(2);
    expect(wrapLines("abcdefghij", 4)).toBe(3);
    expect(wrapLines("a\nb\nc", 10)).toBe(3);
  });

  test("a truncating Text is one row, a plain Text wraps, a column adds, a row takes its tallest", () => {
    expect(heightOf(text("x".repeat(200), { wrap: "truncate-end" }), 40)).toBe(1);
    expect(heightOf(text("word ".repeat(20)), 40)).toBe(3);
    expect(heightOf(box([text("a"), text("b"), text("c")], { flexDirection: "column" }), 40)).toBe(3);
    expect(heightOf(box([text("a"), text("word ".repeat(20))], { flexDirection: "row", columnGap: 1 }), 40)).toBeGreaterThan(1);
  });

  test("a shrinking label beside fixed cells gives up its width, so a long plain Button wraps", () => {
    const row = box([box([button("x".repeat(80), { plain: true })], { flexGrow: 1, flexShrink: 1 }), box([text("12k")], { width: 9, flexShrink: 0 })], { flexDirection: "row", columnGap: 1 });
    expect(heightOf(row, 60)).toBe(2);
    const short = box([box([text("x".repeat(80), { wrap: "truncate-end" })], { flexGrow: 1, flexShrink: 1 }), box([text("12k")], { width: 9, flexShrink: 0 })], { flexDirection: "row", columnGap: 1 });
    expect(heightOf(short, 60)).toBe(1);
  });

  test("a wrapping row of buttons breaks into lines", () => {
    const row = box([button("Session"), button("Usage"), button("Context"), button("History")], { flexDirection: "row", columnGap: 1, flexWrap: "wrap" });
    expect(heightOf(row, 80)).toBe(1);
    expect(heightOf(row, 30)).toBe(2);
  });
});

describe("view/scroll: the window", () => {
  const rows = Array.from({ length: 30 }, (_, i) => text(`row ${i}`, { wrap: "truncate-end", key: `r${i}` }));

  test("rows that fit are all drawn, with no hint", () => {
    const w = windowOf(rows, 40, 30, 0);
    expect(w.overflows).toBe(false);
    expect(w.rows).toHaveLength(30);
    expect(w.above).toBe(0);
    expect(w.below).toBe(0);
  });

  test("an overflow keeps one line of the room for the hint and counts rows above and below", () => {
    const top = windowOf(rows, 40, 10, 0);
    expect(top.overflows).toBe(true);
    expect(top.rows).toHaveLength(9);
    expect(top.below).toBe(21);
    const mid = windowOf(rows, 40, 10, 5);
    expect(mid.above).toBe(5);
    expect(mid.below).toBe(16);
  });

  test("the offset is clamped so the last row is whole at the end", () => {
    const end = windowOf(rows, 40, 10, 999);
    expect(end.offset).toBe(21);
    expect(end.rows).toHaveLength(9);
    expect(end.below).toBe(0);
    expect(windowOf(rows, 40, 10, -5).offset).toBe(0);
  });

  test("a tall row is never cut from the window and a window always shows at least one row", () => {
    const tall = [text("short", { wrap: "truncate-end" }), box([text("a"), text("b"), text("c"), text("d")], { flexDirection: "column" }), text("tail", { wrap: "truncate-end" })];
    const w = windowOf(tall, 40, 3, 0);
    expect(w.rows.length).toBeGreaterThanOrEqual(1);
    expect(w.maxOffset).toBe(2);
  });

  test("moveLines steps whole rows, at least one for any move, and stops at the ends", () => {
    const h = [1, 1, 3, 1, 1, 1];
    expect(moveLines(h, 0, 1, 5)).toBe(1);
    expect(moveLines(h, 1, 3, 5)).toBe(3);
    expect(moveLines(h, 3, -1, 5)).toBe(2);
    expect(moveLines(h, 5, 9, 5)).toBe(5);
    expect(moveLines(h, 0, -9, 5)).toBe(0);
  });

  test("movePage starts the next page where this one ends and the previous one where it fits back", () => {
    const h = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    expect(movePage(h, 4, 0, 6, 1)).toBe(4);
    expect(movePage(h, 4, 4, 6, 1)).toBe(6);
    expect(movePage(h, 4, 6, 6, -1)).toBe(2);
    expect(movePage(h, 4, 2, 6, -1)).toBe(0);
  });

  test("hintLine names what lies above and below and how to scroll when it fits, and drops the how-to when narrow", () => {
    expect(hintLine({ above: 0, below: 14 }, 60)).toBe("\u{2193} 14 more \u{b7} scroll or pgup/pgdn");
    expect(hintLine({ above: 4, below: 60 }, 60)).toBe("\u{2191} 4 above \u{b7} \u{2193} 60 more \u{b7} scroll or pgup/pgdn");
    expect(hintLine({ above: 4, below: 60 }, 30)).toBe("\u{2191} 4 above \u{b7} \u{2193} 60 more");
    expect(hintLine({ above: 4, below: 0 }, 60)).toBe("\u{2191} 4 above \u{b7} scroll or pgup/pgdn");
  });

  test("withAutoFocus marks the first Button, deep, without touching the original, and says null when there is none", () => {
    const original = box([text("title"), box([button("first"), button("second")], { flexDirection: "row" })], { flexDirection: "column" });
    const marked = withAutoFocus(original) as unknown as { children: Array<{ children: Array<{ props: { autoFocus?: boolean } }> }> };
    expect(marked.children[1]?.children[0]?.props.autoFocus).toBe(true);
    expect(marked.children[1]?.children[1]?.props.autoFocus).toBeUndefined();
    expect(JSON.stringify(original)).not.toContain("autoFocus");
    expect(withAutoFocus(text("plain"))).toBeNull();
  });
});

describe("engine/scroll: what a move asks for", () => {
  const m = { active: true, heights: Array.from({ length: 30 }, () => 1), capacity: 9, maxOffset: 21 };

  test("a wheel notch moves three rows, a key one row, and a move of the pane's height or more is a page", () => {
    expect(targetOffset(m, 0, 1, 40, true)).toBe(3);
    expect(targetOffset(m, 6, -1, 40, true)).toBe(3);
    expect(targetOffset(m, 0, 1, 40, false)).toBe(1);
    expect(targetOffset(m, 0, 40, 40, false)).toBe(9);
    expect(targetOffset(m, 9, -40, 40, false)).toBe(0);
    expect(targetOffset(m, 20, 40, 40, false)).toBe(21);
  });
});

describe("engine/window: Esc with the agent list open (U5)", () => {
  // The kit's `$` raises no `ui.close`, so the decision is checked against a stand-in `$` holding the view atom.
  const standIn = (listing: boolean) => {
    const cells = new Map<string, unknown>([["view", { shape: "view-5", value: { ...INITIAL_VIEW, mode: "open", listing } }]]);
    const invalidated: string[] = [];
    const $ = {
      state: {
        get: async (ref: { key: string }) => ({ value: cells.get(ref.key), version: 1 }),
        set: async (ref: { key: string }, value: unknown) => {
          cells.set(ref.key, value);
          return { isSet: true, version: 2 };
        },
      },
      ui: { invalidate: (event: string) => void invalidated.push(event) },
    };
    return { $: $ as never, cells, invalidated };
  };

  test("the person's close with the list open closes the list and keeps the window", async () => {
    const s = standIn(true);
    expect(await closeListFirst(s.$, "person")).toBe(true);
    expect(await readView(s.$)).toMatchObject({ listing: false, mode: "open" });
    expect(s.invalidated).toContain("ui.render");
    // With the list shut, the next close goes on to fold.
    expect(await closeListFirst(s.$, "person")).toBe(false);
  });

  test("our own fold is never held back by the list, and a close with no list passes", async () => {
    expect(await closeListFirst(standIn(true).$, "plugin")).toBe(false);
    expect(await closeListFirst(standIn(false).$, "person")).toBe(false);
  });
});

describe("view/tabbar", () => {
  const width = (cols: number, count: number): number => {
    const t = tabFaces(cols, count);
    const faces = TABS.reduce((n, s) => n + s.hotkey.length + 2 + t.faces[s.tab].length, 0) + TABS.length - 1;
    return faces + (t.fold === "" ? 0 : 1 + t.fold.length);
  };

  test("every width from 40 up fits one row, with or without hints", () => {
    for (let cols = 40; cols <= 120; cols++) for (const count of [0, 1, 12]) expect(width(cols, count)).toBeLessThanOrEqual(cols);
  });

  test("wide shows full names and the fold words; narrower shortens the names and then the fold button", () => {
    expect(tabFaces(90, 0).faces.session).toBe("Session");
    expect(tabFaces(90, 0).fold).toBe("\u{00d7} fold");
    expect(tabFaces(62, 1).faces.session).toBe("Sess");
    expect(tabFaces(62, 0).faces.session).toBe("Session");
    expect(tabFaces(47, 0).faces.session).toBe("Ses");
    expect(tabFaces(47, 0).fold).toBe("\u{00d7}");
  });

  test("the Hints face carries the count, and none when there are no hints", () => {
    expect(tabFaces(90, 3).faces.hints).toBe("Hints(3)");
    expect(tabFaces(90, 0).faces.hints).toBe("Hints");
    expect(tabFaces(47, 2).faces.hints).toBe("Hnt(2)");
  });
});
