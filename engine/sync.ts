// Multi-machine sync: writes this machine's totals file after a scan, reads the other machines' files, and runs the
// git steps when `syncDir` is a repository and the surface is the CLI. Nothing here is shown to the person: a failure
// goes to the debug log. The files of other machines are parsed one per slice.
import { atom, read, update } from "claude-code";
import type { EngineInterface } from "claude-code";
import type { Hint } from "../core/hint.ts";
import { joinPath } from "../core/path.ts";
import { sha256Hex } from "../core/sha256.ts";
import type { Settings } from "../core/settings.ts";
import type { Shard } from "../core/shard.ts";
import { MACHINE_FILE_MAX, buildMachineFileAsync, encodeMachineFile, parseMachineFile } from "../core/sync.ts";
import type { Detail, Extra, MachineFile } from "../core/sync.ts";
import { locate } from "./locate.ts";
import { currentPrices } from "./price-update.ts";
import { loadProject } from "./project-store.ts";
import { yieldNow } from "./clock.ts";
import { listProjects } from "./scanner.ts";
import { makeSlicer } from "./slicer.ts";
import { invalidateWindow } from "./window.ts";

/** The folder under `syncDir` that holds the machine files and the salt. */
export const SYNC_FOLDER = "tally";
export const SALT_FILE = "salt";
/** A scan that ends sooner than this after the last sync waits for it (one trailing run). */
export const SYNC_GAP_MS = 300_000;
/** The remote figures are read again at a draw this long after the last read. */
export const REMOTES_MS = 60_000;
const GIT_MS = 60_000;
const NAME_KEY = "machineName";
const FALLBACK_NAME = "computer";

export type SyncResult = { machines: string[]; error?: string };

/** What the Hints tab needs of another machine's file. */
export type RemoteHints = { machine: string; detail: Detail; writtenAt: number; hints?: Hint[]; hintsDropped: boolean };
export type RemotesView = { at: number; self: string; machines: RemoteHints[] };
export const EMPTY_REMOTES: RemotesView = { at: 0, self: "", machines: [] };

const remotesAtom = atom({ plugin: "tally", key: "remotes" } as const, EMPTY_REMOTES, { shape: "remotes-1" });

export function readRemotes($: EngineInterface): Promise<RemotesView> {
  return read($, remotesAtom);
}

export const needsRemotes = (v: Pick<RemotesView, "at">, now: number): boolean => now - v.at >= REMOTES_MS;

// ---- session state ----

let lastAt = -Infinity;
let gapTimer: { cancel(): void } | undefined;

/** A session starts or ends: the sync gap starts over. */
export function resetSync(): void {
  lastAt = -Infinity;
  gapTimer?.cancel();
  gapTimer = undefined;
}

// `$.process` exists only in the CLI, whose REPL draws on `terminal`; any other surface skips git and `hostname`.
// Asked at each use: a module reload (an option change) does not repeat session.start.
async function isCli($: EngineInterface): Promise<boolean> {
  try {
    return (await $.session.surfaces()).includes("terminal");
  } catch {
    return false;
  }
}

// ---- names and salt ----

/** A file-name-safe machine name: `[A-Za-z0-9._-]`, anything else `-`. */
export function safeMachineName(raw: string): string {
  const s = raw.trim().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
  return /^\.*$/.test(s) ? FALLBACK_NAME : s;
}

/** The setting, else `COMPUTERNAME`, `HOSTNAME`, then `hostname` (CLI only), else the name kept from an earlier session. */
export async function machineNameOf($: EngineInterface, settings: Pick<Settings, "machineName">): Promise<string> {
  if (settings.machineName.trim() !== "") return safeMachineName(settings.machineName);
  let found = (await $.env.get("COMPUTERNAME")) ?? "";
  if (found.trim() === "") found = (await $.env.get("HOSTNAME")) ?? "";
  if (found.trim() === "" && (await isCli($))) {
    try {
      const r = await $.process.run(["hostname"], { timeoutMs: 5000 });
      if (r.exitCode === 0) found = r.stdout;
    } catch {
      /* no hostname binary */
    }
  }
  if (found.trim() !== "") {
    const name = safeMachineName(found);
    // A surface without `hostname` reuses what the CLI found, so both name this computer alike.
    if ((await $.store.get(NAME_KEY)) !== name) await $.store.set(NAME_KEY, name);
    return name;
  }
  const kept = await $.store.get(NAME_KEY);
  return typeof kept === "string" && kept !== "" ? kept : FALLBACK_NAME;
}

type RandomSource = { getRandomValues?: (a: Uint8Array) => Uint8Array };

/** 32 random bytes as hex. Without `crypto` (not verified on Windows), `Math.random` is mixed with SHA-256 of `seed`. */
export function newSalt(seed: string, src: RandomSource | null = (globalThis as { crypto?: RandomSource }).crypto ?? null, rand: () => number = Math.random): string {
  const bytes = new Uint8Array(32);
  if (src !== null && typeof src.getRandomValues === "function") src.getRandomValues(bytes);
  else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(sha256Hex(`${seed}|${i}|${rand()}|${rand()}`).slice(0, 2), 16);
  }
  let hex = "";
  for (const b of bytes) hex += (b < 16 ? "0" : "") + b.toString(16);
  return hex;
}

// An existing salt is never overwritten: aliases on every machine hang on it.
async function saltOf($: EngineInterface, dir: string, seed: string): Promise<string | { error: string }> {
  const path = joinPath(dir, SYNC_FOLDER, SALT_FILE);
  if (await $.fs.exists(path)) {
    const text = (await $.fs.read(path, { as: "text" })).trim();
    return text === "" ? { error: "the salt file is empty" } : text;
  }
  const salt = newSalt(seed);
  await $.fs.write(path, salt);
  return salt;
}

// ---- other machines' files ----

type Tick = () => Promise<void>;

/** The valid files of the machines other than `self`, each read and parsed in its own slice. */
async function readMachineFiles($: EngineInterface, dir: string, self: string, tick: Tick): Promise<MachineFile[]> {
  const folder = joinPath(dir, SYNC_FOLDER);
  let entries: Array<{ name: string; kind: string; size: number }>;
  try {
    entries = await $.fs.list(folder);
  } catch {
    return [];
  }
  const out: MachineFile[] = [];
  for (const e of entries) {
    if (e.kind !== "file" || !e.name.endsWith(".json") || e.size > MACHINE_FILE_MAX) continue;
    await tick();
    let text: string;
    try {
      text = await $.fs.read(joinPath(folder, e.name), { as: "text" });
    } catch {
      continue;
    }
    // One file is parsed in one go (up to 4 MiB); the next starts in a slice of its own.
    await yieldNow($);
    const f = parseMachineFile(text);
    if (f !== null && f.machine !== self) out.push(f);
  }
  await tick();
  return out;
}

const liteOf = (f: MachineFile): RemoteHints => ({ machine: f.machine, detail: f.detail, writtenAt: f.writtenAt, ...(f.hints !== undefined && { hints: f.hints }), hintsDropped: f.omitted?.includes("hints") === true });

/** Reads the other machines' files and keeps what the Hints tab shows of them. */
export async function loadRemotes($: EngineInterface, settings: Pick<Settings, "syncDir" | "machineName">, tick: Tick): Promise<{ self: string; files: MachineFile[] }> {
  const self = await machineNameOf($, settings);
  const files = await readMachineFiles($, settings.syncDir, self, tick);
  const latest = new Map<string, MachineFile>();
  for (const f of files) if ((latest.get(f.machine)?.writtenAt ?? -Infinity) < f.writtenAt) latest.set(f.machine, f);
  const view: RemotesView = { at: await $.clock.now(), self, machines: [...latest.values()].map(liteOf).sort((a, b) => (a.machine < b.machine ? -1 : a.machine > b.machine ? 1 : 0)) };
  await update($, remotesAtom, () => view);
  return { self, files };
}

let reading: Promise<void> | undefined;

/** Reads the remote files into the Hints tab's atom unless a read is under way. Never rejects. */
export async function refreshRemotes($: EngineInterface, settings: Pick<Settings, "syncDir" | "machineName">): Promise<void> {
  if (reading !== undefined || settings.syncDir === "") return;
  const slicer = makeSlicer($);
  reading = loadRemotes($, settings, () => slicer.check())
    .then(() => invalidateWindow($))
    .catch((err: unknown) => {
      try {
        $.ui.log(`tally: sync: could not read the other machines: ${err instanceof Error ? err.message : String(err)}`, { to: "debug" });
      } catch {
        /* nothing to log to */
      }
    })
    .finally(() => {
      reading = undefined;
    });
  await reading;
}

// ---- the run ----

/** Supplies what `full` adds that the engine already holds (hints, context fill); called only for that level. */
export type ExtraSource = () => Promise<Extra>;

const NOTHING_TO_COMMIT = /nothing (added )?to commit|no changes added to commit/i;

/**
 * One sync: pull, write this machine's file, read the others, then add, commit and push. The git steps run only when
 * `<syncDir>/.git` exists and the surface is the CLI; their failures go to the debug log. Never rejects.
 */
export async function runSync($: EngineInterface, settings: Settings, extraOf?: ExtraSource): Promise<SyncResult> {
  const dir = settings.syncDir;
  if (dir === "") return { machines: [] };
  const log = (why: string): void => {
    try {
      $.ui.log(`tally: sync: ${why}`, { to: "debug" });
    } catch {
      /* nothing to log to */
    }
  };
  let self = "";
  try {
    self = await machineNameOf($, settings);
    const git = (await isCli($)) && (await $.fs.exists(joinPath(dir, ".git")));
    const run = async (args: string[]): Promise<{ ok: boolean; text: string }> => {
      try {
        const r = await $.process.run(["git", "-C", dir, ...args], { timeoutMs: GIT_MS, env: { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } });
        return { ok: r.exitCode === 0, text: `${r.stdout}\n${r.stderr}`.trim() };
      } catch (err) {
        return { ok: false, text: err instanceof Error ? err.message : String(err) };
      }
    };
    const step = async (args: string[], tolerate?: RegExp): Promise<boolean> => {
      const r = await run(args);
      if (!r.ok && !(tolerate?.test(r.text) ?? false)) log(`git ${args[0]} failed: ${r.text.split(/\r?\n/, 1)[0]!.slice(0, 200)}`);
      return r.ok || (tolerate?.test(r.text) ?? false);
    };

    if (git) await step(["pull", "--rebase"]);

    const now = await $.clock.now();
    const salt = await saltOf($, dir, `${now}|${self}`);
    if (typeof salt !== "string") {
      log(salt.error);
      return { machines: [self], error: salt.error };
    }

    const loc = await locate($);
    const prices = await currentPrices($);
    const slicer = makeSlicer($);
    const tick: Tick = () => slicer.check();
    const shards: Shard[] = [];
    for (const p of await listProjects($, loc.roots)) {
      await tick();
      const shard = await loadProject($, loc.cfg, p, now, tick);
      if (shard !== null) shards.push(shard);
    }
    const extra = settings.shareDetail === "full" ? await extraOf?.() : undefined;
    const file = await buildMachineFileAsync(shards, prices, { shareDetail: settings.shareDetail, machineName: self, redactEvidence: settings.redactEvidence }, salt, now, extra, tick);
    await $.fs.write(joinPath(dir, SYNC_FOLDER, `${self}.json`), encodeMachineFile(file));

    const remote = await loadRemotes($, settings, tick);
    invalidateWindow($);
    const machines = [...new Set([self, ...remote.files.map((f) => f.machine)])].sort();

    if (git && (await step(["add", SYNC_FOLDER]))) {
      if (await step(["commit", "-m", `tally: ${self}`], NOTHING_TO_COMMIT)) await step(["push"]);
    }
    return { machines };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`failed: ${error}`);
    return { machines: self === "" ? [] : [self], error };
  }
}

let flight: Promise<void> | undefined;
let queued = false;

/** After a completed scan: one sync at a time, at most one per SYNC_GAP_MS, a later one waits for the gap. Off the caller's path. */
export function syncSoon($: EngineInterface, current: () => Settings, extraOf?: ExtraSource): void {
  if (current().syncDir === "") return;
  if (flight !== undefined) {
    queued = true;
    return;
  }
  flight = (async () => {
    const now = await $.clock.now();
    const wait = lastAt + SYNC_GAP_MS - now;
    if (wait > 0) {
      gapTimer ??= $.clock.after(wait, () => {
        gapTimer = undefined;
        syncSoon($, current, extraOf);
      });
      return;
    }
    lastAt = now;
    await runSync($, current(), extraOf);
  })()
    .catch(() => {})
    .finally(() => {
      flight = undefined;
      if (queued) {
        queued = false;
        syncSoon($, current, extraOf);
      }
    });
}
