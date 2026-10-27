import { randomUUID } from "node:crypto";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { TaskRunBinding } from "@open-instinct/core";
import type { BusinessCoordinator } from "./business-coordinator.js";

/** One accounting boundary for the shared model: foreground turns and durable workers. Model currency is USD. */
export function businessUsageStream(coordinator: BusinessCoordinator, binding: TaskRunBinding | undefined, source: StreamFn): StreamFn {
  return async (model, context, options) => {
    const store = coordinator.store;
    const settings = store.settings().value;
    const rates = [model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite];
    // Codex catalog rates describe API-style estimates, not subscription charges
    // or remaining plan credits. Never turn them into a billed dollar amount.
    const priceKnown = model.provider !== "openai-codex" && rates.every(rate => Number.isFinite(rate) && rate >= 0) && rates.some(rate => rate > 0);
    if (settings.limits.modelMinor !== null && (!priceKnown || settings.usage.modelPriceUnknown)) throw new Error("Configured USD model budget cannot be enforced with unknown pricing or usage");
    const maxTokens = Math.min(options?.maxTokens ?? 4096, model.maxTokens);
    // Upper bound, not a default monetary cap. Purchase/business currency is never treated as USD.
    const reserveMinor = priceKnown ? Math.ceil((model.contextWindow * Math.max(model.cost.input, model.cost.cacheRead, model.cost.cacheWrite) + maxTokens * model.cost.output) / 10_000) : null;
    const allowance = reserveMinor === null ? undefined : { category: "model" as const, amountMinor: reserveMinor, currency: "USD" };
    const callId = randomUUID(); const started = store.now();
    const base = { taskId: binding?.taskId ?? null, runId: binding?.runId ?? null, provider: model.provider, model: model.id, status: "attempted", inputTokens: null, outputTokens: null, costMinor: null, currency: null, latencyMs: 0 };
    const invoke = async (signal: AbortSignal) => {
      const record = store.put("usage", callId, base, null);
      try {
        const stream = await source(model, context, { ...options, maxTokens, signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal });
        const result = await stream.result(); const usage = result.usage;
        const reported = priceKnown && Number.isFinite(usage.cost.total) && usage.cost.total >= 0;
        const amount = reported ? Math.ceil(usage.cost.total * 100) : null;
        store.transaction(() => {
          const current = store.settings();
          for (const value of [usage.input, usage.output]) if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid provider usage accounting");
          current.value.usage.inputTokens += usage.input;
          current.value.usage.outputTokens += usage.output;
          current.value.usage.modelPriceUnknown ||= !reported;
          store.updateSettings(current.version, current.value);
          store.put("usage", callId, { ...base, status: "reported", inputTokens: usage.input, outputTokens: usage.output, costMinor: amount, currency: reported ? "USD" : null, latencyMs: store.now() - started, category: result.stopReason }, record.version);
        });
        return { value: stream, receipt: { provider: model.provider, model: model.id, inputTokens: usage.input, outputTokens: usage.output, costMinor: amount, priceAvailable: reported }, verified: true, evidenceRefs: [`usage:${callId}`], ...(amount !== null ? { actualAmountMinor: amount } : {}) };
      } catch (error) {
        store.transaction(() => {
          const current = store.settings(); current.value.usage.modelPriceUnknown = true; store.updateSettings(current.version, current.value);
          const usage = store.get("usage", callId)!;
          store.put("usage", callId, { ...base, status: "unknown", latencyMs: store.now() - started }, usage.version);
        });
        throw error;
      }
    };
    if (binding) return coordinator.dispatch(binding, {
      stepId: `model:${binding.runId}:${callId}`, tool: "model_turn", arguments: { provider: model.provider, model: model.id, maxTokens, pricing: priceKnown ? "catalog" : "unknown" }, sourceRevisions: {}, effectful: false,
      ...(allowance ? { allowance } : {}),
    }, invoke);
    // Foreground reasoning has no operational task. Reserve before network just as workers do.
    if (allowance) store.transaction(() => store.reserveAmount(callId, allowance));
    const outcome = await invoke(AbortSignal.timeout(60_000));
    store.transaction(() => store.settleReservation(callId, true, outcome.actualAmountMinor));
    return outcome.value;
  };
}
