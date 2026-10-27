export interface Citation { sourceId: string; sourceVersion: number; locator: string }
export interface SourcedDecimal { value: string; citation: Citation }
export type Pricing =
  | { kind: "fixed"; currency: string; amount: SourcedDecimal }
  | { kind: "rate"; currency: string; rate: SourcedDecimal; quantity: SourcedDecimal; unit: string }
  | { kind: "range"; currency: string; minimum: SourcedDecimal; maximum: SourcedDecimal }
  | { kind: "custom"; reason: string };
export interface PriceResult { kind: Pricing["kind"]; currency: string | null; minimumMinor: number | null; maximumMinor: number | null; citations: Citation[]; missing: string | null }

export function currencyDigits(currency: string): number {
  if (!/^[A-Z]{3}$/.test(currency) || !Intl.supportedValuesOf("currency").includes(currency)) throw new Error("Unknown currency");
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits!;
}
function decimal(value: string, digits: number): bigint {
  if (typeof value !== "string" || value.length > 32 || !/^\d+(?:\.\d+)?$/.test(value)) throw new Error("Expected nonnegative decimal string");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > digits) throw new Error("Decimal precision exceeds supported units");
  return BigInt(whole!) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, "0") || "0");
}
function checked(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < 0n) throw new Error("Money overflow");
  return Number(value);
}
export function minorUnits(value: string, currency: string): number { return checked(decimal(value, currencyDigits(currency))); }
export function calculatePrice(price: Pricing, validateCitation: (citation: Citation) => void): PriceResult {
  if (price.kind === "custom") {
    if (!price.reason.trim()) throw new Error("Custom assessment requires missing information");
    return { kind: "custom", currency: null, minimumMinor: null, maximumMinor: null, citations: [], missing: price.reason };
  }
  const citations: Citation[] = [];
  const amount = (input: SourcedDecimal): bigint => { validateCitation(input.citation); citations.push(input.citation); return decimal(input.value, currencyDigits(price.currency)); };
  let minimum: bigint, maximum: bigint;
  if (price.kind === "fixed") minimum = maximum = amount(price.amount);
  else if (price.kind === "range") { minimum = amount(price.minimum); maximum = amount(price.maximum); if (maximum < minimum) throw new Error("Reversed price range"); }
  else {
    if (!price.unit.trim()) throw new Error("Rate unit required");
    const rate = amount(price.rate);
    validateCitation(price.quantity.citation); citations.push(price.quantity.citation);
    const product = rate * decimal(price.quantity.value, 6);
    // Round once, half up, at the currency's minor unit. Never use binary floating point.
    minimum = maximum = (product + 500_000n) / 1_000_000n;
  }
  return { kind: price.kind, currency: price.currency, minimumMinor: checked(minimum), maximumMinor: checked(maximum), citations, missing: null };
}
export function addMinorUnits(values: number[]): number {
  return checked(values.reduce((sum, value) => { if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid minor units"); return sum + BigInt(value); }, 0n));
}
