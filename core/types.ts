export type Tokens = { input: number; output: number; cacheRead: number; cw5m: number; cw1h: number };

export type RawUsage = {
  requestId: string;
  sessionId: string;
  ts: number;
  model: string;
  tokens: Tokens;
  fast: boolean;
  sidechain: boolean;
  cwd?: string;
};
