import { createEmulator } from "emulate";
import type { OutboundIsolation } from "../isolation.js";
import { body, exactKeys, json, listenFixture, type FixtureServer } from "./http.js";
interface MessageRef { id: string; threadId: string }
interface MessageList { messages?: MessageRef[]; nextPageToken?: string; resultSizeEstimate?: number }
export interface GoogleFixture extends FixtureServer {
  email: string; upstreamUrl: string; oauthCallbackUrl: string; requestUpstream(path: string, init?: RequestInit): Promise<Response>;
  accepted: Array<MessageRef & { raw: string }>; attempts: Array<{ method: string; path: string }>;
  allMessages(): Promise<MessageRef[]>; importMessage(raw: string): Promise<MessageRef>; reset(): Promise<void>;
  acceptThenDrop(): void; delaySentVisibility(value?: boolean): void; revealSent(): void; expireHistory(value?: boolean): void; failNext(status: number): void;
}
export async function createGoogleFixture(isolation: OutboundIsolation): Promise<GoogleFixture> {
  const email = "owner@fixture.test";
  const token = "synthetic-google-access";
  const callback = await listenFixture((req,res,url)=>{if(req.method!=="GET"||url.pathname!=="/oauth/callback"){json(res,404,{error:"Unsupported OAuth callback"});return;}json(res,200,{code:url.searchParams.get("code"),state:url.searchParams.get("state")});});
  isolation.allow(callback.url);
  const oauthCallbackUrl = `${callback.url}/oauth/callback`;
  const upstream = await createEmulator({service:"google",hostname:"127.0.0.1",port:0,seed:{tokens:{[token]:{login:email}},google:{users:[{email,name:"Synthetic Owner"}],messages:[],calendars:[{id:"upstream-contract-probe",user_email:email,summary:"Unused except upstream gap contract",time_zone:"UTC"}],oauth_clients:[{client_id:"fixture-client",client_secret:"synthetic-oauth-secret",redirect_uris:[oauthCallbackUrl]}]}}}).catch(async error=>{await callback.close();throw error;});
  // The release may advertise localhost even when bound to IPv4. Never permit that alias.
  const upstreamUrl = new URL(upstream.url); upstreamUrl.hostname = "127.0.0.1";
  isolation.allow(upstreamUrl.origin);
  const requestUpstream = (path:string,init:RequestInit={}) => isolation.fetch(`${upstreamUrl.origin}${path}`,{...init,headers:{authorization:`Bearer ${token}`,"content-type":"application/json",...init.headers}});
  const hidden = new Set<string>();
  let hideNew = false, dropNext = false, expiredHistory = false;
  let nextStatus:number|undefined;
  const accepted: Array<MessageRef & {raw:string}> = [];
  const attempts:Array<{method:string;path:string}> = [];
  async function allMessages():Promise<MessageRef[]> {
    const result:MessageRef[]=[]; let page:string|undefined;
    do { const response=await requestUpstream(`/gmail/v1/users/me/messages?maxResults=500${page?`&pageToken=${encodeURIComponent(page)}`:""}`); if(!response.ok)throw new Error(`Emulator message inventory ${response.status}`); const value=await response.json() as MessageList;result.push(...value.messages??[]);page=value.nextPageToken; } while(page);
    return result;
  }
  const server = await listenFixture(async(req,res,url)=>{
    const method=req.method??"GET"; attempts.push({method,path:url.pathname});
    if(nextStatus){const status=nextStatus;nextStatus=undefined;json(res,status,{error:{code:status}});return;}
    const allowed = method === "GET" && /^\/gmail\/v1\/users\/me\/(profile|labels|history|messages(?:\/[^/]+(?:\/attachments\/[^/]+)?)?|threads(?:\/[^/]+)?)$/.test(url.pathname) || method === "POST" && /^\/gmail\/v1\/users\/me\/messages\/(send|import)$/.test(url.pathname);
    if(!allowed){json(res,501,{error:{code:501,message:`Unsupported fixture route ${method} ${url.pathname}`}});return;}
    if(url.pathname.endsWith("/profile")) {
      const refs=await allMessages(); const history=await requestUpstream("/gmail/v1/users/me/history?startHistoryId=0");
      const historyBody=await history.json() as {historyId:string};
      json(res,200,{emailAddress:email,messagesTotal:refs.length,threadsTotal:new Set(refs.map(x=>x.threadId)).size,historyId:historyBody.historyId});return;
    }
    if(expiredHistory && url.pathname.endsWith("/history")){json(res,404,{error:{code:404,message:"History cursor expired"}});return;}
    const id=/\/messages\/([^/]+)$/.exec(url.pathname)?.[1];
    if(method==="GET" && id && hidden.has(id)){json(res,404,{error:{code:404}});return;}
    const value=method==="POST"?await body(req):undefined;
    if(value)exactKeys(value,["raw","threadId","labelIds","internalDateSource"]);
    // emulate 0.12.3 supports -label:, but parses Gmail's equivalent -in: as literal text.
    // Translate only known system labels; keep all storage, search and pagination upstream.
    const query=url.searchParams.get("q");
    if(query)url.searchParams.set("q",query.replace(/(^|\s)-in:(sent|drafts|spam|trash)(?=\s|$)/gi,(_,prefix:string,label:string)=>`${prefix}-label:${label.toLowerCase()==="drafts"?"DRAFT":label.toUpperCase()}`));
    // The pinned parser slices rfc822msgid: at 11 instead of 12, leaving the colon.
    // Read canonical upstream headers rather than maintaining a second message store.
    const messageIdQuery = /(?:^|\s)rfc822msgid:(<?[^<>\s]+>?)(?=\s|$)/i.exec(query ?? "");
    if (method === "GET" && url.pathname.endsWith("/messages") && messageIdQuery) {
      const upstreamQuery = new URLSearchParams(url.search);
      upstreamQuery.set("q", (upstreamQuery.get("q") ?? "").replace(messageIdQuery[0], " ").trim());
      upstreamQuery.set("maxResults", "500"); upstreamQuery.delete("pageToken");
      const matches: MessageRef[] = [], visited = new Set<string>();
      let page: string | undefined;
      const expected = messageIdQuery[1]!.replace(/[<>]/g, "").toLowerCase();
      do {
        if (page) { if (visited.has(page)) throw new Error("Repeated upstream message cursor"); visited.add(page); upstreamQuery.set("pageToken", page); }
        const batch = await requestUpstream(`${url.pathname}?${upstreamQuery}`);
        if (!batch.ok) { json(res, batch.status, await batch.json()); return; }
        const inventory = await batch.json() as MessageList;
        for (const ref of inventory.messages ?? []) {
          if (hidden.has(ref.id)) continue;
          const response = await requestUpstream(`/gmail/v1/users/me/messages/${encodeURIComponent(ref.id)}?format=full`);
          if (!response.ok) throw new Error(`Canonical message read failed ${response.status}`);
          const message = await response.json() as { payload?: { headers?: Array<{name: string; value: string}> } };
          const id = message.payload?.headers?.find(header => header.name.toLowerCase() === "message-id")?.value;
          if (id?.replace(/[<>]/g, "").toLowerCase() === expected) matches.push(ref);
        }
        page = inventory.nextPageToken;
      } while (page);
      const offset = Number(url.searchParams.get("pageToken") ?? 0), limit = Number(url.searchParams.get("maxResults") ?? 100);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) { json(res, 400, { error: "Invalid Message-ID pagination" }); return; }
      json(res, 200, { messages: matches.slice(offset, offset + limit), resultSizeEstimate: matches.length, ...(offset + limit < matches.length ? {nextPageToken: String(offset + limit)} : {}) }); return;
    }
    const response=await requestUpstream(url.pathname+url.search,{method,...(value?{body:JSON.stringify(value)}:{})});
    const data=await response.json() as Record<string,unknown>;
    if(method==="POST" && url.pathname.endsWith("/send") && response.ok){
      const receipt={id:String(data.id),threadId:String(data.threadId),raw:String(value?.raw)};accepted.push(receipt);if(hideNew)hidden.add(receipt.id);
      if(dropNext){dropNext=false;res.destroy();return;}
    }
    if(method==="GET" && url.pathname.endsWith("/messages") && Array.isArray(data.messages))data.messages=(data.messages as MessageRef[]).filter(x=>!hidden.has(x.id));
    json(res,response.status,data);
  });
  isolation.allow(server.url);
  return {...server,email,upstreamUrl:upstreamUrl.origin,oauthCallbackUrl,requestUpstream,accepted,attempts,allMessages,
    acceptThenDrop(){dropNext=true;},delaySentVisibility(value=true){hideNew=value;},revealSent(){hidden.clear();hideNew=false;},expireHistory(value=true){expiredHistory=value;},failNext(status:number){nextStatus=status;},
    async importMessage(raw:string){const response=await requestUpstream("/gmail/v1/users/me/messages/import",{method:"POST",body:JSON.stringify({raw})});if(!response.ok)throw new Error(`Import failed ${response.status}`);return response.json() as Promise<MessageRef>;},
    async close(){await server.close();await upstream.close();await callback.close();},
    async reset(){upstream.reset();accepted.length=0;attempts.length=0;hidden.clear();hideNew=false;dropNext=false;expiredHistory=false;nextStatus=undefined;},
  };
}
