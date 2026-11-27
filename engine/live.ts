// Live tally: `turn.step`, `tool.call`, `agent.spawn`, `turn.complete`, `prompt.submit` and `session.start`
// keep one LiveState atom current for the views. Every handler is O(1) beside awaited, sliced index reads.
import { atom, read, update } from "claude-code";
import type { EngineInterface, On } from "claude-code";
import { applyEarlier, addAgent, addTool, applyStep, earlierSteps, emptyLive, stepRow, stepTokens, ttlFor } from "../core/live-state.ts";
import type { LiveState } from "../core/live-state.ts";
import { projectNameOf } from "../core/plan-scan.ts";
import { costOf, memoResolver } from "../core/pricing.ts";
import type { PriceTable } from "../core/pricing.ts";
import { BUILTIN_PRICES } from "../core/prices.builtin.ts";
import { drainAsync } from "../core/steps.ts";
import { locate } from "./locate.ts";
import { loadProject } from "./project-store.ts";
import { makeSlicer } from "./slicer.ts";

/** The atom the views read. */
export const liveAtom = atom({ plugin: "tally", key: "live" } as const, emptyLive("", 0, 0), { shape: "live-1" });

/** `$.store` key of the last rate-limit windows seen: `{ at, limits }`, kept for reports and near-limit rules. */
export const LAST_LIMITS_KEY = "lastLimits";
/** The ledger is re-read from the index at most this often on turn ends. */
export const LEDGER_INTERVAL_MS = 60_000;

export type LiveDeps = {
  prices?: PriceTable;
};

// The engine follows `$` only into functions declared at the top of the file, so the state the handlers
// share is module state, set by `wireLive`.
let prices: PriceTable = BUILTIN_PRICES;
let resolve = memoResolver(prices);
let cwd = "";
let pending: { id: string; done: Promise<void> } | undefined;
let ledgerAt = 0;

// Fire-and-forget on the clock: the hook that raised it returns first, and a failure never reaches it.
function inBackground($: EngineInterface, work: () => Promise<unknown>): void {
  $.clock.after(0, () => {
    work().catch(() => {});
  });
}

async function idOf($: EngineInterface): Promise<string> {
  try {
    return await $.session.id();
  } catch {
    return "";
  }
}

// The session's live state and the index's part of it, read for `id` and applied when still current.
async function refresh($: EngineInterface, id: string): Promise<void> {
  const at = (await read($, liveAtom)).startedAt;
  const where = cwd !== "" ? cwd : await $.session.cwd();
  const loc = await locate($);
  const now = await $.clock.now();
  const slicer = makeSlicer($);
  const tick = () => slicer.check();
  const shard = await loadProject($, loc.cfg, projectNameOf(where), now, tick);
  if (!shard) return;
  const earlier = await drainAsync(earlierSteps(shard, id, at, prices), tick);
  await update($, liveAtom, (s) => (s.sessionId === id ? applyEarlier(s, earlier) : s));
}

async function noteLimits($: EngineInterface): Promise<void> {
  try {
    const limits = (await $.session.usage()).rateLimits;
    if (limits.length > 0) await $.store.set(LAST_LIMITS_KEY, { at: await $.clock.now(), limits });
  } catch {
    /* the figures stay as last stored */
  }
}

// Starts over for `id`: zeroed, then the earlier launches' cost and cache life from the index in the background.
async function begin($: EngineInterface, id: string): Promise<void> {
  const now = await $.clock.now();
  await update($, liveAtom, () => emptyLive(id, now, 0));
  ledgerAt = now;
  inBackground($, () => refresh($, id));
}

// /clear, /resume and /branch go on under another session id with no session.start: the id is the signal.
async function ensure($: EngineInterface): Promise<LiveState> {
  const id = await idOf($);
  const cur = await read($, liveAtom);
  if (id === "" || cur.sessionId === id) return cur;
  if (pending?.id === id) {
    await pending.done;
    const after = await read($, liveAtom);
    // The state was reset under the same id (a reload kept this module): begin again.
    if (after.sessionId === id) return after;
  }
  const done = begin($, id);
  pending = { id, done };
  await done;
  return read($, liveAtom);
}

/** Sets the live state up for the session that just started; `session.start`'s own handler calls it after `next`. */
export async function startLive($: EngineInterface, e: { cwd: string }): Promise<void> {
  cwd = e.cwd;
  await ensure($);
  inBackground($, () => noteLimits($));
}

/**
 * Registers the live hooks. `session.start` is not among them: a module registers an event once, so its
 * own handler calls `startLive` after `next`.
 */
export function wireLive(on: On, deps: LiveDeps = {}): void {
  prices = deps.prices ?? BUILTIN_PRICES;
  resolve = memoResolver(prices);

  // Accounting never holds up or fails the call it watches: each handler swallows its own errors.
  on("prompt.submit", async ($, e, next) => {
    await ensure($).catch(() => undefined);
    return next(e);
  });

  on("agent.spawn", async ($, e, next) => {
    const spawned = await next(e);
    if (spawned.agentId !== undefined) {
      const id = spawned.agentId;
      await ensure($).catch(() => undefined);
      await update($, liveAtom, (s) => addAgent(s, id, e.subagentType, e.description, spawned.model, e.prompt)).catch(() => undefined);
    }
    return spawned;
  });

  on("tool.call", async ($, e, next) => {
    const tool = String(e.tool);
    let chars = 0;
    try {
      const ran = await next(e);
      chars = ran.text?.length ?? (ran.result === undefined ? 0 : JSON.stringify(ran.result).length);
      return ran;
    } finally {
      await ensure($).catch(() => undefined);
      await update($, liveAtom, (s) => addTool(s, e.agentId, tool, chars)).catch(() => undefined);
    }
  });

  // A background subagent's steps can land after the main turn ended: each counts as it arrives.
  on("turn.step", async function* ($, e, next) {
    const result = yield* next(e);
    const u = result.usage;
    if (u !== null) {
      try {
        const live = await ensure($);
        const ts = await $.clock.now();
        const { tokens, seen } = stepTokens(u, ttlFor(live, e.agentId), ts);
        const usd = costOf(stepRow(live.sessionId, ts, e.agentId, u.model, tokens), prices, resolve).usd;
        await update($, liveAtom, (s) => applyStep(s, { agentId: e.agentId, ts, messageCount: e.messageCount, model: u.model, tokens, usd, ...(seen && { seen }) }));
      } catch {
        /* this step goes uncounted */
      }
    }
    return result;
  });

  on("turn.complete", async ($, e, next) => {
    const done = await next(e);
    if (e.agentId === undefined) {
      inBackground($, () => noteLimits($));
      const now = await $.clock.now();
      if (now - ledgerAt >= LEDGER_INTERVAL_MS) {
        ledgerAt = now;
        const id = await idOf($);
        if (id !== "") inBackground($, () => refresh($, id));
      }
    }
    return done;
  });

  // The engine's own reading of the windows, whenever one moves.
  on("session.measure", async ($, e, next) => {
    if (e.rateLimits.length > 0) await $.store.set(LAST_LIMITS_KEY, { at: await $.clock.now(), limits: e.rateLimits }).catch(() => undefined);
    return next(e);
  });
}
