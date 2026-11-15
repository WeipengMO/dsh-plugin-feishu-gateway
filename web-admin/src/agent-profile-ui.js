/* Browser-only Agent profile editor. All markdown is rendered as text nodes. */
const AGENT_PROFILE_GROUPS = [
  {label:'身份与人格',names:['IDENTITY.md','SOUL.md','USER.md']},
  {label:'工作规则',names:['AGENTS.md','TOOLS.md']},
  {label:'长期记忆',names:['MEMORY.md']},
]
const PROFILE_LOADABLE = ['IDENTITY.md','SOUL.md','USER.md','TOOLS.md','MEMORY.md']
function ProfilePreview({value}) {
  const lines=value.split('\n')
  let fenced=false
  return h('div',{className:'fgw-profile-preview'},
    lines.slice(0,1500).map((line,i)=>{
      if(line.startsWith('~~~')) {fenced=!fenced;return h('div',{key:i},line)}
      if(fenced) return h('pre',{key:i},line||' ')
      const title=/^(#{1,4})\s+(.+)$/.exec(line)
      if(title) return h('div',{key:i,className:'fgw-profile-h'+title[1].length},title[2])
      if(/^\s*[-*]\s+/.test(line))return h('div',{key:i,className:'fgw-profile-list'},'• '+line.replace(/^\s*[-*]\s+/,''))
      if(/^\s*>/.test(line))return h('blockquote',{key:i},line.replace(/^\s*>\s?/,''))
      return h('div',{key:i,className:'fgw-profile-line'},line||' ')
    }),
    lines.length>1500&&h('p',{className:'fgw-muted'},'预览超过 1500 行，已截断显示；保存仍保留完整文本。'))
}
function AgentProfilePanel(){
  const [profile,setProfile]=useState(null)
  const [selected,setSelected]=useState('SOUL.md')
  const [file,setFile]=useState(null)
  const [draft,setDraft]=useState('')
  const [history,setHistory]=useState([])
  const [tab,setTab]=useState('preview')
  const [settings,setSettings]=useState(null)
  const [date,setDate]=useState(new Date().toISOString().slice(0,10))
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [notice,setNotice]=useState('')
  const [loading,setLoading]=useState(true)
  const dirty=!!file&&draft!==file.content
  const bytes=typeof TextEncoder==='function'?new TextEncoder().encode(draft).length:draft.length
  const loadProfile=useCallback(async()=>{
    try{
      const data=(await request('/agent-profile')).profile
      setProfile(data)
      setSettings({enabled:{...data.settings.enabled},maxBytes:data.settings.maxBytes,perFileBytes:data.settings.perFileBytes})
      setError('')
      return data
    }catch(e){setError(e.message||String(e));return null}
    finally{setLoading(false)}
  },[])
  const loadFile=useCallback(async name=>{
    const [result,versions]=await Promise.all([
      request('/agent-profile/file?name='+encodeURIComponent(name)),
      request('/agent-profile/history?name='+encodeURIComponent(name)),
    ])
    setFile(result.file);setDraft(result.file.content);setHistory(versions.history)
  },[])
  useEffect(()=>{void loadProfile()},[loadProfile])
  useEffect(()=>{
    let active=true
    const name=selected
    Promise.all([
      request('/agent-profile/file?name='+encodeURIComponent(name)),
      request('/agent-profile/history?name='+encodeURIComponent(name)),
    ]).then(([result,versions])=>{
      if(!active)return
      setFile(result.file);setDraft(result.file.content);setHistory(versions.history)
    }).catch(e=>{if(active){setFile(null);setError(e.message||String(e))}})
    return()=>{active=false}
  },[selected])
  const pick=name=>{
    if(name===selected)return
    if(dirty&&!window.confirm('当前文件有未保存内容，确认放弃修改？'))return
    setFile(null);setSelected(name);setTab('preview');setNotice('');setError('')
  }
  const save=async()=>{
    if(!file||!dirty||busy)return
    setBusy(true);setError('');setNotice('')
    try{
      await request('/agent-profile/file','PUT',{name:selected,content:draft,expectedRevision:file.revision})
      await Promise.all([loadProfile(),loadFile(selected)])
      setNotice('已保存文件并同步工作区指令。新 Session 读取更新内容；现有 Session 请使用 /new。')
    }catch(e){setError('保存未确认：'+(e.message||String(e))+'。请刷新核对文件和同步状态。')}
    finally{setBusy(false)}
  }
  const restore=async id=>{
    if(!file||busy||dirty||!window.confirm('确认恢复这个历史版本？当前文件会先进入历史记录。'))return
    setBusy(true);setError('');setNotice('')
    try{
      await request('/agent-profile/restore','POST',{name:selected,id,expectedRevision:file.revision})
      await Promise.all([loadProfile(),loadFile(selected)])
      setNotice('已恢复历史版本，并同步新 Session 的上下文。')
    }catch(e){setError(e.message||String(e))}
    finally{setBusy(false)}
  }
  const sync=async()=>{
    setBusy(true);setError('');setNotice('')
    try{
      await request('/agent-profile/sync','POST',{})
      await loadProfile()
      setNotice('已经同步到 AGENTS.local.md。新 Session 自动加载；已有 Session 不会热替换。')
    }catch(e){setError(e.message||String(e))}
    finally{setBusy(false)}
  }
  const saveSettings=async()=>{
    if(!profile||!settings||busy)return
    setBusy(true);setError('');setNotice('')
    try{
      await request('/agent-profile/settings','PUT',{
        settings:{enabled:settings.enabled,maxBytes:Number(settings.maxBytes),perFileBytes:Number(settings.perFileBytes)},
        expectedRevision:profile.settings.revision,
      })
      await loadProfile()
      setNotice('上下文加载规则已保存并同步；新 Session 生效。')
    }catch(e){setError(e.message||String(e))}
    finally{setBusy(false)}
  }
  const files=profile?.files||[]
  const fileButtons=name=>{
    const meta=files.find(x=>x.name===name)
    return h('button',{key:name,type:'button',className:'fgw-profile-file'+(selected===name?' is-active':''),
      onClick:()=>pick(name)},
      h('strong',null,name),h('small',null,meta?.exists?'已创建':'未创建'),
      meta?.loading==='dsh-native'&&h('span',{className:'fgw-muted'},'DSH 原生'))
  }
  const nav=h('aside',{className:'fgw-profile-nav','aria-label':'档案文件列表'},
    AGENT_PROFILE_GROUPS.map(g=>h('section',{key:g.label},
      h('h3',null,g.label),g.names.map(fileButtons))),
    h('section',null,h('h3',null,'每日记忆'),
      h('div',{className:'fgw-profile-date-row'},
        h('input',{type:'date',className:'fga-input',value:date,
          onChange:e=>setDate(e.target.value),'aria-label':'每日记忆日期'}),
        h('button',{type:'button',className:'fgw-refresh',onClick:()=>{
          if(!/^\d{4}-\d{2}-\d{2}$/.test(date)){setError('日期无效');return}
          pick('memory/'+date+'.md')
        }},'打开')),
      files.filter(x=>x.name.startsWith('memory/')).map(x=>fileButtons(x.name))))
  const editor=h('section',{className:'fgw-profile-editor'},
    h('div',{className:'fgw-profile-editor-head'},
      h('div',null,h('strong',null,selected),
        h('span',{className:'fgw-muted'},file?.exists?'已存在':'未创建')),
      h('button',{type:'button',className:'fgw-refresh fgw-ops-cta',
        disabled:busy||!dirty||!file||bytes>(profile?.maxFileBytes||24576),onClick:()=>void save()},
        busy?'保存中…':'保存文件')),
    h('div',{className:'fgw-profile-meta'},
      h('span',null,'UTF-8：',bytes,' / ',profile?.maxFileBytes||24576,' B'),
      h('span',null,'版本：',file?.revision==='absent'?'未创建':file?.revision?.slice(0,12)),
      dirty&&h('strong',{className:'fgw-profile-dirty'},'未保存')),
    h('textarea',{className:'fgw-profile-textarea',value:draft,
      onChange:e=>setDraft(e.target.value),spellCheck:false,
      'aria-label':selected+' Markdown 编辑器',placeholder:'# '+selected+'\n\n在此编写 Markdown 内容…'}),
    h('div',{className:'fgw-profile-bottom'},
      h('span',{className:'fgw-muted'},'保存有版本记录；不会修改其他工作区。'),
      h('button',{type:'button',className:'fgw-refresh',disabled:busy,
        onClick:()=>{if(!dirty||window.confirm('放弃尚未保存的修改？'))setDraft(file?.content||'')}},'恢复到已保存')))
  let sideContent
  if(tab==='preview'){
    sideContent=h('div',{className:'fgw-profile-side-content'},
      h('p',{className:'fgw-muted'},'安全预览，不执行 HTML 或脚本。'),
      h(ProfilePreview,{value:draft}))
  }else if(tab==='history'){
    sideContent=h('div',{className:'fgw-profile-side-content'},
      h('p',{className:'fgw-muted'},'保留最近 30 个版本，恢复时会再次生成备份。'),
      history.length?history.map(entry=>h('div',{className:'fgw-profile-history',key:entry.id},
        h('div',null,h('strong',null,new Date(entry.timestamp).toLocaleString()),
          h('small',null,entry.revision.slice(0,12)+' · '+entry.size+' B')),
        h('button',{type:'button',className:'fgw-refresh',disabled:busy||dirty,
          onClick:()=>void restore(entry.id)},'恢复'))):
        h(WbEmpty,{headline:'还没有历史版本',description:'保存文件后这里会显示快照。'}))
  }else{
    sideContent=h('div',{className:'fgw-profile-side-content'},
      h('p',{className:'fgw-muted'},'已启用的非空档案会同步到 DSH 原生 AGENTS.local.md；每日记忆默认不自动注入。'),
      settings&&PROFILE_LOADABLE.map(name=>h('label',{className:'fgw-profile-check',key:name},
        h('input',{type:'checkbox',checked:settings.enabled[name]===true,
          onChange:e=>setSettings(v=>({...v,enabled:{...v.enabled,[name]:e.target.checked}}))}),
        name)),
      settings&&h('label',{className:'fgw-profile-num'},'总预算（UTF-8 字节）',
        h('input',{className:'fga-input',type:'number',min:1024,max:32768,step:512,
          value:settings.maxBytes,onChange:e=>setSettings(v=>({...v,maxBytes:e.target.value}))})),
      settings&&h('label',{className:'fgw-profile-num'},'单文件上限（UTF-8 字节）',
        h('input',{className:'fga-input',type:'number',min:512,max:32768,step:512,
          value:settings.perFileBytes,onChange:e=>setSettings(v=>({...v,perFileBytes:e.target.value}))})),
      h('button',{className:'fgw-refresh fgw-ops-cta',type:'button',disabled:busy,
        onClick:()=>void saveSettings()},'保存加载规则'),
      h('h3',null,'实际同步'),
      (profile?.loaded||[]).map(x=>h('div',{className:'fgw-profile-loaded',key:x.name},
        h('strong',null,x.name),h('span',{className:'fgw-muted'},' ',x.bytes,' B',x.truncated?'（已截断）':''))),
      h('p',{className:'fgw-muted'},'内容进入模型时可能增加输入 Token；这里限制的是字节数，不是 Token 数。'))
  }
  const right=h('aside',{className:'fgw-profile-right'},
    h('div',{className:'fgw-profile-tabs'},
      [['preview','预览'],['history','历史'],['loading','加载控制']].map(([id,label])=>
        h('button',{key:id,type:'button',className:tab===id?'is-active':'',
          onClick:()=>setTab(id)},label))),
    sideContent)
  return h('div',{className:'fgw-agent-profile'},
    h('div',{className:'fgw-profile-title'},
      h('div',null,h('h2',null,'Agent 档案与记忆'),
        h('p',{className:'fgw-muted'},'直接编辑 Gateway 当前工作区中的 Markdown 文件，保留版本并控制加载。')),
      h('div',{className:'fgw-profile-actions'},
        profile?.syncNeeded&&h('button',{type:'button',className:'fgw-refresh fgw-ops-cta',
          disabled:busy,onClick:()=>void sync()},'同步到 Agent'),
        h('button',{type:'button',className:'fgw-refresh',disabled:busy,
          onClick:()=>{if(!dirty||window.confirm('放弃未保存的内容并刷新？')){
            void loadProfile();void loadFile(selected)}}},'↻ 刷新'))),
    error&&h('div',{className:'fgw-alert',role:'alert'},error),
    notice&&h('div',{className:'fgw-caution',role:'status'},notice),
    !profile&& (loading?h('div',{className:'fgw-caution'},'正在读取工作区信息…'):
      h(OpsUnavailable,{title:'当前工作区不可访问'})),
    profile&&h(React.Fragment,null,
      h('div',{className:'fgw-profile-status'},
        h('div',null,h('span',{className:'fgw-muted'},'实际工作区'),h('code',null,profile.workspace)),
        h('div',null,h('span',{className:'fgw-muted'},'同步状态'),
          h(WbState,{value:profile.syncNeeded?'pending':'ok'})),
        h('div',null,h('span',{className:'fgw-muted'},'加载文件'),
          h('strong',null,(profile.loaded||[]).length)),
        h('div',null,h('span',{className:'fgw-muted'},'上下文'),
          h('strong',null,profile.contextBytes+' / '+profile.settings.maxBytes+' B'))),
      h('p',{className:'fgw-profile-warning'},
        '同一 Gateway 的机器人共享此工作区。修改 SOUL、USER、MEMORY 等文件后只保证新 Session 加载；已有 Session 不会强制热替换。每日记忆默认只在 Agent 主动读取时使用。'),
      h('div',{className:'fgw-profile-columns'},nav,editor,right)))
}
