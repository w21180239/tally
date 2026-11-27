// What the Hints tab reads: the rules' findings for the live session and for the selected span (all repos or the
// live session's repository), built off the draw path. The tab draws what the atom last held and asks for a rebuild when it is
// stale. A project with no usable index counts as unread, never as empty.
import { atom, read, update } from "claude-code";
import type { EngineInterface } from "claude-code";
import { HINT_RULES, runRules } from "../core/hint.ts";
import type { Hint } from "../core/hint.ts";
import { repoOf } from "../core/path.ts";
import { BUILTIN_PRICES } from "../core/prices.builtin.ts";
import type { Shard } from "../core/shard.ts";
import { summarizeAsync, UNKNOWN_REPO } from "../core/summary.ts";
import type { Span } from "../core/summary.ts";
import { locate } from "./locate.ts";
import { loadProject } from "./project-store.ts";
import { listProjects } from "./scanner.ts";
import { makeSlicer } from "./slicer.ts";
import { invalidateWindow } from "./window.ts";

/** Findings older than this are rebuilt at the next draw of the tab. */
export const HINTS_INTERVAL_MS = 120_000;
/** A failed build is not retried sooner than this. */
export const HINTS_RETRY_MS = 30_000;
const FAILURE_CHARS = 80;

export type HintsData = {
  /** What the findings are of: `<span>|<all or repo>|<session id>`. */
  key: string;
  at: number;
  /** The repository the findings are limited to, else empty. */
  repo: string;
  /** Requests in the span; none, with projects unread, means unknown rather than empty. */
  requests: number;
  unread: number;
  session: Hint[];
  span: Hint[];
  /** Set when the last build for `key` failed and none has worked since; the tab shows it instead of waiting. */
  failure?: { key: string; why: string; at: number };
};

export const EMPTY_HINTS: HintsData = { key: "", at: 0, repo: "", requests: 0, unread: 0, session: [], span: [] };

const hintsAtom = atom({ plugin: "tally", key: "hints" } as const, EMPTY_HINTS, { shape: "hints-1" });

export function readHints($: EngineInterface): Promise<HintsData> {
  return read($, hintsAtom);
}

export type HintsWant = { span: Span; repoOnly: boolean; sessionId: string };

export const hintsKeyOf = (w: HintsWant): string => `${w.span}|${w.repoOnly ? "repo" : "all"}|${w.sessionId}`;

/** True when the tab should ask for findings: none of this key yet, or older than their interval; a failed key waits. */
export function needsHints(data: Pick<HintsData, "key" | "at" | "failure">, want: HintsWant, now: number): boolean {
  const key = hintsKeyOf(want);
  if (data.failure?.key === key && now - data.failure.at < HINTS_RETRY_MS) return false;
  return data.key !== key || now - data.at >= HINTS_INTERVAL_MS;
}

let running: Promise<void> | undefined;

async function build($: EngineInterface, want: HintsWant, now: number): Promise<void> {
  const loc = await locate($);
  const slicer = makeSlicer($);
  const tick = () => slicer.check();
  const tzOffsetMin = -new Date(now).getTimezoneOffset();
  const repo = want.repoOnly ? repoOf(await $.session.cwd()) || UNKNOWN_REPO : "";
  const shards: Shard[] = [];
  let unread = 0;
  for (const p of await listProjects($, loc.roots)) {
    await tick();
    const shard = await loadProject($, loc.cfg, p, now, tick);
    if (shard === null) unread++;
    else shards.push(shard);
  }
  const spanSummary = await summarizeAsync(shards, BUILTIN_PRICES, { span: want.span, nowMs: now, tzOffsetMin, ...(want.repoOnly && { repo }) }, tick);
  const session =
    want.sessionId === ""
      ? []
      : runRules(HINT_RULES, { scope: "session", nowMs: now, summary: await summarizeAsync(shards, BUILTIN_PRICES, { span: "session", sessionId: want.sessionId, nowMs: now, tzOffsetMin }, tick) });
  const data: HintsData = {
    key: hintsKeyOf(want),
    at: now,
    repo,
    requests: spanSummary.total.requests,
    unread,
    session,
    span: runRules(HINT_RULES, { scope: "span", nowMs: now, summary: spanSummary }),
  };
  await update($, hintsAtom, () => data);
  invalidateWindow($);
}

/** Rebuilds the findings for `want` unless they are fresh (or `force`); one build runs at a time. Never rejects. */
export async function refreshHints($: EngineInterface, want: HintsWant, force = false): Promise<void> {
  try {
    const key = hintsKeyOf(want);
    let now: number;
    // A build that started during the reads below sends the loop back to wait for it.
    for (;;) {
      while (running !== undefined) await running;
      now = await $.clock.now();
      const data = await read($, hintsAtom);
      if (running !== undefined) continue;
      if (!force && !needsHints(data, want, now)) return;
      break;
    }
    // No await between the check above and this line: only one build starts.
    running = build($, want, now)
      .catch(async (err: unknown) => {
        const why = (err instanceof Error ? err.message : String(err)).split(/\r?\n/, 1)[0]!.slice(0, FAILURE_CHARS);
        try {
          $.ui.log(`tally: hints build failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`, { to: "debug" });
          await update($, hintsAtom, (d) => ({ ...d, failure: { key, why, at: now } }));
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
