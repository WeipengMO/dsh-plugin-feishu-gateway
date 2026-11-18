// README demo captures use the actual built Feishu Admin React components.
// The local HTTP server only serves synthetic, non-sensitive API responses.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execFileAsync = promisify(execFile)

const root=path.resolve(import.meta.dirname,'..')
const output=path.join(root,'docs/screenshots')
const reactBase=process.env.REACT_BASE||path.join(os.tmpdir(),'feishu-preview-react')
const chrome=process.env.CHROME_BIN||'/usr/bin/google-chrome'
const assets={
 '/react.js':path.join(reactBase,'node_modules/react/umd/react.production.min.js'),
 '/react-dom.js':path.join(reactBase,'node_modules/react-dom/umd/react-dom.production.min.js'),
 '/admin.js':path.join(root,'web-admin/lib/client.js'),
}
for(const filename of [chrome,...Object.values(assets)]) if(!fs.existsSync(filename)) throw Error('Required file missing: '+filename)
const state={
 ok:true,revision:5,service:'running',pendingRestart:false,
 bots:[{id:'example-bot',domain:'feishu',enabled:true}],
 credentials:[{id:'example-bot',configured:true}],
 health:{health:{status:'ok',processed:1248,activeTurns:2,errors:0,boundSessions:24,
  pendingApprovals:0,uptimeMs:21634000,transports:{'example-bot':'connected'},
  sessionBridge:{available:true},inbox:{pending:0},outbox:{pending:2},rejected:{}}},
 config:{groupPolicy:'allowlist',groupSenderAllowlist:[],groups:[],approvalCards:true,
  streamCards:true,replyFormat:'inherit',agentPreset:'standard',
  agentWorkspace:'/workspace/feishu-agent',
  agent:{provider:'deepseek-account',model:'deepseek-v4-pro',
    fallbacks:[{provider:'magpie',model:'deepseek-v4'}]}},
 agentRoute:{provider:'deepseek-account',model:'deepseek-v4-pro'},
 profileDefaultRoute:{provider:'deepseek-account',model:'deepseek-v4-pro'},
 modelCatalog:{providers:[
  {id:'deepseek-account',name:'DeepSeek Account',models:[
    {id:'deepseek-v4-pro',name:'DeepSeek-V4-Pro'},
    {id:'deepseek-v4-flash',name:'DeepSeek-V4-Flash'}]},
  {id:'magpie',name:'Magpie',models:[
    {id:'deepseek-v4',name:'DeepSeek V4'},
    {id:'hy4flash-free',name:'Hy4 Flash'}]}]},
 agentPresets:{presets:[{id:'standard',name:'standard',isDefault:true},
  {id:'minimal',name:'minimal'},{id:'balanced',name:'均衡模式'}]},
}
const ops={ok:true,telemetryAvailable:true,summary:{alerts:[]},
 snapshot:{stale:false,tasks:[{ref:'demo-task-0001',botId:'example-bot',
  phase:'running',elapsedMs:32000}]}}
const approvals={ok:true,model:{available:true,pending:[],rules:[],records:[]}}
const page=[
 '<!doctype html><html lang="zh-CN"><meta charset="utf-8">',
 '<meta name="viewport" content="width=device-width, initial-scale=1">',
 '<title>Feishu Admin Chrome preview</title><style>',
 ':root{color-scheme:light;--background:#fff;--foreground:#1b293e;--card:#fff;--popover:#fff;--popover-foreground:#1b293e;--muted:#f4f6f9;--muted-foreground:#8390a2;--border:#dee5ee;--ring:#5588ea;--primary:#487ce7;--primary-foreground:#fff}',
 '*{box-sizing:border-box}html,body{margin:0;background:#fff;color:var(--foreground)}',
 'body{font-family:Inter,Segoe UI,Noto Sans CJK SC,Microsoft YaHei,sans-serif;font-size:13px}',
 '.host{display:flex;min-height:100vh}.host-rail{flex:none;width:64px;background:#f7f9fc;border-right:1px solid #e8edf3;display:flex;flex-direction:column;align-items:center;gap:24px;padding:24px 8px}',
 '.host-rail strong{color:#3069d2;font-size:17px}.host-icon{color:#8a96a7;font-size:20px;padding:6px}.host-icon.active{border-radius:9px;background:#e9efff;color:#376de3}',
 '.host-content{flex:1;min-width:0;padding:12px 22px 40px}',
 'body.settings .host-content{padding:48px 64px}body.settings #root{max-width:980px}',
 '.demo-watermark{position:fixed;right:22px;bottom:12px;z-index:50;padding:6px 11px;font-size:10px;color:#7a8a9e;border:1px solid #e5eaf1;background:#fff;border-radius:7px;box-shadow:0 1px 4px #0001}',
 '</style><body><div class="host"><aside class="host-rail"><strong>DSH</strong>',
 '<span class="host-icon">☰</span><span class="host-icon">◧</span><span class="host-icon active">▣</span><span class="host-icon">⚙</span></aside>',
 '<main class="host-content"><div id="root"></div></main></div>',
 '<span class="demo-watermark">Chrome 渲染 · 演示数据 · 非真实租户</span>',
 '<script src="/react.js"></script><script src="/react-dom.js"></script>',
 '<script>const slots={};window.__ModuleLoader__={load(x){const m=x.factory(n=>{if(n==="react")return React;throw Error(n)});m.apply({effect(f){f()},slots:{inject(n,cb){cb()},register(s,c){slots[s.name]=c}}})}};</script>',
 '<script src="/admin.js"></script><script>',
 'const view=new URLSearchParams(location.search).get("view")||"overview";',
 'if(view==="settings")document.body.classList.add("settings");',
 'const C=slots[view==="settings"?"settings.section":"main"];',
 'if(!C)throw Error("Feishu Admin component not registered");',
 'ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(C));',
 'if(view==="models")setTimeout(()=>{const b=[...document.querySelectorAll("button")].find(x=>x.textContent.trim().includes("模型与连接"));if(b)b.click()},400);',
 '</script></body></html>',
].join('\n')
const server=http.createServer((req,res)=>{
 const pathname=new URL(req.url||'/', 'http://127.0.0.1').pathname
 if(pathname==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(page);return}
 if(assets[pathname]){res.writeHead(200,{'content-type':'application/javascript; charset=utf-8'});res.end(fs.readFileSync(assets[pathname]));return}
 if(pathname.startsWith('/api/feishu-admin/')){
  const e=pathname.split('/').pop()
  const data=e==='state'?state:e==='ops'?ops:e==='approvals'?approvals:
    e==='health'?{ok:true,health:state.health}:{ok:true,available:false,total:0,items:[]}
  res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'})
  res.end(JSON.stringify(data));return
 }
 res.writeHead(404);res.end('not found')
})
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
try{
 fs.mkdirSync(output,{recursive:true})
 for(const [view,name,width,height] of [
  ['overview','admin-overview.png',1480,960],
  ['models','admin-model-routing.png',1480,1150],
  ['settings','gateway-settings.png',1480,900],
 ]){
  const file=path.join(output,name)
  const url='http://127.0.0.1:'+server.address().port+'/?view='+view
  await execFileAsync(chrome,['--headless=new','--no-sandbox','--disable-gpu',
   '--disable-dev-shm-usage','--hide-scrollbars','--force-device-scale-factor=1',
   '--window-size='+width+','+height,'--virtual-time-budget=4000',
   '--screenshot='+file,url],{timeout:45000,maxBuffer:1024*1024})
  const {stdout:dom}=await execFileAsync(chrome,['--headless=new','--no-sandbox',
   '--disable-dev-shm-usage','--disable-gpu','--dump-dom',
   '--virtual-time-budget=4000',url],{timeout:45000,maxBuffer:8*1024*1024})
  const expected=view==='overview'?'飞书机器人运行正常':
    view==='models'?'Agent 预设（飞书工作模式）':'飞书 Gateway 凭据'
  if(!dom.includes(expected) || (!dom.includes('fga-root') && !dom.includes('fgw-root')))
    throw Error('React view did not render correctly: '+view)
  const size=fs.statSync(file).size
  if(size<15000)throw Error('Screenshot unexpectedly small: '+name)
  console.log('Google Chrome rendered '+name+' ('+size+' bytes)')
 }
}finally{server.close()}
