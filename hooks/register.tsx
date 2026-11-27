import type { Register } from "claude-code";
import { projectNameOf } from "../core/plan-scan.ts";
import { debugText, idleProgress } from "../engine/progress.ts";
import type { ScanProgress } from "../engine/progress.ts";
import { listProjects, startScanner } from "../engine/scanner.ts";
import { summaryJson } from "../engine/summary-json.ts";
import { makeSlicer } from "../engine/slicer.ts";
import { BUILTIN_PRICES } from "../core/prices.builtin.ts";
import { locate } from "../engine/locate.ts";
import { startLive, wireLive } from "../engine/live.ts";

export const register: Register = (on) => {
  let progress: ScanProgress = idleProgress(false);
  let stop: (() => void) | undefined;
  // Bumped by every session.start and session.end: a start still waiting on its delay sees it was superseded.
  let gen = 0;
  wireLive(on);
  on("session.start", async ($, e, next) => {
    const started = await next(e);
    await $.command.register({
      name: "tally",
      description: "Show tally's version",
      argumentHint: "",
    });
    // The live tally never holds the session up or fails its start.
    await startLive($, e).catch(() => {});
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
    const args = e.args.trim().split(/\s+/);
    if (args[0] === "debug") {
      const loc = await locate($);
      const projects = await listProjects($, loc.roots);
      if (args[1] === "--json") {
        const now = await $.clock.now();
        const slicer = makeSlicer($);
        const tick = () => slicer.check();
        return { text: await summaryJson($, loc.cfg, projects, now, -new Date(now).getTimezoneOffset(), BUILTIN_PRICES, progress, tick) };
      }
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
