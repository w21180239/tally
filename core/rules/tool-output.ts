import type { FlowItem } from "../flow.ts";
import type { Evidence, HintRule } from "../hint.ts";
import { heavyParts, percentText, rereadTotal, usdText } from "./shared.ts";
import { OUTPUT_MIN_USD, OUTPUT_SHARE } from "./command-output.ts";

const LISTED_PARTS = 3;

// Advice by lower-cased tool name; a tool not listed falls to its source's advice, then to the default.
const BY_TOOL: ReadonlyMap<string, string> = new Map([
  ["grep", "Search a smaller directory with a more exact pattern, and ask for file names only before pulling matching lines."],
  ["glob", "Replace a broad glob with one scoped to the right subdirectory."],
  ["websearch", "Make queries specific and limit them to relevant domains, which returns fewer results."],
  ["webfetch", "Pick a smaller page where possible, and word the fetch prompt around the one section required."],
  ["agent", "Tell the sub-agent to return a findings list; its full write-up is otherwise appended to this context."],
  ["task", "Tell the sub-agent to return a findings list; its full write-up is otherwise appended to this context."],
]);
const BY_SOURCE: Partial<Record<FlowItem["source"], string>> = {
  read: "Locate lines with Grep, then Read with offset and limit instead of loading the whole file.",
  mcp: "Filter on the server side where the tool allows it; failing that, shrink the page size or request fewer fields.",
};
const DEFAULT_ADVICE = "Make the call more targeted; if the result stays large, redirect it to a scratch file and read just the relevant part.";

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
        title: `Tool output: over ${percentText(OUTPUT_SHARE)} of re-read spend`,
        usd,
        summary: `${heavy.length === 1 ? "One source" : `${heavy.length} sources`} returned output that remained in context and cost ${usdText(usd)} in cache reads, over ${percentText(OUTPUT_SHARE)} of all cache-read spend.`,
        action: adviceFor(top),
        evidence,
        short: `tool output re-read: ${usdText(usd)}`,
      },
    ];
  },
};
