// Which transcripts to read, and in what order. Pure.
export type Listing = { project: string; path: string; size: number; mtimeMs: number };
export type Tier = "current" | "day" | "month";
export type FileJob = Listing & { tier: Tier };

export const DAY_MS = 86_400_000;
export const WINDOW_MS = 30 * DAY_MS;

const RANK: Record<Tier, number> = { current: 0, day: 1, month: 2 };

// Current project first, then files touched within 24 h, then within 30 days; older files are not scanned.
// Inside a tier the newest file comes first.
export function orderFiles(listing: Listing[], currentProject: string, nowMs: number): FileJob[] {
  const jobs: FileJob[] = [];
  for (const f of listing) {
    const age = nowMs - f.mtimeMs;
    if (age > WINDOW_MS) continue;
    const tier: Tier = f.project === currentProject ? "current" : age <= DAY_MS ? "day" : "month";
    jobs.push({ ...f, tier });
  }
  return jobs.sort((a, b) => RANK[a.tier] - RANK[b.tier] || b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// Claude Code names a project folder after its cwd with every non-alphanumeric character as "-".
export function projectNameOf(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}
