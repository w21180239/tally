import { describe, expect, test } from "claude-code/testing";
import { formatMoney } from "../core/money.ts";

describe("formatMoney", () => {
  test("cents-and-dollars auto", () => {
    expect(formatMoney(0.8219, "cents-and-dollars", "auto")).toBe("82.19¢");
    expect(formatMoney(2.76, "cents-and-dollars", "auto")).toBe("$2.76");
    expect(formatMoney(0.821, "cents-and-dollars", "auto")).toBe("82.1¢");
    expect(formatMoney(0.5, "cents-and-dollars", "auto")).toBe("50¢");
    expect(formatMoney(0, "cents-and-dollars", "auto")).toBe("0¢");
  });

  test("cents mode shows whole cents until $1,000", () => {
    expect(formatMoney(2.76, "cents", "auto")).toBe("276¢");
    expect(formatMoney(999.99, "cents", "auto")).toBe("99999¢");
    expect(formatMoney(1234.5, "cents", "auto")).toBe("$1,235");
  });

  test("dollars mode", () => {
    expect(formatMoney(0.82, "dollars", "auto")).toBe("$0.82");
    expect(formatMoney(2.7, "dollars", "auto")).toBe("$2.70");
    expect(formatMoney(1000, "dollars", "auto")).toBe("$1,000");
    expect(formatMoney(999.99, "dollars", "auto")).toBe("$999.99");
  });

  test("fixed decimals keep zeros", () => {
    expect(formatMoney(0.821, "cents-and-dollars", "2")).toBe("82.10¢");
    expect(formatMoney(2.76, "cents-and-dollars", "2")).toBe("$2.76");
    expect(formatMoney(0.8219, "cents-and-dollars", "0")).toBe("82¢");
    expect(formatMoney(2.7, "dollars", "0")).toBe("$3");
    expect(formatMoney(2.7, "dollars", "4")).toBe("$2.7000");
  });

  test("fixed decimals shrink to fit 7 characters", () => {
    expect(formatMoney(12.3456, "dollars", "4")).toBe("$12.346");
    expect(formatMoney(999.99, "cents", "2")).toBe("99999¢");
    expect(formatMoney(1234.5, "dollars", "2")).toBe("$1,235");
  });

  test("totals never pass 7 characters", () => {
    const modes = ["cents-and-dollars", "cents", "dollars"] as const;
    const decs = ["auto", "0", "1", "2", "3", "4"] as const;
    const amounts = [0, 0.0004, 0.5, 0.99999, 1, 9.999, 99.99, 999.99, 999.996, 1000, 12345.67, 99999.5, 100000, 123456, 1e6, 123456789, 1e12, 1e15, -0.5, -999.99, -12345.67, -1e6];
    for (const m of modes) {
      for (const d of decs) {
        for (const a of amounts) {
          const s = formatMoney(a, m, d);
          if (s.length > 7) throw new Error(`${a} ${m} ${d} -> ${s}`);
        }
      }
    }
  });

  test("rounding that crosses a unit boundary", () => {
    expect(formatMoney(0.99999, "cents-and-dollars", "auto")).toBe("$1.00");
    expect(formatMoney(999.996, "cents", "auto")).toBe("$1,000");
  });

  test("large amounts drop commas then compact", () => {
    expect(formatMoney(99999.5, "dollars", "auto")).toBe("$100000");
    expect(formatMoney(1e6, "dollars", "auto")).toBe("$1M");
    expect(formatMoney(1234567, "dollars", "auto")).toBe("$1.23M");
  });

  test("negative and non-finite input do not throw", () => {
    expect(formatMoney(-0.5, "cents-and-dollars", "auto")).toBe("-50¢");
    expect(formatMoney(-2.76, "dollars", "auto")).toBe("-$2.76");
    expect(formatMoney(NaN, "cents-and-dollars", "auto")).toBe("0¢");
    expect(formatMoney(Infinity, "dollars", "auto")).toBe("$0.00");
    expect(formatMoney(-Infinity, "cents", "auto")).toBe("0¢");
  });
});
