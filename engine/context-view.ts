// What the Context tab reads: the engine's breakdown of the live session (the quick local estimate first, the
// counted one when it lands), which entries nothing has called lately, and where each sub-agent stands. The tab draws
// whatever the atoms last held and asks for a refresh when they are stale.
import { atom, read, update } from "claude-code";
import type { EngineInterface } from "claude-code";
import { contextOf, EMPTY_CONTEXT } from "../core/context.ts";
import type { ContextData, UsedNames } from "../core/context.ts";
import { mcpServerOf } from "../core/breakdown.ts";
import type { LiveState } from "../core/live-state.ts";
import { projectNameOf } from "../core/plan-scan.ts";
import { STEP_ROWS } from "../core/steps.ts";
import { HOUR_MS } from "../core/time.ts";
import { locate } from "./locate.ts";
import { loadProject } from "./project-store.ts";
import { makeSlicer } from "./slicer.ts";
import { inBackground, invalidateWindow } from "./window.ts";

/** The breakdown is read again when the tab is drawn after this long. */
export const CONTEXT_INTERVAL_MS = 120_000;
/** After a failed read, the next try waits this long. */
export const CONTEXT_RETRY_MS = 30_000;
/** Agent states are read again after this long. */
export const AGENTS_INTERVAL_MS = 10_000;
/** What counts as called: anything in the project's index over this long. */
export const USED_WINDOW_MS = 30 * 24 * HOUR_MS;
const FAILURE_CHARS = 80;

const contextAtom = atom({ plugin: "tally", key: "context" } as const, EMPTY_CONTEXT, { shape: "context-1" });

export type AgentState = { status: string; /** The agent's own window, when the engine names it. */ window?: number };
export type AgentStates = { at: number; byId: Record<string, AgentState> };
export const EMPTY_AGENT_STATES: AgentStates = { at: 0, byId: {} };
const statesAtom = atom({ plugin: "tally", key: "context-agents" } as const, EMPTY_AGENT_STATES, { shape: "context-agents-1" });

export function readContext($: EngineInterface): Promise<ContextData> {
  return read($, contextAtom);
}
export function readAgentStates($: EngineInterface): Promise<AgentStates> {
  return read($, statesAtom);
}

/** True when the tab should ask for a reading: none for this session yet, or an older one. */
export function needsContext(data: Pick<ContextData, "sessionId" | "at">, sessionId: string, now: number): boolean {
  if (sessionId === "") return false;
  return data.sessionId !== sessionId || now - data.at >= CONTEXT_INTERVAL_MS;
}

export const needsAgentStates = (s: Pick<AgentStates, "at">, now: number): boolean => now - s.at >= AGENTS_INTERVAL_MS;

/** A loop that has not ended: it is running, waiting, between turns or about to start. */
export const isActive = (status: string | undefined): boolean => status !== undefined && status !== "completed" && status !== "failed" && status !== "killed";

type Tick = () => Promise<void>;

// The skills, MCP servers and agent types the project's rows show in use, in slices; null when there is no usable
// index to ask (first run, another format, or still being built), which says nothing about what is unused.
async function usedFromIndex($: EngineInterface, now: number, tick: Tick): Promise<UsedNames | null> {
  const loc = await locate($);
  const shard = await loadProject($, loc.cfg, projectNameOf(await $.session.cwd()), now, tick, now - USED_WINDOW_MS);
  if (shard === null) return null;
  const skills = new Set<string>();
  const mcp = new Set<string>();
  const agents = new Set<string>();
  const rows = shard.usage;
  for (let i = 0; i < rows.length; i++) {
    if (i % STEP_ROWS === STEP_ROWS - 1) await tick();
    const r = rows[i]!;
    if (r.ts < now - USED_WINDOW_MS) continue;
    if (r.skill !== undefined) skills.add(r.skill);
    if (r.sidechain && r.agentType !== undefined) agents.add(r.agentType);
    for (const t of r.tools) if (t.mcpServer !== undefined) mcp.add(t.mcpServer);
  }
  return { skills: [...skills], mcp: [...mcp], agents: [...agents] };
}

/** The index's names and the live tally's, together. */
export function mergeUsed(indexed: UsedNames, live: Pick<LiveState, "toolCalls" | "agents">): UsedNames {
  const mcp = new Set(indexed.mcp);
  for (const tool of Object.keys(live.toolCalls)) {
    const server = mcpServerOf(tool);
    if (server !== null) mcp.add(server);
  }
  const agents = new Set(indexed.agents);
  for (const a of Object.values(live.agents)) agents.add(a.type);
  return { skills: indexed.skills, mcp: [...mcp], agents: [...agents] };
}

let builtAt = 0;
let builtFor = "";
let failedAt = 0;
let failedFor = "";
let running: Promise<void> | undefined;

async function build($: EngineInterface, id: string, live: Pick<LiveState, "toolCalls" | "agents">, now: number): Promise<void> {
  const quick = (await $.session.usage({ breakdown: "summary" })).context.breakdown;
  if (quick === undefined) throw new Error("the engine returned no breakdown for this session");
  const before = await readContext($);
  const carried = before.sessionId === id ? before.used : null;
  await update($, contextAtom, () => ({ ...contextOf(id, now, "estimated", quick), used: carried }));
  invalidateWindow($);

  const slicer = makeSlicer($);
  try {
    const indexed = await usedFromIndex($, now, () => slicer.check());
    if (indexed !== null) {
      const used = mergeUsed(indexed, live);
      await update($, contextAtom, (d) => (d.sessionId === id ? { ...d, used } : d));
      invalidateWindow($);
    }
  } catch {
    // The names stay as they were: nothing is marked unused on a guess.
  }

  // Exact counts are fetched last: each tool and file is counted by a separate call, and the lot takes seconds.
  try {
    const full = (await $.session.usage({ breakdown: "full" })).context.breakdown;
    if (full !== undefined) {
      await update($, contextAtom, (d) => (d.sessionId === id ? { ...contextOf(id, now, "counted", full), used: d.used } : d));
      invalidateWindow($);
    }
  } catch {
    // The estimate stands.
  }
}

/**
 * Reads the breakdown for `id` unless it is fresh (or `force`), one read at a time; a failed read is not retried for
 * CONTEXT_RETRY_MS. Never rejects.
 */
export async function refreshContext($: EngineInterface, id: string, live: Pick<LiveState, "toolCalls" | "agents">, force = false): Promise<void> {
  try {
    if (id === "") return;
    const now = await $.clock.now();
    while (running !== undefined) await running;
    if (!force && builtFor === id && now - builtAt < CONTEXT_INTERVAL_MS) return;
    if (!force && failedFor === id && now - failedAt < CONTEXT_RETRY_MS) return;
    // No await between the checks above and this line: only one read starts.
    running = build($, id, live, now)
      .then(() => {
        builtFor = id;
        builtAt = now;
        failedFor = "";
      })
      .catch(async (err: unknown) => {
        failedFor = id;
        failedAt = now;
        const why = (err instanceof Error ? err.message : String(err)).split(/\r?\n/, 1)[0]!.slice(0, FAILURE_CHARS);
        try {
          $.ui.log(`tally: context read failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`, { to: "debug" });
          await update($, contextAtom, (d) => ({ ...d, failure: { sessionId: id, why } }));
          invalidateWindow($);
        } catch {
          /* nothing to log to */
        }
      })
      .finally(() => {
        running = undefined;
      });
    await running;
  } catch {
    /* the tab keeps what it had */
  }
}

/** The agents' states from the engine, kept for the picker. A host that cannot list them leaves the last ones. */
export async function refreshAgentStates($: EngineInterface): Promise<void> {
  try {
    const now = await $.clock.now();
    const list = await $.agent.list();
    const byId: AgentStates["byId"] = {};
    for (const a of list) byId[a.id] = { status: a.status, ...(a.contextWindowSize !== undefined && { window: a.contextWindowSize }) };
    await update($, statesAtom, () => ({ at: now, byId }));
    invalidateWindow($);
  } catch {
    /* the picker shows agents without a state */
  }
}

/** The tab was drawn: ask for what is stale, off the draw. */
export function wantContext($: EngineInterface, data: ContextData, states: AgentStates, live: Pick<LiveState, "sessionId" | "toolCalls" | "agents">, now: number): void {
  if (needsContext(data, live.sessionId, now)) inBackground($, () => refreshContext($, live.sessionId, live));
  if (needsAgentStates(states, now)) inBackground($, () => refreshAgentStates($));
}
