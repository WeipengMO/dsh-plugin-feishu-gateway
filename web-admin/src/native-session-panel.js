/* Conversation-first navigation. Feishu bindings and DSH history are separate
 * resources; do not represent archive/unlink as native transcript deletion. */
function FeishuSessionCenter() {
  const [view,setView]=useState('history')
  const tabs=[['history','对话历史'],['archive','已归档'],['bindings','飞书聊天关联'],
    ['cleanup','整理与清理']]
  return h('section',{className:'fgw-session-center'},
    h('div',{className:'fgw-session-intro'},
      h('h2',null,'会话管理'),
      h('p',null,'查找飞书对话和定时任务留下的历史。DSH 保存对话内容，飞书插件负责把聊天连接到对应的对话。')),
    h('nav',{role:'tablist','aria-label':'会话管理分类',className:'fgw-session-tabs'},
      tabs.map(([id,label])=>h('button',{type:'button',key:id,role:'tab',
        'aria-selected':view===id,
        className:'fgw-session-tab'+(view===id?' is-active':''),
        onClick:()=>setView(id)},label))),
    view==='history'&&h(FeishuNativeSessionLedger,{key:'history',mode:'history'}),
    view==='archive'&&h(React.Fragment,null,
      h('div',{className:'fgw-session-explainer'},
        h('strong',null,'已归档：隐藏但不删除'),
        h('p',null,'归档会话仍然占用磁盘空间。在下方可以尝试恢复到 DSH 列表；只有运行时提供恢复接口才显示可用按钮。')),
      h(FeishuNativeSessionLedger,{key:'archive',mode:'archive'})),
    view==='bindings'&&h('div',{className:'fgw-session-advanced-area'},
      h('div',{className:'fgw-session-explainer'},
        h('strong',null,'飞书聊天关联是什么？'),
        h('p',null,'它决定飞书中的某个聊天继续使用哪段 DSH 对话。解除关联后，下一条消息会创建新对话，旧历史仍保留。这里的“归档关联”也不会删除聊天记录。')),
      h(FeishuSessionsInventory,{})),
    view==='cleanup'&&h('div',{className:'fgw-session-cleanup'},
      h('div',{className:'fgw-session-explainer'},
        h('strong',null,'清理历史应分为三步'),
        h('p',null,'归档只是隐藏；移入回收站应支持恢复；永久删除才会释放磁盘空间。不能用「解除飞书关联」替代删除历史。')),
      h('div',{className:'fgw-session-lifecycle'},
        [['归档','保留历史，只隐藏不常用对话'],['回收站','删除前临时保留，允许撤销'],
          ['永久删除','彻底清除记录并核实释放空间']].map(([title,desc],i)=>
          h('div',{key:title},h('span',null,'0'+(i+1)),h('strong',null,title),h('p',null,desc)))),
      h('div',{className:'fgw-session-explainer'},
        h('strong',null,'自动清理尚未启用'),
        h('p',null,'DSH 当前部署的原生服务只提供历史清单和归档操作，尚无可靠的删除 / 恢复接口。因此本插件不会擅自删除日志。建议将“90 天未使用自动归档、回收站保留 30 天”作为后续可配置策略，默认关闭自动永久删除。')),
      h('details',{className:'fgw-session-details'},
        h('summary',null,'高级设置：飞书工作区整理'),
        h('p',{className:'fgw-muted'},'只整理 DSH 侧栏的归属和显示，不清理聊天正文或磁盘数据。'),
        h(FeishuNativeSessionLedger,{key:'maintenance',mode:'maintenance'}))))
}
/* Native DSH Session ledger (Issue #34).
 * Reads only native headers; raw IDs are hidden until consciously revealed.
 * Workspace reconciliation is opt-in and never resumes native Sessions.
 */
function FeishuNativeSessionLedger({ mode = 'history' }) {
  const [query, setQuery] = useState({ status: mode === 'archive' ? 'archived' : 'all', type: 'all', bot: '', from: '', to: '', search: '', orphan: false, page: 1 })
  const [reveal, setReveal] = useState(false)
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
      setNotice('整理设置已保存；自动整理每约 15 秒检查一次，运行中的 Session 不会被强制归档。')
      void refresh()
    } catch (e) { setError(e.message || String(e)) }
    finally { setBusy(false) }
  }
  const runNow = async () => {
    if (!settings?.enabled || !plan?.available ||
      !window.confirm('执行飞书工作区归位与已确认历史状态的安全对账？\n仅操作 WorkspaceRegistry，不删除 Session 历史；归档需要通过原生活动检查。')) return
    setBusy(true)
    try {
      const result = await request('/sessions/organizer/run', 'POST', {})
      setNotice('对账完成：归位 ' + (result.report.attached || 0) +
        '，归档 ' + (result.report.archived || 0) +
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
    mode === 'maintenance' && h('div', { className: 'fgw-metrics fgw-metrics-three' },
      h(WbMetric, { title: '原生 Session', value: report?.available ? wbCount(report.nativeCount) : '—',
        caption: 'DSH 持久化 header，含历史' }),
      h(WbMetric, { title: '未关联/孤儿', value: report?.available ? wbCount(report.orphanCount) : '—',
        caption: '不等于可安全删除' }),
      h(WbMetric, { title: '飞书工作区', value: report?.workspaceTitle || '未创建',
        caption: '仅在 Web workspace 服务可用时归位' })),
    mode === 'maintenance' && h(WbBlock, { title: '飞书工作区自动整理',
      aside: 'Web 只读取 header；不调用 resume，不抢占 Gateway 写锁' },
      !plan?.available && h('p', { className: 'fgw-caution' },
        'DSH 原生工作区/会话服务尚不可用：' + (plan?.reason || '等待 Gateway 与 Web 服务就绪')),
      h('div', { className: 'fgw-session-actions fgw-native-options' },
        h('label', { className: 'fga-check' },
          h('input', { type: 'checkbox', disabled: busy || !plan?.available,
            checked: settings?.enabled === true,
            onChange: e => void saveSettings({ enabled: e.target.checked }) }),
          '启用自动工作区归位（默认关闭）'),
        h('label', { className: 'fga-check' },
          h('input', { type: 'checkbox', checked: settings?.revealNames === true, disabled: busy,
            onChange: e => void saveSettings({ revealNames: e.target.checked }) }),
          '允许在授权页显示群名'),
        h('label', { className: 'fgw-session-filter' },
          h('span', null, '定时任务失联宽限期'),
          h('select', { className: 'fga-input', value: settings?.graceHours || 24,
            onChange: e => void saveSettings({ graceHours: Number(e.target.value) }), disabled: busy },
            [1, 6, 24, 48, 72, 168].map(n =>
              h('option', { value: n, key: n }, n + ' 小时')))),
        h('button', { type: 'button', className: 'fgw-refresh',
          onClick: () => void refresh(), disabled: busy }, '重新预览'),
        h('button', { type: 'button', className: 'fgw-refresh fgw-ops-cta',
          onClick: () => void runNow(), disabled: busy || !settings?.enabled || !plan?.available }, '立即安全对账')),
      plan?.available && h('p', { className: 'fgw-muted' },
        '预览：待归位 ' + wbCount(plan.attach?.length) + '；符合规则的待归档 ' +
        wbCount(plan.archive?.length) + '；旧工作区会话 ' + wbCount(plan.legacy?.length) +
        '。首次对账不会自动清理未知历史。归档活动检查失败将跳过。'),
      h(OpsNote, null, '原生旧工作区会话的 cwd 不能更改，不能强制 attach；仅通过下面的独立预览逐条归档。手动取消归档后不会再次自动归档已处理记录。')),
    mode !== 'maintenance' && h('div',{className:'fgw-session-list', 'data-expanded':showAdvanced?'yes':'no'},
      h(WbBlock, { title: '会话历史',
      aside: '查看飞书相关的 DSH 对话历史（含定时任务）' },
      h('form', { className: 'fgw-session-filters fgw-session-filters-native',
        onSubmit: e => { e.preventDefault(); void refresh() } },
        mode !== 'archive' && h('label', { className: 'fgw-session-filter' }, h('span', null, '状态'),
          h('select', { className: 'fga-input', value: query.status,
            onChange: e => filter('status', e.target.value) },
            [['all','全部'],['active','活跃'],['idle','空闲'],['unbound','未关联'],
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
          h('input', { className: 'fga-input', value: query.search, maxLength:128,
            onChange: e => filter('search',e.target.value), placeholder: '会话名称、任务名称或引用' })),
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
          {key:'lastActiveAt',title:'最近使用',render:x=>formatDate(x.lastActiveAt)},
          {key:'status',title:'状态',render:x=>h('span',{className:'fgw-pill'},({active:'正在运行',idle:'已保存',unbound:'不再关联',archived:'已归档'})[x.status]||'未知')},
          {key:'actions',title:'操作',render:x=>x.status==='archived' ?
            h('button',{type:'button',className:'fgw-refresh',
              disabled:busy||!report?.canRestore,
              title:report?.canRestore?'恢复到 DSH 会话列表':'此 DSH 版本没有可用的恢复接口',
              onClick:()=>void restore(x)},'恢复') :
            x.orphan&&x.status==='unbound' ?
              h('button',{type:'button',className:'fgw-refresh',disabled:busy,
                onClick:()=>void archive(x)},'归档') : '—'}
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
