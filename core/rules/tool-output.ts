import type { FlowItem } from "../flow.ts";
import type { Evidence, HintRule } from "../hint.ts";
import { heavyParts, percentText, rereadTotal, usdText } from "./shared.ts";
import { OUTPUT_MIN_USD, OUTPUT_SHARE } from "./command-output.ts";

const LISTED_PARTS = 3;

// Advice by tool name (lower-case). A tool missing here falls back to the advice for its source, then to the default.
const BY_TOOL: ReadonlyMap<string, string> = new Map([
  ["grep", "Tighten the pattern or directory, and list matching file names before pulling any lines."],
  ["glob", "Use a more specific glob, or point it at the subfolder you need rather than the whole tree."],
  ["websearch", "Word the query more precisely and restrict it to the domains that matter, so fewer results come back."],
  ["webfetch", "Say in the fetch prompt which section you want, or choose a smaller page."],
  ["agent", "End the delegation prompt with a request for findings only; the agent's whole write-up otherwise stays in this context."],
  ["task", "End the delegation prompt with a request for findings only; the agent's whole write-up otherwise stays in this context."],
]);
const BY_SOURCE: Partial<Record<FlowItem["source"], string>> = {
  read: "Open slices rather than whole files: locate the lines with Grep first, then pass offset and limit.",
  mcp: "Trim what the server sends back: select fewer fields, lower the page size or filter server-side; failing that, use a narrower tool.",
};
const DEFAULT_ADVICE = "Redirect bulky results to a scratch file and open just the slice that matters, or scope the call more tightly.";

const adviceFor = (f: FlowItem): string => BY_TOOL.get(f.label.toLowerCase()) ?? BY_SOURCE[f.source] ?? DEFAULT_ADVICE;

export const toolOutput: HintRule = {
  id: "tool-output",
  run: ({ summary }) => {
    const total = rereadTotal(summary);
    const heavy = heavyParts(summary.flow, ["read", "mcp", "tool"], total, OUTPUT_SHARE, OUTPUT_MIN_USD);
    if (heavy.length === 0) return [];
    const usd = heavy.reduce((n, f) => n + f.rereadUsd, 0);
    const top = heavy[0]!;
    const evidence: Evidence[] = [];
    for (const f of heavy.slice(0, LISTED_PARTS)) {
      evidence.push({ label: f.source === "read" ? "File" : "Tool", detail: f.label, kind: f.source === "read" ? "path" : "text" }, { label: "Re-read", detail: `${percentText(f.rereadUsd / total)} of ${usdText(total)} re-read`, kind: "text" });
    }
    return [
      {
        rule: "tool-output",
        title: "Bulky tool results weigh on later requests",
        usd,
        summary: `${heavy.length === 1 ? "One source" : `${heavy.length} sources`} returned results that stayed in the conversation, and later requests paid ${usdText(usd)} to re-read them.`,
        action: adviceFor(top),
        evidence,
        short: `tool results cost ${usdText(usd)} to re-read`,
      },
    ];
  },
};
