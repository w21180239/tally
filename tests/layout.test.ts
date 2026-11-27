import { describe, expect, test } from "claude-code/testing";
import { parseArgs } from "../core/args.ts";
import { openTarget } from "../core/open-target.ts";
import { emptyLive } from "../core/live-state.ts";
import { cacheOf, contextWords, glanceLines, leftText, tokensText, untilText, windowData } from "../view/data.ts";
import type { WindowData } from "../view/data.ts";
import { foldLine, foldParts } from "../view/fold.tsx";
import { footRows } from "../view/foot.tsx";
import { keyLine, keyLineText, spansOf } from "../view/keys.ts";
import { canDock, layoutOf, opensByItself } from "../view/layout.ts";
import { hourGlyph, textBar } from "../view/theme.ts";

const NOW = Date.UTC(2026, 10, 27, 12);

function dataOf(over: Partial<WindowData> = {}): WindowData {
  return {
    now: NOW,
    money: "cents-and-dollars",
    decimals: "auto",
    costUsd: 5.05,
    agents: 2,
    models: [["opus", 4.5]],
    context: { tokens: 236_000, window: 1_000_000, compactAt: 800_000 },
    limits: [
      { kind: "five_hour", percentUsed: 6, resetsAt: new Date(NOW + (4 * 60 + 20) * 60_000).toISOString() },
      { kind: "seven_day", percentUsed: 22, resetsAt: new Date(NOW + (3 * 24 + 5) * 3_600_000).toISOString() },
    ],
    cache: { leftMs: 42 * 60_000, lifeMs: 3_600_000, isExpired: false, refillUsd: 0.45 },
    chart: "\u{2582}\u{2583}\u{2585}\u{2587}\u{2588}\u{2585}\u{2583}\u{2582}",
    hint: { found: "Cache expired before 3 turns", saving: "saves $2.10" },
    ...over,
  };
}

describe("layoutOf", () => {
  test("width picks compact, narrow or full", () => {
    expect(layoutOf(39, 40, "dock")).toBe("compact");
    expect(layoutOf(40, 40, "dock")).toBe("narrow");
    expect(layoutOf(69, 40, "dock")).toBe("narrow");
    expect(layoutOf(70, 40, "dock")).toBe("full");
    expect(layoutOf(200, 40, "inline")).toBe("full");
  });

  test("an inline frame under 10 rows is the short view at any width; a dock never is", () => {
    expect(layoutOf(80, 9, "inline")).toBe("short");
    expect(layoutOf(20, 9, "inline")).toBe("short");
    expect(layoutOf(80, 10, "inline")).toBe("full");
    expect(layoutOf(80, 9, "dock")).toBe("full");
  });

  test("an inline frame on a fullscreen terminal too narrow to dock is the short view whatever its height", () => {
    expect(layoutOf(96, 40, "inline", { isFullscreen: true })).toBe("short");
    expect(layoutOf(96, 40, "inline", { isFullscreen: false })).toBe("full");
  });

  test("docking needs 110 columns; the window opens by itself from 144", () => {
    expect(canDock(109)).toBe(false);
    expect(canDock(110)).toBe(true);
    expect(opensByItself(143)).toBe(false);
    expect(opensByItself(144)).toBe(true);
  });
});

describe("foldLine", () => {
  test("shows hint with saving, chart, cost, context and cache timer, in that order, when wide", () => {
    const line = foldLine(dataOf(), 200);
    const at = (s: string) => line.indexOf(s);
    expect(at("Cache expired")).toBeGreaterThanOrEqual(0);
    expect(at("saves $2.10")).toBeGreaterThan(at("Cache expired"));
    expect(at("\u{2582}\u{2583}")).toBeGreaterThan(at("saves $2.10"));
    expect(at("$5.05")).toBeGreaterThan(at("\u{2582}\u{2583}"));
    expect(at("ctx 236k (24%)")).toBeGreaterThan(at("$5.05"));
    expect(at("42m")).toBeGreaterThan(at("ctx"));
  });

  test("gives way from the cache timer through chart, saving and hint; at 30 columns only cost and context stay", () => {
    const d = dataOf();
    const widest = foldLine(d, 200).length;
    const noCache = foldLine(d, widest - 1);
    expect(noCache).not.toContain("42m");
    expect(noCache).toContain("saves $2.10");
    const narrow = foldLine(d, 30);
    expect(narrow).toBe("$5.05 \u{b7} ctx 236k (24%)");
    expect(narrow.length).toBeLessThanOrEqual(30);
    expect(foldParts(d, 30).map((p) => p.role)).toEqual(["cost", "context"]);
  });

  test("each drop boundary removes exactly one role, in the order cache, chart, saving, hint, context", () => {
    const d = dataOf();
    const SEP_LEN = " \u{b7} ".length;
    const widthOf = (parts: Array<{ text: string }>): number => parts.reduce((n, p, i) => n + p.text.length + (i === 0 ? 0 : SEP_LEN), 0);
    const steps: Array<{ roles: string[]; saving: boolean }> = [];
    let cols = 200;
    for (;;) {
      const parts = foldParts(d, cols);
      const w = widthOf(parts);
      // Exactly at its own width the same parts stay.
      expect(foldParts(d, w).map((p) => p.text)).toEqual(parts.map((p) => p.text));
      steps.push({ roles: parts.map((p) => p.role), saving: parts.some((p) => p.role === "hint" && p.text.includes("saves $2.10")) });
      if (parts.length === 1) break;
      cols = w - 1;
    }
    expect(steps).toEqual([
      { roles: ["hint", "chart", "cost", "context", "cache"], saving: true },
      { roles: ["hint", "chart", "cost", "context"], saving: true },
      { roles: ["hint", "cost", "context"], saving: true },
      { roles: ["hint", "cost", "context"], saving: false },
      { roles: ["cost", "context"], saving: false },
      { roles: ["cost"], saving: false },
    ]);
  });

  test("a line never passes its width, down to the cost alone cut to fit", () => {
    const d = dataOf();
    for (let cols = 3; cols <= 90; cols++) expect(foldLine(d, cols).length).toBeLessThanOrEqual(cols);
    expect(foldLine(d, 4)).toBe("$5.0");
  });

  test("without a hint or a chart the line is cost, context and cache", () => {
    const line = foldLine(dataOf({ hint: null, chart: null }), 200);
    expect(line).toBe("$5.05 \u{b7} ctx 236k (24%) \u{b7} \u{29d7} 42m");
  });

  test("an expired cache reads cold", () => {
    const d = dataOf({ hint: null, chart: null, cache: { leftMs: 0, lifeMs: 300_000, isExpired: true, refillUsd: 0.5 } });
    expect(foldLine(d, 200)).toContain("cold");
    expect(foldParts(d, 200).at(-1)?.role).toBe("cold");
  });
});

describe("keyLine", () => {
  test("lists only the keys that work on the tab", () => {
    expect(keyLine("session")).toEqual(["0-5 switch tab", "esc collapse"]);
    expect(keyLine("usage")).toEqual(["0-5 switch tab", "s time span", "esc collapse"]);
    expect(keyLine("hints")).toEqual(["0-5 switch tab", "s time span", "r repo filter", "esc collapse"]);
    expect(keyLine("history")).toEqual(["0-5 switch tab", "r repo filter", "esc collapse"]);
    expect(keyLine("help")).toEqual(["0-5 switch tab", "esc collapse"]);
  });

  test("the body's own keys appear only while it has them", () => {
    const all = keyLine("usage", { agents: true, canView: true, canGoBack: true, more: true, rows: true, machines: true });
    expect(all).toEqual(["0-5 switch tab", "s time span", "a agent list", "p/n prev/next", "v open agent", "b return", "m full lists", "tab/enter open rows", "esc collapse"]);
    // `t` is drawn only on the two tabs that merge other computers' figures, and only with a sync folder.
    expect(keyLine("history", { machines: true })).toContain("t computers");
    expect(keyLine("hints", { machines: true })).toContain("t computers");
    expect(keyLine("history")).not.toContain("t computers");
    expect(keyLine("hints", { evidence: true, adopt: true })).toEqual(["0-5 switch tab", "s time span", "r repo filter", "tab/enter show evidence", "y adopt", "esc collapse"]);
    expect(keyLine("session", { machines: true })).not.toContain("t computers");
  });

  test("the line leads with how to focus, then whole entries while they fit", () => {
    const keys = keyLine("hints");
    expect(keyLineText(200, false, keys)).toBe("ctrl+x then tab to focus \u{b7} 0-5 switch tab \u{b7} s time span \u{b7} r repo filter \u{b7} esc collapse");
    expect(keyLineText(200, true, keys).startsWith("keys active \u{b7} 0-5 switch tab")).toBe(true);
    const cut = keyLineText(44, false, keys);
    expect(cut.length).toBeLessThanOrEqual(44);
    expect(cut.endsWith("0-5 switch tab")).toBe(true);
  });

  test("only Usage cycles three spans; Hints two; the rest none", () => {
    expect(spansOf("usage")).toEqual(["session", "24h", "30d"]);
    expect(spansOf("hints")).toEqual(["24h", "30d"]);
    expect(spansOf("history")).toEqual([]);
  });
});

describe("what /tally opens on", () => {
  const target = (s: string) => openTarget(s, parseArgs(s));
  test("usage session, in either order, is the Usage tab on the session span", () => {
    expect(target("usage session")).toEqual({ tab: "usage", span: "session" });
    expect(target("session usage")).toEqual({ tab: "usage", span: "session" });
  });
  test("a bare session is the Session tab", () => {
    expect(target("session")).toEqual({ tab: "session" });
  });
  test("other tab and span words pass through; none is empty", () => {
    expect(target("hints 24h")).toEqual({ tab: "hints", span: "24h" });
    expect(target("30d")).toEqual({ span: "30d" });
    expect(target("")).toEqual({});
  });
  test("a quoted word is data", () => {
    expect(openTarget('"usage" session', parseArgs('"usage" session'))).toEqual({ tab: "session" });
  });
});

describe("window data and glance", () => {
  test("the session total adds the earlier launches, the live requests and the ledger's remainder", () => {
    const live = { ...emptyLive("s", NOW, 1), other: { usd: 0.25, tokens: { input: 0, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0 }, requests: 1 } };
    live.stepped = { "claude-opus-5-5": { usd: 2, tokens: live.other.tokens, requests: 3 }, "claude-sonnet-5-5": { usd: 0.5, tokens: live.other.tokens, requests: 1 } };
    const d = windowData({ live, foot: { contextTokens: null, contextWindow: 0, compactAt: null, limits: [], refillUsd: null }, chart: { values: [], bands: [] }, settings: { money: "dollars", decimals: "auto" }, now: NOW });
    expect(Math.abs(d.costUsd - 3.75) < 1e-9).toBe(true);
    expect(d.models).toEqual([["opus", 2], ["sonnet", 0.5]]);
    expect(d.chart).toBeNull();
    expect(d.cache).toBeNull();
  });

  test("the chart shows only when some hour of the 8 has a request", () => {
    const base = { live: emptyLive("s", NOW, 0), foot: { contextTokens: null, contextWindow: 0, compactAt: null, limits: [], refillUsd: null }, settings: { money: "dollars" as const, decimals: "auto" as const }, now: NOW };
    expect(windowData({ ...base, chart: { values: [0, 0, 0, 0, 0, 0, 0, 0], bands: [1, 2, 3, 4, 5] } }).chart).toBeNull();
    expect(windowData({ ...base, chart: { values: [0, 0, 0, 0, 0, 0, 0, 3], bands: [1, 2, 3, 4, 5] } }).chart).toBe("\u{b7}\u{b7}\u{b7}\u{b7}\u{b7}\u{b7}\u{b7}\u{2585}");
  });

  test("main's cache counts down from its last write and reads expired at zero", () => {
    expect(cacheOf({ ts: NOW - 20 * 60_000, ttl: "1h" }, NOW, 0.4)).toEqual({ leftMs: 40 * 60_000, lifeMs: 3_600_000, isExpired: false, refillUsd: 0.4 });
    expect(cacheOf({ ts: NOW - 6 * 60_000, ttl: "5m" }, NOW, null)?.isExpired).toBe(true);
    expect(cacheOf(undefined, NOW, null)).toBeNull();
  });

  test("durations and token counts read short", () => {
    expect(leftText(45_000)).toBe("45s");
    expect(leftText(125_000)).toBe("2m 05s");
    expect(leftText(42 * 60_000)).toBe("42m");
    expect(leftText(80 * 60_000)).toBe("1h 20m");
    expect(tokensText(236_000)).toBe("236k");
    expect(tokensText(1_000_000)).toBe("1M");
    expect(tokensText(1_250_000)).toBe("1.25M");
    // Past a billion the unit steps up, so a 30-day total fits the 9-cell amount column.
    expect(tokensText(999_994_000)).toBe("999.99M");
    expect(tokensText(999_996_000)).toBe("1B");
    expect(tokensText(999_600)).toBe("1M");
    expect(tokensText(3_016_010_000)).toBe("3.02B");
    expect(tokensText(1_000_000_000)).toBe("1B");
    expect(untilText(new Date(NOW + 3 * 3_600_000 + 5 * 60_000).toISOString(), NOW)).toBe("3h 05m");
    expect(untilText(new Date(NOW + 3 * 86_400_000 + 5 * 3_600_000).toISOString(), NOW)).toBe("3d 5h");
    expect(untilText(new Date(NOW - 1000).toISOString(), NOW)).toBe("now");
    expect(untilText("nonsense", NOW)).toBeNull();
    expect(contextWords(dataOf({ context: { tokens: null, window: 1_000_000, compactAt: null } }))).toBe("ctx -");
  });

  test("the short view gives one line per group, each within its width", () => {
    const lines = glanceLines(dataOf(), 60);
    expect(lines[0]).toBe("$5.05 session \u{b7} 2 subagents");
    expect(lines[1]).toBe("ctx 236k (24%) \u{b7} 5h 6% \u{b7} 7d 22%");
    expect(lines.some((l) => l.startsWith("cache 42m"))).toBe(true);
    for (const l of glanceLines(dataOf(), 20)) expect(l.length).toBeLessThanOrEqual(20);
  });

  test("the foot has the cache row with its refill price, context with compact threshold, and each limit", () => {
    const rows = footRows(dataOf(), false);
    expect(rows.map((r) => r.label)).toEqual(["Cache", "Context", "", "Limits", ""]);
    expect(rows[0]!.figure).toBe("45\u{a2}");
    expect(rows[1]!.words[0]).toBe("236k of a 1M window");
    expect(rows[1]!.figure).toBe("24%");
    expect(rows[2]!.words[0]).toBe("compact at 800k");
    expect(rows[2]!.figure).toBe("80%");
    expect(rows[3]!.words[0]).toBe("5-hour \u{b7} resets in 4h 20m");
    expect(rows[3]!.figure).toBe("6%");
    expect(rows[4]!.words[0]).toBe("7-day \u{b7} resets in 3d 5h");
    expect(footRows(dataOf({ context: { tokens: null, window: 0, compactAt: null }, cache: null, limits: [] }), false)).toHaveLength(1);
  });

  test("hour glyphs follow the rank bands; a bar fills by share", () => {
    const bands = [10, 20, 30, 40, 50];
    expect(hourGlyph(0, bands)).toBe("\u{b7}");
    expect(hourGlyph(5, bands)).toBe("\u{2582}");
    expect(hourGlyph(35, bands)).toBe("\u{2587}");
    expect(hourGlyph(500, bands)).toBe("\u{2588}");
    expect(textBar(0.5, 10)).toBe("\u{2588}".repeat(5) + "\u{2591}".repeat(5));
    expect(textBar(2, 4)).toBe("\u{2588}".repeat(4));
    expect(textBar(-1, 4)).toBe("\u{2591}".repeat(4));
  });
});
