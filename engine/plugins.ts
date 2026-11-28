// Reads the plugin registry (`installed_plugins.json` in the config folder) and each plugin folder for the MCP servers it declares:
// a missing or odd file reads as no plugins, and one bad plugin never hides the rest.
import { joinPath } from "../core/path.ts";
import type { PluginInventory } from "../core/plugins.ts";
import type { StoreEnv } from "./store-index.ts";

type Tick = () => Promise<void>;
const noTick: Tick = async () => {};

/** The registry file of installed plugins. */
export const registryPath = (cfg: string): string => joinPath(cfg, "plugins", "installed_plugins.json");

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

async function readJson(env: StoreEnv, path: string): Promise<unknown> {
  try {
    return JSON.parse(await env.fs.read(path, { as: "text" }));
  } catch {
    return undefined;
  }
}

// An entry is one install: `{ installPath, scope, ... }`; a plugin holds a list of them (older files: a single one).
function installPathOf(entry: unknown): string | undefined {
  const list = Array.isArray(entry) ? entry : [entry];
  const paths = list.filter(isRecord).filter((e) => typeof e.installPath === "string" && e.installPath !== "");
  const mine = paths.find((e) => e.scope === "user") ?? paths[0];
  return mine === undefined ? undefined : (mine.installPath as string);
}

// A servers value is the map itself, or `{ mcpServers: map }`.
function serverNames(doc: unknown): string[] {
  if (!isRecord(doc)) return [];
  return Object.keys(isRecord(doc.mcpServers) ? doc.mcpServers : doc);
}

async function mcpServersOf(env: StoreEnv, dir: string): Promise<string[]> {
  const names = new Set(serverNames(await readJson(env, joinPath(dir, ".mcp.json"))));
  const manifest = await readJson(env, joinPath(dir, ".claude-plugin", "plugin.json"));
  if (isRecord(manifest)) {
    const decl = manifest.mcpServers;
    if (isRecord(decl)) for (const n of Object.keys(decl)) names.add(n);
    else if (typeof decl === "string") for (const n of serverNames(await readJson(env, joinPath(dir, decl.replace(/^\.[\\/]/, ""))))) names.add(n);
  }
  return [...names].sort();
}

const slashed = (p: string): string => p.replace(/\\/g, "/").toLowerCase();

// The status line command, normalised to forward slashes and lower case; "" without one.
async function statusLineOf(env: StoreEnv, cfg: string): Promise<string> {
  const doc = await readJson(env, joinPath(cfg, "settings.json"));
  const line = isRecord(doc) && isRecord(doc.statusLine) ? doc.statusLine.command : undefined;
  return typeof line === "string" ? slashed(line) : "";
}

// A status line runs outside requests, so a plugin it calls is in use though no request names it.
const drivesStatusLine = (line: string, name: string, dir: string | undefined): boolean =>
  line !== "" && (line.includes(`/${name.toLowerCase()}/`) || (dir !== undefined && line.includes(slashed(dir))));

/** Installed plugins by name (the part of the id before `@`), each with the MCP servers it ships; sorted by name. */
export async function readInventory(env: StoreEnv, cfg: string, tick: Tick = noTick): Promise<PluginInventory[]> {
  const registry = await readJson(env, registryPath(cfg));
  const plugins = isRecord(registry) && isRecord(registry.plugins) ? registry.plugins : {};
  const line = await statusLineOf(env, cfg);
  const out = new Map<string, PluginInventory>();
  for (const [id, entry] of Object.entries(plugins)) {
    await tick();
    const name = id.split("@", 1)[0]!;
    if (name === "" || out.has(name)) continue;
    const dir = installPathOf(entry);
    out.set(name, { name, mcpServers: dir === undefined ? [] : await mcpServersOf(env, dir), ...(drivesStatusLine(line, name, dir) && { statusLine: true }) });
  }
  return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
