import { body, exactKeys, json, listenFixture, mcpReply, string, text, type FixtureServer } from "./http.js";
const properties = {computer_id:{type:"string"},action:{type:"string"},coordinate:{type:"array",items:{type:"number"}},text:{type:"string"},path:{type:"string"},content:{type:"string"},command:{type:"string"},reason:{type:"string"},wait:{type:"boolean"},user_id:{type:"string"},name:{type:"string"}};
const names = ["get_computer","computer","request_takeover","takeover_status","close_computer","read_file","write_file","shell"];
const tools = names.map(name=>({name,description:`Synthetic protocol fixture ${name}; no real desktop or shell.`,inputSchema:{type:"object",properties:name==="get_computer"?{user_id:properties.user_id,name:properties.name}:properties}}));
export interface FixtureBinaryFile {encoding:"base64";data:string;bytes:number;sha256:string;mime:string}
export interface FixtureComputer {id:string;workspaceId:string;mode:"agent"|"human";takeover:"none"|"waiting"|"completed"|"failed";files:Map<string,string|FixtureBinaryFile>;closed:boolean}
export interface MaritimeFixture extends FixtureServer {
  computers: Map<string, FixtureComputer>; invocations: Array<{ workspaceId: string; name: string; args: Record<string, unknown> }>;
  discoveredWorkspaces: Set<string>;
  denyEntitlement(value?: boolean): void; acceptThenDrop(): void; finishTakeover(workspaceId: string, success?: boolean): void;
}
export async function createMaritimeFixture(): Promise<MaritimeFixture>{
  const computers = new Map<string, FixtureComputer>();
  const discoveredWorkspaces = new Set<string>();
  const invocations:Array<{workspaceId:string;name:string;args:Record<string,unknown>}> = [];
  let denied=false,dropNext=false;
  const server=await listenFixture(async(req,res,url)=>{
    const match=/^\/mcp\/u\/([^/]+)$/.exec(url.pathname);
    if(!match){json(res,404,{error:"Unsupported Maritime endpoint"});return;}
    if(req.headers.authorization!=="Bearer synthetic-maritime-computer"){json(res,401,{error:"Unauthorized"});return;}
    if(req.method==="GET"){res.writeHead(405);res.end();return;}
    if(req.method==="DELETE"){res.writeHead(200);res.end();return;}
    if(req.method!=="POST"){json(res,405,{error:"Unsupported method"});return;}
    const workspaceId=decodeURIComponent(match[1]!);
    const request=await body(req);
    if(request.method==="tools/list")discoveredWorkspaces.add(workspaceId);
    mcpReply(res,request,tools,(name,args)=>{
      if(!names.includes(name))return {...text({error:`Unknown tool ${name}`}),isError:true};
      exactKeys(args,Object.keys(properties));
      invocations.push({workspaceId,name,args:structuredClone(args)});
      let computer=computers.get(workspaceId);
      if(name==="get_computer"){
        if(!computer){computer={id:`computer-${workspaceId}`,workspaceId,mode:"agent",takeover:"none",files:new Map(),closed:false};computers.set(workspaceId,computer);}
        return text({computer_id:computer.id,status:"ready",synthetic:true});
      }
      if(!computer||computer.closed||args.computer_id!==computer.id)return {...text({error:"Computer not found in this workspace"}),isError:true};
      if(name==="takeover_status")return text({mode:computer.mode,status:computer.takeover,synthetic:true});
      if(name==="request_takeover"){computer.mode="human";computer.takeover="waiting";return text({status:"waiting",viewer_url:`${server.url}/viewer/${workspaceId}`,synthetic:true});}
      if(computer.mode==="human")return {...text({error:"Human takeover: agent cannot view or control"}),isError:true};
      if(denied)return {...text({error:"Computer entitlement required"}),isError:true};
      if(name==="close_computer"){computer.closed=true;return text({closed:true});}
      if(name==="write_file"){
        const path=string(args.path);if(!path.startsWith("/work/")||path.includes(".."))return {...text({error:"Only synthetic /work files"}),isError:true};
        computer.files.set(path,string(args.content));return text({path,size:Buffer.byteLength(string(args.content)),synthetic:true});
      }
      if(name==="read_file"){
        const file=computer.files.get(string(args.path));
        if(file===undefined)return {...text({error:"File not found"}),isError:true};
        // Match the explicit transfer envelope required by the production importer.
        // Binary bytes and metadata belong to the same canonical provider file map.
        return text({path:args.path,...(typeof file==="string"?{encoding:"utf8",content:file}:file),synthetic:true});
      }
      if(name==="shell"){
        // Deliberately never spawn a process. A receipt proves protocol acceptance only.
        if(dropNext){dropNext=false;res.destroy();}
        return text({accepted:true,invocation_id:`invocation-${invocations.length}`,synthetic:true,verification:"unverified",stdout:"Synthetic shell receipt; command was not executed"});
      }
      if(name==="computer"){
        if(!["screenshot","left_click","type","key"].includes(string(args.action)))return {...text({error:"Unsupported computer action"}),isError:true};
        if(dropNext){dropNext=false;res.destroy();}
        return text({action:args.action,computer_id:computer.id,synthetic:true,verification:"protocol-only",screenshot:args.action==="screenshot"?"Synthetic screenshot; not browser evidence":null});
      }
      return {...text({error:"Unsupported operation"}),isError:true};
    });
  });
  return {...server,computers,invocations,discoveredWorkspaces,denyEntitlement(value=true){denied=value;},acceptThenDrop(){dropNext=true;},finishTakeover(workspaceId:string,success=true){const computer=computers.get(workspaceId);if(!computer)throw new Error("Unknown computer");computer.takeover=success?"completed":"failed";if(success)computer.mode="agent";}};
}
