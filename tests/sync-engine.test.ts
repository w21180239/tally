import type { On, RenderInput, TurnStepResult, TurnUsage } from "claude-code";
import type { Engine } from "claude-code/testing";
import { describe, expect, mock, test } from "claude-code/testing";
import { costOf } from "../core/pricing.ts";
import { BUILTIN_PRICES } from "../core/prices.builtin.ts";
import { formatMoney } from "../core/money.ts";
import { DEFAULT_SETTINGS } from "../core/settings.ts";
import type { Shard } from "../core/shard.ts";
import { MACHINE_FILE_MAX, encodeMachineFile, parseMachineFile, repoAlias } from "../core/sync.ts";
import type { HourCell, MachineFile } from "../core/sync.ts";
import type { UsageRow } from "../core/types.ts";
import { dayIdx, saveBuckets } from "../engine/project-store.ts";
import { SYNC_GAP_MS, machineNameOf, newSalt, safeMachineName } from "../engine/sync.ts";
import { req } from "./fixtures/rows.ts";
import { posixPath, worldOf } from "./world.ts";
import type { World } from "./world.ts";

const PLUGIN = "tally";
const NOW = Date.UTC(2026, 10, 27, 12);
// Real repo names that must never reach a numbers file.
const REPO = "zq-secret-repo";
const CWD = `/work/${REPO}`;
const CFG = "/home/u/.claude";
const SYNC = "/sync";
const OPUS = "claude-opus-5-5";
const DAY = 86_400_000;
const HOUR = 3_600_000;

const PANE: Omit<RenderInput<"Pane">, "surface"> = {
  component: "Pane",
  requestId: PLUGIN,
  viewport: { columns: 200, rows: 60, isFullscreen: true },
  props: { title: "tally", isFocused: true, bodyColumns: 89, placement: "dock", scroll: { offset: 0, bodyRows: 120 }, view: {} },
};
const TEXT = (re: RegExp) => ({ type: "Text" as const, text: re });
const money = (usd: number): string => formatMoney(usd, DEFAULT_SETTINGS.money, DEFAULT_SETTINGS.decimals);
const exact = (s: string): RegExp => new RegExp(`^${s.replace(/[$.*+?^${}()|[\]\\]/g, "\\$&")}$`);

// What the host's git answers, by the subcommand after `-C <dir>`.
type Git = Partial<Record<"pull" | "add" | "commit" | "push", { exitCode: number; stdout?: string; stderr?: string }>>;
type Rig = { surface: string; world: World; clock: ReturnType<typeof mock.clock>; events: string[]; runs: string[][]; logs: string[]; toasts: string[]; git: Git; hidden: Set<string> };

const usageOf = (): TurnUsage => ({ input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 10_000, model: OPUS, ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 10_000 });

function rig(on: On): Rig {
  const world = worldOf();
  const r: Rig = { surface: "terminal", world, clock: mock.clock(on, { now: NOW }), events: [], runs: [], logs: [], toasts: [], git: {}, hidden: new Set() };
  const stored = new Map<string, unknown>();
  mock.env(on, { HOME: "/home/u" });
  on("store.get", (_, e) => ({ value: stored.get(e.key) }));
  on("store.set", (_, e) => {
    stored.set(e.key, e.value);
    return { value: undefined };
  });
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("session.end", (_, e) => ({ sessionId: e.sessionId }));
  on("session.measure", (_, e) => ({ changed: e.changed }));
  on("command.register", (_, e) => ({ value: { command: e.name } }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("ui.close", () => ({ value: undefined }));
  on("ui.toast", (_, e) => {
    r.toasts.push(e.text);
    return { value: undefined };
  });
  on("ui.log", (_, e) => {
    r.logs.push(e.text);
    return { value: undefined };
  });
  on("ui.invalidate", () => ({ value: undefined }));
  on("ui.panes", () => ({ value: [] }));
  on("session.id", () => ({ value: "s-1" }));
  on("session.cwd", () => ({ value: CWD }));
  on("session.model", () => ({ value: OPUS }));
  on("session.info", () => ({ value: { platform: "linux" } }));
  on("session.surfaces", () => ({ value: [r.surface] as never }));
  on("session.usage", () => ({ value: { startedAt: NOW, context: { tokens: 236_000, window: 1_000_000, percent: 24 }, rateLimits: [], cost: { usd: 0 } } as never }));
  on("fs.read", async (_, e) => ({ value: await world.$.fs.read(e.path, { as: e.as, offset: e.offset, length: e.length } as never) }));
  on("fs.write", async (_, e) => {
    if (posixPath(e.path).startsWith(`${SYNC}/`)) r.events.push(`write ${posixPath(e.path)}`);
    return { value: await world.$.fs.write(e.path, e.text) };
  });
  on("fs.list", async (_, e) => ({ value: await world.$.fs.list(e.path) }));
  on("fs.exists", async (_, e) => ({ value: !r.hidden.has(posixPath(e.path)) && (await world.$.fs.exists(e.path)) }));
  on("fs.stat", async (_, e) => ({ value: await world.$.fs.stat(e.path) }));
  on("process.run", (_, e) => {
    r.runs.push([...e.argv]);
    const sub = e.argv[0] === "git" ? (e.argv[3] as keyof Git) : undefined;
    if (sub !== undefined) r.events.push(`git ${sub}`);
    const out = sub === undefined ? undefined : r.git[sub];
    return { value: { exitCode: out?.exitCode ?? 0, stdout: out?.stdout ?? "", stderr: out?.stderr ?? "" } };
  });
  on("config.list", () => ({ value: [] }));
  on("turn.start", (_, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_, e) => ({ text: e.answer }));
  on("prompt.submit", (_, e) => ({ text: e.text }));
  on("turn.step", async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: "", toolUses: [], stopReason: "end_turn", usage: usageOf() } as TurnStepResult;
  });
  on("tool.call", () => ({ result: {}, text: "ok" }));
  return r;
}

const start = ($: Engine, r: Rig, surface: "terminal" | "desktop" = "terminal") => {
  r.surface = surface;
  return $.session.start({ cwd: CWD, surface, isInteractive: true });
};
const ago = (days: number, min = 0): number => NOW - days * DAY + min * 60_000;
const at = <T extends { ts: number }>(row: T, ts: number): T => ({ ...row, ts });

const demoUsage = (): UsageRow[] => [
  at(req({ id: "a", session: "s-1", cwd: `/work/${REPO}`, tokens: { input: 1000, output: 500, cacheRead: 100_000, cw5m: 20_000 } }), ago(1)),
  at(req({ id: "b", session: "s-1", cwd: `/work/${REPO}`, tokens: { cacheRead: 120_000 } }), ago(1, 1)),
];
const usdOf = (rows: UsageRow[]): number => rows.reduce((n, row) => n + costOf(row, BUILTIN_PRICES).usd, 0);

async function seedProject(w: World, project: string, usage: UsageRow[]): Promise<void> {
  const byDay = new Map<number, Shard>();
  for (const row of usage) {
    const d = dayIdx(row.ts);
    const sh = byDay.get(d) ?? { v: 1, project, files: {}, usage: [], users: [], metas: [], compacts: [], snapshots: [] };
    sh.usage.push(row);
    byDay.set(d, sh);
  }
  await saveBuckets(w.$, CFG, project, { days: byDay }, {}, NOW);
  w.put(`${CFG}/projects/${project}/${usage[0]!.sessionId}.jsonl`, "");
}

const utf8 = (s: string): number => new TextEncoder().encode(s).length;
const hour = (daysAgo: number): number => Math.floor((NOW - daysAgo * DAY) / HOUR);
const cellOf = (over: Partial<HourCell> = {}): HourCell => ({ h: hour(1), model: OPUS, repo: "r-aaaaaaaaaa", sub: null, fast: false, tokens: { input: 1_000_000, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0 }, usd: 7.25, requests: 3, ...over });
const remoteFile = (over: Partial<MachineFile> = {}): MachineFile => ({ v: 1, machine: "box-b", detail: "numbers", writtenAt: NOW, hours: [cellOf()], ...over });
const putRemote = (w: World, f: MachineFile): void => w.put(`${SYNC}/tally/${f.machine}.json`, encodeMachineFile(f));
const hintOf = (rule: string): { rule: string; title: string; usd: number; summary: string; action: string; evidence: []; short: string } => ({ rule, title: `Title of ${rule}`, usd: 2, summary: `Summary of ${rule}.`, action: `Action for ${rule}.`, evidence: [], short: rule });

const OPTS = { syncDir: SYNC, machineName: "box-a" };
// A sync folder that is a git repository.
const asRepo = (w: World): void => w.put(`${SYNC}/.git/HEAD`, "ref: refs/heads/main\n");

async function settled($: Engine, r: Rig, surface: "terminal" | "desktop" = "terminal"): Promise<void> {
  await seedProject(r.world, "-work-demo", demoUsage());
  await start($, r, surface);
  // The scanner starts after a short delay; its first pass ends a scan, which starts the sync.
  await r.clock.advance(1000);
  await r.clock.settle();
}

describe("names and salt", () => {
  test("a machine name keeps [A-Za-z0-9._-] and turns anything else into -", () => {
    expect(safeMachineName("Work Laptop/1")).toBe("Work-Laptop-1");
    expect(safeMachineName("box-a.local_2")).toBe("box-a.local_2");
    expect(safeMachineName("  ")).toBe("computer");
    expect(safeMachineName("..")).toBe("computer");
    expect(safeMachineName("a".repeat(100)).length).toBe(64);
  });

  test("a salt is 32 random bytes as hex, from crypto when there is one and from Math.random and SHA-256 when there is not", () => {
    const viaCrypto = newSalt("seed", { getRandomValues: (a) => a.fill(171) });
    expect(viaCrypto).toBe("ab".repeat(32));
    const a = newSalt("seed", null, () => 0.25);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(newSalt("seed", null, () => 0.25)).toBe(a);
    expect(newSalt("seed", null, () => 0.5)).not.toBe(a);
    expect(newSalt("other", null, () => 0.25)).not.toBe(a);
    expect(newSalt("x")).toMatch(/^[0-9a-f]{64}$/);
    expect(newSalt("x")).not.toBe(newSalt("x"));
  });

  type Host = Parameters<typeof machineNameOf>[0];
  const fake = (env: Record<string, string>, o: { stdout?: string; stored?: string; surfaces?: string[] } = {}) => {
    const runs: string[][] = [];
    const store = new Map<string, unknown>(o.stored === undefined ? [] : [["machineName", o.stored]]);
    const $ = {
      env: { get: async (n: string) => env[n] },
      session: { surfaces: async () => o.surfaces ?? ["terminal"] },
      store: { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => void store.set(k, v) },
      process: {
        run: async (argv: readonly string[]) => {
          runs.push([...argv]);
          return { exitCode: 0, stdout: o.stdout ?? "", stderr: "" };
        },
      },
    };
    return { $: $ as unknown as Host, runs, store };
  };

  test("the machine name is the setting, then COMPUTERNAME, then HOSTNAME, then `hostname` under the CLI", async () => {
    expect(await machineNameOf(fake({ COMPUTERNAME: "WIN-1", HOSTNAME: "h" }).$, { machineName: "Mine Box" })).toBe("Mine-Box");
    expect(await machineNameOf(fake({ COMPUTERNAME: "WIN 1", HOSTNAME: "h" }).$, { machineName: "" })).toBe("WIN-1");
    const viaHostname = fake({ HOSTNAME: "linux-box" });
    expect(await machineNameOf(viaHostname.$, { machineName: "" })).toBe("linux-box");
    expect(viaHostname.runs).toEqual([]);
    const viaProcess = fake({}, { stdout: "mac book.local\n" });
    expect(await machineNameOf(viaProcess.$, { machineName: "" })).toBe("mac-book.local");
    expect(viaProcess.runs).toEqual([["hostname"]]);
    // The name found is kept, so a surface without `hostname` names this computer alike.
    expect(viaProcess.store.get("machineName")).toBe("mac-book.local");
  });

  test("a name kept from an earlier session beats a fresh hostname, so a rename does not orphan the machine file; the setting still wins", async () => {
    const renamed = fake({ HOSTNAME: "new-host" }, { stored: "old-host" });
    expect(await machineNameOf(renamed.$, { machineName: "" })).toBe("old-host");
    expect(renamed.store.get("machineName")).toBe("old-host");
    expect(renamed.runs).toEqual([]);
    expect(await machineNameOf(fake({ HOSTNAME: "new-host" }, { stored: "old-host" }).$, { machineName: "pinned" })).toBe("pinned");
  });

  test("outside the CLI `hostname` is never run: the name kept by an earlier session is used, else a fixed one", async () => {
    const kept = fake({}, { stdout: "ignored", stored: "kept-name", surfaces: ["desktop"] });
    expect(await machineNameOf(kept.$, { machineName: "" })).toBe("kept-name");
    expect(kept.runs).toEqual([]);
    const none = fake({}, { stdout: "ignored", surfaces: ["desktop"] });
    expect(await machineNameOf(none.$, { machineName: "" })).toBe("computer");
    expect(none.runs).toEqual([]);
  });
});

describe("runSync", () => {
  test("on a non-CLI surface $.process.run is never called, yet the file and the salt are written", { options: { ...OPTS } }, async ($, on) => {
    const r = rig(on);
    asRepo(r.world);
    await settled($, r, "desktop");
    expect(r.runs).toEqual([]);
    const file = parseMachineFile(r.world.text(`${SYNC}/tally/box-a.json`) ?? "");
    expect(file?.machine).toBe("box-a");
    expect(file?.hours.length).toBeGreaterThan(0);
    expect(r.world.text(`${SYNC}/tally/salt`)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("under the CLI a git repository gets pull --rebase, the write, then add, commit and push, as argv arrays", { options: { ...OPTS } }, async ($, on) => {
    const r = rig(on);
    asRepo(r.world);
    await settled($, r);
    expect(r.runs).toEqual([
      ["git", "-C", SYNC, "pull", "--rebase"],
      ["git", "-C", SYNC, "add", "tally"],
      ["git", "-C", SYNC, "commit", "-m", "tally: box-a", "--", "tally"],
      ["git", "-C", SYNC, "push"],
    ]);
    // Our files are written between the pull and the add.
    const order = r.events.map((e) => e.split(" ")[0] === "git" ? e : "write");
    expect(order.indexOf("git pull")).toBeLessThan(order.indexOf("write"));
    expect(order.lastIndexOf("write")).toBeLessThan(order.indexOf("git add"));
    expect(order.indexOf("git add")).toBeLessThan(order.indexOf("git commit"));
    expect(order.indexOf("git commit")).toBeLessThan(order.indexOf("git push"));
  });

  test("a folder that is not a git repository gets the file and no git", { options: { ...OPTS } }, async ($, on) => {
    const r = rig(on);
    await settled($, r);
    expect(r.runs).toEqual([]);
    expect(r.world.text(`${SYNC}/tally/box-a.json`)).toBeDefined();
  });

  test("/tally sync runs one sync now and names the machines it saw", { options: { ...OPTS } }, async ($, on) => {
    const r = rig(on);
    putRemote(r.world, remoteFile());
    await seedProject(r.world, "-work-demo", demoUsage());
    await start($, r);
    // The sync's time slicing sleeps on the manual clock, so the clock is driven until the command answers.
    const asked = $.command.run({ command: "tally", args: "sync", origin: { kind: "composer" }, presentation: { isFullscreen: true, columns: 200 } });
    await r.clock.advance(1000);
    await r.clock.settle();
    const out = await asked;
    expect(r.world.text(`${SYNC}/tally/box-a.json`)).toBeDefined();
    expect(out.text).toContain("box-a");
    expect(out.text).toContain("box-b");
  });

  test("/tally sync with no sync folder says so and writes nothing", { options: { syncDir: "", machineName: "box-a" } }, async ($, on) => {
    const r = rig(on);
    await start($, r);
    const out = await $.command.run({ command: "tally", args: "sync", origin: { kind: "composer" }, presentation: { isFullscreen: true, columns: 200 } });
    expect(out.text).toContain("syncDir");
    expect(r.events).toEqual([]);
  });

  test("with syncDir empty nothing is written and nothing runs", { options: { syncDir: "", machineName: "box-a" } }, async ($, on) => {
    const r = rig(on);
    await settled($, r);
    expect(r.runs).toEqual([]);
    expect(r.events).toEqual([]);
  });

  test("an existing salt is never overwritten, and the aliases in the file come from it", { options: { ...OPTS } }, async ($, on) => {
    const r = rig(on);
    r.world.put(`${SYNC}/tally/salt`, "shared-salt-from-the-first-computer");
    await settled($, r);
    expect(r.world.text(`${SYNC}/tally/salt`)).toBe("shared-salt-from-the-first-computer");
    expect(r.events.filter((e) => e === `write ${SYNC}/tally/salt`)).toEqual([]);
    const file = parseMachineFile(r.world.text(`${SYNC}/tally/box-a.json`) ?? "");
    expect(file?.hours.map((h) => h.repo)).toEqual([repoAlias(REPO, "shared-salt-from-the-first-computer")]);
  });

  test("an empty salt file is left alone and the run stops there", { options: { ...OPTS } }, async ($, on) => {
    const r = rig(on);
    r.world.put(`${SYNC}/tally/salt`, "");
    await settled($, r);
    expect(r.world.text(`${SYNC}/tally/salt`)).toBe("");
    expect(r.world.text(`${SYNC}/tally/box-a.json`)).toBeUndefined();
    expect(r.logs.some((l) => /salt file is empty/.test(l))).toBe(true);
  });

  test("shareDetail numbers keeps every real repo name out of the file", { options: { ...OPTS, shareDetail: "numbers" } }, async ($, on) => {
    const r = rig(on);
    await settled($, r);
    const text = r.world.text(`${SYNC}/tally/box-a.json`) ?? "";
    expect(text.length).toBeGreaterThan(10);
    expect(text).not.toContain(REPO);
    expect(text).not.toContain("secret");
    expect(text).toMatch(/"repo":"r-[0-9a-f]{10}"/);
    expect(utf8(text)).toBeLessThan(MACHINE_FILE_MAX);
  });

  test("shareDetail repos writes the repo names", { options: { ...OPTS, shareDetail: "repos" } }, async ($, on) => {
    const r = rig(on);
    await settled($, r);
    expect(r.world.text(`${SYNC}/tally/box-a.json`)).toContain(REPO);
  });

  test("a failed pull with no rebase or merge in progress (offline) still writes and commits, but does not push; debug log only", { options: { ...OPTS } }, async ($, on) => {
    const r = rig(on);
    asRepo(r.world);
    r.git = { pull: { exitCode: 1, stderr: "fatal: no remote" } };
    await settled($, r);
    expect(r.toasts).toEqual([]);
    expect(r.logs.filter((l) => /sync: git pull failed/.test(l)).length).toBe(1);
    expect(r.logs.some((l) => /needs attention/.test(l))).toBe(false);
    expect(r.world.text(`${SYNC}/tally/box-a.json`)).toBeDefined();
    expect(r.runs.map((a) => a[3])).toEqual(["pull", "add", "commit"]);
  });

  test("a failed push goes to the debug log only: no toast", { options: { ...OPTS } }, async ($, on) => {
    const r = rig(on);
    asRepo(r.world);
    r.git = { push: { exitCode: 1, stderr: "fatal: unable to access" } };
    await settled($, r);
    expect(r.toasts).toEqual([]);
    expect(r.logs.filter((l) => /sync: git push failed/.test(l)).length).toBe(1);
    expect(r.runs.map((a) => a[3])).toEqual(["pull", "add", "commit", "push"]);
  });

  for (const marker of ["rebase-merge", "rebase-apply", "MERGE_HEAD"]) {
    test(`a failed pull with .git/${marker} present writes the local file only: no add, commit or push, one log line over two cycles`, { options: { ...OPTS } }, async ($, on) => {
      const r = rig(on);
      asRepo(r.world);
      r.world.put(`${SYNC}/.git/${marker}${marker === "MERGE_HEAD" ? "" : "/head-name"}`, "x\n");
      r.git = { pull: { exitCode: 1, stderr: "error: could not apply abc123" } };
      await settled($, r);
      expect(r.runs.map((a) => a[3])).toEqual(["pull"]);
      expect(r.world.text(`${SYNC}/tally/box-a.json`)).toBeDefined();
      expect(r.logs.filter((l) => /needs attention/.test(l)).length).toBe(1);
      // A second cycle after the gap: the repo is still stopped, so git is not touched and nothing is logged again.
      r.world.put(`${CFG}/projects/-work-demo/s-1.jsonl`, "\n");
      r.world.setMtime(`${CFG}/projects/-work-demo/s-1.jsonl`, NOW + 5000);
      await r.clock.advance(70_000);
      await r.clock.advance(SYNC_GAP_MS);
      expect(r.events.filter((e) => e.startsWith(`write ${SYNC}/tally/box-a.json`)).length).toBe(2);
      expect(r.runs.map((a) => a[3])).toEqual(["pull"]);
      expect(r.logs.filter((l) => /needs attention|git (pull|add|commit|push) failed/.test(l)).length).toBe(2);
      expect(r.logs.filter((l) => /needs attention/.test(l)).length).toBe(1);
      expect(r.toasts).toEqual([]);
    });
  }

  test("a commit with nothing to commit is not an error", { options: { ...OPTS } }, async ($, on) => {
    const r = rig(on);
    asRepo(r.world);
    r.git = { commit: { exitCode: 1, stdout: "On branch main\nnothing to commit, working tree clean\n" } };
    await settled($, r);
    expect(r.logs.filter((l) => /sync:/.test(l))).toEqual([]);
    expect(r.runs.map((a) => a[3])).toEqual(["pull", "add", "commit", "push"]);
  });

  test("a commit that fails for another reason is logged and nothing is pushed", { options: { ...OPTS } }, async ($, on) => {
    const r = rig(on);
    asRepo(r.world);
    r.git = { commit: { exitCode: 128, stderr: "fatal: unable to auto-detect email address" } };
    await settled($, r);
    expect(r.logs.some((l) => /git commit failed/.test(l))).toBe(true);
    expect(r.runs.map((a) => a[3])).toEqual(["pull", "add", "commit"]);
    expect(r.toasts).toEqual([]);
  });

  test("once the rebase is resolved the next cycle pulls and syncs again", { options: { ...OPTS } }, async ($, on) => {
    const r = rig(on);
    asRepo(r.world);
    r.world.put(`${SYNC}/.git/MERGE_HEAD`, "x\n");
    r.git = { pull: { exitCode: 1, stderr: "error: you have not concluded your merge" } };
    await settled($, r);
    expect(r.runs.map((a) => a[3])).toEqual(["pull"]);
    r.hidden.add(`${SYNC}/.git/MERGE_HEAD`);
    r.git = {};
    r.world.put(`${CFG}/projects/-work-demo/s-1.jsonl`, "\n");
    r.world.setMtime(`${CFG}/projects/-work-demo/s-1.jsonl`, NOW + 5000);
    await r.clock.advance(70_000);
    await r.clock.advance(SYNC_GAP_MS);
    expect(r.runs.map((a) => a[3])).toEqual(["pull", "pull", "add", "commit", "push"]);
  });

  test("scans that end within the gap sync once; the next sync waits for the gap", { options: { ...OPTS } }, async ($, on) => {
    const r = rig(on);
    asRepo(r.world);
    await settled($, r);
    expect(r.runs.filter((a) => a[3] === "push").length).toBe(1);
    // A transcript changes: the next pass finishes a scan, inside the gap.
    r.world.put(`${CFG}/projects/-work-demo/s-1.jsonl`, "\n");
    r.world.setMtime(`${CFG}/projects/-work-demo/s-1.jsonl`, NOW + 5000);
    await r.clock.advance(70_000);
    expect(r.runs.filter((a) => a[3] === "push").length).toBe(1);
    await r.clock.advance(SYNC_GAP_MS);
    expect(r.runs.filter((a) => a[3] === "push").length).toBe(2);
  });
});


describe("the t switch on History", () => {
  const demo = (): number => usdOf(demoUsage());

  async function openHistory($: Engine, r: Rig, files: MachineFile[]) {
    for (const f of files) putRemote(r.world, f);
    await seedProject(r.world, "-work-demo", demoUsage());
    await start($, r);
    await r.clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    await ui.press({ key: "tab-history" });
    await ui.press({ key: "span-30d" });
    await r.clock.settle();
    return ui;
  }

  test("another span says All computers needs the 30 days and shows this computer's figures", { options: { ...OPTS } }, async ($, on) => {
    const r = rig(on);
    // The session's own project, so the session span has figures to draw the note over.
    await seedProject(r.world, "-work-zq-secret-repo", demoUsage());
    const ui = await openHistory($, r, [remoteFile()]);
    await ui.press({ key: "machines-all" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/^All computers \u{b7} box-a, box-b$/u))).toBeDefined();
    await ui.press({ key: "span-session" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/^All computers needs the 30 days span/))).toBeDefined();
    expect(await ui.find(TEXT(/^All computers \u{b7}/u))).toBeUndefined();
    await ui.unmount();
  });

  test("t moves the total from this computer's to the merged figure and back", { options: { ...OPTS } }, async ($, on) => {
    const r = rig(on);
    const ui = await openHistory($, r, [remoteFile()]);
    expect(await ui.find(TEXT(exact(money(demo()))))).toBeDefined();
    expect(await ui.find(TEXT(/ tokens in the past 30 days \u{b7} 2 requests$/u))).toBeDefined();
    expect((await ui.find({ key: "machines-all" }))?.props.hotkey).toBe("t");
    await ui.press({ key: "machines-all" });
    await r.clock.settle();
    // The headline is the merged total; the local repo row keeps this computer's figure.
    expect(await ui.find(TEXT(exact(money(demo() + 7.25))))).toBeDefined();
    expect(await ui.find(TEXT(/ tokens in the past 30 days \u{b7} 5 requests$/u))).toBeDefined();
    expect(await ui.find(TEXT(/ tokens in the past 30 days \u{b7} 2 requests$/u))).toBeUndefined();
    expect(await ui.find(TEXT(/^All computers \u{b7} box-a, box-b$/u))).toBeDefined();
    expect((await ui.find({ key: "machines-this" }))?.props.hotkey).toBe("t");
    await ui.press({ key: "machines-this" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/ tokens in the past 30 days \u{b7} 2 requests$/u))).toBeDefined();
    expect(await ui.find(TEXT(/^All computers/))).toBeUndefined();
    await ui.unmount();
  });

  test("blocks no file carries say This computer only", { options: { ...OPTS } }, async ($, on) => {
    const r = rig(on);
    const ui = await openHistory($, r, [remoteFile()]);
    await ui.press({ key: "machines-all" });
    await r.clock.settle();
    // A numbers file carries no repo or session rows.
    expect((await ui.findAll(TEXT(/This computer only/))).length).toBe(2);
    expect(await ui.find(TEXT(/^This computer only$/))).toBeDefined();
    expect(await ui.find(TEXT(/^press a row to resume \u{b7} This computer only$/u))).toBeDefined();
    // The blocks every file feeds carry no note.
    expect(await ui.find(TEXT(/^newest first/))).toBeDefined();
    expect(await ui.find(TEXT(/^newest first.*This computer only/))).toBeUndefined();
    await ui.unmount();
  });

  test("a repo filter is never merged: it stays on this computer and says so", { options: { ...OPTS } }, async ($, on) => {
    const r = rig(on);
    const ui = await openHistory($, r, [remoteFile()]);
    await ui.press({ key: "machines-all" });
    await r.clock.settle();
    await ui.press({ key: "repo-only" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/^All computers needs All repos/))).toBeDefined();
    expect(await ui.find(TEXT(exact(money(demo() + 7.25))))).toBeUndefined();
    expect(await ui.find(TEXT(/ tokens in the past 30 days \u{b7} 2 requests \u{b7} /u))).toBeDefined();
    await ui.press({ key: "repo-all" });
    await r.clock.settle();
    expect(await ui.find(TEXT(exact(money(demo() + 7.25))))).toBeDefined();
    await ui.unmount();
  });

  test("a remote session names its machine and offers no resume command", { options: { ...OPTS } }, async ($, on) => {
    const r = rig(on);
    const remote = remoteFile({
      machine: "box-c",
      detail: "full",
      sessions: [{ sessionId: "remote-s1", repo: "repo-c", title: "Remote work", started: ago(1), usd: 900, resume: "claude --resume remote-s1" }],
      toolFill: { Bash: 4000 },
    });
    const ui = await openHistory($, r, [remote]);
    await ui.press({ key: "machines-all" });
    await r.clock.settle();
    // A session row is a button: its label is the button's text.
    expect((await ui.find({ key: "open-session|remote-s1" }))?.props.label).toMatch(/^Remote work \u{b7} .* \u{b7} repo-c \u{b7} box-c$/u);
    await ui.press({ key: "open-session|remote-s1" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/^on box-c: resume it there$/))).toBeDefined();
    expect(await ui.find(TEXT(/claude --resume remote-s1/))).toBeUndefined();
    // The local session still resumes here.
    await ui.press({ key: "open-session|s-1" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/^claude --resume s-1$/))).toBeDefined();
    // This file feeds sessions and context fill, so those blocks carry no note.
    expect(await ui.find(TEXT(/^press a row to resume$/))).toBeDefined();
    await ui.unmount();
  });

  test("a file that fails validation is ignored", { options: { ...OPTS } }, async ($, on) => {
    const r = rig(on);
    r.world.put(`${SYNC}/tally/bad.json`, '{"v":1,"machine":"bad"');
    r.world.put(`${SYNC}/tally/other.json`, JSON.stringify({ v: 2, machine: "x" }));
    const ui = await openHistory($, r, [remoteFile()]);
    await ui.press({ key: "machines-all" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/^All computers \u{b7} box-a, box-b$/u))).toBeDefined();
    await ui.unmount();
  });

  test("without a sync folder there is no switch", async ($, on) => {
    const r = rig(on);
    const ui = await openHistory($, r, []);
    expect(await ui.find({ key: "machines-all" })).toBeUndefined();
    await ui.unmount();
  });
});

describe("the t switch on Hints", () => {
  async function openHints($: Engine, r: Rig, files: MachineFile[]) {
    for (const f of files) putRemote(r.world, f);
    await seedProject(r.world, "-work-demo", demoUsage());
    await start($, r);
    await r.clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    await ui.press({ key: "tab-hints" });
    await r.clock.settle();
    return ui;
  }

  test("under All computers a full file's hints are listed under its machine name, and local blocks say This computer only", { options: { ...OPTS } }, async ($, on) => {
    const r = rig(on);
    const ui = await openHints($, r, [remoteFile({ machine: "box-c", detail: "full", hints: [hintOf("remote-rule")] }), remoteFile({ machine: "box-d", detail: "numbers" })]);
    expect(await ui.find(TEXT(/^Title of remote-rule$/))).toBeUndefined();
    expect((await ui.find({ key: "machines-all" }))?.props.hotkey).toBe("t");
    await ui.press({ key: "machines-all" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/^Other computers$/))).toBeDefined();
    expect(await ui.find(TEXT(/^box-c$/))).toBeDefined();
    expect(await ui.find(TEXT(/^Title of remote-rule$/))).toBeDefined();
    expect(await ui.find(TEXT(/^Summary of remote-rule\.$/))).toBeDefined();
    expect(await ui.find(TEXT(/^box-d \u{b7} shares numbers only, so no hints$/u))).toBeDefined();
    expect(await ui.find(TEXT(/^This computer only$/))).toBeDefined();
    expect(await ui.find(TEXT(/^all repos \u{b7} This computer only$/u))).toBeDefined();
    await ui.press({ key: "machines-this" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/^Other computers$/))).toBeUndefined();
    expect(await ui.find(TEXT(/This computer only/))).toBeUndefined();
    await ui.unmount();
  });

  test("a repo filter hides the other computers and says why", { options: { ...OPTS } }, async ($, on) => {
    const r = rig(on);
    const ui = await openHints($, r, [remoteFile({ machine: "box-c", detail: "full", hints: [hintOf("remote-rule")] })]);
    await ui.press({ key: "machines-all" });
    await r.clock.settle();
    await ui.press({ key: "repo-only" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/^Other computers are not shown for one repo/))).toBeDefined();
    expect(await ui.find(TEXT(/^Title of remote-rule$/))).toBeUndefined();
    await ui.unmount();
  });

  test("evidence of a remote hint is stripped by redactEvidence", { options: { ...OPTS, redactEvidence: true } }, async ($, on) => {
    const r = rig(on);
    const hint = { ...hintOf("remote-rule"), evidence: [{ label: "Command", detail: "git push origin secret-branch", kind: "command" as const }] };
    const ui = await openHints($, r, [remoteFile({ machine: "box-c", detail: "full", hints: [hint] })]);
    await ui.press({ key: "machines-all" });
    await r.clock.settle();
    await ui.press({ key: "open-hint|m:box-c|remote-rule" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/secret-branch/))).toBeUndefined();
    expect(await ui.find(TEXT(/^Command \u{b7} git$/u))).toBeDefined();
    await ui.unmount();
  });
});
