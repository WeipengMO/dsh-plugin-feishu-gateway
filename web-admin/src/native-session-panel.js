/* Conversation-first navigation. Feishu bindings and DSH history are separate
 * resources; do not represent archive/unlink as native transcript deletion. */
/* All dangerous Session actions use an in-page, keyboard-accessible modal. */
function FeishuSessionModal({ dialog, busy, error, onCancel, onConfirm }) {
  const [ack,setAck] = React.useState(false)
  const panel = React.useRef(null)
  React.useEffect(()=>{
    const previous = document.activeElement
    panel.current?.focus()
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
          h('span',null,'我了解删除后无法恢复这段 DSH 对话'))),
      error&&h('p',{className:'fgw-caution',role:'alert'},error),
      h('div',{className:'fgw-session-modal-actions'},
        h('button',{type:'button',className:'fgw-refresh',disabled:busy,onClick:onCancel},'取消'),
        h('button',{type:'button',className:'fgw-session-modal-submit'+(dialog.danger?' is-danger':''),
          disabled:busy||(dialog.danger&&!ack),onClick:onConfirm},
          busy?'处理中…':dialog.confirmLabel||'确认'))))
}
function FeishuSessionCenter() {
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
      h(FeishuSessionsInventory,{})))
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
  const filter = (key,value) => setQuery(old => ({ ...old, [key]:value, page:1 }))
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
  const runNow = async () => {
    if (!settings?.enabled || !plan?.available ||
      !window.confirm('整理飞书工作区？\n只更新侧栏显示，不删除聊天记录；仍被使用的会话会跳过。')) return
    setBusy(true)
    try {
      const result = await request('/sessions/organizer/run', 'POST', {})
      setNotice('整理完成：归入工作区 ' + (result.report.attached || 0) +
        '，隐藏旧会话 ' + (result.report.archived || 0) +
        '，跳过 ' + (result.report.skipped?.length || 0) + '。')
      void refresh()
    } catch (e) { setError(e.message || String(e)) }
    finally { setBusy(false) }
  }
  const archive = async row => {
    if (!row.orphan || row.status !== 'unbound') return
    setBusy(true)
    try {
      // Reveal native IDs only for an explicit management action, never in
      // ordinary list results or the visible UI.
      const lookup = await request('/sessions/ledger?' + new URLSearchParams({
        status: 'unbound', search: row.sessionRef, reveal: '1', pageSize: '25'
      }).toString())
      const native = lookup.report?.items?.find(x => x.sessionRef === row.sessionRef && x.orphan)
      if (!native?.sessionId) throw Error('历史记录已变更，请刷新重试')
      const { preview } = await request('/sessions/native/preview', 'POST', { sessionId: native.sessionId })
      if (!window.confirm('归档这段 DSH 对话？\n会话：' + (row.sessionTitle || row.sessionRef) +
        '\n引用：' + preview.sessionRef +
        '\n历史记录不会删除，也不会节省磁盘空间。如果 DSH 提供恢复接口，可以从“已归档”中恢复。')) {
        setNotice('已取消原生 Session 归档')
        return
      }
      const result = await request('/sessions/native/archive', 'POST', { token: preview.token })
      setNotice('已从侧栏隐藏：' + result.result.sessionRef + '（数据未删除）')
      void refresh()
    } catch (e) { setError(e.message || String(e)) }
    finally { setBusy(false) }
  }
  const trash = async row => {
    if (!row.orphan || !report?.canTrash || busy) return
    setBusy(true)
    try {
      const { preview }=await request('/sessions/trash/preview','POST',{sessionRef:row.sessionRef})
      if (!window.confirm('移入回收站？\\n对话：'+(row.sessionTitle||row.scheduleTitle||'未命名')+
        '\\nDSH 会话会从常用列表隐藏，但原始历史仍保留。可从回收站恢复。\\n此操作不会释放磁盘空间。')) return
      const result=await request('/sessions/trash/move','POST',{token:preview.token})
      setNotice('已移入回收站：'+result.result.sessionRef+'（历史未删除）')
      void refresh()
    } catch(e){setError(e.message||String(e))}
    finally{setBusy(false)}
  }
  const recover=async row=>{
    if (row.status!=='trashed'||busy) return
    if(!window.confirm('从回收站恢复「'+(row.sessionTitle||'未命名对话')+'」？\\n聊天记录本来就没有删除。恢复后不会自动重新关联飞书聊天。'))return
    setBusy(true)
    try {
      const {result}=await request('/sessions/trash/restore','POST',{sessionRef:row.sessionRef})
      setNotice(result.target==='archived'?'已恢复到「已归档」':'已恢复到「对话历史」')
      void refresh()
    } catch(e){setError(e.message||String(e))}
    finally{setBusy(false)}
  }
  const restore = async row => {
    if (row.status !== 'archived' || !report?.canRestore) return
    if (!window.confirm('恢复归档的「' + (row.sessionTitle || row.scheduleTitle || '未命名对话') +
      '」？\\n恢复后它会重新出现在 DSH 的会话列表中，不会重新建立已经解除的飞书聊天关联。')) return
    setBusy(true)
    try {
      const result = await request('/sessions/native/restore', 'POST', { sessionRef: row.sessionRef })
      setNotice('已恢复到 DSH 会话列表：' + result.result.sessionRef)
      void refresh()
    } catch (e) { setError(e.message || String(e)) }
    finally { setBusy(false) }
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
      aside: mode==='trash'?'可恢复，当前不能永久删除':mode==='archive'?'归档不会释放磁盘空间':'只显示未归档、未移入回收站的 DSH 对话' },
      h('form', { className: 'fgw-session-filters fgw-session-filters-native',
        onSubmit: e => { e.preventDefault(); setQuery(old=>({...old,search:searchDraft,page:1})); if(searchDraft===query.search) void refresh() } },
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
      h('button', { type:'button', className:'fgw-session-extra-toggle', onClick:()=>setShowAdvanced(x=>!x),
        'aria-expanded':showAdvanced }, showAdvanced?'收起筛选条件':'更多筛选条件'),
      error && h('div',{className:'fgw-caution',role:'alert'},error),
      notice && h('div',{className:'fgw-caution',role:'status'},notice),
      report?.titleSearchLimited&&h('p',{className:'fgw-muted'},'会话过多：标题搜索暂限前 1,000 条，请结合来源或日期筛选。'),
      !report?.available ? h(WbEmpty, {headline:'等待原生 Session 服务',description:report?.reason || '请确认 DSH Web 具备持久化和工作区服务。'}) :
      h(OpsTable, {rows:report.items, empty:'没有符合当前筛选条件的原生 Session',
        columns:[
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
          {key:'status',title:'状态',render:x=>h('span',{className:'fgw-pill'},({active:'正在运行',idle:'已保存',unknown:'状态待确认',unbound:'未关联',archived:'已归档',trashed:'回收站'})[x.status]||'未知')},
          {key:'actions',title:'操作',render:x=>h('div',{className:'fgw-session-row-actions'},
            x.status==='trashed'?
              h('button',{type:'button',className:'fgw-refresh',disabled:busy,
                onClick:()=>void recover(x)},'恢复'):
            x.status==='archived'?
              h('button',{type:'button',className:'fgw-refresh',disabled:busy||!report?.canRestore,
                title:report?.canRestore?'恢复到 DSH 会话列表':'DSH 暂无恢复接口',
                onClick:()=>void restore(x)},'恢复'):
            x.orphan&&x.status==='unbound'?
              h('button',{type:'button',className:'fgw-refresh',disabled:busy,
                onClick:()=>void archive(x)},'归档'):null,
            x.status!=='trashed'&&x.orphan&&['unbound','archived'].includes(x.status)?
              h('button',{type:'button',className:'fgw-refresh',
                disabled:busy||!report?.canTrash,
                title:report?.canTrash?'将此会话放入可恢复的回收站':'当前 DSH 无法安全恢复会话',
                onClick:()=>void trash(x)},'移入回收站'):null,
            x.status==='trashed'&&h('span',{className:'fgw-muted',title:'DSH 尚无可用的永久删除接口'},'永久删除不可用'))}
        ] }),
      report?.available && h('div',{className:'fgw-session-pages'},
        h('span',null,'共 '+wbCount(report.total)+' 条 · 第 '+query.page+'/'+Math.max(1,Math.ceil(report.total/25))+' 页'),
        h('button',{className:'fgw-refresh',type:'button',disabled:busy||query.page<=1,
          onClick:()=>setQuery(x=>({...x,page:x.page-1}))},'上一页'),
        h('button',{className:'fgw-refresh',type:'button',
          disabled:busy||query.page>=Math.ceil(report.total/25),
          onClick:()=>setQuery(x=>({...x,page:x.page+1}))},'下一页')))),
    mode === 'maintenance' && h(OpsNote,null,'这些设置只调整工作区显示方式，不会删除原生聊天历史。'))
}
