import { describe, expect, test } from "claude-code/testing";
import { parseArgs } from "../core/args.ts";
import { openTarget } from "../core/open-target.ts";
import { emptyLive } from "../core/live-state.ts";
import { cacheOf, contextWords, glanceLines, leftText, tokensText, untilText, windowData } from "../view/data.ts";
import type { WindowData } from "../view/data.ts";
import { footRows } from "../view/foot.tsx";
import { keyLine, keyLineRuns, keyLineText, spansOf } from "../view/keys.ts";
import { layoutOf, MAX_COLUMNS } from "../view/layout.ts";
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

  test("an inline frame under 6 rows is the short view at any width; a dock never is", () => {
    expect(layoutOf(80, 5, "inline")).toBe("short");
    expect(layoutOf(20, 5, "inline")).toBe("short");
    expect(layoutOf(80, 6, "inline")).toBe("full");
    expect(layoutOf(80, 5, "dock")).toBe("full");
  });

  test("a fullscreen terminal gets the same drawing as any other: 80x24 reaches the tabs", () => {
    expect(layoutOf(78, 14, "inline")).toBe("full");
    expect(layoutOf(54, 40, "inline")).toBe("narrow");
  });

  test("content is never drawn wider than 96 columns", () => {
    expect(MAX_COLUMNS).toBe(96);
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

  test("the line leads with how to focus, then this tab's keys, a divider and the global pair", () => {
    const keys = keyLine("hints");
    expect(keyLineText(200, false, keys)).toBe("ctrl+x then tab to focus \u{b7} s span  r repo \u{2503} 1-5,0 tab  esc fold");
    expect(keyLineText(200, true, keys)).toBe("keys active \u{b7} s span  r repo \u{2503} 1-5,0 tab  esc fold");
    // A tab with no keys of its own has only the pair.
    expect(keyLineText(200, true, keyLine("help"))).toBe("keys active \u{b7} 1-5,0 tab  esc fold");
  });

  test("narrow, keys drop by priority: esc first, then the tab's own keys from the last, the tab switch last", () => {
    const keys = keyLine("hints", { evidence: true, adopt: true });
    const widths = [90, 70, 60, 50, 44, 40];
    const lines = widths.map((w) => keyLineText(w, true, keys));
    for (let i = 0; i < widths.length; i++) expect(lines[i]!.length).toBeLessThanOrEqual(widths[i]!);
    // At the width where esc no longer fits, the tab's own keys and the switch remain.
    const noEsc = lines.find((l) => !l.includes("esc fold") && l.includes("s span"));
    expect(noEsc).toBeDefined();
    expect(noEsc).toContain("1-5,0 tab");
    // Smaller still: own keys go from the last, and the switch is the last to leave.
    expect(keyLineText(33, true, keys)).toBe("keys active \u{b7} s span \u{2503} 1-5,0 tab");
    expect(keyLineText(28, true, keys)).toBe("keys active \u{b7} 1-5,0 tab");
    expect(keyLineText(10, true, keys)).toBe("keys active");
    // An entry is whole or absent.
    for (const l of lines) expect(l).not.toMatch(/tab\/e$|evide$/);
  });

  test("the runs name each key (drawn bold) apart from its words (dim)", () => {
    const runs = keyLineRuns(200, true, keyLine("usage"));
    expect(runs.filter((r) => r.role === "key").map((r) => r.text)).toEqual(["s", "1-5,0", "esc"]);
    expect(runs.map((r) => r.text).join("")).toBe(keyLineText(200, true, keyLine("usage")));
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
    // No seconds: under a minute is `<1m`, then whole minutes.
    expect(leftText(45_000)).toBe("<1m");
    expect(leftText(0)).toBe("<1m");
    expect(leftText(60_000)).toBe("1m");
    expect(leftText(125_000)).toBe("2m");
    expect(leftText(299_000)).toBe("4m");
    expect(leftText(42 * 60_000)).toBe("42m");
    expect(leftText(80 * 60_000)).toBe("1h 20m");
    expect(tokensText(236_000)).toBe("236k");
    expect(tokensText(1_000_000)).toBe("1M");
    expect(tokensText(1_250_000)).toBe("1.25M");
    // Three significant digits: a count that rounds up to 1000 steps to the next unit.
    expect(tokensText(842)).toBe("842");
    expect(tokensText(4200)).toBe("4.2k");
    expect(tokensText(329_400_000)).toBe("329M");
    expect(tokensText(32_900_000)).toBe("32.9M");
    expect(tokensText(999_994_000)).toBe("1B");
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
    expect(lines[0]).toBe("$5.05 session \u{b7} 2 sub-agents");
    expect(lines[1]).toBe("ctx 236k (24%) \u{b7} 5h 6% \u{b7} 7d 22%");
    expect(lines.some((l) => l.startsWith("cache 42m"))).toBe(true);
    for (const l of glanceLines(dataOf(), 20)) expect(l.length).toBeLessThanOrEqual(20);
  });

  test("the foot has the cache row with its refill price, context with compact threshold, and each limit", () => {
    const rows = footRows(dataOf(), false);
    expect(rows.map((r) => r.label)).toEqual(["Cache", "Context", "", "Limits", ""]);
    expect(rows[0]!.figure).toBe("$0.45");
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
