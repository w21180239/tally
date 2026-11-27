// A sub-agent's transcript for the window's transcript view. The file is read in chunks of at most 4 MiB through the
// scanner's reader, so one of any size opens, and a running agent's is continued from where the last read ended.
import { atom, read, update } from "claude-code";
import type { EngineInterface } from "claude-code";
import { joinPath } from "../core/path.ts";
import { projectNameOf } from "../core/plan-scan.ts";
import { lastAnswer, TAIL_BYTES, transcriptBuilder } from "../core/subagent-view.ts";
import type { TranscriptBuilder, TranscriptView } from "../core/subagent-view.ts";
import type { FileState } from "../core/types.ts";
import { locate } from "./locate.ts";
import { readIncrement } from "./reader.ts";
import { makeSlicer } from "./slicer.ts";
import { invalidateWindow } from "./window.ts";

export type TranscriptEntry = {
  status: "loading" | "ready" | "failed";
  /** Why a read failed. */
  message: string;
  /** When the figures were last read. */
  at: number;
  /** Size of the file at that read. */
  bytes: number;
  view: TranscriptView | null;
};

export type Transcripts = { byAgent: Record<string, TranscriptEntry> };

const transcriptsAtom = atom({ plugin: "tally", key: "transcripts" } as const, { byAgent: {} } as Transcripts, { shape: "transcripts-1" });

export function readTranscripts($: EngineInterface): Promise<Transcripts> {
  return read($, transcriptsAtom);
}

/** A running agent's transcript is read again after this long. */
export const TRANSCRIPT_INTERVAL_MS = 15_000;
/** Agents whose read state is kept; the oldest go first. */
const KEPT = 8;

/** True when the view should ask for a read of `entry`: none yet, a failed one, or a running agent's stale one. */
export function needsTranscript(entry: Pick<TranscriptEntry, "status" | "at"> | undefined, active: boolean, now: number): boolean {
  if (entry === undefined) return true;
  if (entry.status === "loading") return false;
  if (entry.status === "failed") return now - entry.at >= TRANSCRIPT_INTERVAL_MS;
  return active && now - entry.at >= TRANSCRIPT_INTERVAL_MS;
}

type Progress = { path: string; state: FileState; builder: TranscriptBuilder };
const progress = new Map<string, Progress>();
const loading = new Set<string>();

const fileNames = (agentId: string): string[] => (agentId.startsWith("agent-") ? [`${agentId}.jsonl`, `agent-${agentId}.jsonl`] : [`agent-${agentId}.jsonl`, `${agentId}.jsonl`]);

// The transcript file of the agent under each transcript root, the first that exists.
async function findFile($: EngineInterface, sessionId: string, agentId: string): Promise<string | null> {
  const loc = await locate($);
  const project = projectNameOf(await $.session.cwd());
  for (const root of loc.roots) {
    for (const name of fileNames(agentId)) {
      const path = joinPath(root, project, sessionId, "subagents", name);
      try {
        if ((await $.fs.stat(path)).kind === "file") return path;
      } catch {
        /* not under this root */
      }
    }
  }
  return null;
}

async function put($: EngineInterface, agentId: string, entry: TranscriptEntry): Promise<void> {
  await update($, transcriptsAtom, (t) => {
    const byAgent = { ...t.byAgent, [agentId]: entry };
    const ids = Object.keys(byAgent);
    for (let i = 0; i < ids.length - KEPT; i++) delete byAgent[ids[i]!];
    return { byAgent };
  });
  invalidateWindow($);
}

/**
 * Reads agent `agentId`'s transcript (of `sessionId`) into the atom: from the start the first time, from the end of
 * the last read after that. One read of an agent at a time; never rejects.
 */
export async function loadTranscript($: EngineInterface, sessionId: string, agentId: string, agentType: string): Promise<void> {
  if (loading.has(agentId)) return;
  loading.add(agentId);
  try {
    const now = await $.clock.now();
    const before = (await readTranscripts($)).byAgent[agentId];
    if (before === undefined || before.status !== "ready") await put($, agentId, { status: "loading", message: "", at: now, bytes: 0, view: null });
    const path = await findFile($, sessionId, agentId);
    if (path === null) {
      await put($, agentId, { status: "failed", message: "its transcript is not on disk yet", at: now, bytes: 0, view: null });
      return;
    }
    const stat = await $.fs.stat(path);
    let prog = progress.get(agentId);
    // A different file, or one that shrank, is read again from the start.
    if (prog === undefined || prog.path !== path || stat.size < prog.state.size) prog = undefined;
    const builder = prog?.builder ?? transcriptBuilder();
    const slicer = makeSlicer($);
    const state = await readIncrement($, path, prog?.state, { size: stat.size, mtimeMs: stat.mtimeMs }, { path, isSub: true, agentType, repo: "" }, (p) => builder.add(p), slicer);
    progress.set(agentId, { path, state, builder });
    for (const old of [...progress.keys()].slice(0, Math.max(0, progress.size - KEPT))) progress.delete(old);
    // The last words come from the file's end: the chunked pass keeps no text.
    const from = Math.max(0, stat.size - TAIL_BYTES);
    const tail = stat.size === 0 ? "" : await $.fs.read(path, { offset: from, length: stat.size - from });
    const answer = lastAnswer(from > 0 ? tail.slice(tail.indexOf("\n") + 1) : tail);
    await put($, agentId, { status: "ready", message: "", at: now, bytes: stat.size, view: builder.view(answer) });
  } catch (err) {
    const why = (err instanceof Error ? err.message : String(err)).split(/\r?\n/, 1)[0]!.slice(0, 80);
    try {
      await put($, agentId, { status: "failed", message: `failed to read the transcript: ${why}`, at: await $.clock.now(), bytes: 0, view: null });
    } catch {
      /* the window keeps what it showed */
    }
  } finally {
    loading.delete(agentId);
  }
}
