import type { On } from "claude-code";
import type { Engine } from "claude-code/testing";
import { describe, expect, mock, test } from "claude-code/testing";
import { herdrModsDir, herdrRootDir } from "../core/herdr.ts";
import { MARKER, STUB_MAIN, syncHerdr } from "../engine/herdr.ts";
import { posixPath, worldOf } from "./world.ts";
import type { World } from "./world.ts";

const ON = { herdrSidebar: true };
const OFF = { herdrSidebar: false };
const ROOT = "/home/u/.config/herdr-app";
const MOD = `${ROOT}/mods/tally`;
const MAIN_SRC = "// main\nexport default class Tally {}\n";
const MOD_SRC = '{ "place": "right" }\n';

type Opts = { env?: Record<string, string | undefined>; platform?: string; cli?: boolean; exitCode?: number };

// A `$` over the world's fs with the env, plugin folder and process of one session; `rm` runs delete a path prefix.
function session(w: World, o: Opts = {}) {
  const env = { HOME: "/home/u", ...(o.env ?? {}) };
  const runs: string[][] = [];
  const gone: string[] = [];
  const under = (p: string) => gone.some((g) => p === g || p.startsWith(g + "/"));
  const fs = {
    ...w.$.fs,
    exists: async (p: string) => !under(p) && (await w.$.fs.exists(p)),
    read: (async (p: string, x?: object) => {
      if (under(p)) throw new Error(`ENOENT: ${p}`);
      return (w.$.fs.read as (p: string, x?: object) => Promise<unknown>)(p, x);
    }) as typeof w.$.fs.read,
  };
  const $ = {
    ...w.$,
    fs,
    env: { get: async (n: string) => env[n as keyof typeof env] },
    session: { info: async () => ({ platform: o.platform ?? "macos" }) },
    plugin: { root: "/plugin" },
    ...(o.cli === false
      ? {}
      : {
          process: {
            run: async (argv: readonly string[]) => {
              runs.push([...argv]);
              const code = o.exitCode ?? 0;
              if (code === 0) gone.push(argv[argv.length - 1]!);
              return { exitCode: code, stdout: "", stderr: "" };
            },
          },
        }),
  };
  return { $: $ as unknown as Parameters<typeof syncHerdr>[0], runs };
}

function world(opts: { root?: boolean } = {}) {
  const w = worldOf();
  w.put("/plugin/herdr/main.js", MAIN_SRC);
  w.put("/plugin/herdr/mod.json", MOD_SRC);
  if (opts.root !== false) w.put(`${ROOT}/state.json`, "{}");
  return w;
}

describe("herdr paths", () => {
  test("HERDR_APP_HOME wins, then the per-platform default", () => {
    const env = (m: Record<string, string>) => (k: string) => m[k];
    expect(herdrRootDir(env({ HERDR_APP_HOME: "/x/h", HOME: "/home/u" }), "darwin")).toBe("/x/h");
    expect(herdrRootDir(env({ HOME: "/home/u" }), "darwin")).toBe("/home/u/.config/herdr-app");
    expect(herdrRootDir(env({ HOME: "/home/u" }), "linux")).toBe("/home/u/.config/herdr-app");
    expect(herdrRootDir(env({ USERPROFILE: "C:\\Users\\u", APPDATA: "C:\\Users\\u\\AppData\\Roaming" }), "win32")).toBe("C:\\Users\\u\\AppData\\Roaming\\herdr-app");
    expect(herdrModsDir(env({ HERDR_APP_HOME: "/x/h" }), "linux")).toBe("/x/h/mods");
    expect(herdrModsDir(env({ APPDATA: "C:\\A" }), "win32")).toBe("C:\\A\\herdr-app\\mods");
  });

  test("no home and no override gives null", () => {
    expect(herdrRootDir(() => undefined, "linux")).toBeNull();
    expect(herdrModsDir(() => undefined, "win32")).toBeNull();
  });
});

describe("syncHerdr on", () => {
  test("writes marker, source pointer, mod.json and main.js (main.js last)", async () => {
    const w = world();
    const { $ } = session(w, { env: { CLAUDE_CONFIG_DIR: "/cfg" } });
    expect(await syncHerdr($, ON)).toBe("written");
    expect(w.text(`${MOD}/${MARKER}`)).toBeDefined();
    expect(w.text(`${MOD}/mod.json`)).toBe(MOD_SRC);
    expect(w.text(`${MOD}/main.js`)).toBe(MAIN_SRC);
    expect(JSON.parse(w.text(`${MOD}/.tally-source.json`)!)).toEqual({ reports: "/cfg/tally" });
    const order = w.writes.map((x) => x.path.slice(MOD.length + 1));
    expect(order[order.length - 1]).toBe("main.js");
  });

  test("a second run writes nothing", async () => {
    const w = world();
    const { $ } = session(w);
    await syncHerdr($, ON);
    const before = w.writes.length;
    expect(await syncHerdr($, ON)).toBe("current");
    expect(w.writes.length).toBe(before);
  });

  test("a changed source pointer rewrites only that hidden file", async () => {
    const w = world();
    await syncHerdr(session(w).$, ON);
    const before = w.writes.length;
    await syncHerdr(session(w, { env: { CLAUDE_CONFIG_DIR: "/other" } }).$, ON);
    expect(w.writes.slice(before).map((x) => x.path)).toEqual([`${MOD}/.tally-source.json`]);
  });

  test("Windows env writes under APPDATA", async () => {
    const w = worldOf();
    w.put("/plugin/herdr/main.js", MAIN_SRC);
    w.put("/plugin/herdr/mod.json", MOD_SRC);
    w.put("C:/Users/u/AppData/Roaming/herdr-app/x", "");
    const { $ } = session(w, { platform: "windows", env: { HOME: undefined, USERPROFILE: "C:\\Users\\u", APPDATA: "C:\\Users\\u\\AppData\\Roaming" } });
    expect(await syncHerdr($, ON)).toBe("written");
    expect(w.text("C:/Users/u/AppData/Roaming/herdr-app/mods/tally/main.js")).toBe(MAIN_SRC);
  });

  test("HERDR_APP_HOME is the root", async () => {
    const w = worldOf();
    w.put("/plugin/herdr/main.js", MAIN_SRC);
    w.put("/plugin/herdr/mod.json", MOD_SRC);
    w.put("/alt/h/x", "");
    const { $ } = session(w, { env: { HERDR_APP_HOME: "/alt/h" } });
    expect(await syncHerdr($, ON)).toBe("written");
    expect(w.text("/alt/h/mods/tally/main.js")).toBe(MAIN_SRC);
  });

  test("a mods/tally folder without the marker is left alone", async () => {
    const w = world();
    w.put(`${MOD}/main.js`, "// someone else's");
    const { $ } = session(w);
    const before = w.writes.length;
    expect(await syncHerdr($, ON)).toBe("foreign");
    expect(w.writes.length).toBe(before);
    expect(w.text(`${MOD}/main.js`)).toBe("// someone else's");
  });

  test("a missing template writes nothing", async () => {
    const w = worldOf();
    w.put(`${ROOT}/x`, "");
    const { $ } = session(w);
    expect(await syncHerdr($, ON)).toBe("no-template");
    expect(w.writes.length).toBe(0);
  });
});

describe("syncHerdr off", () => {
  test("deletes the folder when the marker is there (POSIX: rm -rf argv)", async () => {
    const w = world();
    const s = session(w);
    await syncHerdr(s.$, ON);
    expect(await syncHerdr(s.$, OFF)).toBe("removed");
    expect(s.runs).toEqual([["rm", "-rf", MOD]]);
    expect(await s.$.fs.exists(MOD)).toBe(false);
  });

  test("Windows deletes with cmd rmdir", async () => {
    const w = worldOf();
    const mod = "C:/A/herdr-app/mods/tally";
    w.put(`${mod}/${MARKER}`, "");
    w.put(`${mod}/main.js`, MAIN_SRC);
    const { $, runs } = session(w, { platform: "windows", env: { HOME: undefined, APPDATA: "C:/A" } });
    expect(await syncHerdr($, OFF)).toBe("removed");
    expect(runs).toEqual([["cmd", "/c", "rmdir", "/s", "/q", "C:/A/herdr-app/mods/tally"]]);
  });

  test("a Windows path cmd.exe would re-parse is never passed to it", async () => {
    const w = worldOf();
    const mod = "C:/Users/a&b/AppData/Roaming/herdr-app/mods/tally";
    w.put(`${mod}/${MARKER}`, "");
    w.put(`${mod}/main.js`, MAIN_SRC);
    const { $, runs } = session(w, { platform: "windows", env: { HOME: undefined, APPDATA: "C:/Users/a&b/AppData/Roaming" } });
    expect(await syncHerdr($, OFF)).toBe("disabled");
    expect(runs).toEqual([]);
    expect(w.text(`${mod}/main.js`)).toBe(STUB_MAIN);
  });

  test("a folder without the marker is not deleted", async () => {
    const w = world();
    w.put(`${MOD}/main.js`, "// theirs");
    const s = session(w);
    expect(await syncHerdr(s.$, OFF)).toBe("foreign");
    expect(s.runs).toEqual([]);
    expect(w.text(`${MOD}/main.js`)).toBe("// theirs");
  });

  test("no Herdr root: nothing is written or run", async () => {
    const w = world({ root: false });
    const s = session(w);
    expect(await syncHerdr(s.$, ON)).toBe("no-herdr");
    expect(await syncHerdr(s.$, OFF)).toBe("no-herdr");
    expect(w.writes.length).toBe(0);
    expect(s.runs).toEqual([]);
  });

  test("without a process API the folder is disabled in place", async () => {
    const w = world();
    await syncHerdr(session(w).$, ON);
    const s = session(w, { cli: false });
    expect(await syncHerdr(s.$, OFF)).toBe("disabled");
    expect(w.text(`${MOD}/main.js`)).toBe(STUB_MAIN);
    expect(w.text(`${MOD}/${MARKER}`)).toBeDefined();
    const before = w.writes.length;
    expect(await syncHerdr(s.$, OFF)).toBe("disabled");
    expect(w.writes.length).toBe(before);
  });

  test("a failed delete falls back to the stub", async () => {
    const w = world();
    await syncHerdr(session(w).$, ON);
    const s = session(w, { exitCode: 1 });
    expect(await syncHerdr(s.$, OFF)).toBe("disabled");
    expect(s.runs.length).toBe(1);
    expect(w.text(`${MOD}/main.js`)).toBe(STUB_MAIN);
  });

  test("a stubbed folder is written again when the option comes back on", async () => {
    const w = world();
    await syncHerdr(session(w).$, ON);
    await syncHerdr(session(w, { cli: false }).$, OFF);
    expect(await syncHerdr(session(w).$, ON)).toBe("written");
    expect(w.text(`${MOD}/main.js`)).toBe(MAIN_SRC);
  });
});

describe("session.start wiring", () => {
  const rig = (on: On, w: World, runs: string[][]) => {
    const clock = mock.clock(on, { now: Date.UTC(2026, 10, 27, 12) });
    mock.env(on, { HOME: "/home/u" });
    on("store.get", () => ({ value: undefined }));
    on("store.set", () => ({ value: undefined }));
    on("session.start", (_, e) => ({ cwd: e.cwd }));
    on("session.end", (_, e) => ({ sessionId: e.sessionId }));
    on("command.register", (_, e) => ({ value: { command: e.name } }));
    on("ui.panes", () => ({ value: [] }));
    on("ui.open", () => ({ value: { isPlaced: true } }));
    on("ui.log", () => ({ value: undefined }));
    on("ui.invalidate", () => ({ value: undefined }));
    on("session.id", () => ({ value: "s-1" }));
    on("session.info", () => ({ value: { platform: "linux" } }));
    // $.plugin.root is the real checkout, absent from the in-memory fs: the template is served from here.
    on("fs.read", async (_, e) =>
      posixPath(e.path).endsWith("/herdr/main.js") ? { value: MAIN_SRC } : posixPath(e.path).endsWith("/herdr/mod.json") ? { value: MOD_SRC } : { value: await w.$.fs.read(e.path, { as: e.as, offset: e.offset, length: e.length } as never) },
    );
    on("fs.write", async (_, e) => ({ value: await w.$.fs.write(e.path, e.text) }));
    on("fs.list", async (_, e) => ({ value: await w.$.fs.list(e.path) }));
    on("fs.exists", async (_, e) => ({ value: await w.$.fs.exists(e.path) }));
    on("fs.stat", async (_, e) => ({ value: await w.$.fs.stat(e.path) }));
    on("process.run", (_, e) => {
      runs.push([...e.argv]);
      return { value: { exitCode: 0, stdout: "", stderr: "" } };
    });
    return clock;
  };
  const start = ($: Engine, interactive = true) => $.session.start({ cwd: "/work/demo", surface: "terminal", isInteractive: interactive });

  test("herdrSidebar on writes the mod after the hook has returned", { options: { herdrSidebar: true } }, async ($, on) => {
    const w = world();
    const clock = rig(on, w, []);
    await start($);
    expect(w.text(`${MOD}/main.js`)).toBeUndefined();
    await clock.settle();
    expect(w.text(`${MOD}/main.js`)).toBe(MAIN_SRC);
  });

  test("herdrSidebar off removes a marked folder; a non-interactive session does neither", { options: { herdrSidebar: false } }, async ($, on) => {
    const w = world();
    const runs: string[][] = [];
    w.put(`${MOD}/${MARKER}`, "tally\n");
    const clock = rig(on, w, runs);
    await start($, false);
    await clock.settle();
    expect(runs).toEqual([]);
    await start($);
    await clock.settle();
    expect(runs).toEqual([["rm", "-rf", MOD]]);
  });
});
