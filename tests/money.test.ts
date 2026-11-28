import { describe, expect, test } from "claude-code/testing";
import { formatMoney, headlineMoney, moneyBlock } from "../core/money.ts";

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

describe("moneyBlock", () => {
  const auto = (v: number[], m: "cents-and-dollars" | "cents" | "dollars" = "cents-and-dollars", d: "auto" | "0" | "1" | "2" | "3" | "4" = "auto") => moneyBlock(v, m, d);

  test("a block with an amount of $1 or more is all dollars, tiny amounts read <$0.01", () => {
    expect(auto([0.0013, 18.39, 53.5587, 0, 29.12])).toEqual(["<$0.01", "$18.39", "$53.56", "$0.00", "$29.12"]);
  });

  test("a block under $1 is all cents with one place", () => {
    expect(auto([0.0002, 0.1286, 0.5])).toEqual(["<0.1¢", "12.9¢", "50.0¢"]);
    expect(auto([0])).toEqual(["0.0¢"]);
  });

  test("the unit follows the largest amount after rounding to a cent", () => {
    expect(auto([0.9996, 0.2])).toEqual(["$1.00", "$0.20"]);
  });

  test("the money setting fixes the unit for the whole block", () => {
    expect(auto([0.0013, 18.39], "cents")).toEqual(["0.1¢", "1839.0¢"]);
    expect(auto([0.0013, 0.5], "dollars")).toEqual(["<$0.01", "$0.50"]);
  });

  test("fixed decimals apply to the whole block and shrink together to fit 7 characters", () => {
    expect(auto([0.5, 2], "cents-and-dollars", "3")).toEqual(["$0.500", "$2.000"]);
    expect(auto([0.0004, 12.3456], "dollars", "4")).toEqual(["<$0.001", "$12.346"]);
    expect(auto([0.0004, 1], "dollars", "0")).toEqual(["<$1", "$1"]);
  });

  test("from $1,000 the block is whole dollars", () => {
    expect(auto([1234.5, 3.2, 0.001])).toEqual(["$1,235", "$3", "$0"]);
  });

  test("every row of a block is the same unit and no longer than 7 characters", () => {
    const modes = ["cents-and-dollars", "cents", "dollars"] as const;
    const decs = ["auto", "0", "1", "2", "3", "4"] as const;
    const sets = [[0, 0.0004, 0.5], [0.99999, 1, 9.999], [99.99, 999.99, 999.996], [1000, 12345.67], [-0.5, 2], [1e6, 1e15], []];
    for (const m of modes) for (const d of decs) for (const set of sets) for (const s of moneyBlock(set, m, d)) if (s.length > 7) throw new Error(`${set} ${m} ${d} -> ${s}`);
  });

  test("a headline is dollars unless cents are asked for", () => {
    expect(headlineMoney(0.0268, "cents-and-dollars", "auto")).toBe("$0.03");
    expect(headlineMoney(1.16, "cents-and-dollars", "auto")).toBe("$1.16");
    expect(headlineMoney(0.0268, "cents", "auto")).toBe("2.7¢");
  });
});
