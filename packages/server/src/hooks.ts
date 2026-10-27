/**
 * Runtime hooks the server hands to core. Core cannot import the network package
 * (it would be a cycle), so the server bridges the two: the OIP describer renders
 * a typed A2A data part for the model, and the prompt hook adds the network
 * guidance for the principal the agent is talking to.
 */
import type { Channel, Principal } from "@open-instinct/core";
import { decodeOip, describeOip, networkGuidance } from "@open-instinct/network";

/** One paragraph for a valid OIP/1 part; undefined for anything else so core falls back to JSON. */
export function describeDataPart(data: Record<string, unknown>): string | undefined {
  const oip = decodeOip(data);
  return oip ? describeOip(oip) : undefined;
}

/** Extra system prompt sections for a principal. Only the network guidance for now. */
export function promptExtraFor(principal: Principal, _channel: Channel, businessMode = false): string[] {
  return [networkGuidance(principal, businessMode)];
}
