// Markdown rendering of a report in five sections: Summary, Tables, Drivers, Baseline comparison, Confidence. Session titles never appear;
// hint evidence is the redacted form `buildReport` made.
import type { Hint } from "../core/hint.ts";
import { activeDays, tokensText } from "../core/rules/shared.ts";
import type { Money } from "../core/summary.ts";
import { DAY_MS } from "../core/time.ts";
import { PRICING_URL } from "../engine/price-update.ts";
import { RUN_RATE_DAYS } from "./build.ts";
import type { Report } from "./build.ts";

const ROWS = 10;

const usd = (n: number): string => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const pct = (part: number, whole: number): string => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%");
const stamp = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const cell = (s: string): string => s.replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|");
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

// Hint text is written for the window (cents, middle dots, ellipses); the report file stays ASCII so any editor or
// console code page shows it as written. Other characters (a repository name in another script) pass through.
const ASCII_OF: Record<string, string> = { "·": "-", "…": "...", "—": "-", "–": "-", "×": "x", "→": "->", "≥": ">=", "≤": "<=", "‘": "'", "’": "'", "“": '"', "”": '"' };
export const plain = (s: string): string =>
  s
    .replace(/(\d+(?:\.\d+)?)¢/g, (_, c: string) => {
      const d = Number(c) / 100;
      return `$${d.toFixed(d >= 0.005 || d === 0 ? 2 : 4)}`;
    })
    .replace(/[·…—–×→≥≤‘’“”]/g, (ch) => ASCII_OF[ch] ?? ch);

function table(head: string[], rows: string[][]): string {
  return [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
}

function ranked(rec: Record<string, Money>, total: number): string[][] {
  return Object.entries(rec)
    .sort((a, b) => b[1].usd - a[1].usd || (a[0] < b[0] ? -1 : 1))
    .slice(0, ROWS)
    .map(([name, m]) => [name, String(m.requests), usd(m.usd), pct(m.usd, total)]);
}

function summarySection(r: Report): string {
  const s = r.summary;
  const days = (s.to - s.from) / DAY_MS;
  const lines = [
    `Window: ${stamp(s.from)} to ${stamp(s.to)} (${days >= 1 ? plural(Math.round(days), "day") : `${Math.max(1, Math.round(days * 24))} h`})${r.repo === undefined ? ", all repositories" : `, repository ${r.repo}`}.`,
    "",
    `- Total: ${usd(s.total.usd)} over ${plural(s.total.requests, "request")}, at API list prices.`,
    `- Main thread: ${usd(s.main.usd)} (${pct(s.main.usd, s.total.usd)}); sub-agents: ${usd(s.sub.usd)} (${pct(s.sub.usd, s.total.usd)}).`,
  ];
  if (s.fast.usd > 0) lines.push(`- Fast mode: ${usd(s.fast.usd)} (${pct(s.fast.usd, s.total.usd)}).`);
  const c = s.compaction;
  if (c !== undefined && c.savedTokens > 0) lines.push(`- Compaction saved ~${usd(c.savedUsd)} across ${plural(c.count, "compaction")} (about ${tokensText(c.savedTokens)} tokens not re-read), a lower bound at cache-read prices.`);
  const worth = r.hints.filter((h) => h.usd > 0).length;
  lines.push(r.hints.length === 0 ? "- Hints: none for this window." : `- Hints: ${r.hints.length}, ${worth} with a dollar figure. The figures are estimates that overlap, so they are not added up.`);
  return lines.join("\n");
}

function tablesSection(r: Report): string {
  const s = r.summary;
  const out: string[] = [];
  const models = ranked(s.byModel, s.total.usd);
  out.push("### By model", "", models.length === 0 ? "No requests." : table(["Model", "Requests", "Spend", "Share"], models), "");
  const repos = ranked(s.byRepo, s.total.usd);
  out.push("### By repository", "", repos.length === 0 ? "No requests." : table(["Repository", "Requests", "Spend", "Share"], repos), "");
  const top = s.topSessions.slice(0, ROWS);
  out.push("### Costliest sessions", "");
  out.push(top.length === 0 ? "No sessions." : table(["Session", "Repository", "Started", "Spend"], top.map((t) => [t.sessionId.slice(0, 8), t.repo, stamp(t.started), usd(t.usd)])));
  return out.join("\n");
}

function hintBlock(h: Hint, i: number): string {
  const tags = [h.urgent === true ? "urgent" : "", h.projected === true ? "estimate under a what-if" : "", h.confidence === "low" ? "low confidence" : ""].filter((t) => t !== "");
  const lines = [`### ${i + 1}. ${plain(h.title)}`, "", `Rule: ${h.rule}`, "", `${h.usd > 0 ? usd(h.usd) : "No dollar figure"}${tags.length === 0 ? "" : ` (${tags.join(", ")})`}`, "", plain(h.summary), "", `Action: ${plain(h.action)}`];
  // A row `redact` blanked (a session title) carries nothing to read.
  const shown = h.evidence.filter((e) => e.detail !== "");
  if (shown.length > 0) lines.push("", "Evidence:", ...shown.map((e) => `- ${plain(e.label)}: ${plain(e.detail)}`));
  return lines.join("\n");
}

function driversSection(r: Report): string {
  return r.hints.length === 0 ? "Nothing was flagged in this window." : r.hints.map(hintBlock).join("\n\n");
}

function baselineSection(r: Report): string {
  const c = r.compare;
  const b = r.baseline;
  if (c === undefined || b === undefined) return "No baseline compared. Run the report with saveBaseline to record one; ask with compare afterwards to see the movement.";
  const delta = c.runRate - c.baselineRunRate;
  const change = c.baselineRunRate > 0 ? ` (${delta >= 0 ? "+" : ""}${Math.round((delta / c.baselineRunRate) * 100)}%)` : "";
  const lines = [
    `Run rate: spend of the latest ${RUN_RATE_DAYS} complete days, stretched to a 30-day month.`,
    "",
    table(["", "Run rate per 30 days"], [[`Baseline (${day(b.at)})`, usd(c.baselineRunRate)], ["Now", usd(c.runRate)], ["Change", `${delta >= 0 ? "+" : ""}${usd(delta)}${change}`]]),
  ];
  if (b.perHint.length > 0) {
    const open = new Set(r.hints.map((h) => h.rule));
    const total = b.perHint.reduce((n, h) => n + h.expectedUsd, 0);
    lines.push("", `The hints at baseline pointed to up to ${usd(total)} (estimates that overlap):`, "", table(["Hint", "Expected saving", "Flagged now"], b.perHint.map((h) => [h.rule, usd(h.expectedUsd), open.has(h.rule) ? "yes" : "no"])));
  }
  return lines.join("\n");
}

function confidenceSection(r: Report): string {
  const s = r.summary;
  const active = activeDays(s);
  const lines: string[] = [];
  let level: "high" | "medium" | "low" = "high";
  const note = (to: "medium" | "low", text: string): void => {
    lines.push(`- ${text}`);
    if (to === "low" || level === "high") level = to;
  };
  if (s.total.requests === 0) note("low", r.repo === undefined ? "No requests in the window." : `No requests matched repository ${r.repo}; check the spelling.`);
  if (r.unread !== undefined) note("low", `${plural(r.unread, "project")} not indexed yet; their spend is missing. Run again once the scan finishes.`);
  if (s.unpriced.length > 0) note("low", `Missing prices for ${s.unpriced.join(", ")}; their requests are counted as $0.`);
  if (s.total.requests > 0 && active < 3) note("medium", `Only ${plural(active, "active day")} of data; averages and run rates are thin.`);
  const low = r.hints.filter((h) => h.confidence === "low").length;
  if (low > 0) note("medium", `${plural(low, "hint")} marked low confidence.`);
  const est = r.hints.filter((h) => h.projected === true).length;
  if (est > 0) lines.push(`- ${plural(est, "hint")} give a projected saving under a what-if, not billed spend.`);
  lines.push("- Prices are the API list prices; a subscription bills differently.");
  if (r.prices !== undefined) lines.push(`- Price table: ${r.prices.source === "builtin" ? `built-in (${day(r.prices.updatedAt)})` : `fetched ${day(r.prices.updatedAt)} from ${PRICING_URL.replace(/^https:\/\//, "")}`}.`);
  return [`Overall: ${level}.`, "", ...lines].join("\n");
}

/** The report as a markdown document. */
export function renderMarkdown(r: Report): string {
  return ["# API spend report", "", "## Summary", "", summarySection(r), "", "## Tables", "", tablesSection(r), "", "## Drivers", "", driversSection(r), "", "## Baseline comparison", "", baselineSection(r), "", "## Confidence", "", confidenceSection(r), ""].join("\n");
}
