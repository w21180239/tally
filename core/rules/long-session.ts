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
      evidence.push({ label: "Peak context", detail: `${percentText(peak / size)} full: ${tokensText(peak)} tokens in a ${tokensText(size)} window`, kind: "text" });
    }
    return [
      {
        rule: "long-session",
        title: "Context windows filling up",
        usd: sessionsUsd(summary, long.map(([id]) => id)),
        summary: `${long.length} ${long.length === 1 ? "session" : "sessions"} peaked beyond ${percentText(FULL_SHARE)} of the context size. Each request re-sends the full context, and answer quality drops as it fills.`,
        action: "Run /compact at a natural break before the window is full, or start a fresh session seeded with a brief summary.",
        evidence,
        short: `${long.length} ${long.length === 1 ? "session" : "sessions"} past ${percentText(FULL_SHARE)} context`,
      },
    ];
  },
};
