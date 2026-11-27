// A plugin as rules and reports see it: its token load per main request, and whether the span touched it.
import { residentTokens } from "./breakdown.ts";
import type { BreakdownSnapshot } from "./breakdown.ts";
import type { Summary } from "./summary.ts";

/** `tokensPerRequest`: tokens that its skill and agent entries and resident MCP schemas add to each main request. */
export type InstalledPlugin = { name: string; tokensPerRequest: number; used: boolean };

/** MCP servers a plugin folder declares; skills and agents are matched by the `<name>:` prefix. */
export type PluginInventory = { name: string; mcpServers: string[] };

// Wire names fold anything outside letters, digits and underscore to "_".
const fold = (s: string): string => s.toLowerCase().replace(/[^a-z0-9_]/g, "_");

/** The wire name of an MCP server a plugin ships. */
export const pluginServerName = (plugin: string, server: string): string => `plugin_${fold(plugin)}_${fold(server)}`;

type Used = Pick<Summary, "byPlugin" | "bySkill" | "bySubType" | "byMcp">;

/**
 * Each inventoried plugin with the tokens it adds per request (from `snap`; none without one) and whether the
 * span used it: through attribution, one of its skills, one of its agent types or one of its MCP servers.
 */
export function pluginsFrom(inventory: PluginInventory[], snap: BreakdownSnapshot | null, used: Used): InstalledPlugin[] {
  const resident = snap === null ? {} : residentTokens(snap);
  return inventory.map((p) => {
    const lower = p.name.toLowerCase();
    const ns = `${lower}:`;
    const inNs = (k: string): boolean => k.toLowerCase().startsWith(ns);
    const servers = new Set(p.mcpServers.map((s) => pluginServerName(p.name, s)));
    let tokens = 0;
    if (snap !== null) {
      for (const [k, n] of Object.entries(snap.skills)) if (inNs(k)) tokens += n;
      for (const [k, n] of Object.entries(snap.agents)) if (inNs(k)) tokens += n;
      for (const [k, n] of Object.entries(resident)) if (servers.has(k)) tokens += n;
    }
    const attributed = (k: string): boolean => k.toLowerCase() === lower || k.toLowerCase().startsWith(`${lower}@`);
    const wasUsed =
      Object.keys(used.byPlugin).some(attributed) || Object.keys(used.bySkill).some(inNs) || Object.keys(used.bySubType).some(inNs) || Object.keys(used.byMcp).some((k) => servers.has(k));
    return { name: p.name, tokensPerRequest: tokens, used: wasUsed };
  });
}
