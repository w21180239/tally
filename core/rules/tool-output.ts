import type { FlowItem } from "../flow.ts";
import type { Evidence, HintRule } from "../hint.ts";
import { heavyParts, percentText, rereadTotal, usdText } from "./shared.ts";
import { OUTPUT_MIN_USD, OUTPUT_SHARE } from "./command-output.ts";

const LISTED_PARTS = 3;

// What to change depends on where the output came from.
const ADVICE = {
  search: "Make the pattern or path filter more specific and cap the results; listing file names alone is often enough.",
  web: "Pull less from the web: request only the section you need, or look for a more specific page.",
  answer: "Tell the agent in its prompt to return conclusions only, not a dump of everything it looked at.",
  read: "Load slices with the offset and limit parameters, or find the lines with Grep first, instead of pulling in complete files.",
  mcp: "Request a smaller payload from the MCP server (filters, page sizes, field lists) or pick a narrower tool, so results are short before they reach the conversation.",
  tool: "Scope the call more tightly, or save the output to a log and open just the relevant slice.",
};

// A source is `read`, `mcp` or `tool`; a tool's own name picks the closest advice.
function adviceFor(f: FlowItem): string {
  if (f.source === "read" || f.source === "mcp") return ADVICE[f.source];
  const name = f.label.toLowerCase();
  if (name === "grep" || name === "glob") return ADVICE.search;
  if (name === "webfetch" || name === "websearch") return ADVICE.web;
  if (name === "agent" || name === "task") return ADVICE.answer;
  return ADVICE.tool;
}

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
        title: "Bulky tool results keep being re-read",
        usd,
        summary: `${heavy.length === 1 ? "One source returned" : `${heavy.length} sources returned`} results that remained in the conversation; later requests re-read them for ${usdText(usd)}.`,
        action: adviceFor(top),
        evidence,
        short: `tool results re-read ${usdText(usd)}`,
      },
    ];
  },
};
