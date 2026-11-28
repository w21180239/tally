import { LIGHT_TICK_OUTPUT, LIGHT_TICK_REQUESTS } from "../loops.ts";
import type { Evidence, HintRule } from "../hint.ts";
import { tokensText, usdText } from "./shared.ts";

/** Light ticks and their cost, in dollars, from which a loop is reported. */
export const IDLE_LOOP_MIN_TICKS = 3;
export const IDLE_LOOP_MIN_USD = 1;

export const idleLoop: HintRule = {
  id: "idle-loop",
  run: ({ summary }) => {
    const l = summary.loops;
    if (l === undefined || l.light < IDLE_LOOP_MIN_TICKS || l.lightUsd < IDLE_LOOP_MIN_USD) return [];
    const evidence: Evidence[] = [
      { label: "Light ticks", detail: `${l.light} of ${l.ticks} ticks: ${LIGHT_TICK_REQUESTS} requests or fewer and under ${LIGHT_TICK_OUTPUT} output tokens each`, kind: "text" },
      { label: "Largest prompt", detail: `${tokensText(l.lightPromptTokens)} tokens re-sent on a tick, across ${l.sessions} ${l.sessions === 1 ? "session" : "sessions"}`, kind: "text" },
    ];
    return [
      {
        rule: "idle-loop",
        title: "Loop ticks that re-sent a large context",
        usd: l.lightUsd,
        summary: `${l.light} of ${l.ticks} self-paced loop ticks did little (${LIGHT_TICK_REQUESTS} requests or fewer, little output), yet each one sent the whole conversation again: ${usdText(l.lightUsd)} in all.`,
        action: "Stretch the interval, or end the loop when nothing is left to watch · press Esc on an empty prompt while it waits. Run /clear before starting a loop that will mostly wait, so each tick carries a small context.",
        evidence,
        short: `${l.light} light loop ticks, ${usdText(l.lightUsd)}`,
      },
    ];
  },
};
