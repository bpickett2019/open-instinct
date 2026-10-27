import {afterEach,describe,expect,it} from "vitest";
import {McpClient,StreamableHttpTransport} from "@earendil-works/pi-mcp";
import {MaritimeMcpBackend} from "@open-instinct/computer";
import {InkboxChannel} from "@open-instinct/inkbox";
import {OutboundIsolation} from "../../testing/isolation.js";
import {createGoogleFixture} from "../../testing/emulators/google.js";
import {createCalendarFixture} from "../../testing/emulators/calendar.js";
import {createComposioFixture} from "../../testing/emulators/composio.js";
import {createMaritimeFixture} from "../../testing/emulators/maritime.js";
import {createInkboxFixture} from "../../testing/emulators/inkbox.js";
import {record,string} from "../../testing/emulators/http.js";
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
function guard(){const isolation=new OutboundIsolation();cleanup.push(async()=>{isolation.restore();isolation.assertClean();});return isolation;}
const raw=(id:string)=>Buffer.from(`From: owner@fixture.test\r\nTo: customer@fixture.test\r\nSubject: Café service\r\nMessage-ID: <${id}@fixture.test>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSynthetic service request.\r\n`).toString("base64url");
const event={id:"abc123",summary:"Synthetic appointment",start:{dateTime:"2026-10-23T10:00:00Z",timeZone:"UTC"},end:{dateTime:"2026-10-23T11:00:00Z",timeZone:"UTC"},attendees:[{email:"customer@fixture.test"}]};
describe.sequential("Pinned provider wire contracts (emulated, not live)",()=>{
  it("Gmail stores sent MIME and Message-ID search/readback in the locked emulator",async()=>{
    const isolation=guard(),google=await createGoogleFixture(isolation);cleanup.push(()=>google.close());isolation.install();
    const response=await fetch(`${google.url}/gmail/v1/users/me/messages/send`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({raw:raw("contract")})});expect(response.status).toBe(200);const sent=record(await response.json());
    expect(google.accepted).toHaveLength(1);expect((await google.allMessages()).some(m=>m.id===sent.id)).toBe(true);
    const fetched=record(await (await google.requestUpstream(`/gmail/v1/users/me/messages/${sent.id}?format=raw`)).json());expect(Buffer.from(string(fetched.raw),"base64url").toString()).toContain("customer@fixture.test");
    const upstreamSearch=record(await (await google.requestUpstream(`/gmail/v1/users/me/messages?q=${encodeURIComponent("in:sent rfc822msgid:contract@fixture.test")}`)).json());
    expect(upstreamSearch.messages??[]).toEqual([]); // Retains the pinned parser's failing-before boundary.
    const found=record(await (await fetch(`${google.url}/gmail/v1/users/me/messages?q=${encodeURIComponent("in:sent rfc822msgid:contract@fixture.test")}`)).json());expect(found.messages).toEqual(expect.arrayContaining([expect.objectContaining({id:sent.id})]));
    expect(record(await (await google.requestUpstream(`/gmail/v1/users/me/messages/${sent.id}`)).json()).labelIds).toContain("SENT");
  });
  it("retains failing-before profile gap and facade derives counts/history from upstream state",async()=>{
    const isolation=guard(),google=await createGoogleFixture(isolation);cleanup.push(()=>google.close());isolation.install();
    expect((await google.requestUpstream("/gmail/v1/users/me/profile")).status).toBe(404);
    const before=record(await (await fetch(`${google.url}/gmail/v1/users/me/profile`)).json());await google.importMessage(raw("inbound"));
    const after=record(await (await fetch(`${google.url}/gmail/v1/users/me/profile`)).json());expect(after.emailAddress).toBe("owner@fixture.test");expect(after.messagesTotal).toBe(Number(before.messagesTotal)+1);expect(BigInt(string(after.historyId))).toBeGreaterThan(BigInt(string(before.historyId)));
    google.expireHistory();expect((await fetch(`${google.url}/gmail/v1/users/me/history?startHistoryId=1`)).status).toBe(404);
    expect((await fetch(`${google.url}/gmail/v1/users/me/unsupported`)).status).toBe(501);
  });
  it("Gmail negated folder queries exclude sent mail while retaining the active inbox window",async()=>{
    const isolation=guard(),google=await createGoogleFixture(isolation);cleanup.push(()=>google.close());isolation.install();
    const inbound=await google.importMessage(raw("negation-inbound"));
    const sent=record(await (await fetch(`${google.url}/gmail/v1/users/me/messages/send`,{method:"POST",body:JSON.stringify({raw:raw("negation-sent")})})).json());
    const query="after:1 -in:sent -in:drafts -in:spam -in:trash";
    // Locked upstream lacks -in: negation; the facade translates only these known system labels.
    const upstream=record(await (await google.requestUpstream(`/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}`)).json());expect(upstream.messages).toEqual([]);
    const page=record(await (await fetch(`${google.url}/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}`)).json());
    expect(page.messages).toEqual([expect.objectContaining({id:inbound.id})]);expect((page.messages as Array<{id:string}>).some(m=>m.id===sent.id)).toBe(false);
  });
  it("accept-before-drop and delayed visibility are not evidence of no effect",async()=>{
    const isolation=guard(),google=await createGoogleFixture(isolation);cleanup.push(()=>google.close());isolation.install();google.acceptThenDrop();google.delaySentVisibility();
    await expect(fetch(`${google.url}/gmail/v1/users/me/messages/send`,{method:"POST",body:JSON.stringify({raw:raw("lost")})})).rejects.toThrow();
    expect(google.accepted).toHaveLength(1);const id=google.accepted[0]!.id;expect((await google.allMessages()).some(m=>m.id===id)).toBe(true);expect((await fetch(`${google.url}/gmail/v1/users/me/messages/${id}`)).status).toBe(404);google.revealSent();expect((await fetch(`${google.url}/gmail/v1/users/me/messages/${id}`)).status).toBe(200);
  });
  it("Calendar has one canonical ID/etag/delete/freebusy state; upstream required routes are absent",async()=>{
    const isolation=guard(),google=await createGoogleFixture(isolation),calendar=await createCalendarFixture();cleanup.push(()=>google.close(),()=>calendar.close());isolation.allow(calendar.url);isolation.install();
    const upstreamInsert=await google.requestUpstream("/calendar/v3/calendars/upstream-contract-probe/events",{method:"POST",body:JSON.stringify(event)});expect(upstreamInsert.status).toBe(200);const upstreamEvent=record(await upstreamInsert.json());
    const upstreamList=record(await (await google.requestUpstream("/calendar/v3/calendars/upstream-contract-probe/events")).json());expect(upstreamList.items).toEqual(expect.arrayContaining([expect.objectContaining({id:upstreamEvent.id})]));
    expect((await google.requestUpstream(`/calendar/v3/calendars/upstream-contract-probe/events/${upstreamEvent.id}`)).status).toBe(404);
    expect((await google.requestUpstream(`/calendar/v3/calendars/upstream-contract-probe/events/${upstreamEvent.id}`,{method:"PUT",body:JSON.stringify(event),headers:{"if-match":"stale"}})).status).toBe(404);
    const base=`${calendar.url}/calendar/v3/calendars/primary/events`;const send=(method:string,path:string,value?:unknown,etag?:string)=>fetch(base+path,{method,headers:{"content-type":"application/json",...(etag?{"if-match":etag}:{})},...(value?{body:JSON.stringify(value)}:{})});
    const created=record(await (await send("POST","",event)).json());expect(created.id).toBe(event.id);expect((await send("POST","",event)).status).toBe(409);
    const busy=()=>fetch(`${calendar.url}/calendar/v3/freeBusy`,{method:"POST",body:JSON.stringify({timeMin:"2026-10-23T00:00:00Z",timeMax:"2026-10-24T00:00:00Z",items:[{id:"primary"}]})}).then(r=>r.json());
    expect(await busy()).toMatchObject({calendars:{primary:{busy:[{start:"2026-10-23T10:00:00.000Z",end:"2026-10-23T11:00:00.000Z"}]}}});
    calendar.raceUpdate(event.id,{summary:"Owner edit"});expect((await send("PUT",`/${event.id}`,event,string(created.etag))).status).toBe(412);expect(calendar.events.get(event.id)?.summary).toBe("Owner edit");
    const current=record(await (await send("GET",`/${event.id}`)).json());const updated=record(await (await send("PATCH",`/${event.id}`,{summary:"Revised"},string(current.etag))).json());expect(updated.etag).not.toBe(current.etag);
    expect((await send("DELETE",`/${event.id}`,undefined,string(updated.etag))).status).toBe(204);expect(calendar.events.get(event.id)?.status).toBe("cancelled");expect(await busy()).toMatchObject({calendars:{primary:{busy:[]}}});
  });
  it("Composio adapter opens a real HTTP MCP transport and rejects unsupported protocol",async()=>{
    const isolation=guard(),google=await createGoogleFixture(isolation),calendar=await createCalendarFixture();cleanup.push(()=>google.close(),()=>calendar.close());isolation.allow(calendar.url);const composio=await createComposioFixture(isolation,google.url,calendar.url);cleanup.push(()=>composio.close());isolation.install();
    const session=await composio.adapters.createComposio!("synthetic-composio-key").sessions.create("workspace-contract",{mcp:true,manageConnections:{enable:true},toolkits:["gmail"]});
    const client=new McpClient({name:"contract",version:"1"});await client.connect(new StreamableHttpTransport({url:session.mcp.url}));cleanup.push(()=>client.close());
    await client.callTool("FIXTURE_RECORD_NOTE",{text:"Persisted note"});expect(composio.notes).toEqual(["Persisted note"]);expect(composio.invocations).toHaveLength(1);
    const bad=await fetch(session.mcp.url,{method:"POST",body:JSON.stringify({jsonrpc:"2.0",id:7,method:"unsupported"})});expect(await bad.json()).toMatchObject({error:{code:-32601}});
  });
  it("production Maritime backend uses workspace-bound state, file transfer and takeover privacy",async()=>{
    const isolation=guard(),maritime=await createMaritimeFixture();cleanup.push(()=>maritime.close());isolation.allow(maritime.url);isolation.install();
    const backend=new MaritimeMcpBackend({url:maritime.url,apiKey:"synthetic-maritime-computer",externalUserId:"workspace-one"});cleanup.push(()=>backend.close());const tools=await backend.tools();const ctx={principal:{kind:"owner" as const,id:"owner",tier:"owner" as const},conversationKey:"chat:fixture",channel:"chat" as const,now:()=>new Date()};
    const execute=(name:string,args:unknown)=>{const tool=tools.find(t=>t.spec.name===name);if(!tool)throw new Error(`Missing ${name}`);return tool.spec.execute(args,ctx);};
    await execute("get_computer",{});await execute("write_file",{path:"/work/result.txt",content:"Synthetic bytes"});expect(maritime.computers.get("workspace-one")?.files.get("/work/result.txt")).toBe("Synthetic bytes");
    await execute("request_takeover",{reason:"Synthetic login"});expect(await execute("computer",{action:"screenshot"})).toMatchObject({isError:true});maritime.finishTakeover("workspace-one");expect(await execute("takeover_status",{})).not.toMatchObject({isError:true});expect(maritime.computers.has("workspace-two")).toBe(false);
    maritime.denyEntitlement();expect(await execute("computer",{action:"left_click",coordinate:[1,2]})).toMatchObject({isError:true});
  });
  it("production Inkbox sends distinguish attempts, acceptance and delivery receipts",async()=>{
    const isolation=guard(),inkbox=await createInkboxFixture();cleanup.push(()=>inkbox.close());isolation.allow(inkbox.url);isolation.install();
    const channel=new InkboxChannel({apiKey:"synthetic-inkbox-key",handle:"fixture-assistant",baseUrl:inkbox.url});
    await channel.send({channel:"sms",to:"+12025550101",text:"Synthetic notification"},{principal:{id:"owner",kind:"owner",tier:"owner"},conversationKey:"sms:+12025550101"});
    expect(inkbox.attempts).toHaveLength(1);expect(inkbox.accepted).toHaveLength(1);expect(inkbox.receipts).toHaveLength(0);inkbox.deliver(String(inkbox.accepted[0]!.id));expect(inkbox.receipts).toHaveLength(1);
  });
  it("Gmail MIME attachment bytes and paginated history/thread references share upstream state",async()=>{
    const isolation=guard(),google=await createGoogleFixture(isolation);cleanup.push(()=>google.close());isolation.install();const bytes=Buffer.from([0,1,2,3,250,251,252,253]);
    const mime=Buffer.from(`From: owner@fixture.test\r\nTo: customer@fixture.test\r\nSubject: Attachment\r\nMessage-ID: <attachment@fixture.test>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"fixture\"\r\n\r\n--fixture\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSynthetic bytes.\r\n--fixture\r\nContent-Type: application/octet-stream; name=\"payload.bin\"\r\nContent-Disposition: attachment; filename=\"payload.bin\"\r\nContent-Transfer-Encoding: base64\r\n\r\n${bytes.toString("base64")}\r\n--fixture--\r\n`).toString("base64url");
    const sent=record(await (await fetch(`${google.url}/gmail/v1/users/me/messages/send`,{method:"POST",body:JSON.stringify({raw:mime})})).json());const full=record(await (await google.requestUpstream(`/gmail/v1/users/me/messages/${sent.id}?format=full`)).json());const payload=record(full.payload);
    expect(Array.isArray(payload.parts)).toBe(true);const part=(payload.parts as unknown[]).map(record).find(p=>p.filename==="payload.bin");expect(part).toBeDefined();const attachmentId=string(record(part!.body).attachmentId);const attachment=record(await (await fetch(`${google.url}/gmail/v1/users/me/messages/${sent.id}/attachments/${attachmentId}`)).json());expect(Buffer.from(string(attachment.data),"base64url")).toEqual(bytes);
    const thread=record(await (await fetch(`${google.url}/gmail/v1/users/me/threads/${sent.threadId}`)).json());expect(thread.messages).toEqual(expect.arrayContaining([expect.objectContaining({id:sent.id})]));
    await google.importMessage(raw("page-two"));const first=record(await (await fetch(`${google.url}/gmail/v1/users/me/messages?maxResults=1`)).json());expect(first.nextPageToken).toBeTruthy();const second=record(await (await fetch(`${google.url}/gmail/v1/users/me/messages?maxResults=1&pageToken=${first.nextPageToken}`)).json());expect(second.messages).not.toEqual(first.messages);
  });
  it("locked Google OAuth binds the synthetic client/redirect and rejects authorization-code replay",async()=>{
    const isolation=guard(),google=await createGoogleFixture(isolation);cleanup.push(()=>google.close());isolation.install();
    const fields={email:google.email,redirect_uri:google.oauthCallbackUrl,scope:"openid email profile https://mail.google.com/",state:"synthetic-csrf-state",client_id:"fixture-client"};
    const authorize=await google.requestUpstream(`/o/oauth2/v2/auth?${new URLSearchParams({...fields,response_type:"code"})}`);expect(authorize.status).toBe(200);
    const callback=await google.requestUpstream("/o/oauth2/v2/auth/callback",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams(fields),redirect:"manual"});expect(callback.status).toBe(302);const location=new URL(callback.headers.get("location")!);expect(location.origin).toBe(new URL(google.oauthCallbackUrl).origin);expect(location.searchParams.get("state")).toBe(fields.state);
    const exchange={grant_type:"authorization_code",client_id:"fixture-client",client_secret:"synthetic-oauth-secret",redirect_uri:google.oauthCallbackUrl,code:location.searchParams.get("code")};
    const response=await google.requestUpstream("/oauth2/token",{method:"POST",body:JSON.stringify(exchange)});expect(response.status).toBe(200);const issued=record(await response.json());expect(issued.access_token).toBeTypeOf("string");expect(issued.id_token).toBeTypeOf("string");expect((await google.requestUpstream("/oauth2/token",{method:"POST",body:JSON.stringify(exchange)})).status).toBe(400);
  });
});
