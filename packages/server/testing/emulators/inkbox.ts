import {randomUUID} from "node:crypto";
import {body,exactKeys,json,listenFixture,type FixtureServer} from "./http.js";

export type FeedbackKind = "read" | "typing" | "reaction";
export interface IncomingFixtureMessage extends Record<string, unknown> {
  id: string; conversation_id: string; direction: "inbound"; content: string;
  remote_number: string; is_group: boolean; participants: string[]; is_read: boolean;
}
export interface InkboxFixture extends FixtureServer {
  attempts: Array<{ path: string; key: string | null; body: Record<string, unknown> }>;
  accepted: Array<Record<string, unknown>>; receipts: Array<{ messageId: string; status: "delivered" | "delivery_failed" }>;
  feedbackAttempts: Array<{kind: FeedbackKind; path: string; body: Record<string, unknown>}>;
  readReceipts: Array<{conversation_id: string; updated_count: number}>;
  typingIndicators: Array<{conversation_id: string}>;
  reactions: Array<Record<string, unknown>>;
  addIncoming(options: {id?: string; conversationId: string; text?: string; from?: string; isGroup?: boolean; participants?: string[]}): IncomingFixtureMessage;
  acceptThenDropFeedback(kind: FeedbackKind): void;
  failNextFeedback(kind: FeedbackKind, status: number): void;
  holdNextFeedback(kind: FeedbackKind, gate: Promise<void>): void;
  acceptThenDrop(): void; failNext(status: number): void; deliver(messageId: string, status?: "delivered" | "delivery_failed"): void;
}
export async function createInkboxFixture(): Promise<InkboxFixture>{
  const attempts:Array<{path:string;key:string|null;body:Record<string,unknown>}> = [];
  const accepted:Array<Record<string,unknown>>=[];
  const receipts:Array<{messageId:string;status:"delivered"|"delivery_failed"}>=[];
  const feedbackAttempts: InkboxFixture["feedbackAttempts"] = [];
  const readReceipts: InkboxFixture["readReceipts"] = [];
  const typingIndicators: InkboxFixture["typingIndicators"] = [];
  const reactions: InkboxFixture["reactions"] = [];
  const incoming = new Map<string, IncomingFixtureMessage>();
  const feedbackDrops = new Set<FeedbackKind>();
  const feedbackFailures = new Map<FeedbackKind, number>();
  const feedbackHolds = new Map<FeedbackKind, Promise<void>>();
  const reactionKinds = ["love", "like", "dislike", "laugh", "emphasize", "question", "eyes"];
  const idempotency=new Map<string,Record<string,unknown>>();
  let dropNext=false,nextStatus:number|undefined;
  const server=await listenFixture(async(req,res,url)=>{
    if(req.headers.authorization!=="Bearer synthetic-inkbox-key"&&req.headers["x-api-key"]!=="synthetic-inkbox-key"){json(res,401,{error:"Unauthorized"});return;}
    if(req.method==="GET"&&url.pathname==="/api/v1/identities/fixture-assistant"){
      json(res,200,{id:"identity-fixture",agent_handle:"fixture-assistant",display_name:"Synthetic Assistant",imessage_enabled:true,email_address:"assistant@fixture.test",created_at:"2026-01-01T00:00:00Z",phone_number:{id:"phone-fixture",phone_number:"+12025550100",created_at:"2026-01-01T00:00:00Z"},mailbox:{id:"mail-fixture",email_address:"assistant@fixture.test",created_at:"2026-01-01T00:00:00Z"}});return;
    }
    const lookup = /^\/api\/v1\/imessage\/messages\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && lookup) {
      if (url.searchParams.has("agent_identity_id") && url.searchParams.get("agent_identity_id") !== "identity-fixture") { json(res,404,{error:"Unknown identity message"}); return; }
      const id = decodeURIComponent(lookup[1]!);
      const message = incoming.get(id) ?? accepted.find(message => message.id === id);
      json(res,message ? 200 : 404,message ?? {error:"Unknown message"}); return;
    }
    const conversation = /^\/api\/v1\/imessage\/conversations\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && conversation) {
      const id = decodeURIComponent(conversation[1]!);
      const message = [...incoming.values()].find(message => message.conversation_id === id);
      json(res,message ? 200 : 404,message ? {id,assignment_id:null,remote_number:message.remote_number,is_group:message.is_group,participants:message.participants} : {error:"Unknown conversation"}); return;
    }
    const kind: FeedbackKind | undefined = url.pathname === "/api/v1/imessage/mark-read" ? "read"
      : url.pathname === "/api/v1/imessage/typing" ? "typing" : url.pathname === "/api/v1/imessage/reactions" ? "reaction" : undefined;
    if (req.method === "POST" && kind) {
      const value = await body(req);
      exactKeys(value, kind === "reaction" ? ["message_id", "reaction", "part_index"] : ["conversation_id"]);
      feedbackAttempts.push({kind,path:url.pathname,body:value});
      const target = typeof value.message_id === "string" ? incoming.get(value.message_id) : undefined;
      const conversationId = kind === "reaction" ? target?.conversation_id : value.conversation_id;
      if (kind === "reaction" && (!target || typeof value.reaction !== "string" || !reactionKinds.includes(value.reaction) || !Number.isInteger(value.part_index) || Number(value.part_index) < 0)) {
        json(res,400,{error:"Reaction requires a seeded inbound message, named tapback and nonnegative part index"}); return;
      }
      if (typeof conversationId !== "string" || !conversationId) { json(res,400,{error:"Missing conversation_id"}); return; }
      if (kind !== "reaction" && [...incoming.values()].some(message => message.conversation_id === conversationId && message.is_group)) {
        json(res,409,{error:"Group read receipts and typing are unsupported"}); return;
      }
      const hold = feedbackHolds.get(kind); feedbackHolds.delete(kind);
      if (hold) {
        const closed = Promise.withResolvers<void>();
        res.once("close", closed.resolve);
        try { await Promise.race([hold, closed.promise]); } finally { res.off("close", closed.resolve); }
        if (res.destroyed) return;
      }
      const failure = feedbackFailures.get(kind); feedbackFailures.delete(kind);
      if (failure !== undefined) { json(res,failure,{error:"Injected feedback failure"}); return; }
      let result: Record<string,unknown>;
      if (kind === "read") {
        let updatedCount = 0;
        for (const message of incoming.values()) if (message.conversation_id === conversationId && !message.is_read) { message.is_read = true; updatedCount++; }
        result = {conversation_id:conversationId,updated_count:updatedCount};
        readReceipts.push({conversation_id:conversationId,updated_count:updatedCount});
      } else if (kind === "typing") {
        result = {conversation_id:conversationId}; typingIndicators.push({conversation_id:conversationId});
      } else {
        result = {id:randomUUID(),conversation_id:conversationId,assignment_id:null,target_message_id:target!.id,direction:"outbound",reaction:value.reaction,remote_number:target!.remote_number,part_index:value.part_index,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
        reactions.push(result);
      }
      if (feedbackDrops.delete(kind)) { res.destroy(); return; }
      json(res,200,result); return;
    }
    const sms=url.pathname==="/api/v1/phone/numbers/phone-fixture/texts";
    const imessage=url.pathname==="/api/v1/imessage/messages";
    if(req.method==="POST"&&(sms||imessage)){
      const value=await body(req);exactKeys(value,["to","conversation_id","text","media_urls","agent_identity_id","agent_handle","reply_to_message_id","send_style"]);
      const key=typeof req.headers["idempotency-key"]==="string"?req.headers["idempotency-key"]:null;
      attempts.push({path:url.pathname,key,body:value});
      if(nextStatus){const status=nextStatus;nextStatus=undefined;json(res,status,{error:"Injected provider failure"});return;}
      let message=key?idempotency.get(key):undefined;
      if(message&&JSON.stringify(message.fixture_request)!==JSON.stringify(value)){json(res,409,{error:"Idempotency payload mismatch"});return;}
      if(!message){message={id:randomUUID(),conversation_id:value.conversation_id??"conversation-fixture",text:value.text??"",body:value.text??"",to:value.to??[],direction:"outbound",status:"queued",state:"queued",created_at:new Date().toISOString(),fixture_request:value};accepted.push(message);if(key)idempotency.set(key,message);}
      if(dropNext){dropNext=false;res.destroy();return;}
      json(res,200,imessage?{message}:message);return;
    }
    json(res,501,{error:`Unsupported Inkbox fixture ${req.method} ${url.pathname}`});
  });
  return {...server,attempts,accepted,receipts,feedbackAttempts,readReceipts,typingIndicators,reactions,
    addIncoming(options) {
      const id = options.id ?? randomUUID();
      if (incoming.has(id) || accepted.some(message => message.id === id)) throw new Error("Duplicate fixture message");
      const from = options.from ?? "+12025550101";
      const message: IncomingFixtureMessage = {id,conversation_id:options.conversationId,direction:"inbound",content:options.text ?? "Synthetic incoming message",remote_number:from,sender_number:from,is_group:options.isGroup ?? false,participants:options.participants ?? [from],is_read:false,assignment_id:null,message_type:"text",service:"iMessage",media:[],created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
      incoming.set(id,message); return message;
    },
    acceptThenDropFeedback(kind){feedbackDrops.add(kind);},
    failNextFeedback(kind,status){feedbackFailures.set(kind,status);},
    holdNextFeedback(kind,gate){feedbackHolds.set(kind,gate);},
    acceptThenDrop(){dropNext=true;},failNext(status:number){nextStatus=status;},deliver(messageId:string,status:"delivered"|"delivery_failed"="delivered"){if(!accepted.some(m=>m.id===messageId))throw new Error("Unknown accepted message");receipts.push({messageId,status});}};
}
