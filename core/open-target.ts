// Which tab and span `/tally` opens on. parseArgs keeps the last tab word; `usage session` in either order
// means the Usage tab on the session span, and a bare `session` the Session tab.
import type { ParsedArgs, TabId } from "./args.ts";
import type { Span } from "./summary.ts";

export function openTarget(input: string, a: Pick<ParsedArgs, "tab" | "span">): { tab?: TabId; span?: Span } {
  // Quoted words are data, never keywords.
  const words = input.replace(/"[^"]*"|'[^']*'/g, " ").toLowerCase().split(/\s+/);
  if (words.includes("usage") && words.includes("session")) return { tab: "usage", span: "session" };
  return { ...(a.tab !== undefined && { tab: a.tab }), ...(a.span !== undefined && { span: a.span }) };
}
