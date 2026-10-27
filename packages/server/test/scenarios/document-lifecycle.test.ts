import {afterEach,describe,expect,it} from "vitest";
import {createHash} from "node:crypto";
import {fauxAssistantMessage} from "@earendil-works/pi-ai";
import {createScenarioApp,type ScenarioApp} from "../../testing/scenario-app.js";
import {record} from "../../testing/emulators/http.js";
import {DEFAULT_FOLLOW_UP} from "../../src/business-commitments.js";
import type {BusinessConnection} from "@open-instinct/core";
import {assessmentRates,assessmentObjective,importAssessmentRequest,importAssessmentReply,scriptAssessmentQuote,storedMail,toolCall as call,toolResult as result} from "../../testing/document-lifecycle.js";
const instances:ScenarioApp[]=[];
afterEach(async()=>{for(const s of instances.splice(0).reverse())await s.close();});
describe.sequential("Document-grounded customer lifecycle (emulated)",()=>{
  it("G1/G3/G4/G5/G8: cited quote PDF is registered, attached and verified; a real reply suppresses persisted follow-through after restart",async()=>{
    let time=Date.parse("2026-10-19T10:00:00Z");const s=await createScenarioApp({responses:[],now:()=>new Date(time)});instances.push(s);await s.login();
    const upload=await s.owner("/knowledge",{method:"POST",body:{filename:"fictional-service-rates.txt",mimeType:"text/plain",base64:Buffer.from(assessmentRates).toString("base64"),authoritative:true}});expect(upload.status).toBe(201);const source=record(await upload.json());
    const store=s.app.business!.coordinator.store,connection=store.list<BusinessConnection>("connection").find(c=>c.value.toolkit==="gmail")!;
    const routine=store.get("routine","follow-through")!;
    expect((await s.owner("/routines/follow-through",{method:"PATCH",body:{expectedVersion:routine.version,routine:{kind:"follow-through",name:"Customer follow-through",objective:"Follow up only while unanswered",doneCriteria:["One justified customer follow-up"],enabled:true,sources:[{connectionId:connection.id,accountId:connection.value.accountId}],timezone:"UTC",cron:null,followUp:DEFAULT_FOLLOW_UP}}})).status).toBe(200);
    const customer=await importAssessmentRequest(s,time);
    const quote=scriptAssessmentQuote(s,String(source.id),customer,()=>time,{
      source:chunk=>expect(chunk.text).toContain("250.00"),
      price:price=>{expect(price.minimumMinor).toBe(25000);expect(price.maximumMinor).toBe(25000);},
    });
    expect((await s.postMessage(assessmentObjective)).status).toBe(202);
    await s.waitFor(()=>store.tasks().some(t=>t.status==="completed"),"source-grounded quote completion");
    expect(s.providers.google.accepted).toHaveLength(1);const sent=s.providers.google.accepted[0]!;expect(sent.threadId).toBe(customer.threadId);
    const {message:full,parsed}=await storedMail(s,sent.id);expect(full.labelIds).toContain("SENT");
    expect(parsed.to.value.map(address=>address.address)).toEqual(["customer@fixture.test"]);expect(parsed.subject).toBe("Assessment quote");expect(parsed.text).toContain(quote.quoteText);
    expect(parsed.attachments).toHaveLength(1);const attachment=parsed.attachments[0]!;expect(attachment.filename).toBe("quote.pdf");expect(attachment.contentType).toBe("application/pdf");
    const artifactId=quote.artifactId,downloaded=await s.owner(`/files/${artifactId}/download`);expect(downloaded.status).toBe(200);const pdf=Buffer.from(await downloaded.arrayBuffer());expect(pdf.subarray(0,5).toString()).toBe("%PDF-");expect(attachment.content).toEqual(pdf);
    expect(store.get<{sha256:string}>("artifact",artifactId)?.value.sha256).toBe(createHash("sha256").update(pdf).digest("hex"));
    const task=store.tasks()[0]!,send=store.actions(task.id).find(a=>a.tool==="business_google"&&a.effectful&&a.status==="verified")!;expect(send.sourceRevisions[`knowledge:${source.id}`]).toBe(store.get("knowledge",String(source.id))!.version);
    const commitments=store.list<{parentTaskId:string;status:string}>("commitment").filter(c=>c.value.parentTaskId===task.id);expect(commitments).toHaveLength(1);
    time+=3600000;await importAssessmentReply(s,time);
    time+=14*86400000;await s.restart();await s.login();await s.app.business!.coordinator.sweep();
    expect(s.app.business!.coordinator.store.get<{status:string}>("commitment",commitments[0]!.id)?.value.status).toBe("suppressed");expect(s.providers.google.accepted).toHaveLength(1);
    expect((await s.owner(`/files/${artifactId}/download`)).status).toBe(200);expect(JSON.stringify(await (await s.owner(`/tasks/${task.id}`)).json())).toContain(`gmail:${sent.id}`);
  },20000);
  it("G5: registered Calendar insert/update/cancel retain one provider event and stale etags cannot overwrite a human change",async()=>{
    const s=await createScenarioApp({responses:[]});instances.push(s);const input={summary:"Synthetic assessment",start:{dateTime:"2026-10-23T10:00:00Z",timeZone:"UTC"},end:{dateTime:"2026-10-23T11:00:00Z",timeZone:"UTC"},attendees:[{email:"customer@fixture.test"}],sendUpdates:"all"};let id="",originalEtag="",updateEtag="",finished=false;
    s.model.setResponses([
      call("business_google",{operation:"insert",input}),
      transcript=>{const inserted=result(transcript,"business_google");id=String(inserted.id);originalEtag=String(inserted.etag);expect(s.providers.calendar.events.get(id)?.summary).toBe(input.summary);return call("business_google",{operation:"update",input:{...input,id,etag:originalEtag,summary:"Revised assessment"}});},
      transcript=>{const updated=result(transcript,"business_google");updateEtag=String(updated.etag);expect(updateEtag).not.toBe(originalEtag);expect(s.providers.calendar.events.get(id)?.summary).toBe("Revised assessment");return call("business_google",{operation:"cancel",input:{id,etag:updateEtag,sendUpdates:"all"}});},
      ()=>{finished=true;return fauxAssistantMessage("The calendar appointment is cancelled.");},
    ]);
    await s.postMessage("Create the synthetic assessment, revise its summary, then cancel it");await s.waitFor(()=>finished&&s.app.runtime.stats().busy===0,"calendar lifecycle");
    expect(s.providers.calendar.events.size).toBe(1);expect(s.providers.calendar.events.get(id)?.status).toBe("cancelled");expect(s.app.business!.coordinator.store.actions().filter(a=>a.tool==="business_google"&&a.status==="verified"&&a.effectful)).toHaveLength(3);
    s.providers.calendar.raceUpdate(id,{summary:"Human restored booking",status:"confirmed"});let conflictSettled=false;
    s.model.setResponses([call("business_google",{operation:"update",input:{...input,id,etag:updateEtag,summary:"Must not overwrite human"}}),()=>{conflictSettled=true;return fauxAssistantMessage("The human edit must be preserved.");}]);
    await s.postMessage("Try the previous appointment revision, respecting its saved etag");await s.waitFor(()=>conflictSettled&&s.app.runtime.stats().busy===0,"calendar conflict");
    expect(s.providers.calendar.events.size).toBe(1);expect(s.providers.calendar.events.get(id)?.summary).toBe("Human restored booking");expect(s.app.business!.coordinator.store.actions().filter(a=>a.tool==="business_google"&&a.status==="verified"&&a.effectful)).toHaveLength(3);
  });
  it.each(["evidence-only","superseded"] as const)("G4: %s rate sources cause a durable missing-information wait instead of a commercial send",async(mode)=>{
    const s=await createScenarioApp({responses:[]});instances.push(s);await s.login();
    const body={filename:"contested-rate.txt",mimeType:"text/plain",base64:Buffer.from("Fixed assessment price USD 250.00.").toString("base64"),authoritative:mode==="superseded"};
    const uploaded=await s.owner("/knowledge",{method:"POST",body});expect(uploaded.status).toBe(201);const source=record(await uploaded.json());
    const detail=record(await (await s.owner(`/knowledge/${source.id}`)).json()),chunk=record((detail.chunks as unknown[])[0]);
    if(mode==="superseded"){const replacement=await s.owner("/knowledge",{method:"POST",body:{...body,base64:Buffer.from("Assessment requires a custom site evaluation; no fixed price is authorized.").toString("base64"),supersedes:source.id,expectedVersion:source.version}});expect(replacement.status).toBe(201);}
    let refused=false;
    s.model.setResponses([call("business_price",{scope:"business",price:{kind:"fixed",currency:"USD",amount:{value:"250.00",citation:{sourceId:source.id,sourceVersion:source.sourceVersion,locator:chunk.locator}}}}),transcript=>{
      const response=transcript.messages.findLast(m=>m.role==="toolResult"&&m.toolName==="business_price");expect(response?.role==="toolResult"&&response.isError).toBe(true);refused=true;
      return call("task_wait",{kind:"missing_information",correlationKey:"current-assessment-rate",question:"What current authoritative assessment price should be used?"});
    },fauxAssistantMessage("A current authoritative assessment price is required.")]);
    await s.postMessage("Prepare the assessment quote only from current authoritative rates");await s.waitFor(()=>refused&&s.app.business!.coordinator.store.tasks().some(t=>t.status==="waiting"),"sourced pricing blocker");
    expect(s.providers.google.accepted).toHaveLength(0);expect(s.app.business!.coordinator.store.waits().some(w=>w.kind==="missing_information")).toBe(true);
    expect(JSON.stringify(await (await s.owner("/messages")).json())).toContain("What current authoritative assessment price");
  });
});
