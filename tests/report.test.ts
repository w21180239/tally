import type { On, RenderInput, TurnStepResult, TurnUsage } from "claude-code";
import type { Engine } from "claude-code/testing";
import { describe, expect, mock, test } from "claude-code/testing";
import { HINT_RULES } from "../core/hint.ts";
import type { Hint, HintInput, HintRule } from "../core/hint.ts";
import { BUILTIN_PRICES } from "../core/prices.builtin.ts";
import type { Shard } from "../core/shard.ts";
import { summarize } from "../core/summary.ts";
import type { Summary } from "../core/summary.ts";
import type { MetaRow, UsageRow, UserRow } from "../core/types.ts";
import { REPORT_TOOL_FULL, argsOf, clampDays, resetSnapshots } from "../engine/report-tool.ts";
import { dayIdx, saveBuckets } from "../engine/project-store.ts";
import { BASELINE_KEY, baselineOf, buildReport, parseBaseline, runRateOf, snapshotJson } from "../report/build.ts";
import type { Baseline, Report } from "../report/build.ts";
import { renderMarkdown } from "../report/markdown.ts";
import { req } from "./fixtures/rows.ts";
import { worldOf } from "./world.ts";
import type { World } from "./world.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 27, 12);
const TZ = -new Date(NOW).getTimezoneOffset();
const CWD = "/work/demo";
const CFG = "/home/u/.claude";
const OPUS = "claude-opus-5-5";

const at = <U extends { ts: number }>(row: U, ts: number): U => ({ ...row, ts });
const ago = (d: number): number => NOW - d * DAY;

// One request on `d` days ago, a fixed token mix so every one costs the same.
const usageRow = (id: string, d: number, session = "s-1"): UsageRow => at(req({ id, at: 0, session, cwd: CWD, tokens: { input: 1000, output: 100_000, cacheRead: 100_000 } }), ago(d));
const shardOf = (rows: UsageRow[]): Shard => ({ v: 1, project: "-work-demo", files: {}, usage: rows, users: [] as UserRow[], metas: [], compacts: [], snapshots: [] });
const summaryOf = (rows: UsageRow[], span: "24h" | "30d" = "30d", metas: MetaRow[] = []): Summary => summarize([{ ...shardOf(rows), metas }], BUILTIN_PRICES, { span, nowMs: NOW, tzOffsetMin: TZ, usage: true });
const inputOf = (summary: Summary): HintInput => ({ scope: "span", summary, snaps: [], plugins: [], prices: BUILTIN_PRICES, nowMs: NOW });
const OPTS = { days: 30, compare: false };
const unit = summaryOf([usageRow("a", 3)]).total.usd;

// A rule that always fires, for evidence that no real rule shows on demand; the rule list is shared, so it is removed again.
const stub = (evidence: Hint["evidence"]): HintRule => ({
  id: "stub-rule",
  run: () => [{ rule: "stub-rule", title: "Stub title", usd: 1.5, summary: "Stub summary.", action: "Stub action.", evidence, short: "stub" }],
});
async function withRule<T>(rule: HintRule, f: () => Promise<T>): Promise<T> {
  HINT_RULES.push(rule);
  try {
    return await f();
  } finally {
    HINT_RULES.splice(HINT_RULES.indexOf(rule), 1);
  }
}

describe("buildReport", () => {
  test("evidence is always redacted: a command keeps its program, a path its file name, a title nothing", async () => {
    const rule = stub([
      { label: "Command", detail: "TOKEN=abc sudo -E /usr/local/bin/curl -H 'x: secret' https://example.test/path", kind: "command" },
      { label: "File", detail: "/home/someone/secret-project/notes.txt", kind: "path" },
      { label: "Prompt", detail: "my private prompt text", kind: "title" },
      { label: "Count", detail: "3 reads", kind: "text" },
    ]);
    const report = await withRule(rule, () => buildReport(inputOf(summaryOf([usageRow("a", 1)])), OPTS));
    const h = report.hints.find((x) => x.rule === "stub-rule")!;
    expect(h.evidence.map((e) => e.detail)).toEqual(["curl", "notes.txt", "", "3 reads"]);
    const md = renderMarkdown(report);
    for (const leak of ["secret", "TOKEN", "example.test", "someone", "private prompt"]) expect(md).not.toContain(leak);
    expect(md).toContain("- Command: curl");
  });

  test("compare needs both a baseline and a run rate; without a baseline the report holds neither", async () => {
    const s = summaryOf([usageRow("a", 3)]);
    const baseline: Baseline = { at: ago(10), runRate: 100, perHint: [] };
    const both = await buildReport(inputOf(s), { ...OPTS, compare: true, baseline, runRate: 40 });
    expect(both.compare).toEqual({ runRate: 40, baselineRunRate: 100 });
    expect(both.baseline).toEqual(baseline);
    const none = await buildReport(inputOf(s), { ...OPTS, compare: true, runRate: 40 });
    expect(none.compare).toBeUndefined();
    expect(none.baseline).toBeUndefined();
    const off = await buildReport(inputOf(s), { ...OPTS, baseline, runRate: 40 });
    expect(off.compare).toBeUndefined();
  });
});

describe("runRateOf", () => {
  test("the last 14 complete days times 30 over 14; today and older days stay out", () => {
    // Today (0), 1..14 days ago in the window, 15 and 16 days ago outside the 14.
    const rows = [usageRow("t1", 0), usageRow("t2", 0), ...Array.from({ length: 14 }, (_, i) => usageRow(`d${i + 1}`, i + 1)), usageRow("o1", 15), usageRow("o2", 16)];
    const s = summaryOf(rows);
    const per = unit;
    expect(Math.abs(runRateOf(s) - (14 * per * 30) / 14)).toBeLessThan(1e-9);
  });

  test("a quiet fortnight is zero; hourly buckets are not a run rate", () => {
    expect(runRateOf(summaryOf([usageRow("a", 20)]))).toBe(0);
    expect(runRateOf(summaryOf([usageRow("a", 0.1)], "24h"))).toBe(0);
  });
});

describe("baseline records", () => {
  test("baselineOf keeps the hints that carry a dollar figure", () => {
    const hints = [{ rule: "a", usd: 2 }, { rule: "b", usd: 0 }, { rule: "c", usd: 1.25 }] as Hint[];
    expect(baselineOf(7, 12.5, hints)).toEqual({ at: 7, runRate: 12.5, perHint: [{ rule: "a", expectedUsd: 2 }, { rule: "c", expectedUsd: 1.25 }] });
  });

  test("parseBaseline drops malformed entries and malformed records", () => {
    expect(parseBaseline({ at: 1, runRate: 2, perHint: [{ rule: "a", expectedUsd: 3 }, { rule: 4 }, null] })).toEqual({ at: 1, runRate: 2, perHint: [{ rule: "a", expectedUsd: 3 }] });
    expect(parseBaseline(undefined)).toBeUndefined();
    expect(parseBaseline({ at: "x", runRate: 2, perHint: [] })).toBeUndefined();
    expect(parseBaseline({ at: 1, runRate: 2 })).toBeUndefined();
  });
});

const HEADINGS = ["## Summary", "## Tables", "## Drivers", "## Baseline comparison", "## Confidence"];

describe("renderMarkdown", () => {
  test("holds the five sections in order", async () => {
    const md = renderMarkdown(await buildReport(inputOf(summaryOf([usageRow("a", 2)])), OPTS));
    const at = HEADINGS.map((h) => md.indexOf(`\n${h}\n`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  test("an empty window still renders every section", async () => {
    const md = renderMarkdown(await buildReport(inputOf(summaryOf([])), OPTS));
    for (const h of HEADINGS) expect(md).toContain(h);
    expect(md).toContain("No requests in the window.");
  });

  test("compare with a baseline prints the run rate before and after, and the change", async () => {
    const s = summaryOf([usageRow("a", 3)]);
    const now = runRateOf(s);
    const baseline: Baseline = { at: ago(10), runRate: now * 2, perHint: [{ rule: "cache-rebuilt", expectedUsd: 4.5 }] };
    const md = renderMarkdown(await buildReport(inputOf(s), { ...OPTS, compare: true, baseline, runRate: now }));
    const money = (n: number) => `$${n.toFixed(2)}`;
    expect(md).toContain(`| Baseline (2026-11-17) | ${money(now * 2)} |`);
    expect(md).toContain(`| Now | ${money(now)} |`);
    expect(md).toContain(`| Change | -${money(now)} (-50%) |`);
    expect(md).toContain("| cache-rebuilt | $4.50 |");
  });

  test("without compare the baseline section says there is none", async () => {
    const md = renderMarkdown(await buildReport(inputOf(summaryOf([usageRow("a", 3)])), OPTS));
    expect(md).toContain("No baseline compared.");
    expect(md).not.toContain("Run rate per 30 days");
  });

  test("session titles stay out of the tables", async () => {
    const s = summaryOf([usageRow("a", 3)], "30d", [{ sessionId: "s-1", key: "ai-title", value: "Quarterly secret roadmap" }]);
    expect(s.topSessions[0]?.title).toBeDefined();
    expect(renderMarkdown(await buildReport(inputOf(s), OPTS))).not.toContain("roadmap");
  });

  test("table cells escape a pipe in a repository name", async () => {
    const s = summaryOf([usageRow("a", 3)]);
    s.byRepo["a|b"] = s.byRepo["demo"]!;
    expect(renderMarkdown(await buildReport(inputOf(s), OPTS))).toContain("| a\\|b |");
  });

  test("unread projects and unpriced models lower the confidence", async () => {
    const s = summaryOf([usageRow("a", 3)]);
    const md = renderMarkdown(await buildReport(inputOf({ ...s, unpriced: ["mystery-model"] }), { ...OPTS, unread: 2 }));
    expect(md).toContain("Overall: low.");
    expect(md).toContain("2 projects not indexed yet");
    expect(md).toContain("mystery-model");
  });
});

describe("snapshotJson", () => {
  const big = async (): Promise<Report> => {
    const r = await buildReport(inputOf(summaryOf([usageRow("a", 2)])), OPTS);
    r.summary.topSessions = Array.from({ length: 20 }, (_, i) => ({ sessionId: `s${i}`, repo: "demo", title: "t".repeat(2000), pr: "p", started: i, usd: 20 - i, resume: "r".repeat(2000) }));
    return r;
  };

  test("a report that fits is written whole", async () => {
    const r = await big();
    expect(snapshotJson(r)).toBe(JSON.stringify(r));
  });

  test("over the limit the top sessions lose their detail first, then go; spend and hints stay", async () => {
    const r = await big();
    const whole = JSON.stringify(r).length;
    const slim = JSON.parse(snapshotJson(r, whole - 1)!) as Report;
    expect(slim.summary.topSessions.length).toBe(20);
    expect(Object.keys(slim.summary.topSessions[0]!).sort()).toEqual(["repo", "sessionId", "started", "usd"]);
    expect(slim.summary.total.usd).toBe(r.summary.total.usd);
    const none = JSON.parse(snapshotJson(r, JSON.stringify(slim).length - 1)!) as Report;
    expect(none.summary.topSessions).toEqual([]);
    expect(none.summary.total.usd).toBe(r.summary.total.usd);
    expect(none.hints.length).toBe(r.hints.length);
  });

  test("a limit nothing can meet gives null", async () => {
    expect(snapshotJson(await big(), 10)).toBeNull();
  });
});

describe("tool arguments", () => {
  test("argsOf keeps typed fields only; clampDays holds 1 to 30", () => {
    expect(argsOf({ days: 7, repo: " demo ", compare: true, saveBaseline: true, extra: 1 })).toEqual({ days: 7, repo: "demo", compare: true, saveBaseline: true });
    expect(argsOf({ days: "7", repo: 3, compare: "yes", saveBaseline: 1 })).toEqual({});
    expect(argsOf(undefined)).toEqual({});
    expect(argsOf({ adopt: [" fast-mode ", "fast-mode", "", 3, "long-session"] })).toEqual({ adopt: ["fast-mode", "long-session"] });
    expect(argsOf({ adopt: [] })).toEqual({});
    expect(argsOf({ adopt: "fast-mode" })).toEqual({});
    expect([undefined, 0, -4, 3.6, 99].map(clampDays)).toEqual([30, 1, 1, 4, 30]);
  });
});

// The plugin under test, driven through its hooks over an in-memory home.
describe("thinking-output effort floor", () => {
  const thinking = HINT_RULES.find((h) => h.id === "thinking-output")!;
  const at = (effort: string | undefined): UsageRow[] => [usageRow("a", 3), usageRow("b", 20)].map((r) => (effort === undefined ? r : { ...r, effort }));
  test("no lower-effort advice when most requests already ran at medium or below; the spend is still summed", () => {
    for (const effort of ["medium", "low"]) {
      const s = summaryOf(at(effort));
      expect(s.byEffort?.[effort]?.requests).toBe(2);
      expect(thinking.run(inputOf(s))).toEqual([]);
    }
  });
  test("above medium, or with no effort recorded, the hint stays", () => {
    expect(thinking.run(inputOf(summaryOf(at("high"))))).toHaveLength(1);
    expect(thinking.run(inputOf(summaryOf(at(undefined))))).toHaveLength(1);
  });
});

const PLUGIN = "tally";
const PANE: Omit<RenderInput<"Pane">, "surface"> = {
  component: "Pane",
  requestId: PLUGIN,
  viewport: { columns: 200, rows: 80, isFullscreen: true },
  props: { title: "tally", isFocused: true, bodyColumns: 120, placement: "dock", scroll: { offset: 0, bodyRows: 160 }, view: {} },
};
void PANE;

type Rig = { world: World; clock: ReturnType<typeof mock.clock>; stored: Map<string, unknown>; registered: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }> };

const usageOf = (): TurnUsage => ({ input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 10_000, model: OPUS, ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 10_000 });

function rig(on: On): Rig {
  resetSnapshots();
  const world = worldOf();
  const r: Rig = { world, clock: mock.clock(on, { now: NOW }), stored: new Map(), registered: [] };
  mock.env(on, { HOME: "/home/u" });
  on("store.get", (_, e) => ({ value: r.stored.get(e.key) }));
  on("store.set", (_, e) => {
    r.stored.set(e.key, e.value);
    return { value: undefined };
  });
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("session.end", (_, e) => ({ sessionId: e.sessionId }));
  on("session.measure", (_, e) => ({ changed: e.changed }));
  on("command.register", (_, e) => ({ value: { command: e.name } }));
  on("tool.register", (_, e) => {
    r.registered.push(e as never);
    return { value: { tool: REPORT_TOOL_FULL } };
  });
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("ui.close", () => ({ value: undefined }));
  on("ui.toast", () => ({ value: undefined }));
  on("ui.log", () => ({ value: undefined }));
  on("ui.invalidate", () => ({ value: undefined }));
  on("ui.panes", () => ({ value: [] }));
  on("session.id", () => ({ value: "s-1" }));
  on("session.cwd", () => ({ value: CWD }));
  on("session.model", () => ({ value: OPUS }));
  on("session.info", () => ({ value: { platform: "linux" } }));
  on("session.usage", () => ({ value: { startedAt: NOW, context: { tokens: 236_000, window: 1_000_000, percent: 24 }, rateLimits: [], cost: { usd: 0 } } as never }));
  on("fs.read", async (_, e) => ({ value: await world.$.fs.read(e.path, { as: e.as, offset: e.offset, length: e.length } as never) }));
  on("fs.write", async (_, e) => ({ value: await world.$.fs.write(e.path, e.text) }));
  on("fs.list", async (_, e) => ({ value: await world.$.fs.list(e.path) }));
  on("fs.exists", async (_, e) => ({ value: await world.$.fs.exists(e.path) }));
  on("fs.stat", async (_, e) => ({ value: await world.$.fs.stat(e.path) }));
  on("config.list", () => ({ value: [] }));
  on("turn.start", (_, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_, e) => ({ text: e.answer }));
  on("prompt.submit", (_, e) => ({ text: e.text }));
  on("turn.step", async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: "", toolUses: [], stopReason: "end_turn", usage: usageOf() } as TurnStepResult;
  });
  return r;
}

async function seed(w: World, rows: UsageRow[]): Promise<void> {
  const byDay = new Map<number, Shard>();
  for (const row of rows) {
    const d = dayIdx(row.ts);
    const sh = byDay.get(d) ?? shardOf([]);
    byDay.set(d, sh);
    sh.usage.push(row);
  }
  await saveBuckets(w.$, CFG, "-work-demo", { days: byDay }, {}, NOW);
  w.put(`${CFG}/projects/-work-demo/s-1.jsonl`, "");
}

const start = ($: Engine) => $.session.start({ cwd: CWD, surface: "terminal", isInteractive: true });
const call = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: REPORT_TOOL_FULL, ...input } as never) as Promise<{ result?: unknown; deny?: string }>;
const run = (args: string) => ({ command: "tally", args, origin: { kind: "composer" as const }, presentation: { isFullscreen: true, columns: 200 } });
const textOf = (r: { result?: unknown }): string => String(r.result);

// One request half an hour ago keeps the 24h window busy and sits in today's bucket; the others sit 3 and 20 days back.
const rowsOf = (): UsageRow[] => [usageRow("a", 3), usageRow("b", 20), usageRow("c", 0.02)];

describe("the tally_report tool", () => {
  test("is declared at session start with its five parameters", async ($, on) => {
    const r = rig(on);
    await start($);
    expect(r.registered.map((t) => t.name)).toEqual(["tally_report"]);
    const props = (r.registered[0]!.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props).sort()).toEqual(["adopt", "compare", "days", "repo", "saveBaseline"]);
  });

  test("answers with the markdown report", async ($, on) => {
    const r = rig(on);
    await seed(r.world, rowsOf());
    await start($);
    const out = textOf(await call($, { days: 7 }));
    for (const h of HEADINGS) expect(out).toContain(h);
    expect(out).toContain("(7 days)");
    expect(out).toContain("2 requests");
  });

  test("a repository filter limits the report; an unknown one says so", async ($, on) => {
    const r = rig(on);
    await seed(r.world, rowsOf());
    await start($);
    expect(textOf(await call($, { repo: "demo" }))).toContain("3 requests");
    const none = textOf(await call($, { repo: "other" }));
    expect(none).toContain("No requests matched repository other");
  });

  test("saveBaseline stores the pace plus each hint's expected saving; compare then reads them", async ($, on) => {
    const r = rig(on);
    await seed(r.world, rowsOf());
    await start($);
    const saved = textOf(await call($, { saveBaseline: true }));
    expect(saved).toContain("Baseline saved:");
    const stored = r.stored.get(BASELINE_KEY) as Baseline;
    // The 3-day-old request is the only one among the last 14 complete days.
    expect(Math.abs(stored.runRate - (unit * 30) / 14)).toBeLessThan(1e-9);
    expect(stored.at).toBe(NOW);
    expect(Array.isArray(stored.perHint)).toBe(true);
    const cmp = textOf(await call($, { compare: true, days: 7 }));
    expect(cmp).toContain(`| Baseline (2026-11-27) | $${((unit * 30) / 14).toFixed(2)} |`);
    expect(cmp).toContain("| Change | +$0.00");
  });

  test("compare with nothing saved says there is no baseline", async ($, on) => {
    const r = rig(on);
    await seed(r.world, rowsOf());
    await start($);
    expect(textOf(await call($, { compare: true }))).toContain("No baseline compared.");
    expect(r.stored.has(BASELINE_KEY)).toBe(false);
  });
});

// The seeded rows give the thinking-output rule a hint: all of the output cost is thinking, and it has a metric.
const adoptionsOf = (r: Rig): Array<{ rule: string; at: number; metricName?: string; before?: number; expectedUsd: number }> => (r.stored.get("adoptions") as never) ?? [];

describe("the tally_report adopt parameter", () => {
  test("records an adoption for each flagged rule, with its metric and expected saving", async ($, on) => {
    const r = rig(on);
    await seed(r.world, rowsOf());
    await start($);
    const out = textOf(await call($, { adopt: ["thinking-output"] }));
    expect(out).toContain("Adopted: thinking-output.");
    const [a, ...rest] = adoptionsOf(r);
    expect(rest).toEqual([]);
    expect(a).toMatchObject({ rule: "thinking-output", at: NOW, metricName: "thinking share of output cost" });
    expect(Math.abs(a!.before! - 1)).toBeLessThan(1e-6);
    expect(Math.abs(a!.expectedUsd - 6)).toBeLessThan(1e-6);
  });

  test("an unknown id and an unflagged rule are skipped and named", async ($, on) => {
    const r = rig(on);
    await seed(r.world, rowsOf());
    await start($);
    expect(HINT_RULES.find((h) => h.id === "fast-mode")!.run(inputOf(summaryOf(rowsOf())))).toEqual([]);
    const out = textOf(await call($, { adopt: ["no-such-rule", "fast-mode", "thinking-output"] }));
    expect(out).toContain("Adopted: thinking-output.");
    expect(out).toContain("Skipped, unknown rule: no-such-rule.");
    expect(out).toContain("Skipped, not flagged over 30 days: fast-mode.");
    expect(adoptionsOf(r).map((a) => a.rule)).toEqual(["thinking-output"]);
  });

  test("nothing adoptable records nothing", async ($, on) => {
    const r = rig(on);
    await seed(r.world, rowsOf());
    await start($);
    const out = textOf(await call($, { adopt: ["no-such-rule"] }));
    expect(out).toContain("Adopted: none.");
    expect(r.stored.has("adoptions")).toBe(false);
  });

  test("adopt and saveBaseline in one call write both, over the whole 30 days even for a narrower report", async ($, on) => {
    const r = rig(on);
    await seed(r.world, rowsOf());
    await start($);
    const out = textOf(await call($, { days: 7, repo: "demo", saveBaseline: true, adopt: ["thinking-output"] }));
    expect(out).toContain("Baseline saved:");
    expect(out).toContain("Adopted: thinking-output.");
    // The 7-day report holds two requests ($4); the baseline and the adoption both see all three ($6).
    const per = (r.stored.get(BASELINE_KEY) as Baseline).perHint.find((h) => h.rule === "thinking-output")!;
    expect(Math.abs(per.expectedUsd - 6)).toBeLessThan(1e-6);
    expect(Math.abs(adoptionsOf(r)[0]!.expectedUsd - 6)).toBeLessThan(1e-6);
  });

  test("adopting a rule again replaces its record", async ($, on) => {
    const r = rig(on);
    await seed(r.world, rowsOf());
    await start($);
    await call($, { adopt: ["thinking-output"] });
    await call($, { adopt: ["thinking-output"] });
    expect(adoptionsOf(r)).toHaveLength(1);
  });
});

describe("report text for the skill", () => {
  test("each hint names its rule id, and Confidence states the price table and its date", async ($, on) => {
    const r = rig(on);
    await seed(r.world, rowsOf());
    await start($);
    const out = textOf(await call($, {}));
    expect(out).toContain("Rule: thinking-output");
    expect(out).toMatch(/- Price table: built-in \(\d{4}-\d{2}-\d{2}\)\./);
  });
});

describe("/tally report", () => {
  test("writes api-spend-<date>.md in the session folder and names it", async ($, on) => {
    const r = rig(on);
    await seed(r.world, rowsOf());
    await start($);
    const out = (await $.command.run(run("report 7 demo"))).text;
    const date = new Date(NOW - new Date(NOW).getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
    expect(out).toBe(`Wrote ${CWD}/api-spend-${date}.md.`);
    const md = r.world.text(`${CWD}/api-spend-${date}.md`)!;
    for (const h of HEADINGS) expect(md).toContain(h);
    expect(md).toContain("repository demo");
    expect(md).toContain("2 requests");
  });
});

const pick = (obj: unknown, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);

describe("report snapshots", () => {
  test("a finished scan writes report-24h.json and report-30d.json with the fields the Herdr mod reads", async ($, on) => {
    const r = rig(on);
    await seed(r.world, rowsOf());
    await start($);
    await r.clock.advance(1_000);
    await r.clock.settle();
    for (const [span, requests] of [["24h", 1], ["30d", 3]] as const) {
      const text = r.world.text(`${CFG}/tally/report-${span}.json`);
      expect(text).toBeDefined();
      const snap = JSON.parse(text!) as Report;
      expect(snap.span).toBe(span);
      expect(pick(snap, "generatedAt") as number).toBeGreaterThanOrEqual(NOW);
      expect(pick(snap, "generatedAt") as number).toBeLessThan(NOW + 60_000);
      expect(pick(snap, "summary.total.requests")).toBe(requests);
      expect(typeof pick(snap, "summary.total.usd")).toBe("number");
      expect(pick(snap, "summary.total.usd")).toBeGreaterThan(0);
      expect(typeof pick(snap, "summary.main.usd")).toBe("number");
      expect(typeof pick(snap, "summary.sub.usd")).toBe("number");
      expect(typeof pick(snap, `summary.byModel.${OPUS}.usd`)).toBe("number");
      expect(typeof pick(snap, "summary.byRepo.demo.usd")).toBe("number");
      expect(Array.isArray(pick(snap, "hints"))).toBe(true);
      for (const h of snap.hints) {
        expect(typeof h.title).toBe("string");
        expect(typeof h.usd).toBe("number");
        expect(typeof h.summary).toBe("string");
        expect(typeof h.action).toBe("string");
      }
    }
  });

  test("the owner's beat refreshes both files when no scan has finished", async ($, on) => {
    const r = rig(on);
    await seed(r.world, rowsOf());
    await start($);
    await r.clock.advance(1_000);
    await r.clock.settle();
    const first = JSON.parse(r.world.text(`${CFG}/tally/report-30d.json`)!).generatedAt as number;
    expect(first).toBeGreaterThanOrEqual(NOW);
    // The owner's beat refreshes the sliding 24h window even when a scan found nothing new.
    await r.clock.advance(650_000);
    await r.clock.settle();
    expect(JSON.parse(r.world.text(`${CFG}/tally/report-24h.json`)!).generatedAt).toBeGreaterThan(first);
  });
});
