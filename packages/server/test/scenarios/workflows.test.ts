import {afterEach,describe,expect,it} from "vitest";
import {readFileSync,writeFileSync,mkdtempSync,realpathSync,rmSync} from "node:fs";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {tmpdir} from "node:os";
import {createBusinessBackup,restoreBusinessBackup,defaultPolicy,savePolicy} from "@open-instinct/core";
import {BusinessCommitments,DEFAULT_FOLLOW_UP} from "../../src/business-commitments.js";
import {fauxAssistantMessage,fauxToolCall} from "@earendil-works/pi-ai";
import {GoogleWorkspace,GmailIntake} from "@open-instinct/apps";
import type {BusinessConnection,LogicalAction,Principal,Json} from "@open-instinct/core";
import {createScenarioApp,type ScenarioApp} from "../../testing/scenario-app.js";
import {record} from "../../testing/emulators/http.js";
const instances:ScenarioApp[]=[];
afterEach(async()=>{for(const instance of instances.splice(0).reverse())await instance.close();});
async function scenario(options:Parameters<typeof createScenarioApp>[0]={}){const app=await createScenarioApp(options);instances.push(app);return app;}
const owner:Principal={id:"owner",kind:"owner",tier:"owner"};
function claim(s:ScenarioApp,label:string){const coordinator=s.app.business!.coordinator;const id=randomUUID();const authority=coordinator.ownerAuthority(owner,"chat",id,label);const task=coordinator.admitTask({channel:"chat",conversationKey:`chat:${id}`,replyRef:{},requester:"owner",audience:"owner"},authority,{objective:label,doneCriteria:[label]},id);const binding=coordinator.claimRun(task.id);if(!binding)throw new Error("Task claim failed");return {coordinator,task,binding};}
const action=(stepId:string):LogicalAction=>({stepId,tool:"fixture_provider_effect",arguments:{text:"Synthetic effect"},sourceRevisions:{},effectful:true});
function sendMail(s:ScenarioApp){s.model.setResponses([fauxAssistantMessage([fauxToolCall("business_google",{operation:"send",input:{to:["customer@fixture.test"],subject:"Synthetic requested reply",text:"Thank you for the synthetic service request. Please send the remaining project scope."}})],{stopReason:"toolUse"}),fauxAssistantMessage("Inspect the sent-message evidence before claiming completion.")]);}

describe.sequential("Integrated durable workflows (emulated)",()=>{
  it("G4: editing a business file preserves owner bytes and verifies a new revision",async()=>{
    const s=await scenario({responses:[]});const original=join(s.root,"workspace/owner-notes.txt");writeFileSync(original,"Owner price: USD 125\n");
    s.model.setResponses([fauxAssistantMessage([fauxToolCall("edit",{path:"owner-notes.txt",edits:[{oldText:"125",newText:"150"}]})],{stopReason:"toolUse"}),fauxAssistantMessage("Inspect the new revision.")]);
    await s.postMessage("Create a revised copy of owner-notes.txt with price USD 150");
    await s.waitFor(()=>s.app.business!.coordinator.store.actions().some(a=>a.tool==="edit"&&a.status==="verified"),"verified file revision");
    const edit=s.app.business!.coordinator.store.actions().find(a=>a.tool==="edit")!,receipt=record(edit.receipt);
    expect(readFileSync(original,"utf8")).toBe("Owner price: USD 125\n");
    expect(readFileSync(join(s.root,"workspace",String(receipt.path)),"utf8")).toBe("Owner price: USD 150\n");
    expect(edit.evidenceRefs).toContain(`artifact:${receipt.artifactId}`);
  });
  it("G10: saved custom daily owner limits survive migration and serialize parallel reservations",async()=>{
    let now=new Date("2026-10-23T12:00:00Z");const s=await scenario({responses:[],now:()=>now});
    const policy=defaultPolicy();policy.spend.perDayUsd=7;savePolicy(s.state,policy);await s.restart();
    const first=claim(s,"first bounded purchase"),second=claim(s,"second bounded purchase"),gate=s.gate();
    const purchase={...action("purchase"),spendCapable:true,allowance:{category:"purchase" as const,currency:"USD",amountMinor:500}};
    const pending=first.coordinator.dispatch(first.binding,purchase,async()=>{await gate.promise;return {value:true,receipt:{accepted:true},evidenceRefs:["fixture:purchase"],verified:true};});
    await s.waitFor(()=>first.coordinator.store.actions(first.task.id).some(a=>a.status==="dispatching"),"first purchase reservation");
    let invoked=false;await expect(second.coordinator.dispatch(second.binding,purchase,async()=>{invoked=true;throw new Error("Forbidden second purchase");})).rejects.toThrow(/daily/);
    expect(invoked).toBe(false);expect(first.coordinator.store.savedPurchaseBalance()).toMatchObject({perActionMinor:null,perDayMinor:700,heldMinor:500,remainingMinor:200});
    gate.release();await pending;expect(first.coordinator.store.savedPurchaseBalance()).toMatchObject({usedMinor:500,heldMinor:0});
    now=new Date("2026-10-25T12:00:00Z");expect(first.coordinator.store.savedPurchaseBalance()).toMatchObject({usedMinor:0,remainingMinor:700});
  });
  it("G1/G8: duplicate authenticated client IDs admit once; real Pi tool writes persisted evidence/history",async()=>{
    const s=await scenario();await s.login();const responses=await Promise.all([s.postMessage("Create scenario-result.txt", "same-client-0001"),s.postMessage("Create scenario-result.txt","same-client-0001")]);expect(responses.map(r=>r.status)).toEqual([202,202]);
    await s.waitFor(()=>s.app.business!.coordinator.store.tasks().some(t=>t.status==="completed"),"real file task completion");const store=s.app.business!.coordinator.store;expect(store.tasks()).toHaveLength(1);const writes=store.actions().filter(a=>a.tool==="write");expect(writes).toHaveLength(1);expect(writes[0]!.status).toBe("verified");expect(readFileSync(join(s.root,"workspace/scenario-result.txt"),"utf8")).toBe("Synthetic verified result\n");
    await s.waitFor(()=>s.app.runtime.stats().busy===0,"foreground and worker projections settled");
    const first=await (await s.owner("/messages")).json(),second=await (await s.owner("/messages")).json();expect(second).toEqual(first);const taskId=store.tasks()[0]!.id;await s.restart();await s.login();expect(s.app.business!.coordinator.store.task(taskId)?.status).toBe("completed");expect(record(await (await s.owner("/messages")).json()).messages).toEqual(record(first).messages);
  });
  it("G1: competing claims and stale checkpoint/task/control fences never invoke a provider",async()=>{
    const s=await scenario({responses:[]});const {coordinator,task,binding}=claim(s,"Fence regression");expect(coordinator.claimRun(task.id)).toBeUndefined();let effects=0;const invoke=async()=>{effects++;return {value:true,receipt:{accepted:true},evidenceRefs:["fixture:readback"],verified:true};};
    const current=coordinator.checkpoint(binding,{next:"dispatch"});await expect(coordinator.dispatch(binding,action("stale"),invoke)).rejects.toThrow(/fenced/i);coordinator.control(owner,task.id,"stop");await expect(coordinator.dispatch(current,action("cancelled"),invoke)).rejects.toThrow(/fenced/i);expect(effects).toBe(0);
    const next=claim(s,"Global stop fence");coordinator.control(owner,"workspace","pause");await expect(coordinator.dispatch(next.binding,action("stopped"),invoke)).rejects.toThrow(/fenced/i);expect(effects).toBe(0);
  });
  it("G2: Gmail accepts before response loss; restart and delayed readback never resend",async()=>{
    const s=await scenario({responses:[]});s.providers.google.delaySentVisibility();s.providers.google.acceptThenDrop();sendMail(s);expect((await s.postMessage("Send the sourced quote to customer@fixture.test")).status).toBe(202);
    await s.waitFor(()=>s.app.business!.coordinator.store.actions().some(a=>a.tool==="business_google"&&a.status==="unknown"),"unknown Gmail action");expect(s.providers.google.accepted).toHaveLength(1);const id=s.providers.google.accepted[0]!.id;
    await s.restart();await s.app.business!.coordinator.sweep();expect(s.providers.google.accepted).toHaveLength(1);expect((await s.providers.google.allMessages()).some(m=>m.id===id)).toBe(true);
    s.providers.google.revealSent();await s.app.business!.coordinator.sweep();expect(s.providers.google.accepted).toHaveLength(1);expect(s.app.business!.coordinator.store.actions().some(a=>a.tool==="business_google"&&a.status==="verified")).toBe(true);
  });
  it("G2: uncertain hosted shell receipt is retained, not replayed after restart",async()=>{
    const s=await scenario({responses:[]});s.providers.maritime.acceptThenDrop();s.model.setResponses([fauxAssistantMessage([fauxToolCall("shell",{command:"synthetic-submit"})],{stopReason:"toolUse"}),fauxAssistantMessage("The remote outcome is unknown.")]);await s.postMessage("Submit the synthetic computer job");
    await s.waitFor(()=>s.app.business!.coordinator.store.actions().some(a=>a.tool==="shell"&&a.status==="unknown"),"unknown shell effect");const attempts=s.providers.maritime.invocations.filter(i=>i.name==="shell").length;expect(attempts).toBe(1);await s.restart();await s.app.business!.coordinator.sweep();expect(s.providers.maritime.invocations.filter(i=>i.name==="shell")).toHaveLength(attempts);expect(s.app.business!.coordinator.store.actions().some(a=>a.tool==="shell"&&a.status==="unknown")).toBe(true);
  });
  it("G4: obsolete source versions cannot dispatch a commercial effect",async()=>{
    const s=await scenario({responses:[]});const {coordinator,binding}=claim(s,"Use current source only");const store=coordinator.store;store.put("knowledge","rate-source",{rate:"125",currency:"USD",authority:"owner"},null);store.put("knowledge","rate-source",{rate:"150",currency:"USD",authority:"owner"},1);
    let invoked=false;await expect(coordinator.dispatch(binding,{...action("quote"),sourceRevisions:{"rate-source":1}},async()=>{invoked=true;return {value:true,receipt:{},evidenceRefs:[],verified:false};})).rejects.toThrow(/source revision/i);expect(invoked).toBe(false);expect(store.actions(binding.taskId)).toHaveLength(0);
  });
  it("G5: changed Calendar etag refuses overwrite and wrong readback cannot verify",async()=>{
    const s=await scenario({responses:[]});s.providers.calendar.wrongReadback();s.model.setResponses([fauxAssistantMessage([fauxToolCall("business_google",{operation:"insert",input:{summary:"Synthetic booking",start:{dateTime:"2026-10-23T10:00:00Z",timeZone:"UTC"},end:{dateTime:"2026-10-23T11:00:00Z",timeZone:"UTC"},attendees:[{email:"customer@fixture.test"}],sendUpdates:"all"}})],{stopReason:"toolUse"}),fauxAssistantMessage("Readback mismatch needs reconciliation.")]);await s.postMessage("Book the synthetic agreed appointment");
    await s.waitFor(()=>s.providers.calendar.events.size===1,"accepted calendar event");await s.waitFor(()=>s.app.business!.coordinator.store.actions().some(a=>a.tool==="business_google"&&a.status!=="dispatching"),"readback result");expect(s.app.business!.coordinator.store.actions().filter(a=>a.tool==="business_google").every(a=>a.status!=="verified")).toBe(true);expect(s.app.business!.coordinator.store.tasks().every(t=>t.status!=="completed")).toBe(true);
  });
  it("G6: direct owner stop bypasses a blocked model turn and survives restart",async()=>{
    const s=await scenario({responses:[]});const gate=s.gate();let entered=false;s.model.setResponses([async()=>{entered=true;await gate.promise;return fauxAssistantMessage([fauxToolCall("write",{path:"after-stop.txt",content:"must not dispatch"})],{stopReason:"toolUse"});}]);await s.postMessage("Start a long task");await s.waitFor(()=>entered,"model gate entered");
    const stopped=await s.owner("/control",{method:"POST",body:{target:"workspace",operation:"pause"}});expect(stopped.status).toBe(200);expect(s.app.business!.coordinator.store.settings().value.stopped).toBe(true);gate.release();await s.restart();expect(s.app.business!.coordinator.store.settings().value.stopped).toBe(true);expect(s.app.business!.coordinator.store.actions().filter(a=>a.tool==="write")).toHaveLength(0);
  });
  it("G6: racing in-flight verified success remains visible after stop",async()=>{
    const s=await scenario({responses:[]});const {coordinator,binding}=claim(s,"In-flight result");const gate=s.gate();let entered=false;
    const event={id:"race123",summary:"Racing synthetic event",start:{dateTime:"2026-10-23T10:00:00Z",timeZone:"UTC"},end:{dateTime:"2026-10-23T11:00:00Z",timeZone:"UTC"}};
    const pending=coordinator.dispatch(binding,{...action("in-flight"),arguments:event},async()=>{const response=await s.fetch(`${s.providers.calendar.url}/calendar/v3/calendars/primary/events`,{method:"POST",body:JSON.stringify(event)});expect(response.status).toBe(200);entered=true;await gate.promise;const readback=record(await (await s.fetch(`${s.providers.calendar.url}/calendar/v3/calendars/primary/events/${event.id}`)).json());expect(readback.summary).toBe(event.summary);return {value:"accepted",receipt:{providerId:String(readback.id)},evidenceRefs:[`calendar:${readback.id}`],verified:true};});await s.waitFor(()=>entered,"external dispatch");coordinator.control(owner,"workspace","pause");gate.release();await pending;expect(s.providers.calendar.events.get(event.id)?.summary).toBe(event.summary);expect(coordinator.store.actions(binding.taskId)[0]?.status).toBe("verified");expect(coordinator.store.activity().some(e=>e.kind==="action.verified"&&record(e.detail).late===true)).toBe(true);
  });
  it("G9: disabled/account-substituted connections cannot reuse old dispatch authority",async()=>{
    const s=await scenario({responses:[]});await s.login();const list=record(await (await s.owner("/connections")).json());expect(list).toBeDefined();const store=s.app.business!.coordinator.store;const saved=store.list<BusinessConnection>("connection").find(c=>c.value.toolkit==="gmail");if(!saved)throw new Error("Google binding missing");const {coordinator,binding}=claim(s,"Revocation boundary");const original={id:saved.id,version:saved.version,epoch:saved.value.epoch,accountId:saved.value.accountId};
    const response=await s.owner(`/connections/${saved.id}`,{method:"DELETE",body:{expectedVersion:saved.version}});expect(response.status).toBe(200);const disabled=store.get<BusinessConnection>("connection",saved.id)!;expect(disabled.value.status).toBe("disabled");expect(disabled.value.revocation).toBe("requested");let calls=0;await expect(coordinator.dispatch(binding,{...action("after-disconnect"),connection:original},async()=>{calls++;return {value:true,receipt:{},evidenceRefs:[],verified:false};})).rejects.toThrow(/connection/i);expect(calls).toBe(0);
  });
  it("G10: event-before-wait, duplicates, late terminal events and provider challenge verification",async()=>{
    const s=await scenario({responses:[]});const {coordinator,binding,task}=claim(s,"Event-before-wait");const event={id:"reply-1",channel:"gmail",correlationKey:"thread-1",kind:"reply",content:{text:"yes"},at:coordinator.store.now(),verified:true};coordinator.appendEvent(event);coordinator.appendEvent(event);
    const wait=coordinator.wait(binding,{kind:"external_event",correlationKey:"thread-1",eventCursor:0,deadline:null,requiresVerification:false});expect(wait.status).toBe("satisfied");expect(coordinator.store.events("thread-1")).toHaveLength(1);coordinator.control(owner,task.id,"stop");coordinator.appendEvent({...event,id:"late",at:event.at-100});expect(coordinator.store.task(task.id)?.status).toBe("cancelled");
    const challenge=claim(s,"Takeover challenge");coordinator.wait(challenge.binding,{kind:"provider_challenge",correlationKey:"takeover-1",eventCursor:0,deadline:null,requiresVerification:true});coordinator.appendEvent({...event,id:"owner-done",correlationKey:"takeover-1",verified:false});expect(coordinator.store.task(challenge.task.id)?.status).toBe("waiting");coordinator.appendEvent({...event,id:"provider-done",correlationKey:"takeover-1",verified:true});expect(coordinator.store.task(challenge.task.id)?.status).toBe("queued");
    const expiry=claim(s,"Expired external wait");coordinator.wait(expiry.binding,{kind:"external_event",correlationKey:"expired-thread",eventCursor:0,deadline:coordinator.store.now()-1,requiresVerification:false});await coordinator.sweep();expect(coordinator.store.waits(expiry.task.id)[0]?.status).toBe("expired");
  });
  it("G10: typed over-cap purchases never dispatch; concurrent reservations retain unknown spend",async()=>{
    const s=await scenario({responses:[]});const store=s.app.business!.coordinator.store;const settings=store.settings();store.updateSettings(settings.version,{...settings.value,limits:{...settings.value.limits,purchaseMinor:100}});const one=claim(s,"Purchase one"),two=claim(s,"Purchase two");const gate=s.gate();let launched=false;const purchase={...action("purchase"),allowance:{category:"purchase" as const,amountMinor:70,currency:"USD"}};
    let deniedEffects=0;const forbidden=async()=>{deniedEffects++;return {value:true,receipt:{},evidenceRefs:["never"],verified:true};};
    await expect(one.coordinator.dispatch(one.binding,{...purchase,stepId:"over-cap",allowance:{...purchase.allowance,amountMinor:101}},forbidden)).rejects.toThrow(/budget|allowance|limit/i);
    const first=one.coordinator.dispatch(one.binding,purchase,async()=>{launched=true;await gate.promise;throw new Error("Provider response lost");});const observed=first.catch(error=>error);await s.waitFor(()=>launched,"reserved purchase");await expect(two.coordinator.dispatch(two.binding,purchase,forbidden)).rejects.toThrow(/budget|allowance|limit/i);gate.release();await observed;expect(store.actions(one.task.id).some(a=>a.status==="unknown")).toBe(true);expect(store.settings().value.usage.purchaseMinor).toBe(0);await expect(two.coordinator.dispatch(two.binding,{...purchase,stepId:"retry"},forbidden)).rejects.toThrow();expect(deniedEffects).toBe(0);expect(store.allowanceBalances().purchase).toMatchObject({heldMinor:70,remainingMinor:30});
  });
  it.each(["reply","owner_intervention","opt_out"])("G5: %s before follow-up suppresses the chase across restart and downtime",async(kind)=>{
    let time=Date.parse("2026-10-19T10:00:00Z");const s=await scenario({responses:[],now:()=>new Date(time)});await s.login();await s.owner("/connections");
    const coordinator=s.app.business!.coordinator,store=coordinator.store,connections=store.list<BusinessConnection>("connection");const connection=connections.find(c=>c.value.toolkit==="gmail");if(!connection)throw new Error("Missing bound Gmail");
    const commitments=new BusinessCommitments(coordinator);const row=commitments.create({principal:owner,channel:"chat",ownerTurn:true},{name:"Synthetic follow-up",objective:"Chase only if still unanswered",doneCriteria:["Send one justified chase"],dueAt:time+72*3600000,timezone:"UTC",cron:null,parentTaskId:null,routineId:null,sourceRefs:[],premise:{correlationKey:"customer-thread",after:time,eventCursor:0,connection:{id:connection.id,accountId:connection.value.accountId,epoch:connection.value.epoch},sourceRevisions:{},availabilityKey:null},followUp:DEFAULT_FOLLOW_UP},`follow-up-${kind}`);
    coordinator.appendEvent({id:`event-${kind}`,channel:"gmail",correlationKey:"customer-thread",kind,content:{source:"synthetic"},at:time+1,verified:true});time+=14*86400000;await s.restart();const resumed=new BusinessCommitments(s.app.business!.coordinator);await resumed.sweep();await resumed.sweep();
    expect(s.app.business!.coordinator.store.get<{status:string}>("commitment",row.id)?.value.status).toBe("suppressed");expect(s.providers.google.accepted).toHaveLength(0);expect(s.app.business!.coordinator.store.tasks()).toHaveLength(0);
  });
  it("G6: a backup preceding a remote effect restores stopped and never replays lost work",async()=>{
    const s=await scenario({responses:[]});const claimed=claim(s,"Snapshot before provider acceptance");const backupRoot=realpathSync(mkdtempSync(join(tmpdir(),"instinct-backup-contract-")));
    try {
      const snapshot=createBusinessBackup(claimed.coordinator.store,{destination:backupRoot,retention:2});
      await claimed.coordinator.dispatch(claimed.binding,action("after-snapshot"),async()=>{const response=await s.providers.google.requestUpstream("/gmail/v1/users/me/messages/send",{method:"POST",body:JSON.stringify({raw:Buffer.from("To: customer@fixture.test\r\nSubject: Backup race\r\n\r\nSynthetic").toString("base64url")})});const receipt=record(await response.json());return {value:true,receipt:{providerId:String(receipt.id)},evidenceRefs:[`gmail:${receipt.id}`],verified:true};});
      const count=(await s.providers.google.allMessages()).length;claimed.coordinator.control(owner,"workspace","pause");
      await s.restart(async()=>{restoreBusinessBackup({source:join(backupRoot,snapshot.id),destination:join(s.root,"business")});});
      expect(s.app.business!.coordinator.store.settings().value.stopped).toBe(true);expect(s.app.business!.coordinator.store.task(claimed.task.id)?.status).toBe("blocked");await s.app.business!.coordinator.sweep();expect((await s.providers.google.allMessages()).length).toBe(count);
    } finally {rmSync(backupRoot,{recursive:true,force:true});}
  });
  it("G10: model usage with unavailable pricing is not recorded as free",async()=>{
    const s=await scenario({responses:[fauxAssistantMessage("Synthetic reasoning with unknown catalog pricing.")]});await s.postMessage("Inspect the current situation");
    await s.waitFor(()=>s.app.business!.coordinator.store.list("usage").length>0,"usage accounting");
    expect(s.app.business!.coordinator.store.settings().value.usage.modelPriceUnknown).toBe(true);
    expect(s.app.business!.coordinator.store.list<{costMinor:number|null}>("usage").every(row=>row.value.costMinor===null)).toBe(true);
  });
  it("G1/G3/G8: signed owner texting uses real Inkbox transport and duplicate ingress is not a second task",async()=>{
    const s=await scenario();const event={id:"event-owner-001",event_type:"imessage.received",timestamp:new Date().toISOString(),data:{message:{id:"message-owner-001",conversation_id:"conversation-owner",remote_number:"+12025550101",content:"Create scenario-result.txt",is_group:false,participants:["+12025550101"],media:[]},contacts:[],agent_identities:[]}};
    expect((await s.webhook(event)).status).toBe(204);expect((await s.webhook(event)).status).toBe(204);
    await s.waitFor(()=>s.app.business!.coordinator.store.tasks().some(t=>t.status==="completed"),"signed text completion");
    await s.waitFor(()=>s.app.business!.coordinator.store.list<{status:string}>("notification").some(n=>n.id.startsWith("answer:")&&n.value.status==="accepted")&&s.app.business!.coordinator.store.list<{status:string}>("notification").some(n=>n.id.endsWith(":completed")&&n.value.status==="accepted"),"foreground and completion carrier acceptance");
    expect(s.app.business!.coordinator.store.tasks()).toHaveLength(1);expect(s.providers.inkbox.accepted.length).toBeGreaterThan(0);expect(s.providers.inkbox.receipts).toHaveLength(0);
    const accepted=s.providers.inkbox.accepted.length;await s.login();await s.owner("/messages");await s.owner("/messages");expect(s.providers.inkbox.accepted).toHaveLength(accepted);expect(s.providers.inkbox.receipts).toHaveLength(0);
  });
  it("G3: ordinary autonomous Gmail send reaches independently stored SENT content without approval",async()=>{
    const s=await scenario({responses:[]});sendMail(s);await s.postMessage("Send the sourced synthetic quote");
    await s.waitFor(()=>s.app.business!.coordinator.store.actions().some(a=>a.tool==="business_google"&&a.status==="verified"),"verified Gmail effect");
    expect(s.providers.google.accepted).toHaveLength(1);const sent=s.providers.google.accepted[0]!;const readback=record(await (await s.providers.google.requestUpstream(`/gmail/v1/users/me/messages/${sent.id}?format=raw`)).json());
    expect(Buffer.from(String(readback.raw),"base64url").toString()).toContain("customer@fixture.test");expect(s.app.business!.coordinator.store.actions().find(a=>a.tool==="business_google")?.evidenceRefs.length).toBeGreaterThan(0);
  });
  it("G4/G9: separate business workspaces cannot retrieve another workspace's knowledge or computer",async()=>{
    const first=await scenario({responses:[]});await first.login();const uploaded=await first.owner("/knowledge",{method:"POST",body:{filename:"fictional-rates.txt",mimeType:"text/plain",base64:Buffer.from("Fictional Field Services: unique rate source alpha.").toString("base64"),authoritative:true}});expect(uploaded.status).toBe(201);const artifact=record(await uploaded.json()),firstId=first.app.business!.coordinator.store.settings().value.workspaceId;
    await first.close();instances.splice(instances.indexOf(first),1);
    const second=await scenario({responses:[]});await second.login();const secondId=second.app.business!.coordinator.store.settings().value.workspaceId;expect(secondId).not.toBe(firstId);expect((await second.owner(`/knowledge/${artifact.id}`)).status).toBe(404);
    const searched=record(await (await second.owner("/knowledge?q=alpha")).json());expect(searched.results).toEqual([]);expect(second.providers.maritime.computers.has(firstId)).toBe(false);expect([...second.providers.composio.sessions.values()].every(session=>session.userId===secondId)).toBe(true);
  });
  it("G9: production proxy preserves auth/scope/rate/outage failures and rejects account substitution",async()=>{
    const s=await scenario({responses:[]});await s.login();expect((await s.owner("/connections")).status).toBe(200);const saved=s.app.business!.coordinator.store.list<BusinessConnection>("connection").find(c=>c.value.toolkit==="gmail");if(!saved||!s.app.apps)throw new Error("Bound Google unavailable");
    const google=new GoogleWorkspace(s.app.apps.googleTransport("gmail",saved.value.accountId,()=>{}));
    for(const status of [401,403,429,500]){s.providers.google.failNext(status);await expect(google.profile()).rejects.toMatchObject({status});}
    for(const result of ["blocked","input_required"] as const){s.providers.composio.respondNext(result);await expect(google.profile()).rejects.toThrow();}
    const attempts=s.providers.google.attempts.length,proxies=s.providers.composio.proxyRequests.length;s.providers.composio.substitute(saved.value.accountId,"replacement-account");await expect(google.profile()).rejects.toMatchObject({status:401});expect(s.providers.google.attempts).toHaveLength(attempts);expect(s.providers.composio.proxyRequests).toHaveLength(proxies);expect(s.providers.google.accepted).toHaveLength(0);
  });
  it("G2/G10: Gmail discoveries survive admission failure and expired-history rescan dedupes",async()=>{
    const s=await scenario({responses:[]});const saved=s.app.business!.coordinator.store.list<BusinessConnection>("connection").find(c=>c.value.toolkit==="gmail");if(!saved||!s.app.apps)throw new Error("Missing Gmail binding");
    let intake=new GmailIntake(s.app.business!.coordinator.store,new GoogleWorkspace(s.app.apps.googleTransport("gmail",saved.value.accountId,()=>{})),saved.value.accountId);await intake.activate(Date.now()-1000);
    const message=await s.providers.google.importMessage(Buffer.from("From: customer@fixture.test\r\nTo: owner@fixture.test\r\nSubject: Synthetic intake\r\nMessage-ID: <intake@fixture.test>\r\n\r\nPlease discuss the missing scope.").toString("base64url"));
    await expect(intake.sweep(async()=>{throw new Error("Interrupted after durable discovery");})).rejects.toThrow("Interrupted");expect(s.app.business!.coordinator.store.get<{admitted:boolean}>("cursor",`gmail-message:${saved.value.accountId}:${message.id}`)?.value.admitted).toBe(false);
    await s.restart();intake=new GmailIntake(s.app.business!.coordinator.store,new GoogleWorkspace(s.app.apps!.googleTransport("gmail",saved.value.accountId,()=>{})),saved.value.accountId);let admissions=0;
    const admit=async(event:{id:string;message:Json})=>{admissions++;s.app.business!.coordinator.appendEvent({id:event.id,channel:"gmail",correlationKey:message.threadId,kind:"customer-request",content:event.message,at:Date.now(),verified:false});};
    await intake.sweep(admit);s.providers.google.expireHistory();await intake.sweep(admit);s.providers.google.expireHistory(false);await intake.sweep(admit);
    expect(admissions).toBe(1);expect(s.app.business!.coordinator.store.events(message.threadId)).toHaveLength(1);expect(s.app.business!.coordinator.store.tasks()).toHaveLength(0);
  });
});
