// Facts the Help tab cannot get at draw time: the manifest version and the recently seen models that have no price.
// Built off the draw path; the tab draws the atom's last reading and asks for a rebuild once it is stale.
import { atom, read, update } from "claude-code";
import type { EngineInterface } from "claude-code";
import type { Shard } from "../core/shard.ts";
import { summarizeAsync } from "../core/summary.ts";
import { DAY_MS } from "../core/time.ts";
import { locate } from "./locate.ts";
import { currentPrices } from "./price-update.ts";
import { loadProject } from "./project-store.ts";
import { listProjects } from "./scanner.ts";
import { makeSlicer } from "./slicer.ts";
import { invalidateWindow } from "./window.ts";

/** A reading older than this is rebuilt at the next draw of the tab. */
export const HELP_INTERVAL_MS = 300_000;
/** A failed build is not retried sooner than this. */
export const HELP_RETRY_MS = 30_000;
const FAILURE_CHARS = 80;
/** How far back the models are looked at. */
const LOOKBACK_DAYS = 30;

export type HelpData = {
  at: number;
  /** False until a build has finished. */
  ready: boolean;
  /** Empty if plugin.json cannot be opened. */
  version: string;
  /** Models in the recent index with no price (cost counted as $0), sorted. */
  unpriced: string[];
  /** Projects with no usable index: their models are not known. */
  unread: number;
  failure?: { why: string; at: number };
};

export const EMPTY_HELP: HelpData = { at: 0, ready: false, version: "", unpriced: [], unread: 0 };

const helpAtom = atom({ plugin: "tally", key: "help" } as const, EMPTY_HELP, { shape: "help-1" });

export function readHelp($: EngineInterface): Promise<HelpData> {
  return read($, helpAtom);
}

/** True when the tab should ask for a build: none yet, a reading past its age, or a failure past its retry gap. */
export function needsHelp(data: Pick<HelpData, "at" | "ready" | "failure">, now: number): boolean {
  if (data.failure !== undefined && now - data.failure.at < HELP_RETRY_MS) return false;
  return !data.ready || now - data.at >= HELP_INTERVAL_MS;
}

async function versionOf($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "";
  } catch {
    return "";
  }
}

let running: Promise<void> | undefined;

async function build($: EngineInterface, now: number): Promise<void> {
  const loc = await locate($);
  const slicer = makeSlicer($);
  const tick = () => slicer.check();
  const shards: Shard[] = [];
  let unread = 0;
  for (const p of await listProjects($, loc.roots)) {
    await tick();
    const shard = await loadProject($, loc.cfg, p, now, tick, now - LOOKBACK_DAYS * DAY_MS);
    if (shard === null) unread++;
    else shards.push(shard);
  }
  const prices = await currentPrices($);
  const summary = await summarizeAsync(shards, prices, { span: "30d", nowMs: now, tzOffsetMin: 0 }, tick);
  const data: HelpData = { at: now, ready: true, version: await versionOf($), unpriced: summary.unpriced, unread };
  await update($, helpAtom, () => data);
  invalidateWindow($);
}

/** Rebuilds the reading unless it is fresh (or `force`); one build runs at a time. Never rejects. */
export async function refreshHelp($: EngineInterface, force = false): Promise<void> {
  try {
    let now: number;
    for (;;) {
      while (running !== undefined) await running;
      now = await $.clock.now();
      const data = await read($, helpAtom);
      if (running !== undefined) continue;
      if (!force && !needsHelp(data, now)) return;
      break;
    }
    // No await between the check above and this line: only one build starts.
    running = build($, now)
      .catch(async (err: unknown) => {
        const why = (err instanceof Error ? err.message : String(err)).split(/\r?\n/, 1)[0]!.slice(0, FAILURE_CHARS);
        try {
          $.ui.log(`tally: help build failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`, { to: "debug" });
          await update($, helpAtom, (d) => ({ ...d, failure: { why, at: now } }));
          invalidateWindow($);
        } catch {
          /* nothing to log to */
        }
      })
      .finally(() => {
        running = undefined;
      });
    await running;
  } catch {
    /* the tab keeps what it had */
  }
}
