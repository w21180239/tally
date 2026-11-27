import type { Evidence, HintRule } from "../hint.ts";
import { DEFAULT_WINDOW, LISTED, percentText, sessionsUsd, titleOf, tokensText } from "./shared.ts";

/** A session counts as long when its largest prompt exceeds this fraction of the window. */
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
        title: "Sessions close to the context limit",
        usd: sessionsUsd(summary, long.map(([id]) => id)),
        summary: `${long.length} ${long.length === 1 ? "session" : "sessions"} peaked at a prompt size over ${percentText(FULL_SHARE)} of the context limit. Each request carried that entire prompt, and answers tend to get worse as the window fills.`,
        action: "Begin a new session from a brief hand-off note, or run /compact at a task boundary, before the window fills.",
        evidence,
        short: `${long.length} ${long.length === 1 ? "session" : "sessions"} over ${percentText(FULL_SHARE)} of context capacity`,
      },
    ];
  },
};
