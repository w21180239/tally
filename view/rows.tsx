// Row drawings shared by every tab: a titled section, a row on the grid, a blank row, wrapped text and status blocks.
// `row` and `section` draw the grid of grid.ts: one row high at any width, the label cut at its end, the figures
// right-aligned, the bar column kept whether or not the row has a bar. `title`, `amountRow` and `Line` are the older
// forms the Context tab and its transcript still draw with.
import type { RenderElement } from "claude-code";
import { INDENT, SVG_BAR_H, SVG_CELL_PX, figureCell, titleParts } from "./grid.ts";
import type { Grid } from "./grid.ts";
import type { Table } from "./table.ts";
import { barRuns, svgBar, textBar, toneProps } from "./theme.ts";
import type { Tone } from "./theme.ts";

const AMOUNT_CELLS = 9;
const BAR_CELLS = 8;
const SVG_BAR_PX = 60;

export function title(t: Table, key: string, name: string, note?: string, amount?: string): RenderElement {
  const { Box, Text } = t;
  return (
    <Box key={`title-${key}`} flexDirection="row" columnGap={1}>
      <Box flexGrow={1} flexShrink={1} flexDirection="row" columnGap={1}>
        <Text weight="bold">{name}</Text>
        {note !== undefined && (
          <Text dimColor wrap="truncate-end">
            {note}
          </Text>
        )}
      </Box>
      {amount !== undefined && (
        <Box width={AMOUNT_CELLS} flexShrink={0} justifyContent="flex-end">
          <Text>{amount}</Text>
        </Box>
      )}
    </Box>
  );
}

export const blank = (t: Table, key: string): RenderElement => {
  const { Text } = t;
  return <Text key={`gap-${key}`}> </Text>;
};

/** `onPress` makes the label a button that opens what is behind the row. */
export type Line = { key: string; label: string; amount: string; share?: number | null; quiet?: boolean; onPress?: () => void };

export function amountRow(t: Table, l: Line): RenderElement {
  const { Box, Text, Button, Svg } = t;
  const share = l.share ?? null;
  const bar =
    share === null ? null : Svg === null ? (
      <Text dimColor>{textBar(share, BAR_CELLS)}</Text>
    ) : (
      <Svg source={svgBar(share, SVG_BAR_PX, SVG_BAR_H, "accent")} alt={`${Math.round(share * 100)}%`} width={SVG_BAR_PX} height={SVG_BAR_H} />
    );
  return (
    <Box key={l.key} flexDirection="row" columnGap={1}>
      <Box flexGrow={1} flexShrink={1}>
        {l.onPress === undefined ? (
          <Text wrap="truncate-end" dimColor={l.quiet === true}>
            {l.label}
          </Text>
        ) : (
          <Button key={`open-${l.key}`} plain dimColor={l.quiet === true} onPress={l.onPress}>
            {l.label}
          </Button>
        )}
      </Box>
      <Box width={AMOUNT_CELLS} flexShrink={0} justifyContent="flex-end">
        <Text dimColor={l.quiet === true}>{l.amount}</Text>
      </Box>
      {bar}
    </Box>
  );
}

/** Lines of free text under a label: at most `max`, each cut to the row. */
export function textLines(t: Table, key: string, text: string, max: number): RenderElement {
  const { Box, Text } = t;
  const lines = text.trim().split(/\r?\n/);
  const body = lines.length > max ? [...lines.slice(0, max), "..."] : lines;
  return (
    <Box key={key} flexDirection="column" paddingLeft={2}>
      {body.map((line, n) => (
        <Text key={`${key}-${n}`} dimColor wrap="truncate-end">
          {line === "" ? " " : line}
        </Text>
      ))}
    </Box>
  );
}

/** What one row of the grid says. Figures are right-aligned in their columns; `est` puts `~` before them. */
export type RowSpec = {
  key: string;
  /** The foot's fixed leading column; bold. */
  lead?: string;
  label: string;
  /** The label is indented a step (a sub-item). */
  indent?: boolean;
  tokens?: string;
  money?: string;
  est?: boolean;
  /** The bar's share, 0 to 1; null or absent leaves the bar column empty. */
  share?: number | null;
  /** The bar's colour: a threshold tone, else the text colour. */
  tone?: Tone;
  quiet?: boolean;
  bold?: boolean;
  /** The money figure's colour (a hint's saving). */
  moneyTone?: Tone;
  /** Makes the label a button that opens what is behind the row. */
  onPress?: () => void;
};

// On the terminal a row is clipped to its one line, whatever a surface does with a label that is too long.
const oneLine = (t: Table): { height?: number } => (t.hasKeys ? { height: 1 } : {});
const style = (quiet: boolean | undefined, bold: boolean | undefined): Record<string, unknown> => ({ ...(quiet === true && { dimColor: true }), ...(bold === true && { weight: "bold" }) });

function figure(t: Table, key: string, width: number, text: string, props: Record<string, unknown>): RenderElement | null {
  if (width <= 0) return null;
  const { Box, Text } = t;
  return (
    <Box width={width} flexShrink={0} justifyContent="flex-end">
      <Text wrap="truncate-end" {...props}>
        {text}
      </Text>
    </Box>
  );
}

function barCell(t: Table, g: Grid, key: string, share: number | null | undefined, tone: Tone | undefined, quiet: boolean | undefined): RenderElement | null {
  if (g.bar <= 0) return null;
  const { Box, Text, Svg } = t;
  if (share === undefined || share === null) return <Box width={g.bar} flexShrink={0} />;
  const shown = quiet === true ? "dim" : (tone ?? "text");
  if (Svg !== null) {
    const px = g.bar * SVG_CELL_PX;
    return (
      <Box width={g.bar} flexShrink={0}>
        <Svg source={svgBar(share, px, SVG_BAR_H, shown)} alt={`${Math.round(share * 100)}%`} width={px} height={SVG_BAR_H} />
      </Box>
    );
  }
  const runs = barRuns(share, g.bar);
  return (
    <Box width={g.bar} flexShrink={0} flexDirection="row">
      <Text {...toneProps(shown)}>{runs.filled}</Text>
      <Text dimColor>{runs.empty}</Text>
    </Box>
  );
}

/** One row of the grid: label, the figures and the bar, one line high at any width. */
export function row(t: Table, g: Grid, r: RowSpec): RenderElement {
  const { Box, Text, Button } = t;
  const props = style(r.quiet, r.bold);
  const label = `${r.indent === true ? " ".repeat(INDENT) : ""}${r.label}`;
  return (
    <Box key={r.key} flexDirection="row" columnGap={1} {...oneLine(t)}>
      {g.lead > 0 && (
        <Box width={g.lead} flexShrink={0}>
          <Text weight="bold" wrap="truncate-end">
            {r.lead ?? ""}
          </Text>
        </Box>
      )}
      <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
        {r.onPress === undefined ? (
          <Text wrap="truncate-end" {...props}>
            {label}
          </Text>
        ) : (
          <Button key={`open-${r.key}`} label={label} plain dimColor={r.quiet === true} onPress={r.onPress}>
            <Text wrap="truncate-end">{label}</Text>
          </Button>
        )}
      </Box>
      {figure(t, `${r.key}-tokens`, g.tokens, figureCell(r.tokens, r.est === true, g.tokens), props)}
      {figure(t, `${r.key}-money`, g.money, figureCell(r.money, r.est === true, g.money), { ...props, ...(r.moneyTone !== undefined && toneProps(r.moneyTone)) })}
      {barCell(t, g, r.key, r.share, r.tone, r.quiet)}
    </Box>
  );
}

export type SectionSpec = { key: string; name: string; note?: string; tokens?: string; money?: string; est?: boolean };

/** A section's title row: the name in bold, a dim note and a dim rule to the end of the label, then the section's totals. */
export function section(t: Table, g: Grid, s: SectionSpec): RenderElement {
  const { Box, Text } = t;
  const parts = titleParts(s.name, s.note, g.label);
  return (
    <Box key={`title-${s.key}`} flexDirection="row" columnGap={1} {...oneLine(t)}>
      {g.lead > 0 && <Box width={g.lead} flexShrink={0} />}
      <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden" flexDirection="row" columnGap={1}>
        <Text weight="bold" wrap="truncate-end">
          {parts.name}
        </Text>
        {parts.note !== "" && (
          <Text dimColor wrap="truncate-end">
            {parts.note}
          </Text>
        )}
        {parts.rule !== "" && <Text dimColor>{parts.rule}</Text>}
      </Box>
      {figure(t, `title-${s.key}-tokens`, g.tokens, figureCell(s.tokens, s.est === true, g.tokens), {})}
      {figure(t, `title-${s.key}-money`, g.money, figureCell(s.money, s.est === true, g.money), {})}
      {g.bar > 0 && <Box width={g.bar} flexShrink={0} />}
    </Box>
  );
}

/** Free text that wraps to the row, at most `max` rows, the last ending in an ellipsis. */
export function wrapped(t: Table, key: string, text: string, opts: { max: number; indent?: number; quiet?: boolean }): RenderElement {
  const { Box, Text } = t;
  return (
    <Box key={key} flexDirection="column" paddingLeft={opts.indent ?? INDENT}>
      <Text wrap="wrap" maxLines={opts.max} {...(opts.quiet === true && { dimColor: true })}>
        {text}
      </Text>
    </Box>
  );
}

/** A term and its text: the term in a column of `cells`, the text wrapping beside it so a second line hangs under the first. */
export function hanging(t: Table, key: string, term: string, text: string, opts: { cells: number; indent?: number; termColor?: string; quiet?: boolean }): RenderElement {
  const { Box, Text } = t;
  return (
    <Box key={key} flexDirection="row" columnGap={1} paddingLeft={opts.indent ?? INDENT}>
      <Box key={`${key}-term`} width={opts.cells} flexShrink={0}>
        <Text wrap="truncate-end" {...(opts.termColor === undefined ? { dimColor: true } : { color: opts.termColor })}>
          {term}
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="wrap" {...(opts.quiet === false ? {} : { dimColor: true })}>
          {text}
        </Text>
      </Box>
    </Box>
  );
}

/** A state in place of a body: the situation in one line and, dim beneath it, the step that follows. */
export function status(t: Table, key: string, head: string, next?: string): RenderElement {
  const { Box, Text } = t;
  return (
    <Box key={key} flexDirection="column">
      <Text wrap="truncate-end">{head}</Text>
      {next !== undefined && <Text dimColor wrap="wrap">{next}</Text>}
    </Box>
  );
}
