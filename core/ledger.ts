import type { UsageRow } from "./types.ts";

type Entry = { row: UsageRow; file: string; isSub: boolean };

// One row per requestId: keeps the largest output; a subagent file takes ownership from a main file.
export class Ledger {
  private map = new Map<string, Entry>();

  offer(row: UsageRow, fileKey: string, isSub: boolean): "new" | "replace" | "dup" {
    const cur = this.map.get(row.requestId);
    if (!cur) {
      this.map.set(row.requestId, { row, file: fileKey, isSub });
      return "new";
    }
    const larger = row.tokens.output > cur.row.tokens.output;
    const takeOwner = isSub && !cur.isSub && fileKey !== cur.file;
    if (!larger && !takeOwner) return "dup";
    if (larger) {
      // Ownership follows the sub-agent file: a larger main-file row inherits its sidechain flag and type.
      if (cur.isSub && !isSub) {
        row.sidechain = true;
        if (cur.row.agentType !== undefined) row.agentType = cur.row.agentType;
        if (cur.row.agentId !== undefined) row.agentId = cur.row.agentId;
      }
      cur.row = row;
    }
    if (takeOwner) {
      cur.file = fileKey;
      cur.isSub = true;
    }
    return "replace";
  }

  owner(requestId: string): string | undefined {
    return this.map.get(requestId)?.file;
  }

  get(requestId: string): UsageRow | undefined {
    return this.map.get(requestId)?.row;
  }

  rows(): UsageRow[] {
    return Array.from(this.map.values(), (e) => e.row);
  }
}
