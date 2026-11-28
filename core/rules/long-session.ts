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
      // An automatic compaction fires when the context runs to the host's limit: the compaction came late.
      const auto = summary.compaction?.bySession[id]?.autoPeak;
      if (auto !== undefined) evidence.push({ label: "Auto-compaction", detail: `ran to the automatic limit at ${tokensText(auto)} tokens`, kind: "text" });
    }
    const ranToLimit = long.filter(([id]) => (summary.compaction?.bySession[id]?.autoCount ?? 0) > 0).length;
    return [
      {
        rule: "long-session",
        title: "Sessions close to the context limit",
        usd: sessionsUsd(summary, long.map(([id]) => id)),
        summary: `${long.length} ${long.length === 1 ? "session" : "sessions"} peaked at a prompt size over ${percentText(FULL_SHARE)} of the context limit. Each request carried that entire prompt, and answers tend to get worse as the window fills.${ranToLimit > 0 ? ` ${ranToLimit} of them ran into automatic compaction, which fires only once the context reaches the host's limit.` : ""}`,
        action: "Compact earlier: run /compact <next step> at a task boundary, before the window fills, or /clear when the next task is unrelated. /autocompact (the autoCompactWindow setting) sets an earlier point for automatic compaction. A new session begun from a brief hand-off note works too.",
        evidence,
        short: `${long.length} ${long.length === 1 ? "session" : "sessions"} over ${percentText(FULL_SHARE)} of context capacity`,
      },
    ];
  },
};
