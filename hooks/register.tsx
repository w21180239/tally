import type { Register } from "claude-code";
import { parseArgs } from "../core/args.ts";
import { openTarget } from "../core/open-target.ts";
import { readSettings } from "../core/settings.ts";
import { projectNameOf } from "../core/plan-scan.ts";
import { debugText, idleProgress } from "../engine/progress.ts";
import type { ScanProgress } from "../engine/progress.ts";
import { listProjects, startScanner } from "../engine/scanner.ts";
import { summaryJson } from "../engine/summary-json.ts";
import { makeSlicer } from "../engine/slicer.ts";
import { currentPrices } from "../engine/price-update.ts";
import { locate } from "../engine/locate.ts";
import { recheckSoon } from "../engine/adopt.ts";
import { syncHerdr } from "../engine/herdr.ts";
import { REPORT_TOOL_FULL, argsOf, registerReportTool, reportCommand, reportText, snapshotSoon } from "../engine/report-tool.ts";
import { resetSync, runSync, syncSoon } from "../engine/sync.ts";
import { syncExtra } from "../engine/sync-extra.ts";
import { readLive, startLive, updatePrices, wireLive } from "../engine/live.ts";
import { COMMAND, PANE_ID, applySettings, invalidateWindow, keepFolded, openWindow, readView, restoreWindow, startFeeds, useSettings } from "../engine/window.ts";
import { startSessionView } from "../engine/session-view.ts";
import { startTimers } from "../engine/timers.ts";
import { drawBand, drawPane } from "../view/app.tsx";

const RECHECK_DELAY_MS = 10_000;
// The 24h snapshot slides with the clock even when a scan finds nothing new, so the owner refreshes it on this beat too.
const SNAPSHOT_EVERY_MS = 600_000;
const USAGE = "a tab (session, usage, context, history, hints, help), a span (24h, 30d), a setting (money, decimals, open, row, ...), report, sync or debug";

export const register: Register = (on, options) => {
  // A change in the config menu reloads the module with the new options, so this runs again.
  let settings = readSettings((options ?? {}) as Record<string, unknown>);
  let progress: ScanProgress = idleProgress(false);
  let stop: (() => void) | undefined;
  let timers: Array<{ cancel(): void }> = [];
  let snapTimer: { cancel(): void } | undefined;
  // Bumped by every session.start and session.end: a start still waiting on its delay sees it was superseded.
  let gen = 0;
  useSettings(settings);
  wireLive(on);
  on("session.start", async ($, e, next) => {
    const started = await next(e);
    await $.command.register({
      name: COMMAND,
      description: "Open the tally window: spend, context and hints. A tab or 24h/30d opens it there; money, decimals, open or row sets an option; report [days] [repo] writes a spend report file; debug shows the scan",
      argumentHint: "[session|usage|context|history|hints|help|24h|30d] or money <cents-and-dollars|cents|dollars> or decimals <auto|0-4> or row <on|off> or report [days] [repo]",
    });
    // The report tool is optional too: without it the window and the command still work.
    await registerReportTool($).catch(() => {});
    // The live tally never holds the session up or fails its start.
    await startLive($, e).catch(() => {});
    // Nor does the window: open or folded as the person left it, with the foot and chart filling in behind.
    try {
      await restoreWindow($, settings, e.isInteractive);
      const live = await readLive($);
      startFeeds($, live.lastWrite?.ttl ?? "1h");
      startSessionView($, live);
      for (const t of timers) t.cancel();
      timers = startTimers($);
    } catch {
      /* the window is optional */
    }
    // The price refresh waits for the clock like the scanner below: a slow page never holds the start up.
    $.clock.after(0, () => {
      void updatePrices($, settings);
    });
    // The Herdr sidebar mod follows the herdrSidebar setting; like the price refresh it runs off the hook's path.
    if (e.isInteractive) {
      $.clock.after(0, () => {
        syncHerdr($, settings).catch(() => {});
      });
    }
    const sessionId = await $.session.id();
    const loc = await locate($);
    stop?.();
    const mine = ++gen;
    // Adopted hints that came due get their check once the scan has had a head start; a scan that finds nothing new
    // reports nothing, so no scan event can be waited for. Only an interactive session has a toast to show it in.
    if (e.isInteractive) {
      $.clock.after(RECHECK_DELAY_MS, () => {
        if (mine === gen) recheckSoon($, () => settings.recheckDays);
      });
    }
    snapTimer?.cancel();
    snapTimer = $.clock.every(SNAPSHOT_EVERY_MS, () => {
      if (mine === gen && progress.owner) snapshotSoon($);
    });
    resetSync();
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
          // A finished scan of the owner session feeds the sync, off this callback's path and one at a time.
          if (p.phase === "done" && p.owner) {
            syncSoon($, () => settings, () => syncExtra($));
            snapshotSoon($);
          }
        },
        onShardSaved: () => {},
      }).stop;
    });
    return started;
  });

  on("session.end", async (_$, e, next) => {
    // /clear and an in-process /resume end the session but the process goes on with no session.start: the scanner
    // (and its lease heartbeat) and the redraw timers keep running, and a start still waiting on its delay stays
    // valid. Only the reasons that end the process stop them.
    if (e.reason === "prompt_input_exit" || e.reason === "other" || e.reason === "logout") {
      gen++;
      resetSync();
      stop?.();
      stop = undefined;
      snapTimer?.cancel();
      snapTimer = undefined;
      for (const t of timers) t.cancel();
      timers = [];
    }
    return next(e);
  });

  // The person's Esc or close mark folds the window to its line above the prompt; a press on the line or /tally brings it back.
  on("ui.close", { id: PANE_ID }, async ($, e, next) => {
    // Our own fold set its mode before it closed the pane.
    if ((await readView($)).mode !== "folded" && e.origin.kind !== "unload") await keepFolded($);
    return next(e);
  });

  // The tool tally_report: the model calls it, this answers with the markdown.
  on("tool.run", { tool: REPORT_TOOL_FULL }, async ($, e) => {
    try {
      return { result: await reportText($, argsOf(e)) };
    } catch (err) {
      return { deny: `tally_report failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  on("ui.render", { component: "Pane", requestId: PANE_ID }, ($, e) => drawPane($, e, settings));
  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => drawBand($, e, next, settings));

  on("command.run", { command: COMMAND }, async ($, e) => {
    const a = parseArgs(e.args);
    if (a.unknown.length > 0) return { text: `"${a.unknown[0]}" is not ${USAGE}.` };
    if (a.sub === "debug") {
      const loc = await locate($);
      const projects = await listProjects($, loc.roots);
      if (a.json === true) {
        const now = await $.clock.now();
        const slicer = makeSlicer($);
        const tick = () => slicer.check();
        return { text: await summaryJson($, loc.cfg, projects, now, -new Date(now).getTimezoneOffset(), await currentPrices($), progress, tick) };
      }
      return { text: await debugText($, loc.cfg, projects, progress, await $.clock.now(), () => $.clock.sleep(0)) };
    }
    if (a.sub === "report") return { text: await reportCommand($, { ...(a.days !== undefined && { days: a.days }), ...(a.repo !== undefined && { repo: a.repo }) }) };
    if (a.sub === "sync") {
      if (settings.syncDir === "") return { text: "Sharing is off: set syncDir to a shared folder first." };
      const r = await runSync($, settings, () => syncExtra($));
      return { text: r.error === undefined ? (r.machines.length > 0 ? `Synced; machines: ${r.machines.join(", ")}.` : "Synced; no other machines yet.") : `Sync failed: ${r.error}` };
    }

    const hasSet = Object.keys(a.set).length > 0;
    const target = openTarget(e.args, a);
    // Settings alone change settings; a tab or span, or nothing at all, opens the window.
    const opens = !hasSet || target.tab !== undefined || target.span !== undefined;
    // The open goes first: the engine ties it to this command only while nothing has been awaited since.
    if (opens) await openWindow($, settings, { asked: true, ...target });
    const said: string[] = [];
    if (hasSet) {
      const done = await applySettings($, a.set);
      settings = { ...settings, ...done.applied };
      useSettings(settings);
      if (done.applied.herdrSidebar !== undefined) {
        $.clock.after(0, () => {
          syncHerdr($, settings).catch(() => {});
        });
      }
      invalidateWindow($);
      said.push(...done.said);
      if (done.error !== undefined) return { text: `${said.length === 0 ? "" : `${said.join(", ")}; `}${done.error}` };
    }
    if (opens) said.unshift(target.tab === undefined && target.span === undefined ? "tally opened" : `tally opened on ${[target.tab, target.span].filter((x) => x !== undefined).join(" ")}`);
    return { text: `${said.join(", ")}.` };
  });
};
