import {afterEach,describe,expect,it} from "vitest";
import {fauxAssistantMessage,fauxToolCall,getCurrentTools,type TranscriptContext} from "@earendil-works/pi-ai";
import {createScenarioApp,type ScenarioApp} from "../../testing/scenario-app.js";
import type {FeedbackKind} from "../../testing/emulators/inkbox.js";

const instances: ScenarioApp[] = [];
afterEach(async () => { for (const app of instances.splice(0).reverse()) await app.close(); });
async function scenario() {
  const app = await createScenarioApp({responses:[],foregroundResponses:[]});
  instances.push(app); return app;
}
const call = (name: string, args: Record<string,unknown>) => fauxAssistantMessage([fauxToolCall(name,args)],{stopReason:"toolUse"});
function incoming(s: ScenarioApp, id: string, options: Partial<Parameters<ScenarioApp["providers"]["inkbox"]["addIncoming"]>[0]> = {}) {
  const message = s.providers.inkbox.addIncoming({id:`message-${id}`,conversationId:"feedback-owner",text:"Please acknowledge this message naturally.",...options});
  return event(id,message);
}
function event(id: string, message: Record<string,unknown>) {
  return {id,event_type:"imessage.received",timestamp:new Date().toISOString(),data:{message,contacts:[],agent_identities:[]}};
}
function cursor(s: ScenarioApp, id: string) {
  return s.app.business!.coordinator.store.get<{status:string;reply:string}>("cursor",`inbound:${id}`)?.value;
}
function receipt(s: ScenarioApp, kind: "read" | "reaction", id: string) {
  return s.app.business!.coordinator.store.get<{status:string;sourceId:string;route:{conversationKey:string;messageId:string};reaction?:string}>("cursor",`feedback:${kind}:${id}`)?.value;
}
async function answered(s: ScenarioApp, id: string) {
  await s.waitFor(() => cursor(s,id)?.status === "answered" && s.app.runtime.stats().busy === 0,`answered ${id}`);
}
async function sent(s: ScenarioApp, text: string) {
  await s.waitFor(() => s.providers.inkbox.accepted.some(message => message.text === text),`carrier accepted ${text}`);
}
function resultError(transcript: TranscriptContext, name: string): boolean | undefined {
  const result = transcript.messages.findLast(message => message.role === "toolResult" && message.toolName === name);
  return result?.role === "toolResult" ? result.isError : undefined;
}
async function bounded<T>(work: Promise<T>, label: string): Promise<T> {
  // Only a failure deadline: real HTTP sockets and production cancellation cannot use fake timers.
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => deadline.reject(new Error(`Timed out ${label}`)),3_000);
  try { return await Promise.race([work,deadline.promise]); }
  finally { clearTimeout(timer); }
}

describe.sequential("Business iMessage feedback through production boot and signed ingress",() => {
  it("commits read and typing before a gated final reply and never repeats read or reaction on duplicate/restart",async () => {
    const s = await scenario(), gate = s.gate(), inbound = incoming(s,"feedback-gated");
    let entered = false, prompt = "", tools: string[] = [];
    s.foregroundModel.setResponses([
      transcript => { prompt = JSON.stringify(transcript); tools = getCurrentTools(transcript.messages).map(tool => tool.name); return call("react",{messageId:inbound.data.message.id,reaction:"eyes"}); },
      async () => { entered = true; await gate.promise; return fauxAssistantMessage("I have read your message."); },
    ]);
    expect((await s.webhook(inbound)).status).toBe(204);
    await s.waitFor(() => entered && receipt(s,"read",inbound.id)?.status === "accepted" && s.providers.inkbox.readReceipts.length === 1 && s.providers.inkbox.typingIndicators.length > 0,"feedback while final answer is gated");
    expect(prompt).toContain(String(inbound.data.message.id)); expect(tools).toContain("react");
    expect(s.providers.inkbox.accepted).toHaveLength(0);
    expect(s.providers.inkbox.reactions).toMatchObject([{target_message_id:inbound.data.message.id,reaction:"eyes"}]);
    expect(receipt(s,"read",inbound.id)).toMatchObject({sourceId:inbound.id,status:"accepted",route:{messageId:inbound.data.message.id}});
    expect(receipt(s,"reaction",inbound.id)).toMatchObject({sourceId:inbound.id,status:"accepted",reaction:"eyes"});
    expect(cursor(s,inbound.id)).toBeDefined(); expect(s.app.business!.coordinator.store.tasks()).toHaveLength(0);
    expect((await s.webhook(inbound)).status).toBe(204);
    gate.release(); await answered(s,inbound.id); await sent(s,"I have read your message.");
    const attempts = s.providers.inkbox.feedbackAttempts.filter(attempt => attempt.kind !== "typing").length;
    await s.restart(); expect((await s.webhook(inbound)).status).toBe(204);
    expect(receipt(s,"read",inbound.id)?.status).toBe("accepted"); expect(receipt(s,"reaction",inbound.id)?.status).toBe("accepted");
    expect(s.providers.inkbox.feedbackAttempts.filter(attempt => attempt.kind !== "typing")).toHaveLength(attempts);
    expect(s.providers.inkbox.accepted).toHaveLength(1);
  });

  it("uses all seven registered named tapbacks without tasks and lets a reaction-only turn stay text-free",async () => {
    const s = await scenario();
    const reactions = ["love","like","dislike","laugh","emphasize","question","eyes"];
    for (const reaction of reactions) {
      const inbound = incoming(s,`named-${reaction}`), answer = reaction === "eyes" ? "" : `Acknowledged with ${reaction}.`;
      s.foregroundModel.setResponses([call("react",{messageId:inbound.data.message.id,reaction}),call("react",{messageId:inbound.data.message.id,reaction}),fauxAssistantMessage(answer)]);
      expect((await s.webhook(inbound)).status).toBe(204); await answered(s,inbound.id);
      if (answer) await sent(s,answer);
      expect(receipt(s,"reaction",inbound.id)).toMatchObject({status:"accepted",reaction,route:{messageId:inbound.data.message.id}});
      expect(cursor(s,inbound.id)?.reply).toBe(answer);
    }
    expect(s.providers.inkbox.reactions.map(reaction => reaction.reaction)).toEqual(reactions);
    expect(s.providers.inkbox.accepted).toHaveLength(6);
    expect(JSON.stringify(s.providers.inkbox.accepted)).not.toMatch(/model returned no answer/i);
    expect(s.app.business!.coordinator.store.message("answer:named-eyes")).toMatchObject({role:"notice"});
    expect(s.app.business!.coordinator.store.tasks()).toHaveLength(0);
  });

  it.each(["failed","uncertain"] as const)("does not replay a %s reaction, still sends the final answer, and retains the fence after restart",async outcome => {
    const s = await scenario(), inbound = incoming(s,`reaction-${outcome}`);
    if (outcome === "failed") s.providers.inkbox.failNextFeedback("reaction",403);
    else s.providers.inkbox.acceptThenDropFeedback("reaction");
    let firstError: boolean | undefined, retryError: boolean | undefined;
    s.foregroundModel.setResponses([
      call("react",{messageId:inbound.data.message.id,reaction:"like"}),
      transcript => { firstError = resultError(transcript,"react"); return call("react",{messageId:inbound.data.message.id,reaction:"like"}); },
      transcript => { retryError = resultError(transcript,"react"); return fauxAssistantMessage("Here is the requested answer regardless of the tapback outcome."); },
    ]);
    expect((await s.webhook(inbound)).status).toBe(204); await answered(s,inbound.id);
    await sent(s,"Here is the requested answer regardless of the tapback outcome.");
    expect(firstError).toBe(true); expect(retryError).toBe(true);
    expect(s.providers.inkbox.feedbackAttempts.filter(attempt => attempt.kind === "reaction")).toHaveLength(1);
    expect(s.providers.inkbox.reactions).toHaveLength(outcome === "uncertain" ? 1 : 0);
    expect(receipt(s,"reaction",inbound.id)?.status).toBe("unknown");
    await s.restart(); expect((await s.webhook(inbound)).status).toBe(204);
    expect(receipt(s,"reaction",inbound.id)?.status).toBe("unknown");
    expect(s.providers.inkbox.feedbackAttempts.filter(attempt => attempt.kind === "reaction")).toHaveLength(1);
    expect(s.providers.inkbox.accepted).toHaveLength(1); expect(s.app.business!.coordinator.store.tasks()).toHaveLength(0);
  });

  it.each(["foreign","outbound"] as const)("rejects a %s target through the registered owner tool before reaction dispatch",async targetKind => {
    const s = await scenario(), first = incoming(s,`target-setup-${targetKind}`);
    s.foregroundModel.setResponses([fauxAssistantMessage("Prior outbound message.")]);
    await s.webhook(first); await answered(s,first.id); await sent(s,"Prior outbound message.");
    const target = targetKind === "foreign"
      ? s.providers.inkbox.addIncoming({conversationId:"different-private-thread",text:"Unrelated inbound message"}).id
      : String(s.providers.inkbox.accepted[0]!.id);
    // Claim the real outbound ID at ingress so provider lookup, not only source-ID matching, must reject it.
    const inbound = targetKind === "outbound"
      ? event("target-outbound",{...first.data.message,id:target,content:"React to this claimed incoming message."})
      : incoming(s,"target-foreign");
    let denied: boolean | undefined;
    s.foregroundModel.setResponses([call("react",{messageId:target,reaction:"love"}),transcript => { denied = resultError(transcript,"react"); return fauxAssistantMessage("Only the current incoming message is eligible."); }]);
    await s.webhook(inbound); await answered(s,inbound.id); await sent(s,"Only the current incoming message is eligible.");
    expect(denied).toBe(true); expect(s.providers.inkbox.reactions).toHaveLength(0);
    expect(s.providers.inkbox.feedbackAttempts.filter(attempt => attempt.kind === "reaction")).toHaveLength(0);
    if (targetKind === "foreign") expect(receipt(s,"reaction",inbound.id)).toBeUndefined();
  });

  it("binds a delayed reaction to its admitted source, not a later owner carrier route",async () => {
    const s = await scenario(), gate = s.gate();
    const first = incoming(s,"bound-first",{conversationId:"first-private-thread"});
    const second = incoming(s,"bound-second",{conversationId:"second-private-thread"});
    let entered = false;
    s.foregroundModel.setResponses([
      async () => { entered = true; await gate.promise; return call("react",{messageId:first.data.message.id,reaction:"like"}); },
      fauxAssistantMessage("Second thread answered."),
      fauxAssistantMessage("First thread answered."),
    ]);
    await s.webhook(first); await s.waitFor(() => entered,"first source paused in model");
    await s.webhook(second); await sent(s,"Second thread answered.");
    expect(s.app.business!.coordinator.store.get<{conversationKey:string}>("cursor","owner:carrier-route")?.value.conversationKey).toContain("second-private-thread");
    gate.release(); await answered(s,first.id); await sent(s,"First thread answered.");
    expect(s.providers.inkbox.reactions).toMatchObject([{conversation_id:"first-private-thread",target_message_id:first.data.message.id}]);
    expect(receipt(s,"reaction",first.id)?.route.conversationKey).toContain("first-private-thread");
    expect(receipt(s,"reaction",second.id)).toBeUndefined();
  });

  it.each(["web","guidance"] as const)("does not grant %s a tapback tool or reuse the last texting route as feedback authority",async surface => {
    const s = await scenario(), inbound = incoming(s,`surface-${surface}`);
    s.foregroundModel.setResponses([fauxAssistantMessage("Carrier route established.")]);
    await s.webhook(inbound); await answered(s,inbound.id); await sent(s,"Carrier route established.");
    await s.waitFor(() => receipt(s,"read",inbound.id)?.status === "accepted","initial read accepted");
    const before = s.providers.inkbox.feedbackAttempts.length; let tools: string[] | undefined;
    s.foregroundModel.setResponses([transcript => { tools = getCurrentTools(transcript.messages).map(tool => tool.name); return fauxAssistantMessage("This conversation stays on the owner web surface."); }]);
    await s.login();
    if (surface === "web") expect((await s.postMessage("A web-only question","web-feedback-source")).status).toBe(202);
    else expect((await s.owner("/onboarding/conversation",{method:"POST",body:{}})).status).toBe(202);
    await s.waitFor(() => tools !== undefined && s.app.runtime.stats().busy === 0,"web foreground settled");
    expect(tools).not.toContain("react"); expect(tools).not.toContain("send_typing");
    expect(s.providers.inkbox.feedbackAttempts).toHaveLength(before);
    const sourceId = surface === "web" ? "web:web-feedback-source" : "workspace-onboarding";
    expect(receipt(s,"read",sourceId)).toBeUndefined(); expect(receipt(s,"reaction",sourceId)).toBeUndefined();
  });

  it.each(["foreign","group","unknown-scope"] as const)("does not admit %s ingress as business owner feedback authority",async scope => {
    const s = await scenario();
    let message: Record<string,unknown>;
    if (scope === "unknown-scope") message = {id:"unknown-scope-message",conversation_id:"unresolvable-conversation",remote_number:"+12025550101",content:"A scope-less message",media:[]};
    else message = s.providers.inkbox.addIncoming({id:`message-${scope}`,conversationId:`scope-${scope}`,from:scope === "foreign" ? "+12025550199" : "+12025550101",isGroup:scope === "group",participants:scope === "group" ? ["+12025550101","+12025550199"] : ["+12025550199"]});
    let personalTools: string[] = [];
    s.model.setResponses(scope === "foreign"
      ? [transcript => { personalTools = getCurrentTools(transcript.messages).map(tool => tool.name); return call("react",{messageId:message.id,reaction:"like"}); },call("send_typing",{}),fauxAssistantMessage("An ordinary personal conversation, not business owner authority.")]
      : [fauxAssistantMessage("An ordinary personal conversation, not business owner authority.")]);
    const inbound = event(`scope-${scope}`,message);
    expect((await s.webhook(inbound)).status).toBe(204);
    await s.waitFor(() => {
      const persisted = s.state.readJson<{receipts:Array<{id:string;status:string;attempts:number}>}>("inkbox-inbox.json",{receipts:[]});
      const row = persisted.receipts.find(row => row.id === inbound.id);
      return !!row && row.attempts > 0 && (scope === "unknown-scope" ? row.status === "queued" : row.status === "done");
    },"signed non-owner/scope ingress handled");
    expect(cursor(s,inbound.id)).toBeUndefined();
    expect(receipt(s,"read",inbound.id)).toBeUndefined(); expect(receipt(s,"reaction",inbound.id)).toBeUndefined();
    expect(s.app.business!.coordinator.store.get("cursor","owner:carrier-route")).toBeUndefined();
    expect(s.app.business!.coordinator.store.tasks()).toHaveLength(0);
    if (scope === "foreign") {
      expect(personalTools).toContain("react"); expect(personalTools).toContain("send_typing");
      expect(s.providers.inkbox.reactions).toMatchObject([{target_message_id:message.id,reaction:"like"}]);
      expect(s.providers.inkbox.typingIndicators.length).toBeGreaterThan(0);
    }
    if (scope === "unknown-scope") expect(s.providers.inkbox.feedbackAttempts).toHaveLength(0);
  });

  it("does not send iMessage feedback for an owner message carried as SMS",async () => {
    const s = await scenario(), seeded = s.providers.inkbox.addIncoming({conversationId:"sms-service-thread",text:"This message used SMS transport."});
    const inbound = event("owner-sms-service",{...seeded,service:"SMS"});
    let tools: string[] = [];
    s.foregroundModel.setResponses([transcript => { tools = getCurrentTools(transcript.messages).map(tool => tool.name); return fauxAssistantMessage("I can answer without iMessage feedback."); }]);
    expect((await s.webhook(inbound)).status).toBe(204); await answered(s,inbound.id); await sent(s,"I can answer without iMessage feedback.");
    expect(tools).not.toContain("react");
    expect(s.providers.inkbox.feedbackAttempts).toHaveLength(0);
    expect(receipt(s,"read",inbound.id)).toBeUndefined(); expect(receipt(s,"reaction",inbound.id)).toBeUndefined();
  });

  it("keeps separately authorized task reactions in the dispatcher journal and never replays uncertain acceptance",async () => {
    const s = await scenario(), gate = s.gate();
    const older = s.providers.inkbox.addIncoming({id:"older-owner-message",conversationId:"feedback-owner",text:"Earlier context."});
    const inbound = incoming(s,"delegated-reaction",{text:"React once to my earlier message as a delegated task."});
    let workerTools: string[] = [];
    s.foregroundModel.setResponses([
      call("business_delegate",{objective:"React once to my earlier message as a delegated task.",doneCriteria:["Carrier reaction outcome is independently recorded."]}),
      fauxAssistantMessage("The reaction request has a durable task."),
    ]);
    s.providers.inkbox.acceptThenDropFeedback("reaction");
    s.model.setResponses([
      async transcript => { workerTools = getCurrentTools(transcript.messages).map(tool => tool.name); await gate.promise; return call("react",{messageId:older.id,reaction:"like"}); },
      call("react",{messageId:older.id,reaction:"like"}),
      fauxAssistantMessage("Acceptance is uncertain; no further reaction was sent."),
    ]);
    await s.webhook(inbound); await s.waitFor(() => cursor(s,inbound.id)?.status === "answered","owner foreground settled before worker reaction"); await sent(s,"The reaction request has a durable task.");
    gate.release();
    await s.waitFor(() => s.app.business!.coordinator.store.actions().some(action => action.tool === "react" && action.status === "unknown") && s.app.runtime.stats().busy === 0,"uncertain dispatched reaction");
    expect(workerTools).toContain("react");
    expect(receipt(s,"reaction",inbound.id)).toBeUndefined();
    expect(s.app.business!.coordinator.store.tasks()).toHaveLength(1);
    expect(s.providers.inkbox.reactions).toMatchObject([{target_message_id:older.id,reaction:"like"}]);
    expect(s.providers.inkbox.feedbackAttempts.filter(attempt => attempt.kind === "reaction")).toHaveLength(1);
    await s.restart(); await s.app.business!.coordinator.sweep();
    expect(s.providers.inkbox.feedbackAttempts.filter(attempt => attempt.kind === "reaction")).toHaveLength(1);
    expect(s.app.business!.coordinator.store.actions().filter(action => action.tool === "react")).toEqual([expect.objectContaining({status:"unknown"})]);
  });

  it.each(["read","typing","reaction"] as const)("a slow %s request cannot block signed priority stop or controller shutdown",async (kind: FeedbackKind) => {
    const s = await scenario(), providerGate = Promise.withResolvers<void>(), modelGate = s.gate();
    const inbound = incoming(s,`slow-${kind}`);
    s.providers.inkbox.holdNextFeedback(kind,providerGate.promise);
    s.foregroundModel.setResponses(kind === "reaction"
      ? [call("react",{messageId:inbound.data.message.id,reaction:"eyes"}),fauxAssistantMessage("No operational work requested.")]
      : [async () => { await modelGate.promise; return fauxAssistantMessage("No operational work requested."); }]);
    try {
      expect((await s.webhook(inbound)).status).toBe(204);
      await s.waitFor(() => s.providers.inkbox.feedbackAttempts.some(attempt => attempt.kind === kind),`held ${kind} HTTP request`);
      const stop = incoming(s,`stop-${kind}`,{text:"stop"});
      expect((await bounded(s.webhook(stop),"priority stop webhook")).status).toBe(204);
      expect(s.app.business!.coordinator.store.settings().value.stopped).toBe(true);
      await bounded(s.restart(),"shutdown while provider feedback remains held");
      expect(s.app.business!.coordinator.store.settings().value.stopped).toBe(true);
      if (kind === "reaction") {
        expect(receipt(s,"reaction",inbound.id)?.status).toBe("unknown");
        expect(s.providers.inkbox.reactions).toHaveLength(0);
      }
    } finally { providerGate.resolve(); modelGate.release(); }
  });
});
