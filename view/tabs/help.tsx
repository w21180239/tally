// The Help tab: the keys, a legend for colours and glyphs, where the figures come from, the settings with their
// current values, the price table's provenance and the version. The keys come from keys.ts, the one source the key
// line at the window's foot also reads. `drawHelp` returns the rows; the tab adds no keys.
import type { RenderElement } from "claude-code";
import { PRICING_URL } from "../../engine/price-update.ts";
import type { PriceError } from "../../engine/price-update.ts";
import type { PriceTable } from "../../core/pricing.ts";
import { SETTING_KEYS } from "../../core/settings.ts";
import type { Settings } from "../../core/settings.ts";
import type { HelpData } from "../../engine/help-view.ts";
import { INDENT, TERM_KEYS, gridOf } from "../grid.ts";
import { ESC_FOLD, ESC_WORDS, TABS, keyLine } from "../keys.ts";
import type { KeyCtx } from "../keys.ts";
import { blank, hanging, row, section, wrapped } from "../rows.tsx";
import type { Table } from "../table.ts";
import { CACHE_MARK, CRIT_MARK, HINT_MARK, HOT_SHARE, PART_GLYPHS, WARN_SHARE } from "../theme.ts";

/** Unpriced models listed before the rest are counted. */
export const UNPRICED_ROWS = 10;
const LEGEND_CELLS = 8;
/** A setting's value column: `cents-and-dollars` is the longest word a setting takes. */
const VALUE_CELLS = 18;
const NOTE_INDENT = 4;
const SOURCE_LINES = 3;

export type HelpInput = {
  settings: Settings;
  /** The table in effect. */
  prices: PriceTable;
  /** The last failed price update, when there is one. */
  priceError?: PriceError;
  data: HelpData;
};

export type HelpDrawing = { rows: RenderElement[]; ctx: KeyCtx };

const PRICING_PAGE = PRICING_URL.replace(/^https:\/\//, "");

/** A day as `YYYY-MM-DD` in UTC. */
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const percent = (share: number): string => `${Math.round(share * 100)}%`;

const SOURCES = [
  "Transcripts: the session files in your Claude config folder, read by a background scan. tally never writes a transcript.",
  "Index: tally's own copy of each request's token counts, kept beside the config. The Spend, Tokens and Hints tabs read it.",
  "This session: counted live as each request finishes, so Session shows it before the index does.",
  "Prices: a built-in table, refreshed weekly from the Anthropic pricing page unless priceUpdate is off. That page is the only network call tally makes.",
  "Amounts are list-price API equivalents of your token use, not an invoice.",
];

/** Every key that works somewhere, with the words keys.ts gives it, and the keys that are not tab keys. */
const FULL: KeyCtx = { agents: true, canView: true, canGoBack: true, canFull: true, more: true, rows: true, evidence: true, adopt: true, machines: true };
const EXTRA_KEYS: Array<[string, string]> = [
  ["ctrl+x, tab", "hand the keyboard to the window"],
  ["/tally", "open the window; add a tab name or a span, or set an option like money dollars"],
];

/** The key line's entries, each split into its key and its words; one key that shows twice reads once. */
export function keyRows(): Array<[string, string]> {
  const byKey = new Map<string, string[]>();
  // Hints has the most keys, in the order the key line gives them, so it goes first.
  for (const { tab } of [...TABS].sort((a, b) => Number(b.tab === "hints") - Number(a.tab === "hints"))) {
    for (const full of keyLine(tab, FULL)) {
      const entry = full === ESC_WORDS ? ESC_FOLD : full;
      const at = entry.indexOf(" ");
      const [key, words] = at < 0 ? [entry, ""] : [entry.slice(0, at), entry.slice(at + 1)];
      const seen = byKey.get(key) ?? [];
      if (!seen.includes(words)) seen.push(words);
      byKey.set(key, seen);
    }
  }
  return [...byKey.entries()].map(([key, words]): [string, string] => [key, words.join(" / ")]);
}

const SETTING_NOTES: Record<keyof Settings, string> = {
  priceUpdate: "fetch current prices weekly",
  syncDir: "git-synced folder for sharing totals between computers",
  machineName: "this computer's label in shared totals; empty uses the hostname",
  shareDetail: "how much shared totals reveal: numbers, repos or full",
  redactEvidence: "in hint evidence, commands keep the program name, paths the file name, titles are blank",
  recheckDays: "days after a hint is adopted before tally checks whether the saving held",
  open: "fold on the first message, stay open, or open only via /tally",
  money: "unit of amounts: cents-and-dollars, cents or dollars",
  decimals: "auto trims zeros; 0-4 fixes the places",
  desktopRow: "summary line over the prompt, desktop app only",
  herdrSidebar: "also write the report to a Herdr sidebar",
};

function valueText(v: Settings[keyof Settings]): string {
  if (typeof v === "boolean") return v ? "on" : "off";
  return v === "" ? "(unset)" : String(v);
}

export function drawHelp(t: Table, i: HelpInput): HelpDrawing {
  const { Box, Text } = t;
  const { settings, prices, priceError, data } = i;
  const out: RenderElement[] = [];
  const g = gridOf(t.cols, { money: true, moneyCells: VALUE_CELLS });
  const head = gridOf(t.cols);
  const line = (key: string, text: string, tone?: "warning"): void => {
    out.push(
      <Box key={key} paddingLeft={INDENT}>
        <Text wrap="wrap" {...(tone === undefined ? { dimColor: true } : { color: tone })}>
          {text}
        </Text>
      </Box>,
    );
  };
  const legend = (key: string, term: string, text: string, color?: string): RenderElement => hanging(t, key, term, text, { cells: LEGEND_CELLS, ...(color !== undefined && { termColor: color }) });

  out.push(section(t, head, { key: "keys", name: "Keys", note: "the key line at the foot shows those that work on this tab" }));
  const rows = [...keyRows(), ...EXTRA_KEYS];
  rows.forEach(([key, words], n) => out.push(hanging(t, `key-${n}`, key, words, { cells: TERM_KEYS, termColor: "claude" })));
  out.push(blank(t, "keys"));

  out.push(section(t, head, { key: "colours", name: "Colours" }));
  out.push(legend("colour-green", "green", `under ${percent(WARN_SHARE)} of a window or budget used`, "success"));
  out.push(legend("colour-amber", "amber", `${percent(WARN_SHARE)} up to ${percent(HOT_SHARE)} used, with a word such as near limit`, "warning"));
  out.push(legend("colour-red", "red", `${percent(HOT_SHARE)} or more used; a red figure starts with ${CRIT_MARK}`, "error"));
  out.push(legend("colour-orange", "orange", "key names and the main thread's part of a bar", "claude"));
  out.push(legend("colour-dim", "dim", "secondary labels and figures"));
  out.push(legend("glyph-parts", PART_GLYPHS.join(""), "the parts of a stacked bar, each with its own colour too"));
  out.push(legend("glyph-hours", "\u{2582}\u{2583}\u{2585}\u{2587}\u{2588}", "tokens in each of the last 8 hours; taller is more, a dot is none"));
  out.push(legend("glyph-hint", HINT_MARK, "a hint was found"));
  out.push(legend("glyph-cache", CACHE_MARK, "time left before the prompt cache expires"));
  out.push(blank(t, "colours"));

  out.push(section(t, head, { key: "sources", name: "Data sources" }));
  SOURCES.forEach((s, n) => out.push(wrapped(t, `source-${n}`, s, { max: SOURCE_LINES, quiet: true })));
  out.push(blank(t, "sources"));

  out.push(section(t, head, { key: "settings", name: "Settings", note: "plugin menu or /tally <name> <value>" }));
  for (const key of SETTING_KEYS) {
    out.push(row(t, g, { key: `setting-${key}`, label: key, money: valueText(settings[key]) }));
    out.push(wrapped(t, `setting-${key}-note`, SETTING_NOTES[key], { max: 2, quiet: true, indent: NOTE_INDENT }));
  }
  out.push(blank(t, "settings"));

  out.push(section(t, head, { key: "prices", name: "Prices" }));
  const source = prices.source === "builtin" ? `built-in (${isoDay(prices.updatedAt)})` : `fetched ${isoDay(prices.updatedAt)} from ${PRICING_PAGE}`;
  out.push(
    <Box key="prices-source" paddingLeft={INDENT}>
      <Text wrap="wrap">{`Prices: ${source}`}</Text>
    </Box>,
  );
  line("prices-size", `${Object.keys(prices.models).length} models, fast mode ${prices.fastMul}x`);
  if (!settings.priceUpdate) line("prices-off", "Online update is off (priceUpdate): prices change only when tally does.");
  if (priceError !== undefined) line("prices-error", `Last price update failed (${isoDay(priceError.at)}): ${priceError.message}`, "warning");

  if (data.ready) {
    if (data.unpriced.length === 0) line("unpriced-none", "Every model in recent history has a price.");
    else {
      line("unpriced-note", "These models have no price and are counted as $0:");
      for (const m of data.unpriced.slice(0, UNPRICED_ROWS)) {
        out.push(
          <Box key={`unpriced-${m}`} paddingLeft={NOTE_INDENT}>
            <Text wrap="truncate-end">{m}</Text>
          </Box>,
        );
      }
      if (data.unpriced.length > UNPRICED_ROWS) line("unpriced-more", `${data.unpriced.length - UNPRICED_ROWS} more`);
    }
    if (data.unread > 0) line("unpriced-unread", `${data.unread} ${data.unread === 1 ? "project is" : "projects are"} not indexed yet; their models are not listed.`);
  } else if (data.failure !== undefined) {
    line("unpriced-failed", `Could not list unpriced models: ${data.failure.why}`);
  } else {
    line("unpriced-loading", "Looking for models without a price...");
  }
  out.push(blank(t, "prices"));

  out.push(section(t, head, { key: "version", name: "Version" }));
  out.push(
    <Box key="version-text" paddingLeft={INDENT}>
      <Text>{data.version === "" ? "tally (version unknown)" : `tally ${data.version}`}</Text>
    </Box>,
  );
  return { rows: out, ctx: {} };
}
