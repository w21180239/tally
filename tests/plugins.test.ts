import { describe, expect, test } from "claude-code/testing";
import type { BreakdownSnapshot } from "../core/breakdown.ts";
import { pluginServerName, pluginsFrom } from "../core/plugins.ts";
import type { PluginInventory } from "../core/plugins.ts";
import { HINTS_INTERVAL_MS, limitsFrom, needsTop } from "../engine/hints-view.ts";
import { readInventory, registryPath } from "../engine/plugins.ts";
import { worldOf } from "./world.ts";

const NOW = Date.UTC(2026, 10, 27, 12);
const CFG = "/home/u/.claude";
const money = { usd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0 }, requests: 1 };

const snap = (over: Partial<BreakdownSnapshot> = {}): BreakdownSnapshot => ({ sessionId: "s1", ts: NOW, skills: {}, mcp: {}, agents: {}, memory: {}, system: 0, tools: 0, ...over });
const used = (over: Partial<Record<"byPlugin" | "bySkill" | "bySubType" | "byMcp", Record<string, unknown>>> = {}) => ({ byPlugin: {}, bySkill: {}, bySubType: {}, byMcp: {}, ...over }) as never;

describe("pluginsFrom", () => {
  const inv: PluginInventory[] = [
    { name: "alpha", mcpServers: ["web"] },
    { name: "beta-two", mcpServers: [] },
  ];
  const s = snap({
    skills: { "alpha:review": 300, "beta-two:plan": 50, "user-skill": 999 },
    agents: { "alpha:scout": 200 },
    mcp: { plugin_alpha_web: { tokens: 1500, deferred: 500 }, other: { tokens: 700, deferred: 0 } },
  });

  test("tokens per request add its namespaced skills and agents and its resident MCP schemas, and no one else's", () => {
    const got = pluginsFrom(inv, s, used());
    expect(got.map((p) => [p.name, p.tokensPerRequest])).toEqual([["alpha", 300 + 200 + 1000], ["beta-two", 50]]);
  });

  test("with no snapshot a plugin adds nothing known", () => {
    expect(pluginsFrom(inv, null, used()).map((p) => p.tokensPerRequest)).toEqual([0, 0]);
  });

  test("used follows attribution, a skill, an agent type or an MCP server of the plugin", () => {
    const flags = (u: ReturnType<typeof used>) => pluginsFrom(inv, s, u).map((p) => p.used);
    expect(flags(used())).toEqual([false, false]);
    expect(flags(used({ byPlugin: { "alpha@market": money } }))).toEqual([true, false]);
    expect(flags(used({ bySkill: { "beta-two:plan": money } }))).toEqual([false, true]);
    expect(flags(used({ bySubType: { "alpha:scout": {} } }))).toEqual([true, false]);
    expect(flags(used({ byMcp: { [pluginServerName("alpha", "web")]: money } }))).toEqual([true, false]);
  });

  test("a user skill that shares a name with a plugin's is not that plugin's use", () => {
    expect(pluginsFrom(inv, s, used({ bySkill: { review: money, plan: money } })).map((p) => p.used)).toEqual([false, false]);
  });

  test("a plugin unused here but used in other repos names them in usedIn; a used plugin and one used nowhere carry none", () => {
    const elsewhere = [
      { repo: "other", plugins: [], skills: ["alpha:review"], agents: [], mcp: [] },
      { repo: "third", plugins: ["alpha@market"], skills: [], agents: [], mcp: [] },
      { repo: "quiet", plugins: [], skills: ["user-skill"], agents: [], mcp: [] },
    ];
    const got = pluginsFrom(inv, s, { ...used(), elsewhere });
    expect(got.map((p) => [p.used, p.usedIn])).toEqual([[false, ["other", "third"]], [false, undefined]]);
    const here = pluginsFrom(inv, s, { ...used({ bySkill: { "alpha:review": money } }), elsewhere });
    expect(here.map((p) => [p.used, p.usedIn])).toEqual([[true, undefined], [false, undefined]]);
  });

  test("the wire name of a plugin's server folds punctuation like the engine does", () => {
    expect(pluginServerName("my-plugin", "the.server")).toBe("plugin_my_plugin_the_server");
  });
});

describe("readInventory", () => {
  const registry = (plugins: unknown) => JSON.stringify({ version: 2, plugins });

  test("names come from the id, servers from .mcp.json (flat or wrapped) and the manifest (inline or by path), sorted", async () => {
    const w = worldOf();
    w.put(registryPath(CFG), registry({
      "zed@m": [{ scope: "user", installPath: "/p/zed" }],
      "alpha@m": [{ scope: "project", installPath: "/p/alpha-proj" }, { scope: "user", installPath: "/p/alpha" }],
      "mid@m": [{ installPath: "/p/mid" }],
    }));
    w.put("/p/zed/.mcp.json", JSON.stringify({ mcpServers: { one: {}, two: {} } }));
    w.put("/p/alpha/.mcp.json", JSON.stringify({ flat: {} }));
    w.put("/p/alpha/.claude-plugin/plugin.json", JSON.stringify({ name: "alpha", mcpServers: { inline: {} } }));
    w.put("/p/alpha-proj/.mcp.json", JSON.stringify({ wrong: {} }));
    w.put("/p/mid/.claude-plugin/plugin.json", JSON.stringify({ mcpServers: "./servers.json" }));
    w.put("/p/mid/servers.json", JSON.stringify({ mcpServers: { viaPath: {} } }));
    expect(await readInventory(w.$, CFG)).toEqual([
      { name: "alpha", mcpServers: ["flat", "inline"] },
      { name: "mid", mcpServers: ["viaPath"] },
      { name: "zed", mcpServers: ["one", "two"] },
    ]);
  });

  test("a Windows install path reads the same, and an older registry with one entry per plugin does too", async () => {
    const w = worldOf();
    w.put(registryPath(CFG), registry({ "win@m": { installPath: "C:\\Users\\u\\plug\\win" } }));
    w.put("C:\\Users\\u\\plug\\win\\.mcp.json", JSON.stringify({ srv: {} }));
    expect(await readInventory(w.$, CFG)).toEqual([{ name: "win", mcpServers: ["srv"] }]);
  });

  test("a missing, torn or odd registry reads as no plugins; a plugin with no folder lists no servers", async () => {
    const w = worldOf();
    expect(await readInventory(w.$, CFG)).toEqual([]);
    w.put(registryPath(CFG), "{ not json");
    expect(await readInventory(w.$, CFG)).toEqual([]);
    w.put(registryPath(CFG), JSON.stringify({ plugins: [1, 2] }));
    expect(await readInventory(w.$, CFG)).toEqual([]);
    w.put(registryPath(CFG), registry({ "gone@m": [{ installPath: "/nowhere" }], "empty@m": [] }));
    expect(await readInventory(w.$, CFG)).toEqual([{ name: "empty", mcpServers: [] }, { name: "gone", mcpServers: [] }]);
  });

  test("a plugin installed under several ids is read one time, with a tick per plugin", async () => {
    const w = worldOf();
    w.put(registryPath(CFG), registry({ "a@m": [{ installPath: "/p/a" }], "a@n": [{ installPath: "/p/a" }], "b@m": [{ installPath: "/p/b" }] }));
    let ticks = 0;
    const got = await readInventory(w.$, CFG, async () => void ticks++);
    expect(got.map((p) => p.name)).toEqual(["a", "b"]);
    expect(ticks).toBe(3);
  });
});

describe("limitsFrom", () => {
  const at = new Date(NOW + 3_600_000).toISOString();
  test("the five-hour and seven-day windows become percent and reset time", () => {
    expect(limitsFrom({ at: NOW, limits: [{ kind: "five_hour", percentUsed: 91, resetsAt: at }, { kind: "seven_day", percentUsed: 12, resetsAt: at }] })).toEqual({
      fiveHour: { percentUsed: 91, resetsAt: NOW + 3_600_000 },
      sevenDay: { percentUsed: 12, resetsAt: NOW + 3_600_000 },
    });
  });
  test("a window with no reset time keeps its percent and leaves the reset unset", () => {
    const got = limitsFrom({ limits: [{ kind: "five_hour", percentUsed: 95 }, { kind: "seven_day", percentUsed: 40, resetsAt: "not a date" }] });
    expect(got).toEqual({ fiveHour: { percentUsed: 95 }, sevenDay: { percentUsed: 40 } });
    expect(got?.fiveHour && "resetsAt" in got.fiveHour).toBe(false);
  });
  test("a window without a figure, an unknown kind and a bad record read as nothing", () => {
    expect(limitsFrom({ limits: [{ kind: "five_hour", resetsAt: at }, { kind: "other", percentUsed: 5, resetsAt: at }, { kind: "seven_day", percentUsed: "x", resetsAt: at }, null] })).toBeUndefined();
    expect(limitsFrom(undefined)).toBeUndefined();
    expect(limitsFrom({ limits: "no" })).toBeUndefined();
  });
});

describe("needsTop", () => {
  const top = { sessionId: "s1", at: NOW, hint: null };
  test("a hint is rebuilt for another session or once its interval has passed, never for no session", () => {
    expect(needsTop(top, "s1", NOW + HINTS_INTERVAL_MS - 1)).toBe(false);
    expect(needsTop(top, "s1", NOW + HINTS_INTERVAL_MS)).toBe(true);
    expect(needsTop(top, "s2", NOW)).toBe(true);
    expect(needsTop(top, "", NOW + 10 * HINTS_INTERVAL_MS)).toBe(false);
  });
});
