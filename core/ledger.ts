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
    if (larger) cur.row = row;
    if (takeOwner) {
      cur.file = fileKey;
      cur.isSub = true;
    }
    return "replace";
  }

  owner(requestId: string): string | undefined {
    return this.map.get(requestId)?.file;
  }

  rows(): Iterable<UsageRow> {
    const it = this.map.values();
    return {
      [Symbol.iterator]: function* () {
        for (const e of it) yield e.row;
      },
    };
  }
}
