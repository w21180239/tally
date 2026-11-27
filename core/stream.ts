// A stream is one conversation with its own cache and context: a session's main thread, or one sub-agent transcript.
type Streamed = { sessionId: string; sidechain?: boolean; agentId?: string };

/** Key of the stream a row belongs to. A sidechain row without a transcript id shares one stream per session. */
export const streamOf = (x: Streamed): string => `${x.sessionId}\u0000${x.agentId ?? (x.sidechain ? "?" : "")}`;

/** Key of the main thread in per-agent breakdowns; a sub-agent's key is `sub:<type>`. */
export const MAIN_AGENT = "main";

/** The agent a request or line belongs to: the main thread, or its sub-agent's type. */
export const agentKeyOf = (r: { sidechain?: boolean; agentId?: string; agentType?: string }): string =>
  r.sidechain === true || r.agentId !== undefined ? `sub:${r.agentType ?? "sub-agent"}` : MAIN_AGENT;
