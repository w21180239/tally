import type { HintInput, HintRule } from "../hint.ts";
import { percentText, usdText } from "./shared.ts";

/** Share of the requests with a recorded effort that must run at max (strictly over), and the floor on their spend in dollars. */
export const MAX_EFFORT_SHARE = 0.5;
export const MAX_EFFORT_MIN_USD = 5;

// Requests at max over requests with a recorded effort. Base: those requests.
const maxShare = ({ summary }: HintInput): number => {
  const by = summary.byEffort ?? {};
  const all = Object.values(by).reduce((n, m) => n + m.requests, 0);
  return all > 0 ? (by.max?.requests ?? 0) / all : 0;
};

export const effortMax: HintRule = {
  id: "effort-max",
  metric: maxShare,
  run: (i) => {
    const max = i.summary.byEffort?.max;
    if (max === undefined || max.usd < MAX_EFFORT_MIN_USD || maxShare(i) <= MAX_EFFORT_SHARE) return [];
    return [
      {
        rule: "effort-max",
        title: "Effort left at max",
        usd: max.usd,
        summary: `${percentText(maxShare(i))} of the requests ran at max effort, ${usdText(max.usd)} in all. Max is prone to overthinking, and thinking tokens bill at the output rate.`,
        action: "Lower the default effort · run /effort high. Raise it for the one task that needs it, and pick it at the start of a session.",
        evidence: [{ label: "Max effort", detail: `${max.requests} ${max.requests === 1 ? "request" : "requests"}, ${usdText(max.usd)}`, kind: "text" }],
        short: `${percentText(maxShare(i))} of requests at max effort`,
        metric: { name: "max-effort share of requests", value: maxShare(i) },
      },
    ];
  },
};
