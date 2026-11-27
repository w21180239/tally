// A stream is one conversation with its own cache and context: a session's main thread, or one sub-agent transcript.
type Streamed = { sessionId: string; sidechain?: boolean; agentId?: string };

/** Key of the stream a row belongs to. A sidechain row without a transcript id shares one stream per session. */
export const streamOf = (x: Streamed): string => `${x.sessionId}\u0000${x.agentId ?? (x.sidechain ? "?" : "")}`;
