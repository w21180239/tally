// Row drawings shared by the Context tab and its transcript view: a titled block, a blank row, and a label with an
// amount at the right and an optional share bar.
import type { RenderElement } from "claude-code";
import type { Table } from "./table.ts";
import { svgBar, textBar } from "./theme.ts";

const AMOUNT_CELLS = 9;
const BAR_CELLS = 8;
const SVG_BAR_PX = 60;
const SVG_BAR_H = 8;

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
