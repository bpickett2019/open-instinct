import {afterEach,describe,expect,it} from "vitest";
import {symlinkSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {fauxAssistantMessage,fauxToolCall} from "@earendil-works/pi-ai";
import type {Principal} from "@open-instinct/core";
import {createScenarioApp,type ScenarioApp} from "../../testing/scenario-app.js";
import {OutboundIsolation} from "../../testing/isolation.js";
import {listenFixture,json} from "../../testing/emulators/http.js";
const apps:ScenarioApp[]=[];
afterEach(async()=>{for(const app of apps.splice(0).reverse())await app.close();});
async function scenario(){const app=await createScenarioApp({responses:[]});apps.push(app);return app;}
describe.sequential("Application and development-tool security boundaries",()=>{
  it("tooling: exact allocated origins only; swallowed global/injected/redirect violations fail teardown",async()=>{
    const isolation=new OutboundIsolation();const server=await listenFixture((_req,res)=>{res.writeHead(302,{location:"https://provider.example.test/paid-operation"});res.end();});isolation.allow(server.url);isolation.install();
    try{
      await expect(fetch("https://api.openai.com/v1/responses")).rejects.toThrow(/nonfixture/);
      await expect(isolation.fetch("http://127.0.0.1:9/not-allocated")).rejects.toThrow(/nonfixture/);
      await expect(fetch(server.url)).rejects.toThrow(/nonfixture/);
      await expect(fetch(server.url,{redirect:"manual"})).rejects.toThrow(/nonfixture/);
      expect(()=>isolation.assertClean()).toThrow(/swallowed/);expect(isolation.violations).toHaveLength(4);
    }finally{isolation.restore();await server.close();}
  });
  it("tooling: deliberately incorrect semantic assertion fails without weakening production",()=>{
    expect(()=>expect({accepted:1,delivered:0}).toEqual({accepted:1,delivered:1})).toThrow();
  });
  it("G7: session login, CSRF, exact origin, legacy bearer separation, tunnel and logout",async()=>{
    const s=await scenario();expect((await s.fetch(`${s.url}/api/owner/tasks`)).status).toBe(401);
    expect((await s.fetch(`${s.url}/api/owner/session`,{method:"POST",headers:{origin:s.url,"content-type":"application/json"},body:JSON.stringify({token:"incorrect"})})).status).toBe(401);
    const session=await s.login();expect(session.cookie).not.toContain(s.token);expect((await s.owner("/overview")).status).toBe(200);
    expect((await s.owner("/control",{method:"POST",body:{target:"workspace",operation:"pause"},headers:{"x-workspace-csrf":"incorrect"}})).status).toBe(403);
    expect((await s.owner("/control",{method:"POST",body:{target:"workspace",operation:"pause"},headers:{origin:"https://attacker.test"}})).status).toBe(403);
    expect((await s.fetch(`${s.url}/chat`,{method:"POST",headers:{cookie:session.cookie,"content-type":"application/json"},body:JSON.stringify({message:"Do not admit"})})).status).toBe(401);
    expect((await s.fetch(`${s.tunnelUrl}/workspace`)).status).toBe(404);expect((await s.fetch(`${s.tunnelUrl}/api/owner/tasks`,{headers:{authorization:`Bearer ${s.token}`}})).status).toBe(404);
    expect(s.app.business!.coordinator.store.tasks()).toHaveLength(0);
    const page=await s.fetch(`${s.url}/workspace`);expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");expect(page.headers.get("cache-control")).toBe("no-store");expect(await page.text()).not.toContain(s.token);
    expect((await s.owner("/session",{method:"DELETE",body:{}})).status).toBe(200);expect((await s.owner("/overview")).status).toBe(401);
  });
  it("G7: clock-driven idle expiry and restart log browser out, not persisted assistant state",async()=>{
    let time=Date.now();const s=await createScenarioApp({responses:[],now:()=>new Date(time)});apps.push(s);const session=await s.login();time+=31*60_000;expect((await s.owner("/overview")).status).toBe(401);await s.login();await s.restart();expect((await s.fetch(`${s.url}/api/owner/overview`,{headers:{cookie:session.cookie,origin:s.url}})).status).toBe(401);expect(s.app.business!.coordinator.store.settings().value.workspaceId).toBeTruthy();
  });
  it("G3/G7: wrong signature, forged email-owner, group cap and delegated principals cannot grant authority",async()=>{
    const s=await scenario();expect((await s.webhook({event:"text.received",data:{}},false)).status).toBe(401);expect(s.app.business!.coordinator.store.tasks()).toHaveLength(0);
    const c=s.app.business!.coordinator;const owner:Principal={id:"owner",kind:"owner",tier:"owner"};expect(()=>c.ownerAuthority(owner,"email","forged-email","Do dangerous work")).toThrow();
    const capped={...owner,tier:"friend",cappedFrom:"owner"} as Principal;expect(()=>c.ownerAuthority(capped,"imessage","group","Stop all work")).toThrow();
    const stranger={id:"external-agent",kind:"agent",tier:"stranger"} as Principal;expect(()=>c.ownerAuthority(stranger,"a2a","external","Read business knowledge")).toThrow();expect(c.store.list("authority")).toHaveLength(0);
  });
  it("G7: real registered file tools reject traversal and symlinks into private controller state",async()=>{
    const s=await scenario();writeFileSync(join(s.root,"private-controller.txt"),"synthetic controller secret");symlinkSync(join(s.root,"private-controller.txt"),join(s.root,"workspace/escape.txt"));
    s.model.setResponses([fauxAssistantMessage([fauxToolCall("read",{path:"../private-controller.txt"})],{stopReason:"toolUse"}),fauxAssistantMessage([fauxToolCall("read",{path:"escape.txt"})],{stopReason:"toolUse"}),fauxAssistantMessage("Access denied.")]);await s.postMessage("Read private controller state");await s.waitFor(()=>s.app.business!.coordinator.store.actions().filter(a=>a.tool==="read").length>=2,"file confinement results");
    expect(JSON.stringify(s.app.business!.coordinator.store.messages())).not.toContain("synthetic controller secret");expect(s.app.business!.coordinator.store.actions().filter(a=>a.tool==="read").every(a=>a.status!=="verified")).toBe(true);
    expect((await s.owner("/files/..%2F..%2Fprivate-controller.txt/download")).status).not.toBe(200);
  });
  it("G7: uploaded hostile content is non-active and filenames never resolve controller paths",async()=>{
    const s=await scenario();await s.login();const uploaded=await s.owner("/knowledge",{method:"POST",body:{filename:"../../escape.html",mimeType:"text/html",base64:Buffer.from("<script>fetch('/api/owner/control')</script>").toString("base64"),authoritative:false}});expect([400,415,422]).toContain(uploaded.status);
    const active=await s.fetch(`${s.url}/workspace/assets/../../config.json`);expect(active.status).not.toBe(200);
  });
  it("G8: independent readers do not consume messages or create delivery receipts",async()=>{
    const s=await scenario();await s.login();s.foregroundModel.setResponses([fauxAssistantMessage("A synthetic immediate response.")]);await s.postMessage("What is the current situation?");await s.waitFor(()=>s.app.business!.coordinator.store.messages().some(message=>message.text==="A synthetic immediate response."),"durable immediate response");expect(s.app.business!.coordinator.store.tasks()).toHaveLength(0);
    const before=s.app.business!.coordinator.store.messages();const deliveries=s.providers.inkbox.receipts.length;const [first,second]=await Promise.all([s.owner("/messages?after=0"),s.owner("/messages?after=0")]);expect(await first.json()).toEqual(await second.json());expect(s.app.business!.coordinator.store.messages()).toEqual(before);expect(s.providers.inkbox.receipts).toHaveLength(deliveries);
  });
  it("G7: production attachment SSRF policy rejects loopback media even on a fixture origin",async()=>{
    const s=await scenario();if(!s.app.hydrateInbound)throw new Error("Production Inkbox hydrator missing");
    const hydrated=await s.app.hydrateInbound({id:"local-media",channel:"imessage",conversationKey:"imessage:owner",from:"+12025550101",text:"Synthetic attachment",replyRef:{},receivedAt:new Date().toISOString(),meta:{conversationScopeKnown:true,isGroup:false},attachments:[{url:`${s.providers.inkbox.url}/private-media`,name:"fixture.txt",mimeType:"text/plain"}]});
    expect(hydrated.attachments?.[0]?.path).toBeUndefined();expect(hydrated.text).toContain("could not be downloaded");expect(s.providers.inkbox.attempts).toHaveLength(0);
  });
  it("G7: declared oversized office expansion is reported failed, never indexed as empty success",async()=>{
    const s=await scenario();await s.login();const name=Buffer.from("[Content_Types].xml");const local=Buffer.alloc(30+name.length+1);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(8,8);local.writeUInt32LE(1,18);local.writeUInt32LE(17*1024*1024,22);local.writeUInt16LE(name.length,26);name.copy(local,30);
    const central=Buffer.alloc(46+name.length);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(8,10);central.writeUInt32LE(1,20);central.writeUInt32LE(17*1024*1024,24);central.writeUInt16LE(name.length,28);name.copy(central,46);
    const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(local.length,16);
    const response=await s.owner("/knowledge",{method:"POST",body:{filename:"expansion.docx",mimeType:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",base64:Buffer.concat([local,central,end]).toString("base64"),authoritative:false}});
    expect(response.status).toBe(201);expect(await response.json()).toMatchObject({extraction:"failed"});expect(s.app.business!.coordinator.store.searchKnowledge("Content_Types")).toEqual([]);
  });
});
