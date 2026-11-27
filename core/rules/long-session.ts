import type { Evidence, HintRule } from "../hint.ts";
import { DEFAULT_WINDOW, LISTED, percentText, sessionsUsd, titleOf, tokensText } from "./shared.ts";

/** Fraction of the context window that marks a session as long, judged by its largest prompt. */
export const FULL_SHARE = 0.7;

export const longSession: HintRule = {
  id: "long-session",
  run: ({ summary, window }) => {
    const size = window ?? DEFAULT_WINDOW;
    const long = Object.entries(summary.peakContext)
      .filter(([, peak]) => peak > FULL_SHARE * size)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    if (long.length === 0) return [];
    const evidence: Evidence[] = [];
    for (const [id, peak] of long.slice(0, LISTED)) {
      const title = titleOf(summary, id);
      if (title !== undefined && title !== "") evidence.push({ label: "Session", detail: title, kind: "title" });
      evidence.push({ label: "Peak context", detail: `${tokensText(peak)} of ${tokensText(size)} tokens (${percentText(peak / size)})`, kind: "text" });
    }
    return [
      {
        rule: "long-session",
        title: "Sessions near a full window",
        usd: sessionsUsd(summary, long.map(([id]) => id)),
        summary: `${long.length} ${long.length === 1 ? "session" : "sessions"} peaked above ${percentText(FULL_SHARE)} of the context window. The whole context is read again on every request, and answers get worse as it fills.`,
        action: "Compact at a natural pause before the window fills, or break the job into new sessions that each start from a brief summary.",
        evidence,
        short: `${long.length} ${long.length === 1 ? "session" : "sessions"} near a full window`,
      },
    ];
  },
};
