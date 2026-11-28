import { describe, expect, test } from "claude-code/testing";
import { cacheWords } from "../view/data.ts";
import type { WindowData } from "../view/data.ts";
import { cacheRun, cardSections, DETAILS_LABEL, rowRuns } from "../view/desktop-row.tsx";
import { ENTRY_FULL, ENTRY_SHORT, foldLine, foldParts } from "../view/fold.tsx";

const NOW = Date.UTC(2026, 10, 27, 12);
const SEP_LEN = " \u{b7} ".length;

function dataOf(over: Partial<WindowData> = {}): WindowData {
  return {
    now: NOW,
    money: "cents-and-dollars",
    decimals: "auto",
    costUsd: 1.16,
    agents: 2,
    models: [["opus", 1]],
    context: { tokens: 207_000, window: 1_000_000, compactAt: 800_000 },
    limits: [{ kind: "five_hour", percentUsed: 83, resetsAt: new Date(NOW + 130 * 60_000).toISOString() }],
    cache: { leftMs: 42 * 60_000, lifeMs: 3_600_000, isExpired: false, refillUsd: 0.45 },
    chart: "\u{2582}\u{2583}\u{2585}\u{2587}\u{2588}\u{2585}\u{2583}\u{2582}",
    hint: { found: "1 installed plugin never used", saving: "~$0.03" },
    ...over,
  };
}

const widthOf = (parts: Array<{ text: string }>): number => parts.reduce((n, p, i) => n + p.text.length + (i === 0 ? 0 : SEP_LEN), 0);

describe("fold line order and labels", () => {
  test("spend, context, cache, chart, hint, in that order, every amount with its word", () => {
    const line = foldLine(dataOf(), 300);
    expect(line).toBe("session $1.16 \u{b7} ctx 21% \u{b7} cache 42m \u{b7} 8h \u{2582}\u{2583}\u{2585}\u{2587}\u{2588}\u{2585}\u{2583}\u{2582} \u{b7} \u{25b2} 1 installed plugin never used, save ~$0.03");
  });

  test("an expired cache reads expired, never cold", () => {
    const d = dataOf({ hint: null, chart: null, cache: { leftMs: 0, lifeMs: 300_000, isExpired: true, refillUsd: 0.5 } });
    expect(foldLine(d, 200)).toBe("session $1.16 \u{b7} ctx 21% \u{b7} cache expired");
    expect(foldParts(d, 200).at(-1)?.role).toBe("expired");
    expect(foldLine(d, 200)).not.toContain("cold");
  });

  test("the cache shows whole minutes, and <1m in the last minute", () => {
    expect(foldLine(dataOf({ hint: null, chart: null, cache: { leftMs: 4 * 60_000 + 2_000, lifeMs: 300_000, isExpired: false, refillUsd: null } }), 200)).toContain("cache 4m");
    expect(foldLine(dataOf({ hint: null, chart: null, cache: { leftMs: 40_000, lifeMs: 300_000, isExpired: false, refillUsd: null } }), 200)).toContain("cache <1m");
  });

  test("a hint with no priced saving shows no save label", () => {
    const d = dataOf({ hint: { found: "big paste", saving: null }, chart: null });
    expect(foldLine(d, 200)).toContain("\u{25b2} big paste");
    expect(foldLine(d, 200)).not.toContain("save");
  });

  test("the amount follows the money setting", () => {
    expect(foldLine(dataOf({ money: "cents", hint: null, chart: null }), 200)).toContain("session 116\u{a2}");
    expect(foldLine(dataOf({ money: "dollars", costUsd: 0.5, hint: null, chart: null }), 200)).toContain("session $0.5");
  });
});

describe("fold line at several widths", () => {
  const d = dataOf();

  test("each drop boundary removes one part, in the order entry, chart, saving, cache, hint text, context", () => {
    const steps: string[][] = [];
    let cols = 300;
    for (;;) {
      const parts = foldParts(d, cols, true);
      const w = widthOf(parts);
      // At its own width the same parts stay.
      expect(foldParts(d, w, true).map((p) => p.text)).toEqual(parts.map((p) => p.text));
      steps.push(parts.map((p) => (p.role === "hint" ? (p.text.includes("save") ? "hint+save" : p.text === "\u{25b2} hint" ? "marker" : "hint") : p.role)));
      if (parts.length === 1) break;
      cols = w - 1;
    }
    expect(steps).toEqual([
      ["cost", "context", "cache", "chart", "hint+save", "entry"],
      ["cost", "context", "cache", "chart", "hint+save", "entry"],
      ["cost", "context", "cache", "chart", "hint+save"],
      ["cost", "context", "cache", "hint+save"],
      ["cost", "context", "cache", "hint"],
      ["cost", "context", "hint"],
      ["cost", "context", "marker"],
      ["cost", "context"],
      ["cost"],
    ]);
    expect(foldParts(d, 300, true).at(-1)?.text).toBe(ENTRY_FULL);
    expect(foldParts(d, widthOf(foldParts(d, 300, true)) - 1, true).at(-1)?.text).toBe(ENTRY_SHORT);
  });

  test("100 columns on the main screen: spend, context, cache and hint, with the short way in", () => {
    const line = foldLine(dataOf({ chart: null }), 100, true);
    expect(line).toBe(`session $1.16 \u{b7} ctx 21% \u{b7} cache 42m \u{b7} \u{25b2} 1 installed plugin never used, save ~$0.03 \u{b7} ${ENTRY_SHORT}`);
    expect(foldLine(dataOf({ chart: null }), 120, true).endsWith(ENTRY_FULL)).toBe(true);
  });

  test("54 columns: spend, context and the hint; the entry words and the chart are gone", () => {
    const line = foldLine(d, 54, true);
    expect(line.length).toBeLessThanOrEqual(54);
    expect(line.startsWith("session $1.16 \u{b7} ctx 21%")).toBe(true);
    expect(line).toContain("\u{25b2}");
    expect(line).not.toContain("8h");
    expect(line).not.toContain("/tally");
  });

  test("a line never passes its width, down to the cost alone cut to fit", () => {
    for (let cols = 3; cols <= 160; cols++) expect(foldLine(d, cols, true).length).toBeLessThanOrEqual(cols);
    expect(foldLine(d, 4)).toBe("$1.1");
  });

  test("the way in is shown only when asked for", () => {
    expect(foldLine(d, 300)).not.toContain("/tally");
    expect(foldLine(d, 300, true)).toContain(ENTRY_FULL);
    expect(ENTRY_FULL).toContain("ctrl+x");
    expect(ENTRY_FULL).toContain("/tally");
  });
});

describe("desktop row", () => {
  test("uses the shared words: expired, sub-agent, details", () => {
    const expired = dataOf({ cache: { leftMs: 0, lifeMs: 300_000, isExpired: true, refillUsd: 0.5 } });
    expect(cacheRun(expired)?.text).toBe("expired");
    const text = rowRuns(expired).map((r) => r.text).join("");
    expect(text).toBe("$1.16 session \u{b7} 2 sub-agents \u{b7} cache expired \u{b7} ctx 207k (21%)");
    expect(cacheWords(expired)).toBe("\u{29d7} expired");
    expect(DETAILS_LABEL).toBe("details \u{25b8}");
  });

  test("the hover card labels the hint's amount as a saving", () => {
    const hint = cardSections(dataOf()).find((s) => s.label === "Hint");
    const runs = hint?.lines[0] as Array<{ text: string }>;
    expect(runs.map((r) => r.text).join("")).toContain("save ~$0.03");
  });
});
