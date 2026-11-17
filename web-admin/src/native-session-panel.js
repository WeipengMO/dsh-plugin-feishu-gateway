/* Conversation-first navigation. Feishu bindings and DSH history are separate
 * resources; do not represent archive/unlink as native transcript deletion. */
/* All dangerous Session actions use an in-page, keyboard-accessible modal. */
function FeishuSessionModal({ dialog, busy, error, onCancel, onConfirm }) {
  const [ack,setAck] = React.useState(false)
  const panel = React.useRef(null)
  React.useEffect(()=>{
    const previous = document.activeElement
    panel.current?.querySelector('button')?.focus()
    return ()=>previous?.focus?.()
  },[])
  const onKeys = event=>{
    if(event.key==='Escape'&&!busy){event.preventDefault();onCancel()}
    if(event.key!=='Tab')return
    const nodes=Array.from(panel.current?.querySelectorAll(
      'button:not([disabled]),input:not([disabled]),select:not([disabled])')||[])
    if(nodes.length===0)return
    const first=nodes[0],last=nodes[nodes.length-1]
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}
  }
  return h('div',{className:'fgw-modal-backdrop',
    onMouseDown:event=>{if(event.target===event.currentTarget&&!busy)onCancel()}},
    h('div',{ref:panel,role:'alertdialog','aria-modal':true,tabIndex:-1,
      'aria-labelledby':'fgw-session-modal-title',
      'aria-describedby':'fgw-session-modal-desc',
      className:'fgw-session-modal'+(dialog.danger?' is-danger':''),
      onKeyDown:onKeys},
      h('div',{className:'fgw-session-modal-head'},
        h('h3',{id:'fgw-session-modal-title'},dialog.title),
        h('button',{type:'button',className:'fgw-session-modal-close',
          'aria-label':'关闭弹窗',disabled:busy,onClick:onCancel},'×')),
      h('div',{id:'fgw-session-modal-desc',className:'fgw-session-modal-body'},
        h('p',null,dialog.description),
        dialog.detail&&h('div',{className:'fgw-session-modal-detail'},dialog.detail),
        dialog.note&&h('p',{className:'fgw-muted'},dialog.note),
        dialog.danger&&h('label',{className:'fgw-session-modal-ack'},
          h('input',{type:'checkbox',checked:ack,disabled:busy,onChange:e=>setAck(e.target.checked)}),
          h('span',null,'我了解删除后无法恢复所选 DSH 对话'))),
      error&&h('p',{className:'fgw-caution',role:'alert'},error),
      h('div',{className:'fgw-session-modal-actions'},
        h('button',{type:'button',className:'fgw-refresh',disabled:busy,onClick:onCancel},'取消'),
        h('button',{type:'button',className:'fgw-session-modal-submit'+(dialog.danger?' is-danger':''),
          disabled:busy||(dialog.danger&&!ack),onClick:onConfirm},
          busy?'处理中…':dialog.confirmLabel||'确认'))))
}
function FeishuSessionCenter({ compaction, compactionStale = false }) {
  const [view,setView]=useState('history')
  const tabs=[['history','对话历史'],['archive','已归档'],['bindings','飞书聊天关联']]
  return h('section',{className:'fgw-session-center'},
    h('div',{className:'fgw-session-intro'},
      h('h2',null,'会话管理'),
      h('p',null,'查看 DSH 保存的飞书对话、整理旧历史和管理飞书聊天关联。')),
    h('nav',{role:'tablist','aria-label':'会话管理分类',className:'fgw-session-tabs'},
      tabs.map(([id,label])=>h('button',{type:'button',key:id,role:'tab',
        'aria-selected':view===id,className:'fgw-session-tab'+(view===id?' is-active':''),
        onClick:()=>setView(id)},label))),
    view==='history'&&h(FeishuNativeSessionLedger,{key:'history',mode:'history'}),
    view==='archive'&&h(FeishuArchiveHub,{}),
    view==='bindings'&&h('div',{className:'fgw-session-advanced-area'},
      h('p',{className:'fgw-session-lead'},
        '飞书聊天关联决定下一条消息沿用哪段 DSH 对话。解除关联只创建新上下文，不会删除旧聊天记录。'),
      h(FeishuSessionsInventory,{})),
    h('details',{className:'fgw-session-details fgw-context-compaction'},
      h('summary',null,'上下文压缩 · '+(compactionStale?'运行状态待更新':
        compaction?.available===true && compaction?.automaticCompletedInProcess>0?'已观察到自动压缩':
        compaction?.available===true?'原生引擎可用 · 自动状态待验证':
        compaction?.available===false?'未检测到原生压缩引擎':'运行状态未同步')),
      h('p',null,'DSH 原生 compaction-basic 决定何时自动压缩；飞书不会按累计 Token 用量重复触发，也不会创建第二套摘要。'),
      h('div',{className:'fgw-session-meta'},
        h('p',null,'自动压缩：',compactionStale?'状态待更新':
          compaction?.available!==true?'尚不可确认':
          compaction.automaticCompletedInProcess>0?'已观察到真实自动压缩':'未验证（不代表已关闭）'),
        h('p',null,'本次运行完成：',compaction?.completedInProcess??'—',
          ' 次 · 自动 ',compaction?.automaticCompletedInProcess??'—',
          ' · 手动 ',compaction?.manualCompletedInProcess??'—',
          ' · 未分类 ',compaction?.unclassifiedCompletedInProcess??'—'),
        h('p',null,'本次运行失败：',compaction?.failedInProcess??'—',' 次'),
        compaction?.lastAutoCompletedAt&&h('p',null,'最近自动压缩：',opsDate(compaction.lastAutoCompletedAt)),
        compaction?.lastCompletedAt&&h('p',null,'最近完整压缩：',opsDate(compaction.lastCompletedAt),
          ' · ',({automatic:'自动',manual:'手动',unclassified:'未分类'})[compaction.lastTrigger]||'来源未知',
          ' · 替换历史项 ',compaction.lastShadowedItems??0,' 个')),
      h('p',{className:'fgw-muted'},'只有宿主产生的原生事件才能证明自动压缩实际发生。引擎可用不等于 auto 已启用；当前接口无法可靠读取实时上下文百分比或配置值。'),
      h('p',null,'在飞书发送 ',h('code',null,'/context'),' 查看当前聊天的事件统计；发送 ',
        h('code',null,'/compact'),' 手动压缩旧历史。压缩不会删除原始 Session 日志。'),
      h('p',{className:'fgw-muted'},'检查自动策略：在 feishu-channel Profile 确认已挂载 @deepseek-ai/dsh-compaction-basic、auto: true，并为小窗口模型调整 headroomTokens。'),
      h('p',null,h('a',{href:'https://github.com/WeipengMO/dsh-plugin-feishu-gateway/blob/main/docs/CONTEXT-COMPACTION.md',
        target:'_blank',rel:'noopener noreferrer'},'查看触发原理与验收步骤')))

}
function FeishuArchiveHub() {
  const [policy,setPolicy]=useState(null)
  const [preview,setPreview]=useState(null)
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [notice,setNotice]=useState('')
  const [dialog,setDialog]=useState(null)
  const [dialogBusy,setDialogBusy]=useState(false)
  const [dialogError,setDialogError]=useState('')
  const refresh=useCallback(async()=>{
    setBusy(true)
    try {
      const result=await request('/sessions/retention')
      setPolicy(result.report?.settings||null)
      setPreview(result.report)
      setError('')
    } catch(e){setError(e.message||String(e))}
    finally{setBusy(false)}
  },[])
  useEffect(()=>{void refresh()},[refresh])
  const update=async patch=>{
    setBusy(true)
    try {
      const result=await request('/sessions/retention/settings','PUT',patch)
      setPolicy(result.settings)
      setNotice('设置已保存。自动归档只隐藏能够确认闲置时间的旧对话。')
      await refresh()
    } catch(e){setError(e.message||String(e))}
    finally{setBusy(false)}
  }
  const confirm=async()=>{
    if(!dialog||dialogBusy)return
    setDialogBusy(true);setDialogError('')
    try{await dialog.onConfirm();setDialog(null)}
    catch(e){setDialogError(e.message||String(e))}
    finally{setDialogBusy(false)}
  }
  const candidateRows=(preview?.candidatePreview||[]).map(row=>
    h('li',{key:row.sessionRef},h('strong',null,row.title),
      h('span',{className:'fgw-muted'},'最后使用：'+opsDate(row.lastActiveAt))))
  return h('div',{className:'fgw-session-recycle'},
    h(FeishuNativeSessionLedger,{key:'archive',mode:'archive'}),
    h('section',{className:'fgw-session-policy'},
      h('div',{className:'fgw-session-policy-head'},
        h('div',null,h('h3',null,'自动整理'),
          h('p',null,'自动归档只隐藏历史，不删除对话。永久删除需逐条确认。'))),
      h('div',{className:'fgw-retention-grid'},
        h('label',{className:'fgw-retention-setting'},
          h('span',null,'多久未使用自动归档'),
          h('select',{className:'fga-input',value:policy?.archiveAfterDays||90,disabled:busy||!policy,
            onChange:e=>void update({archiveAfterDays:Number(e.target.value)})},
            [30,60,90,180,365].map(n=>h('option',{key:n,value:n},n+' 天')))),
        h('label',{className:'fgw-retention-setting fgw-retention-toggle'},
          h('input',{type:'checkbox',checked:policy?.autoArchiveEnabled===true,
            disabled:busy||!policy,onChange:e=>{
              if(!e.target.checked){void update({autoArchiveEnabled:false});return}
              setDialogError('')
              setDialog({title:'启用自动归档',confirmLabel:'启用',description:
                '将每小时检查一次旧对话，仅隐藏超过 '+(policy?.archiveAfterDays||90)+
                ' 天未使用、且没有飞书关联和运行任务的记录。',
                note:'没有可靠最后活动时间的会话会跳过；不会删除任何对话正文。',
                onConfirm:()=>update({autoArchiveEnabled:true})})
            }}),
          h('span',null,'启用自动归档'))),
      h('p',{className:'fgw-muted fgw-session-policy-hint'},
        '符合归档条件：'+(preview?.candidates??'—')+' 条；'+
        (preview?.skippedUnknownActivity??'—')+' 条缺少可靠的最后使用时间，将跳过。'),
      candidateRows.length>0&&h('details',{className:'fgw-retention-preview'},
        h('summary',null,'查看待归档对话（'+preview.candidates+' 条）'),
        h('ul',null,...candidateRows)),
      h('p',{className:'fgw-muted fgw-session-policy-hint'},
        '自动永久删除默认关闭。只有部署了受支持的安全删除服务，才能手动永久删除已归档会话。'),
      h('button',{type:'button',className:'fgw-refresh',onClick:()=>void refresh(),disabled:busy},
        busy?'正在检查…':'刷新候选统计')),
    error&&h('p',{className:'fgw-caution',role:'alert'},error),
    notice&&h('p',{className:'fgw-muted',role:'status'},notice),
    h('details',{className:'fgw-session-details fgw-workspace-settings'},
      h('summary',null,'高级设置 · 飞书工作区归位'),
      h('p',{className:'fgw-muted'},'只控制 DSH 侧栏中的会话归属与显示，不清理历史。'),
      h(FeishuNativeSessionLedger,{key:'maintenance',mode:'maintenance'})),
    dialog&&h(FeishuSessionModal,{key:dialog.title,dialog,busy:dialogBusy,error:dialogError,
      onCancel:()=>setDialog(null),onConfirm:()=>void confirm()}))
}
/* Native DSH Session ledger (Issue #34).
 * Reads only native headers; raw IDs are hidden until consciously revealed.
 * Workspace reconciliation is opt-in and never resumes native Sessions.
 */
function FeishuNativeSessionLedger({ mode = 'history' }) {
  const [query, setQuery] = useState({ status: mode === 'archive' ? 'archived' : mode === 'trash' ? 'trashed' : 'current', type: 'all', bot: '', from: '', to: '', search: '', orphan: false, page: 1 })
  const [reveal, setReveal] = useState(false)
  const [searchDraft,setSearchDraft] = useState('')
  const [showAdvanced,setShowAdvanced] = useState(false)
  const [report, setReport] = useState(null)
  const [plan, setPlan] = useState(null)
  const [settings, setSettings] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  // Selection is retained across pages of one search, capped at 20 records.
  const [selected,setSelected]=useState([])
  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      const params = new URLSearchParams({
        status: query.status, type: query.type, bot: query.bot,
        from: query.from, to: query.to, search: query.search,
        orphan: query.orphan ? '1' : '0', page: String(query.page),
        reveal: reveal ? '1' : '0'
      })
      const [ledger, organizer] = await Promise.all([
        request('/sessions/ledger?' + params.toString()),
        request('/sessions/organizer')
      ])
      setReport(ledger.report)
      setPlan(organizer.report)
      setSettings(organizer.settings)
      setError('')
    } catch (e) { setError(e.message || String(e)) }
    finally { setBusy(false) }
  }, [query, reveal])
  useEffect(() => { void refresh() }, [refresh])
  const filter = (key,value) => {setSelected([]);setQuery(old => ({ ...old, [key]:value, page:1 }))}
  const saveSettings = async patch => {
    setBusy(true)
    try {
      const result = await request('/sessions/organizer/settings', 'PUT', patch)
      setSettings(result.settings)
      setNotice('工作区整理设置已保存；不会删除聊天记录。')
      void refresh()
    } catch (e) { setError(e.message || String(e)) }
    finally { setBusy(false) }
  }
  const [dialog,setDialog]=useState(null)
  const [dialogBusy,setDialogBusy]=useState(false)
  const [dialogError,setDialogError]=useState('')
  const ask=info=>{setDialogError('');setDialog(info)}
  const confirm=async()=>{
    if(!dialog||dialogBusy)return
    setDialogBusy(true);setDialogError('')
    try{await dialog.onConfirm();setDialog(null)}
    catch(e){setDialogError(e.message||String(e))}
    finally{setDialogBusy(false)}
  }
  const runNow=()=>{
    if(!settings?.enabled||!plan?.available)return
    ask({title:'整理飞书工作区',confirmLabel:'执行整理',
      description:'将符合条件的会话归入飞书工作区，必要时隐藏不再关联的历史。',
      note:'操作只改变侧栏显示，不会删除聊天记录；正在使用的会话会跳过。',
      onConfirm:async()=>{
        const result=await request('/sessions/organizer/run','POST',{})
        setNotice('整理完成：归入工作区 '+(result.report.attached||0)+
          '，隐藏旧会话 '+(result.report.archived||0)+'，跳过 '+(result.report.skipped?.length||0)+'。')
        await refresh()
      }})
  }
  const canSelect = row => mode==='archive' ?
    Boolean(row && ['archived','trashed'].includes(row.status)) :
    Boolean(report?.canArchive && row?.orphan && row?.status==='unbound' && row?.type!=='schedule')
  const toggleSelection = (row,checked) => {
    if(!canSelect(row)||busy||dialogBusy)return
    setSelected(previous=>{
      const items=previous.filter(item=>item.sessionRef!==row.sessionRef)
      if(!checked)return items
      if(previous.some(item=>item.sessionRef===row.sessionRef))return previous
      if(items.length>=20){setNotice('每次最多选择 20 条对话，请先处理当前选择。');return previous}
      return [...items,row]
    })
  }
  const selectCurrentPage = () => {
    setSelected(previous=>{
      const items=[...previous]
      const rows=(report?.items||[]).filter(canSelect)
      for(const row of rows) {
        if(items.length>=20)break
        if(!items.some(item=>item.sessionRef===row.sessionRef))items.push(row)
      }
      if(items.length===20&&rows.some(row=>!items.some(item=>item.sessionRef===row.sessionRef)))
        setNotice('本次最多选择 20 条；其余记录请分批处理。')
      return items
    })
  }
  const startNativeAction = async (action,rows) => {
    if(busy||dialogBusy||!rows?.length)return
    setBusy(true);setError('');setNotice('')
    try{
      const {preview}=await request('/sessions/native/batch/preview','POST',{
        action,sessionRefs:rows.map(row=>row.sessionRef)
      })
      if(preview.eligible===0){
        setNotice('所选 '+preview.requested+' 条对话均不满足操作条件。'+
          (preview.skippedItems||[]).slice(0,2).map(item=>item.reason).join('；'))
        return
      }
      const verb={archive:'归档',restore:'恢复',delete:'永久删除'}[action]
      const isDelete=action==='delete'
      const sample=rows.slice(0,3).map(row=>row.sessionTitle||row.scheduleTitle||'未命名对话')
      const details=[
        '选择 '+preview.requested+' 条，可'+verb+' '+preview.eligible+' 条'+
          (preview.skipped?'；将跳过 '+preview.skipped+' 条':'')+'。',
        '对话：'+sample.join('、')+(rows.length>3?' 等 '+rows.length+' 条':''),
        ...((preview.skippedItems||[]).slice(0,3).map(item=>'跳过原因：'+item.reason))
      ]
      ask({
        title:rows.length===1?verb+'对话':'批量'+verb+'对话',
        confirmLabel:rows.length===1?verb:'确认'+verb+' '+preview.eligible+' 条',
        danger:isDelete,
        description:isDelete?
          '永久删除所选已归档的 DSH 对话，删除后无法恢复。':
          action==='archive'?
            '将所选旧对话从常用列表移到「已归档」，聊天记录会完整保留。':
            '将所选已归档对话恢复到「对话历史」。',
        detail:h('div',{className:'fgw-session-batch-preview'},
          details.map((line,i)=>h('p',{key:i},line))),
        note:isDelete?
          '删除通过 @michengai/dsh-archive-manager 执行，可能同时清理子代理历史；不会删除飞书服务器已发送的消息。':
          '操作前会重新检查每条会话；状态发生变化时会跳过，不会强制中断任务。',
        onConfirm:async()=>{
          const {result}=await request('/sessions/native/batch/execute','POST',{token:preview.token})
          setSelected([])
          setNotice(verb+'完成：成功 '+result.succeeded+' 条，未处理 '+result.failed+' 条。'+
            (result.failedItems||[]).slice(0,3).map(item=>item.reason).join('；'))
          await refresh()
        }
      })
    }catch(e){setError(e.message||String(e))}
    finally{setBusy(false)}
  }
  const formatDate = ts => Number.isFinite(ts) && ts > 0 ? opsDate(ts) : '—'
  return h(React.Fragment, null,
    mode === 'maintenance' && h(WbBlock, { title: '自动整理工作区',
      aside: '只整理侧栏归属，不修改对话正文' },
      !plan?.available && h('p', { className: 'fgw-caution' },
        'DSH 原生工作区/会话服务尚不可用：' + (plan?.reason || '等待 Gateway 与 Web 服务就绪')),
      h('div', { className: 'fgw-workspace-controls' },
        h('label', { className: 'fgw-workspace-toggle' },
          h('input', { type: 'checkbox', disabled: busy || !plan?.available,
            checked: settings?.enabled === true,
            onChange: e => void saveSettings({ enabled: e.target.checked }) }),
          '自动归入飞书会话工作区'),
        h('label', { className: 'fga-check' },
          h('input', { type: 'checkbox', checked: settings?.revealNames === true, disabled: busy,
            onChange: e => void saveSettings({ revealNames: e.target.checked }) }),
          '显示已配置的群聊名称'),
        h('label', { className: 'fgw-session-filter fgw-workspace-duration' },
          h('span', null, '定时任务移除后等待'),
          h('select', { className: 'fga-input', value: settings?.graceHours || 24,
            onChange: e => void saveSettings({ graceHours: Number(e.target.value) }), disabled: busy },
            [1, 6, 24, 48, 72, 168].map(n =>
              h('option', { value: n, key: n }, n + ' 小时')))),
        h('div',{className:'fgw-workspace-actions'},
          h('button', { type: 'button', className: 'fgw-refresh',
            onClick: () => void refresh(), disabled: busy }, '刷新预览'),
        h('button', { type: 'button', className: 'fgw-refresh fgw-ops-cta',
          onClick: () => void runNow(), disabled: busy || !settings?.enabled || !plan?.available }, '执行整理'))),
      plan?.available && h('p', { className: 'fgw-muted' },
        '预览：待归位 ' + wbCount(plan.attach?.length) + '；符合规则的待归档 ' +
        wbCount(plan.archive?.length) + '；旧工作区会话 ' + wbCount(plan.legacy?.length) +
        '。不会修改旧会话的工作目录，无法确认状态时会跳过。'),
      h(OpsNote, null, '已有旧工作区中的会话不会强制迁移；手动恢复的会话不会被自动重复隐藏。')),
    mode !== 'maintenance' && h('div',{className:'fgw-session-list', 'data-expanded':showAdvanced?'yes':'no'},
      h(WbBlock, { title: mode === 'archive'?'已归档的对话':mode==='trash'?'回收站中的对话':'对话历史',
      aside: mode==='archive'?'选择恢复，或在安全删除服务可用时永久删除':'只显示未归档的 DSH 对话' },
      h('form', { className: 'fgw-session-filters fgw-session-filters-native',
        onSubmit: e => { e.preventDefault(); setSelected([]); setQuery(old=>({...old,search:searchDraft,page:1})); if(searchDraft===query.search) void refresh() } },
        mode === 'all' && h('label', { className: 'fgw-session-filter' }, h('span', null, '状态'),
          h('select', { className: 'fga-input', value: query.status,
            onChange: e => filter('status', e.target.value) },
            [['all','全部'],['active','正在运行'],['idle','已保存'],['unknown','待确认'],['unbound','未关联'],
              ['archived','已归档']].map(([value,label]) => h('option', {key:value,value},label)))),
        h('label', { className: 'fgw-session-filter' }, h('span', null, '会话来源'),
          h('select', { className: 'fga-input', value: query.type,
            onChange: e => filter('type', e.target.value) },
            [['all','全部'],['p2p','私聊'],['group','群聊'],['schedule','定时']].map(([value,label]) =>
              h('option', {key:value,value},label)))),
        h('label', { className: 'fgw-session-filter fgw-session-filter-extra' }, h('span', null, '机器人 ID'),
          h('input', { className: 'fga-input', value: query.bot, maxLength: 32,
            onChange: e => filter('bot', e.target.value), placeholder: '所有机器人' })),
        h('label', { className: 'fgw-session-filter fgw-session-filter-extra' }, h('span', null, '开始日期'),
          h('input', { className: 'fga-input', type: 'date', value: query.from,
            onChange: e => filter('from', e.target.value) })),
        h('label', { className: 'fgw-session-filter fgw-session-filter-extra' }, h('span', null, '结束日期'),
          h('input', { className: 'fga-input', type: 'date', value: query.to,
            onChange: e => filter('to', e.target.value) })),
        h('label', { className: 'fgw-session-filter' }, h('span', null, '搜索对话或定时任务'),
          h('input', { className: 'fga-input', value: searchDraft, maxLength:128,
            onChange: e => setSearchDraft(e.target.value), placeholder: '会话名称、任务名称或引用' })),
        h('label', { className: 'fga-check fgw-session-filter-extra' },
          h('input', { type: 'checkbox', checked: query.orphan,
            onChange: e => filter('orphan', e.target.checked) }), '仅看不再关联的历史'),
        h('label', { className: 'fga-check fgw-session-filter-extra' },
          h('input', { type: 'checkbox', checked: reveal,
            onChange: e => setReveal(e.target.checked) }), '显示完整技术标识（仅排查问题时使用）'),
        h('button', { type: 'submit', className:'fgw-refresh', disabled:busy }, busy?'加载中…':'刷新')),
      mode==='archive'&&report?.available&&
        h('p',{className:'fgw-session-deletion-info'},
          report.canDelete?
            '已检测到 @michengai/dsh-archive-manager 的删除接口。只有未关联、非运行中的已归档会话才能永久删除。':
            h(React.Fragment,null,
              report.deleteUnavailableReason || '暂时无法使用删除。',
              ' 永久删除依赖可选插件 ',
              h('code',null,'@michengai/dsh-archive-manager'),
              '（安装在 DSH 的 web Profile 并启用）；未安装时按钮保持灰色，其他功能正常使用。')),
      h('button', { type:'button', className:'fgw-session-extra-toggle', onClick:()=>setShowAdvanced(x=>!x),
        'aria-expanded':showAdvanced }, showAdvanced?'收起筛选条件':'更多筛选条件'),
      error && h('div',{className:'fgw-caution',role:'alert'},error),
      notice && h('div',{className:'fgw-caution',role:'status'},notice),
      report?.available && h('div',{className:'fgw-session-selection-toolbar',role:'group',
        'aria-label':mode==='archive'?'已归档会话批量操作':'对话历史批量归档'},
        h('div',{className:'fgw-session-selection-meta'},
          h('strong',null,'已选 '+selected.length+' 条'),
          h('span',{className:'fgw-muted'},'支持跨页选择，单次最多 20 条')),
        h('div',{className:'fgw-session-selection-actions'},
          h('button',{type:'button',className:'fgw-refresh',disabled:busy||dialogBusy||
            !(report?.items||[]).some(row=>canSelect(row)&&!selected.some(item=>item.sessionRef===row.sessionRef))||
            selected.length>=20,onClick:selectCurrentPage},'选择本页'),
          h('button',{type:'button',className:'fgw-refresh',disabled:busy||dialogBusy||selected.length===0,
            onClick:()=>setSelected([])},'清空选择'),
          mode==='archive'?
            h(React.Fragment,null,
              h('button',{type:'button',className:'fgw-refresh fgw-ops-cta',
                disabled:busy||dialogBusy||!report?.canRestore||selected.length===0,
                onClick:()=>void startNativeAction('restore',selected)},'批量恢复'),
              h('button',{type:'button',className:'fgw-refresh fgw-archive-delete',
                disabled:busy||dialogBusy||!report?.canDelete||selected.length===0,
                title:!report?.canDelete?report?.deleteUnavailableReason:
                  '仅删除符合条件的已归档、未关联对话；其他会话将跳过',
                onClick:()=>void startNativeAction('delete',selected)},'批量删除')):
            h('button',{type:'button',className:'fgw-refresh fgw-ops-cta',
              disabled:busy||dialogBusy||!report?.canArchive||selected.length===0,
              onClick:()=>void startNativeAction('archive',selected)},'批量归档'))),
      mode!=='archive'&&report?.available&&
        h('p',{className:'fgw-session-selection-tip'},
          '未关联且没有运行任务的对话可以归档；仍与飞书聊天关联或属于定时任务的记录暂不可归档。'),
      report?.titleSearchLimited&&h('p',{className:'fgw-muted'},'会话过多：标题搜索暂限前 1,000 条，请结合来源或日期筛选。'),
      !report?.available ? h(WbEmpty, {headline:'等待原生 Session 服务',description:report?.reason || '请确认 DSH Web 具备持久化和工作区服务。'}) :
      h(OpsTable, {rows:report.items, empty:'没有符合当前筛选条件的原生 Session',
        columns:[
          {key:'selection',title:'选择',render:x=>h('input',{
            type:'checkbox',className:'fgw-native-session-checkbox',
            checked:selected.some(item=>item.sessionRef===x.sessionRef),
            disabled:busy||dialogBusy||!canSelect(x),
            'aria-label':'选择对话 '+(x.sessionTitle||x.scheduleTitle||'未命名对话'),
            title:mode==='archive'?'选择此已归档对话':
              !x.orphan?'仍与飞书聊天关联，请先解除关联':
              x.type==='schedule'?'定时任务会话不支持手动归档':
              !report?.canArchive?'运行状态未确认，暂不能归档':
              x.status!=='unbound'?'正在运行或状态未知，暂不能归档':'选择此对话',
            onChange:event=>toggleSelection(x,event.target.checked)} )},
          {key:'sessionTitle', title:'对话',render:x=>h('div',null,
            h('strong',null,x.sessionTitle || x.scheduleTitle || '未命名'),
            h('div',{className:'fgw-muted'},x.type==='schedule'?'定时':
              x.type==='group'?'群聊':'私聊',x.legacy?' · 旧工作区':'',
              x.orphan?' · 不再关联':''),
            h('details',{className:'fgw-session-tech'},
              h('summary',null,'查看技术信息'),
              h('div',null,'会话引用：',h('code',null,reveal&&x.sessionId?x.sessionId:x.sessionRef)),
              x.chatRef&&h('div',null,'聊天引用：',h('code',null,x.chatRef)),
              x.botId&&h('div',null,'机器人：',x.botId)))},
          {key:'lastActiveAt',title:mode==='trash'?'移入回收站':'活动时间',render:x=>
            mode==='trash'?formatDate(x.trashedAt):
            x.lastActiveKnown ? formatDate(x.lastActiveAt) :
            h('span',{className:'fgw-muted'},'最近活动未记录（创建：'+formatDate(x.createdAt)+'）')},
          {key:'status',title:'状态',render:x=>h('span',{className:'fgw-pill'},({active:'正在运行',idle:'已保存',unknown:'状态待确认',unbound:'未关联',archived:'已归档',trashed:'已归档'})[x.status]||'未知')},
          {key:'actions',title:'操作',render:x=>h('div',{className:'fgw-session-row-actions'},
            mode==='archive'?
              h(React.Fragment,null,
                h('button',{type:'button',className:'fgw-refresh',
                  disabled:busy||dialogBusy||!report?.canRestore,
                  title:report?.canRestore?'恢复到正常对话列表':'当前 DSH 版本没有可用的恢复接口',
                  onClick:()=>void startNativeAction('restore',[x])},'恢复'),
                h('button',{type:'button',className:'fgw-refresh fgw-archive-delete',
                  disabled:busy||dialogBusy||!report?.canDelete||!x.orphan||x.type==='schedule',
                  title:!report?.canDelete?(report?.deleteUnavailableReason||'缺少可选归档管理插件的删除接口'):
                    !x.orphan?'此对话仍与飞书聊天关联':
                    x.type==='schedule'?'定时任务会话不能直接删除':'永久删除 DSH 对话',
                  onClick:()=>void startNativeAction('delete',[x])},'删除')):
              h('button',{type:'button',className:'fgw-refresh',
                disabled:busy||dialogBusy||!canSelect(x),
                title:!report?.canArchive?'运行状态暂不能确认':
                  !x.orphan?'仍与飞书聊天关联，请先解除关联':
                  x.type==='schedule'?'定时任务历史暂不允许手动归档':
                  x.status!=='unbound'?'此会话正在使用或状态不明确':'移到「已归档」',
                onClick:()=>void startNativeAction('archive',[x])},'归档'))}
        ] }),
      report?.available && h('div',{className:'fgw-session-pages'},
        h('span',null,'共 '+wbCount(report.total)+' 条 · 第 '+query.page+'/'+Math.max(1,Math.ceil(report.total/25))+' 页'),
        h('button',{className:'fgw-refresh',type:'button',disabled:busy||query.page<=1,
          onClick:()=>setQuery(x=>({...x,page:x.page-1}))},'上一页'),
        h('button',{className:'fgw-refresh',type:'button',
          disabled:busy||query.page>=Math.ceil(report.total/25),
          onClick:()=>setQuery(x=>({...x,page:x.page+1}))},'下一页')))),
    mode === 'maintenance' && h(OpsNote,null,'这些设置只调整工作区显示方式，不会删除原生聊天历史。'),
    dialog&&h(FeishuSessionModal,{key:dialog.title+String(dialog.description),
      dialog,busy:dialogBusy,error:dialogError,
      onCancel:()=>setDialog(null),onConfirm:()=>void confirm()}))
}
