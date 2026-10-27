import {mkdtempSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createServer,type Server} from "node:http";
import {randomUUID} from "node:crypto";
import {createModels,fauxProvider,fauxAssistantMessage,fauxToolCall,getCurrentTools,type FauxResponseStep,type FauxProviderHandle} from "@earendil-works/pi-ai";
import type {StreamFn} from "@earendil-works/pi-agent-core";
import {StateDir,defaultConfig,saveConfig} from "@open-instinct/core";
import {computeInkboxSignature} from "@open-instinct/inkbox";
import {boot,type BootResult} from "../dist/boot.js";
import {createHttpServer,closeInkboxInbox} from "../dist/http.js";
import {OutboundIsolation} from "./isolation.js";
import {createGoogleFixture,type GoogleFixture} from "./emulators/google.js";
import {createCalendarFixture,type CalendarFixture} from "./emulators/calendar.js";
import {createComposioFixture,type ComposioFixture} from "./emulators/composio.js";
import {createMaritimeFixture,type MaritimeFixture} from "./emulators/maritime.js";
import {createInkboxFixture,type InkboxFixture} from "./emulators/inkbox.js";
import {record,string} from "./emulators/http.js";

async function listen(server:Server):Promise<string>{const ready=Promise.withResolvers<void>();server.once("error",ready.reject);server.listen(0,"127.0.0.1",ready.resolve);await ready.promise;const address=server.address();if(!address||typeof address==="string")throw new Error("Controller did not bind");return `http://127.0.0.1:${address.port}`;}
async function closeServer(server:Server|undefined){if(!server)return;if(!server.listening){server.emit("close");return;}const done=Promise.withResolvers<void>();server.close(e=>e?done.reject(e):done.resolve());server.closeAllConnections();await done.promise;}
export interface ScenarioOptions {responses?:FauxResponseStep[];foregroundResponses?:FauxResponseStep[];now?:()=>Date}
export interface ScenarioApp {
  readonly url: string; readonly tunnelUrl: string; readonly token: string; readonly signingKey: string; readonly root: string;
  readonly state: StateDir; readonly model: FauxProviderHandle; readonly foregroundModel: FauxProviderHandle; readonly app: BootResult; readonly fetch: typeof fetch; readonly allowedOrigins: Set<string>;
  readonly providers: {google: GoogleFixture; calendar: CalendarFixture; composio: ComposioFixture; maritime: MaritimeFixture; inkbox: InkboxFixture};
  waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeout?: number): Promise<void>;
  login(): Promise<{cookie: string; csrf: string}>;
  owner(path: string, options?: {method?: string; body?: unknown; headers?: Record<string,string>}): Promise<Response>;
  postMessage(text: string, id?: string): Promise<Response>; webhook(payload: unknown, valid?: boolean): Promise<Response>;
  gate(): {promise: Promise<void>; release(): void}; restart(beforeStart?: () => Promise<void>): Promise<void>; close(): Promise<void>;
}
export async function createScenarioApp(options:ScenarioOptions={}): Promise<ScenarioApp>{
  const isolation=new OutboundIsolation();
  const root=realpathSync(mkdtempSync(join(tmpdir(),"instinct-scenario-")));
  const state=new StateDir(root);state.ensure();
  const config=defaultConfig();config.business={autonomy:"full"};config.owner.name="Synthetic Owner";config.owner.phones=["+12025550101"];config.owner.emails=["owner@fixture.test"];config.agent.handle="fixture-assistant";config.apps.toolkits=["gmail","googlecalendar"];config.apps.enabled=true;config.model={primary:"faux/scenario",thinking:"off"};saveConfig(state,config);
  const cleanup:Array<()=>Promise<void>>=[];
  let app:BootResult,listener:Server|undefined,routes:Server|undefined,tunnel:Server|undefined,url="",tunnelUrl="";
  let cookie="",csrf="";
  let started = false;
  const releases=new Set<()=>void>();
  const model=fauxProvider({provider:"faux",models:[{id:"scenario"}]});const models=createModels();models.setProvider(model.provider);
  const foregroundModel=fauxProvider({provider:"faux-foreground",models:[{id:"foreground"}]});const foregroundModels=createModels();foregroundModels.setProvider(foregroundModel.provider);
  foregroundModel.setResponses(options.foregroundResponses??[]);
  const streamFn: StreamFn=(selected,context,streamOptions)=>{
    const foreground = (context.systemPrompt ?? "").includes("## Business foreground") || context.messages.some(message => message.role === "system" && (typeof message.content === "string" ? message.content : message.content.map(block => block.text).join("\n")).includes("## Business foreground"));
    if(!foreground)return models.streamSimple(selected,context,streamOptions);
    if(foregroundModel.getPendingResponseCount()===0)foregroundModel.setResponses([(transcript)=>{
      if(!getCurrentTools(transcript.messages).length)return fauxAssistantMessage("Welcome. Tell me about your business and what you would like help with.");
      const lastUserIndex=transcript.messages.findLastIndex(message=>message.role==="user");
      const user=transcript.messages[lastUserIndex];if(!user||user.role!=="user")throw new Error("Foreground fixture requires an actual owner message");
      const result=transcript.messages.slice(lastUserIndex+1).findLast(message=>message.role==="toolResult"&&message.toolName==="business_delegate");
      if(result?.role==="toolResult"){const detail=result.content.filter(block=>block.type==="text").map(block=>block.text).join("\n");return fauxAssistantMessage(`${result.isError?"Delegation blocked":"Delegation recorded"}: ${detail}`);}
      const objective=typeof user.content==="string"?user.content:user.content.filter(block=>block.type==="text").map(block=>block.text).join("\n");
      return fauxAssistantMessage([fauxToolCall("business_delegate",{objective,doneCriteria:["Satisfy the owner's objective with independently inspectable outcome evidence."]})],{stopReason:"toolUse"});
    }]);
    return foregroundModels.streamSimple(foregroundModel.getModel("foreground")!,context,streamOptions);
  };
  const token="synthetic-owner-workspace-token",signingKey="synthetic-inkbox-signing-key";
  const now=options.now??(()=>new Date());
  async function stopController(){for(const release of releases)release();releases.clear();await closeServer(listener);listener=undefined;await closeServer(tunnel);tunnel=undefined;await closeServer(routes);routes=undefined;if(app){await closeInkboxInbox(app);await app.close();}}
  try{
    const google=await createGoogleFixture(isolation);cleanup.push(()=>google.close());
    const calendar=await createCalendarFixture();isolation.allow(calendar.url);cleanup.push(()=>calendar.close());
    const composio=await createComposioFixture(isolation,google.url,calendar.url);cleanup.push(()=>composio.close());
    const maritime=await createMaritimeFixture();isolation.allow(maritime.url);cleanup.push(()=>maritime.close());
    const inkbox=await createInkboxFixture();isolation.allow(inkbox.url);cleanup.push(()=>inkbox.close());
    isolation.install();
    async function start(){
      listener=createServer();url=await listen(listener);isolation.allow(url);
      const env:NodeJS.ProcessEnv={INSTINCT_DATA_DIR:root,INSTINCT_CHAT_TOKEN:token,INSTINCT_WORKSPACE_ORIGIN:url,INSTINCT_WORKSPACE_ALLOW_HTTP:"1",INSTINCT_SKILLS_DIR:join(root,"no-skills"),COMPOSIO_API_KEY:"synthetic-composio-key",INKBOX_API_KEY:"synthetic-inkbox-key",INKBOX_AGENT_HANDLE:"fixture-assistant",INKBOX_HANDLE:"fixture-assistant",INKBOX_BASE_URL:inkbox.url,INKBOX_SIGNING_KEY:signingKey,MARITIME_COMPUTER_API_KEY:"synthetic-maritime-computer",MARITIME_COMPUTERS_MCP_URL:maritime.url};
      app=await boot(env,{model:model.getModel("scenario"),streamFn,logger:()=>{},fetchImpl:isolation.fetch,appsAdapters:composio.adapters,now});
      routes=createHttpServer(app,{env,now});
      // Keep the allocated socket; these are the real production route listeners.
      for(const handler of routes.listeners("request"))listener.on("request",handler as (req:unknown,res:unknown)=>void);
      tunnel=createHttpServer(app,{env,now,tunnelOnly:true});tunnelUrl=await listen(tunnel);isolation.allow(tunnelUrl);
      if(!app.business||!app.apps||app.computerKind!=="maritime")throw new Error("Scenario optional provider boot failed");
      const names=(await app.apps.tools()).map(tool=>tool.spec.name);if(!names.includes("app_fixture_record_note"))throw new Error("Composio real MCP catalog unavailable");
      if(!started)for(const slug of ["gmail","googlecalendar"])if(!app.appsConnected?.includes(slug))throw new Error(`Missing connected fixture ${slug}`);
      if(!maritime.discoveredWorkspaces.has(app.business.coordinator.store.settings().value.workspaceId))throw new Error("Maritime MCP tool discovery failed");
      if(!app.ownerWorkspace?.connections||!app.ownerWorkspace.artifacts||!app.ownerWorkspace.computer)throw new Error("Business owner services failed to initialize");
      const bound=await app.ownerWorkspace.connections.list();for(const toolkit of ["gmail","googlecalendar"])if(!bound.some(connection=>connection.toolkit===toolkit&&(started||connection.status==="connected")&&connection.identity==="owner@fixture.test"))throw new Error(`Missing verified fixture identity ${toolkit}`);
      const asset=await isolation.fetch(`${url}/workspace/assets/workspace.js`);if(!asset.ok||(await asset.text()).length<100)throw new Error("Compiled workspace assets missing; build before scenarios");
      cookie="";csrf="";
      started=true;
    }
    const facade: ScenarioApp={
      get url(){return url;},get tunnelUrl(){return tunnelUrl;},token,signingKey,root,state,model,foregroundModel,
      get app(){return app;},providers:{google,calendar,composio,maritime,inkbox},fetch:isolation.fetch,allowedOrigins:isolation.origins,
      async waitFor(predicate:()=>boolean|Promise<boolean>,label:string,timeout=10_000){const deadline=performance.now()+timeout;while(!await predicate()){if(performance.now()>deadline)throw new Error(`Timed out ${label}; tasks=${JSON.stringify(app.business?.coordinator.store.tasks())}`);const tick=Promise.withResolvers<void>();setImmediate(tick.resolve);await tick.promise;}},
      async login(){const response=await isolation.fetch(`${url}/api/owner/session`,{method:"POST",headers:{origin:url,"content-type":"application/json"},body:JSON.stringify({token})});if(!response.ok)throw new Error(`Login failed ${response.status}: ${await response.text()}`);cookie=response.headers.get("set-cookie")?.split(";")[0]??"";csrf=string(record(await response.json()).csrf);return {cookie,csrf};},
      async owner(path:string,options:{method?:string;body?:unknown;headers?:Record<string,string>}={}){return isolation.fetch(`${url}/api/owner${path}`,{method:options.method??"GET",headers:{cookie,origin:url,"content-type":"application/json","x-workspace-csrf":csrf,...options.headers},...(options.body!==undefined?{body:JSON.stringify(options.body)}:{})});},
      async postMessage(text:string,id=randomUUID()){if(!cookie)await facade.login();return facade.owner("/messages",{method:"POST",body:{text,clientId:id}});},
      async webhook(payload:unknown,valid=true){const raw=JSON.stringify(payload),id=randomUUID(),timestamp=String(Math.floor(Date.now()/1000));const signature=computeInkboxSignature(raw,id,timestamp,signingKey);return isolation.fetch(`${tunnelUrl}/webhooks/inkbox`,{method:"POST",headers:{"content-type":"application/json","x-inkbox-request-id":id,"x-inkbox-timestamp":timestamp,"x-inkbox-signature":valid?signature:"invalid"},body:raw});},
      gate(){const gate=Promise.withResolvers<void>();releases.add(gate.resolve);return {promise:gate.promise,release:()=>{releases.delete(gate.resolve);gate.resolve();}};},
      async restart(beforeStart){await stopController();await beforeStart?.();await start();},
      async close(){const errors:unknown[]=[];try{await stopController();}catch(e){errors.push(e);}for(const close of cleanup.reverse())try{await close();}catch(e){errors.push(e);}isolation.restore();try{isolation.assertClean();}catch(e){errors.push(e);}rmSync(root,{recursive:true,force:true});if(errors.length)throw new AggregateError(errors,"Scenario teardown failed");},
    };
    // Only model messages are scripted. Evidence comes from the real dispatcher, never fixture receipts.
    model.setResponses(options.responses??[
      fauxAssistantMessage([fauxToolCall("write",{path:"scenario-result.txt",content:"Synthetic verified result\n"})],{stopReason:"toolUse"}),
      fauxAssistantMessage([fauxToolCall("task_inspect",{})],{stopReason:"toolUse"}),
      ()=>{const store=app.business!.coordinator.store;const task=store.tasks().find(t=>t.status==="running");if(!task)throw new Error("No active scenario task");const refs=store.actions(task.id).filter(a=>a.status==="verified"&&a.tool!=="model_turn"&&!(a.receipt&&typeof a.receipt==="object"&&!Array.isArray(a.receipt)&&a.receipt.evidenceLevel==="primitive-only")).flatMap(a=>a.evidenceRefs);return fauxAssistantMessage([fauxToolCall("task_finish",{result:"Created scenario-result.txt and verified its bytes.",criteriaEvidence:task.doneCriteria.map((_,criterion)=>({criterion,evidenceRefs:refs}))})],{stopReason:"toolUse"});},
      fauxAssistantMessage("Created scenario-result.txt and verified its bytes."),
    ]);
    await start();return facade;
  }catch(error){try{await stopController();}catch{}for(const close of cleanup.reverse())try{await close();}catch{}isolation.restore();rmSync(root,{recursive:true,force:true});throw error;}
}
