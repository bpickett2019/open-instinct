import {randomUUID} from "node:crypto";
import {McpClient,StreamableHttpTransport} from "@earendil-works/pi-mcp";
import type {ComposioAppsOptions,ComposioSessionLike} from "@open-instinct/apps";
import type {OutboundIsolation} from "../isolation.js";
import {body,exactKeys,json,listenFixture,mcpReply,record,string,text,type FixtureServer} from "./http.js";
interface Account {id:string;user_id:string;toolkit:{slug:string};status:string;is_disabled:boolean}
interface Session {id:string;userId:string;toolkits:string[];accounts:Record<string,string>}
export interface ComposioFixture extends FixtureServer {
  accounts: Map<string, Account>; sessions: Map<string, Session>; invocations: Array<{ sessionId: string; name: string; args: Record<string, unknown> }>;
  proxyRequests: Array<Record<string, unknown>>; notes: string[]; adapters: NonNullable<ComposioAppsOptions["adapters"]>;
  revoke(id: string): void; reconnect(id: string): void; substitute(id: string, newId: string): void; respondNext(result: "blocked" | "input_required"): void;
  enablePayments(userId: string): void; purchases: Array<Record<string, unknown>>;
}
export async function createComposioFixture(isolation:OutboundIsolation,googleUrl:string,calendarUrl:string): Promise<ComposioFixture>{
  const accounts=new Map<string,Account>(),sessions=new Map<string,Session>();
  const invocations:Array<{sessionId:string;name:string;args:Record<string,unknown>}>=[];
  const proxyRequests:Array<Record<string,unknown>>=[];
  let nextResult:"blocked"|"input_required"|undefined;
  function seedAccounts(userId:string){for(const slug of ["gmail","googlecalendar"]){const id=`${slug}-${userId}`;if(!accounts.has(id))accounts.set(id,{id,user_id:userId,toolkit:{slug},status:"ACTIVE",is_disabled:false});}}
  const catalog=[{name:"FIXTURE_RECORD_NOTE",description:"Store a synthetic connected-app note.",inputSchema:{type:"object",properties:{text:{type:"string"}},required:["text"]}}];
  const paymentCatalog=[{name:"STRIPE_CREATE_PAYMENT_INTENT",description:"Create a synthetic payment intent.",inputSchema:{type:"object",properties:{amount:{type:"integer"},currency:{type:"string"}},required:["amount","currency"]}}];
  const purchases:Array<Record<string,unknown>>=[];
  const notes:string[]=[];
  const server=await listenFixture(async(req,res,url)=>{
    const mcp=/^\/mcp\/([^/]+)$/.exec(url.pathname);
    if(mcp){
      const session=sessions.get(mcp[1]!);if(!session){json(res,404,{error:"Unknown session"});return;}
      if(req.method==="GET"){res.writeHead(405);res.end();return;}if(req.method==="DELETE"){res.writeHead(200);res.end();return;}
      if(req.method!=="POST"){json(res,405,{error:"Unsupported method"});return;}
      const selectedCatalog=session.toolkits.includes("stripe")?paymentCatalog:catalog;
      mcpReply(res,await body(req),selectedCatalog,(name,args)=>{
        invocations.push({sessionId:session.id,name,args:structuredClone(args)});
        if(name==="STRIPE_CREATE_PAYMENT_INTENT"&&session.toolkits.includes("stripe")){exactKeys(args,["amount","currency"]);if(!Number.isSafeInteger(args.amount)||Number(args.amount)<=0||args.currency!=="usd")throw new Error("Invalid payment");purchases.push(structuredClone(args));return text({id:`payment-${purchases.length}`,status:"succeeded"});}
        if(name!=="FIXTURE_RECORD_NOTE"||session.toolkits.includes("stripe"))return {...text({error:"Unsupported tool"}),isError:true};
        exactKeys(args,["text"]);notes.push(string(args.text));return text({id:`note-${notes.length}`,accepted:true});
      });return;
    }
    if(req.headers["x-api-key"]!=="synthetic-composio-key"){json(res,401,{error:"Unauthorized"});return;}
    if(url.pathname==="/fixture/sessions"&&req.method==="POST"){
      const value=await body(req);exactKeys(value,["userId","config"]);const userId=string(value.userId);const config=record(value.config);exactKeys(config,["toolkits","manageConnections","mcp","sessionPreset","connectedAccounts","workbench"]);
      seedAccounts(userId);
      const selected: Record<string,string> = {};
      for(const [toolkit,id] of Object.entries(record(config.connectedAccounts??{}))){const account=accounts.get(string(id));if(!account||account.user_id!==userId||account.toolkit.slug!==toolkit||account.status!=="ACTIVE"||account.is_disabled){json(res,403,{error:"MCP account binding rejected"});return;}selected[toolkit]=account.id;}
      const session:Session={id:randomUUID(),userId,toolkits:Array.isArray(config.toolkits)?config.toolkits.map(string):["gmail","googlecalendar"],accounts:selected};sessions.set(session.id,session);json(res,200,session);return;
    }
    const sessionRoute=/^\/fixture\/sessions\/([^/]+)(?:\/(toolkits|authorize))?$/.exec(url.pathname);
    if(sessionRoute){const session=sessions.get(sessionRoute[1]!);if(!session){json(res,404,{error:"Unknown session"});return;}
      if(!sessionRoute[2]&&req.method==="GET"){json(res,200,session);return;}
      if(sessionRoute[2]==="toolkits"&&req.method==="POST"){const value=await body(req);exactKeys(value,["toolkits","isConnected","limit","cursor"]);const slugs=Array.isArray(value.toolkits)?value.toolkits.map(string):session.toolkits;json(res,200,{items:slugs.map(slug=>({slug,connection:{isActive:[...accounts.values()].some(a=>a.user_id===session.userId&&a.toolkit.slug===slug&&a.status==="ACTIVE"&&!a.is_disabled)}}))});return;}
      if(sessionRoute[2]==="authorize"&&req.method==="POST"){const value=await body(req);exactKeys(value,["toolkit"]);json(res,200,{redirectUrl:`${server.url}/oauth/${encodeURIComponent(string(value.toolkit))}`});return;}
    }
    if(url.pathname==="/api/v3/connected_accounts"&&req.method==="GET"){json(res,200,{items:[...accounts.values()].filter(a=>a.user_id===url.searchParams.get("user_ids")),next_cursor:null});return;}
    const accountRoute=/^\/api\/v3\/connected_accounts\/([^/]+)$/.exec(url.pathname);
    if(accountRoute){const account=accounts.get(decodeURIComponent(accountRoute[1]!));if(!account){json(res,404,{error:"Account not found"});return;}
      if(req.method==="GET"){json(res,200,account);return;}
      if(req.method==="DELETE"&&url.searchParams.get("revoke_on_delete")==="true"){account.status="DELETED";account.is_disabled=true;json(res,200,{success:true,revoke_job_id:`revoke-${account.id}`});return;}
    }
    if(url.pathname==="/api/v3/tool_router/session"&&req.method==="POST"){
      const value=await body(req);exactKeys(value,["user_id","toolkits","connected_accounts","manage_connections","workbench","proxy_execute"]);
      if(!value.toolkits||typeof value.toolkits!=="object"||Array.isArray(value.toolkits)){json(res,400,{error:"Invalid toolkit allowlist"});return;}
      const toolkits=record(value.toolkits);exactKeys(toolkits,["enable"]);
      if(!Array.isArray(toolkits.enable)||!toolkits.enable.length||toolkits.enable.some(slug=>typeof slug!=="string")){json(res,400,{error:"Invalid toolkit allowlist"});return;}
      const userId=string(value.user_id),bound=record(value.connected_accounts);const selected:Record<string,string>={};
      if(toolkits.enable.length!==Object.keys(bound).length||toolkits.enable.some(slug=>!Object.hasOwn(bound,String(slug)))){json(res,403,{error:"Toolkit account binding rejected"});return;}
      for(const [toolkit,id] of Object.entries(bound)){const account=accounts.get(string(id));if(!account||account.user_id!==userId||account.toolkit.slug!==toolkit||account.is_disabled||account.status!=="ACTIVE"){json(res,403,{error:"Account binding rejected"});return;}selected[toolkit]=account.id;}
      const session:Session={id:randomUUID(),userId,toolkits:toolkits.enable.map(string),accounts:selected};sessions.set(session.id,session);json(res,201,{session_id:session.id,config:{user_id:userId,toolkits:{enabled:session.toolkits},connected_accounts:selected}});return;
    }
    const proxy=/^\/api\/v3\/tool_router\/session\/([^/]+)\/proxy_execute$/.exec(url.pathname);
    if(proxy&&req.method==="POST"){
      const session=sessions.get(proxy[1]!);if(!session){json(res,404,{error:"Unknown session"});return;}
      const value=await body(req);exactKeys(value,["toolkit_slug","endpoint","method","body","parameters"]);proxyRequests.push(structuredClone(value));
      const toolkit=string(value.toolkit_slug),account=accounts.get(session.accounts[toolkit]??"");
      if(!account||account.user_id!==session.userId||account.status!=="ACTIVE"||account.is_disabled){json(res,200,{result_type:"blocked",reason:"Account revoked"});return;}
      if(nextResult){const result=nextResult;nextResult=undefined;json(res,200,{result_type:result});return;}
      const endpoint=new URL(string(value.endpoint));
      const isGmail=toolkit==="gmail"&&endpoint.hostname==="gmail.googleapis.com"&&endpoint.pathname.startsWith("/gmail/v1/");
      const isCalendar=toolkit==="googlecalendar"&&endpoint.hostname==="www.googleapis.com"&&endpoint.pathname.startsWith("/calendar/v3/");
      if(endpoint.protocol!=="https:"||endpoint.username||endpoint.password||endpoint.search||(!isGmail&&!isCalendar)){json(res,400,{error:"Unsupported proxy destination"});return;}
      const target=new URL(endpoint.pathname,isGmail?googleUrl:calendarUrl);const headers:Record<string,string>={"content-type":"application/json"};
      if(!Array.isArray(value.parameters))throw new Error("Expected proxy parameters");
      for(const item of value.parameters){const parameter=record(item);exactKeys(parameter,["name","value","type"]);if(parameter.type==="query")target.searchParams.append(string(parameter.name),string(parameter.value));else if(parameter.type==="header"&&parameter.name==="If-Match")headers["if-match"]=string(parameter.value);else throw new Error("Unsupported proxy parameter");}
      const method=string(value.method);if(!["GET","POST","PATCH","PUT","DELETE"].includes(method))throw new Error("Unsupported proxy method");
      try{const response=await isolation.fetch(target,{method,headers,...(value.body?{body:JSON.stringify(value.body)}:{})});const data=response.status===204?{}:await response.json();json(res,200,{result_type:"completed",status:response.status,data});}catch{res.destroy();}return;
    }
    json(res,501,{error:`Unsupported Composio fixture ${req.method} ${url.pathname}`});
  });
  isolation.allow(server.url);
  async function request(path:string,method="GET",value?:unknown){const response=await isolation.fetch(server.url+path,{method,headers:{"x-api-key":"synthetic-composio-key","content-type":"application/json"},...(value?{body:JSON.stringify(value)}:{})});if(!response.ok)throw new Error(`Fixture session request ${response.status}`);return record(await response.json());}
  function sessionClient(value:Record<string,unknown>):ComposioSessionLike{
    const id=string(value.id);return {sessionId:id,mcp:{url:`${server.url}/mcp/${id}`},authorize:async toolkit=>{const result=await request(`/fixture/sessions/${id}/authorize`,"POST",{toolkit});return {redirectUrl:string(result.redirectUrl)};},toolkits:async options=>{const result=await request(`/fixture/sessions/${id}/toolkits`,"POST",options??{});if(!Array.isArray(result.items))throw new Error("Invalid fixture toolkits");return {items:result.items.map(item=>{const entry=record(item);return {slug:string(entry.slug),connection:{isActive:record(entry.connection).isActive===true}};})};}};
  }
  const adapters:NonNullable<ComposioAppsOptions["adapters"]>={
    createComposio:()=>({sessions:{create:async(userId,config)=>sessionClient(await request("/fixture/sessions","POST",{userId,config})),use:async id=>sessionClient(await request(`/fixture/sessions/${id}`))}}),
    connectMcp:async endpoint=>{isolation.assertAllowed(endpoint.url);const client=new McpClient({name:"fixture-composio-client",version:"1"});await client.connect(new StreamableHttpTransport({url:endpoint.url,headers:endpoint.headers??{}}));return client;},
    fetchImpl:async(input,init)=>{const request=new Request(input,init),url=new URL(request.url);if(url.origin!=="https://backend.composio.dev"||!url.pathname.startsWith("/api/v3/"))return isolation.fetch(request);return isolation.fetch(new Request(server.url+url.pathname+url.search,request));},
  };
  const enablePayments=(userId:string)=>{const id=`stripe-${userId}`;accounts.set(id,{id,user_id:userId,toolkit:{slug:"stripe"},status:"ACTIVE",is_disabled:false});};
  return {...server,accounts,sessions,invocations,proxyRequests,notes,purchases,enablePayments,adapters,revoke(id:string){const account=accounts.get(id);if(!account)throw new Error("Unknown account");account.status="EXPIRED";account.is_disabled=true;},reconnect(id:string){const account=accounts.get(id);if(!account)throw new Error("Unknown account");account.status="ACTIVE";account.is_disabled=false;},substitute(id:string,newId:string){const account=accounts.get(id);if(!account)throw new Error("Unknown account");accounts.delete(id);accounts.set(newId,{...account,id:newId});},respondNext(result:"blocked"|"input_required"){nextResult=result;}};
}
