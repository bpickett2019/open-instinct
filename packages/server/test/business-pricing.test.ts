import { describe, expect, it } from "vitest";
import { addMinorUnits, calculatePrice, minorUnits, type Citation } from "../src/business-pricing.js";

const citation: Citation = { sourceId: "rate-source", sourceVersion: 1, locator: "paragraph:1" };
const sourced = (value: string) => ({ value, citation });
describe("checked sourced commercial arithmetic", () => {
  it("keeps decimal fixed prices and currency minor units exact", () => {
    expect(minorUnits("0.29", "USD")).toBe(29);
    expect(minorUnits("123", "JPY")).toBe(123);
    expect(minorUnits("1.234", "KWD")).toBe(1234);
    expect(calculatePrice({ kind: "fixed", currency: "USD", amount: sourced("199.99") }, () => {}).minimumMinor).toBe(19999);
    expect(addMinorUnits([29, 71])).toBe(100);
  });
  it("rounds a rate formula once at the minor unit and retains both sources", () => {
    const result = calculatePrice({ kind: "rate", currency: "USD", rate: sourced("0.01"), quantity: sourced("1.5"), unit: "hour" }, () => {});
    expect(result.minimumMinor).toBe(2);
    expect(result.citations).toHaveLength(2);
    expect(calculatePrice({ kind: "rate", currency: "USD", rate: sourced("87.35"), quantity: sourced("2.25"), unit: "hour" }, () => {}).minimumMinor).toBe(19654);
  });
  it("returns ranges and explicit custom assessment instead of inventing prices", () => {
    expect(calculatePrice({ kind: "range", currency: "USD", minimum: sourced("20"), maximum: sourced("40") }, () => {})).toMatchObject({ minimumMinor: 2000, maximumMinor: 4000 });
    expect(calculatePrice({ kind: "custom", reason: "Site measurements missing" }, () => {})).toMatchObject({ minimumMinor: null, maximumMinor: null, missing: "Site measurements missing" });
    expect(() => calculatePrice({ kind: "range", currency: "USD", minimum: sourced("40"), maximum: sourced("20") }, () => {})).toThrow(/range/);
  });
  it("refuses unsupported precision, binary-number inputs, invalid currency and overflow", () => {
    for (const value of ["1e2", "-1", "NaN", "0.001", " 1", "", "9007199254740992"]) expect(() => minorUnits(value, "USD")).toThrow();
    expect(() => minorUnits("1", "XYZ")).toThrow(/currency/);
    expect(() => minorUnits("1.5", "JPY")).toThrow(/precision/);
    expect(() => addMinorUnits([Number.MAX_SAFE_INTEGER, 1])).toThrow(/overflow/);
    expect(() => calculatePrice({ kind: "rate", currency: "USD", rate: sourced("99999999999999"), quantity: sourced("99999999"), unit: "unit" }, () => {})).toThrow(/overflow/);
  });
  it("will not use stale or unsourced commercial inputs", () => {
    expect(() => calculatePrice({ kind: "fixed", currency: "USD", amount: sourced("10") }, () => { throw new Error("obsolete citation"); })).toThrow(/obsolete/);
  });
});
