// The element table a drawing uses: the surface's own primitives, and what the surface can show.
import type { BoxProps, ButtonProps, EngineInterface, ElementConstructor, RenderInput, SvgProps, TextProps } from "claude-code";

export type Table = {
  Box: ElementConstructor<BoxProps>;
  Text: ElementConstructor<TextProps>;
  Button: ElementConstructor<ButtonProps>;
  /** Null on the terminal, which draws bars as text. */
  Svg: ElementConstructor<SvgProps> | null;
  surface: string;
  /** Only the terminal says its keys: key line, hotkey faces. */
  hasKeys: boolean;
  /** The columns the drawing has: what the grid of grid.ts is cut from. */
  cols: number;
};

// `$.ui.resolve` is told the surface by the render input; a Pane and the band share the primitives used here.
export function tableOf($: EngineInterface, e: RenderInput<"Pane"> | RenderInput<"AbovePrompt">): Table {
  const t = $.ui.resolve(e as RenderInput<"Pane">) as unknown as Record<string, unknown>;
  const Svg = e.surface !== "terminal" && "Svg" in t ? (t.Svg as Table["Svg"]) : null;
  return { Box: t.Box as Table["Box"], Text: t.Text as Table["Text"], Button: t.Button as Table["Button"], Svg, surface: e.surface, hasKeys: e.surface === "terminal", cols: e.props.bodyColumns };
}
