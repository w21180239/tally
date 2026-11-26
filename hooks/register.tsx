import type { Register } from "claude-code";
import { configDir, scanRoots } from "../core/path.ts";
import { projectNameOf } from "../core/plan-scan.ts";
import { debugText, idleProgress } from "../engine/progress.ts";
import type { ScanProgress } from "../engine/progress.ts";
import { listProjects, startScanner } from "../engine/scanner.ts";

type Platform = "darwin" | "win32" | "linux";
type EnvMap = Record<string, string | undefined>;

// Each name is its own literal call: the engine rejects a non-literal `$.env.get` argument.
async function readEnv($: { env: { get(name: string): Promise<string | undefined> } }): Promise<EnvMap> {
  return {
    CLAUDE_CONFIG_DIR: await $.env.get("CLAUDE_CONFIG_DIR"),
    HOME: await $.env.get("HOME"),
    USERPROFILE: await $.env.get("USERPROFILE"),
    APPDATA: await $.env.get("APPDATA"),
    XDG_CONFIG_HOME: await $.env.get("XDG_CONFIG_HOME"),
  };
}

async function platformOf($: { session: { info(): Promise<{ platform?: string }> } }, env: EnvMap): Promise<Platform> {
  try {
    const p = (await $.session.info()).platform;
    if (p === "macos") return "darwin";
    if (p === "windows") return "win32";
    if (p === "linux" || p === "wsl") return "linux";
  } catch {
    /* fall through to the env guess */
  }
  return !env.HOME && (env.USERPROFILE || env.APPDATA) ? "win32" : "linux";
}

async function locate($: Parameters<typeof readEnv>[0] & Parameters<typeof platformOf>[0]): Promise<{ cfg: string; roots: string[] }> {
  const env = await readEnv($);
  const get = (k: string) => env[k];
  return { cfg: configDir(get), roots: scanRoots(get, await platformOf($, env)) };
}

export const register: Register = (on) => {
  let progress: ScanProgress = idleProgress(false);
  let stop: (() => void) | undefined;
  // Bumped by every session.start and session.end: a start still waiting on its delay sees it was superseded.
  let gen = 0;
  on("session.start", async ($, e, next) => {
    const started = await next(e);
    await $.command.register({
      name: "tally",
      description: "Show tally's version",
      argumentHint: "",
    });
    const sessionId = await $.session.id();
    const loc = await locate($);
    stop?.();
    const mine = ++gen;
    // Start off the hook's path so the session is never held up by the first listing.
    $.clock.after(100, () => {
      if (mine !== gen) return;
      stop = startScanner($, {
        sessionId,
        currentProject: projectNameOf(e.cwd),
        cfg: loc.cfg,
        roots: loc.roots,
        onProgress: (p) => {
          progress = p;
        },
        onShardSaved: () => {},
      }).stop;
    });
    return started;
  });

  on("session.end", async (_$, e, next) => {
    gen++;
    stop?.();
    stop = undefined;
    return next(e);
  });

  on("command.run", { command: "tally" }, async ($, e) => {
    if (e.args.trim() === "debug") {
      const loc = await locate($);
      const projects = await listProjects($, loc.roots);
      return { text: await debugText($, loc.cfg, projects, progress, await $.clock.now(), () => $.clock.sleep(0)) };
    }
    let version = "";
    try {
      const m = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`));
      version = typeof m?.version === "string" ? m.version : "";
    } catch {
      version = "";
    }
    return { text: `tally ${version}` };
  });
};
