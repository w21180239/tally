import { describe, expect, test } from "claude-code/testing";
import { BAR_FILL, PART_COLORS, PART_FILLS, PART_GLYPHS, barRuns, partGlyph, selectedProps, textBar, toneOfCache, toneOfShare } from "../view/theme.ts";

const luminance = (hex: string): number => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const contrast = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

describe("palette", () => {
  test("every fixed Svg fill is readable as a graphic (3:1) on a white and on a near-black background", () => {
    for (const fill of [...Object.values(BAR_FILL), ...PART_FILLS]) {
      expect(contrast(fill, "#ffffff")).toBeGreaterThanOrEqual(3);
      expect(contrast(fill, "#1e1e1e")).toBeGreaterThanOrEqual(3);
    }
  });

  test("the categories never borrow a status colour, and each part has its own glyph and colour", () => {
    for (const c of PART_COLORS) expect(["success", "warning", "error"]).not.toContain(c);
    expect(new Set(PART_GLYPHS).size).toBe(PART_GLYPHS.length);
    expect(new Set(PART_COLORS).size).toBe(PART_COLORS.length);
    expect(partGlyph(0)).not.toBe(partGlyph(1));
    // A fifth part reuses a shape, in a colour no earlier part with that shape has.
    expect(partGlyph(4)).toBe(partGlyph(0));
    expect(PART_COLORS[4]).not.toBe(PART_COLORS[0]);
  });

  test("thresholds: usage turns amber at half and red at 80%; a cache turns amber at a fifth left and red when expired", () => {
    expect(toneOfShare(0.49)).toBe("success");
    expect(toneOfShare(0.5)).toBe("warning");
    expect(toneOfShare(0.8)).toBe("error");
    expect(toneOfCache(0.5, false)).toBe("success");
    expect(toneOfCache(0.2, false)).toBe("warning");
    expect(toneOfCache(0, true)).toBe("error");
  });

  test("the selected choice is bold and underlined, the others dim", () => {
    expect(selectedProps(true)).toEqual({ weight: "bold", underline: true });
    expect(selectedProps(false)).toEqual({ dimColor: true });
  });

  test("a bar's two runs add up to the bar", () => {
    const r = barRuns(0.25, 8);
    expect(r.filled + r.empty).toBe(textBar(0.25, 8));
    expect(r.filled).toHaveLength(2);
    expect(barRuns(NaN, 4).filled).toBe("");
  });
});
