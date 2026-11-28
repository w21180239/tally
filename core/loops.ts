// Self-paced /loop ticks: a main-thread request that resumes after a ScheduleWakeup call, up to the call that schedules the next wake-up.
import { streamOf } from "./stream.ts";
import { STEP_ROWS } from "./steps.ts";
import type { Steps } from "./steps.ts";
import type { UsageRow } from "./types.ts";

/** A tick of at most this many requests and under LIGHT_TICK_OUTPUT output tokens did little more than look and reschedule. */
export const LIGHT_TICK_REQUESTS = 3;
export const LIGHT_TICK_OUTPUT = 1500;
/** A request this soon after the one that scheduled the wake-up is not the wake-up. */
const MIN_WAKE_GAP_MS = 30_000;

/** `ticks`: all ticks; `light`: the small ones, with their cost, their largest prompt and the sessions they ran in. */
export type LoopTicks = { ticks: number; light: number; lightUsd: number; lightPromptTokens: number; sessions: number };

const wakes = (r: UsageRow): boolean => r.tools.some((t) => t.name === "ScheduleWakeup");
const promptOf = (r: UsageRow): number => r.tokens.input + r.tokens.cacheRead + r.tokens.cw5m + r.tokens.cw1h;

/** Ticks of the self-paced loops among `rows` (counted requests only; `usd` prices one request). The /loop forms with a fixed interval leave no marker in the transcript and are not seen. */
export function* loopTicksSteps(rows: UsageRow[], counted: (r: UsageRow) => boolean, usd: (r: UsageRow) => number): Steps<LoopTicks> {
  const streams = new Map<string, UsageRow[]>();
  let n = 0;
  for (const r of rows) {
    if (++n % STEP_ROWS === 0) yield;
    if (r.sidechain || r.agentId !== undefined || !counted(r)) continue;
    const key = streamOf(r);
    const g = streams.get(key);
    if (g) g.push(r);
    else streams.set(key, [r]);
  }
  const out: LoopTicks = { ticks: 0, light: 0, lightUsd: 0, lightPromptTokens: 0, sessions: 0 };
  const lightSessions = new Set<string>();
  for (const group of streams.values()) {
    group.sort((a, b) => a.ts - b.ts || (a.requestId < b.requestId ? -1 : 1));
    n += group.length;
    if (n >= STEP_ROWS) {
      n = 0;
      yield;
    }
    let tick: { requests: number; output: number; usd: number; prompt: number; session: string } | null = null;
    const close = (): void => {
      if (tick === null) return;
      out.ticks++;
      if (tick.requests <= LIGHT_TICK_REQUESTS && tick.output < LIGHT_TICK_OUTPUT) {
        out.light++;
        out.lightUsd += tick.usd;
        out.lightPromptTokens = Math.max(out.lightPromptTokens, tick.prompt);
        lightSessions.add(tick.session);
      }
      tick = null;
    };
    for (let i = 0; i < group.length; i++) {
      const r = group[i]!;
      if (tick === null) {
        const p = group[i - 1];
        if (p === undefined || !wakes(p) || r.ts - p.ts < MIN_WAKE_GAP_MS) continue;
        tick = { requests: 0, output: 0, usd: 0, prompt: 0, session: r.sessionId };
      }
      tick.requests++;
      tick.output += r.tokens.output;
      tick.usd += usd(r);
      tick.prompt = Math.max(tick.prompt, promptOf(r));
      if (wakes(r)) close();
    }
    close();
  }
  out.sessions = lightSessions.size;
  return out;
}
