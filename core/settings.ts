// The 11 user settings, their defaults and the validators shared by readSettings and parseArgs.
export type Decimals = "auto" | "0" | "1" | "2" | "3" | "4";

export type Settings = {
  priceUpdate: boolean;
  syncDir: string;
  // "" when unset: the engine resolves the default (hostname) at run time.
  machineName: string;
  shareDetail: "numbers" | "repos" | "full";
  redactEvidence: boolean;
  recheckDays: number;
  open: "before-first-message" | "always" | "never";
  money: "cents-and-dollars" | "cents" | "dollars";
  decimals: Decimals;
  desktopRow: boolean;
  herdrSidebar: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  priceUpdate: true,
  syncDir: "",
  machineName: "",
  shareDetail: "numbers",
  redactEvidence: false,
  recheckDays: 14,
  open: "before-first-message",
  money: "cents-and-dollars",
  decimals: "auto",
  desktopRow: true,
  herdrSidebar: false,
};

const TRUE_WORDS = ["true", "on", "yes"];
const FALSE_WORDS = ["false", "off", "no"];

// Each coercer returns undefined for an invalid value.
const bool = (v: unknown): boolean | undefined => {
  if (typeof v === "boolean") return v;
  if (typeof v !== "string") return undefined;
  const w = v.trim().toLowerCase();
  return TRUE_WORDS.includes(w) ? true : FALSE_WORDS.includes(w) ? false : undefined;
};
const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const oneOf =
  <T extends string>(...opts: T[]) =>
  (v: unknown): T | undefined => {
    if (typeof v !== "string") return undefined;
    const w = v.trim().toLowerCase();
    return opts.find((o) => o === w);
  };
const days = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
};
const decimals = (v: unknown): Decimals | undefined => {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim().toLowerCase() : "";
  return s === "auto" || s === "0" || s === "1" || s === "2" || s === "3" || s === "4" ? s : undefined;
};

export const COERCE: { [K in keyof Settings]: (v: unknown) => Settings[K] | undefined } = {
  priceUpdate: bool,
  syncDir: text,
  machineName: text,
  shareDetail: oneOf("numbers", "repos", "full"),
  redactEvidence: bool,
  recheckDays: days,
  open: oneOf("before-first-message", "always", "never"),
  money: oneOf("cents-and-dollars", "cents", "dollars"),
  decimals,
  desktopRow: bool,
  herdrSidebar: bool,
};

export const SETTING_KEYS = Object.keys(COERCE) as (keyof Settings)[];

// Invalid or missing raw values fall back to the defaults.
export function readSettings(raw: Record<string, unknown>): Settings {
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const k of SETTING_KEYS) {
    const v = COERCE[k](raw[k]);
    if (v !== undefined) out[k] = v;
  }
  return out as Settings;
}
