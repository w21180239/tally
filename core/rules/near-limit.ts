import type { Evidence, HintRule, LimitWindow } from "../hint.ts";
import { durationText } from "./shared.ts";

/** A window above this percent used is reported. */
export const NEAR_LIMIT_PERCENT = 80;

export const nearLimit: HintRule = {
  id: "near-limit",
  run: ({ limits, nowMs }) => {
    if (limits === undefined) return [];
    const windows: Array<[string, string, LimitWindow | undefined]> = [
      ["5-hour window", "5h", limits.fiveHour],
      ["7-day window", "7d", limits.sevenDay],
    ];
    const near = windows.filter((w): w is [string, string, LimitWindow] => w[2] !== undefined && w[2].percentUsed > NEAR_LIMIT_PERCENT && w[2].resetsAt > nowMs);
    if (near.length === 0) return [];
    const evidence: Evidence[] = near.map(([label, , w]) => ({ label, detail: `${Math.round(w.percentUsed)}% used, resets in ${durationText(w.resetsAt - nowMs)}`, kind: "text" }));
    const worst = near.reduce((a, b) => (b[2].percentUsed > a[2].percentUsed ? b : a));
    return [
      {
        rule: "near-limit",
        title: "Usage limit running low",
        usd: 0,
        urgent: true,
        summary: `Your ${worst[0]} has used ${Math.round(worst[2].percentUsed)}%. Once it reaches 100% requests wait for the reset.`,
        action: "Schedule the heavy jobs (big refactors, many parallel agents) after the reset, and give routine steps to a cheaper model meanwhile.",
        evidence,
        short: `${worst[1]} limit ${Math.round(worst[2].percentUsed)}%`,
      },
    ];
  },
};
