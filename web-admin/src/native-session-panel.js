/* Native DSH Session ledger (Issue #34).
 * Reads only native headers; raw IDs are hidden until consciously revealed.
 * Workspace reconciliation is opt-in and never resumes native Sessions.
 */
function FeishuNativeSessionLedger() {
  const [query, setQuery] = useState({ status: 'all', type: 'all', bot: '', from: '', to: '', search: '', orphan: false, page: 1 })
  const [reveal, setReveal] = useState(false)
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
    if (!row.sessionId) return
    setBusy(true)
    try {
      const { preview } = await request('/sessions/native/preview', 'POST', { sessionId: row.sessionId })
      if (!window.confirm('归档 DSH 原生 Session？\n会话：' + (row.sessionTitle || row.sessionRef) +
        '\n引用：' + preview.sessionRef +
        '\n这会在 DSH Web 中隐藏会话，保留完整原生历史及恢复可能。确认后立即执行。')) {
        setNotice('已取消原生 Session 归档')
        return
      }
      const result = await request('/sessions/native/archive', 'POST', { token: preview.token })
      setNotice('原生 Session 已归档：' + result.result.sessionRef + '（数据未删除）')
      void refresh()
    } catch (e) { setError(e.message || String(e)) }
    finally { setBusy(false) }
  }
  const formatDate = ts => Number.isFinite(ts) && ts > 0 ? opsDate(ts) : '—'
  return h(React.Fragment, null,
    h('div', { className: 'fgw-metrics fgw-metrics-three' },
      h(WbMetric, { title: '原生 Session', value: report?.available ? wbCount(report.nativeCount) : '—',
        caption: 'DSH 持久化 header，含历史' }),
      h(WbMetric, { title: '未关联/孤儿', value: report?.available ? wbCount(report.orphanCount) : '—',
        caption: '不等于可安全删除' }),
      h(WbMetric, { title: '飞书工作区', value: report?.workspaceTitle || '未创建',
        caption: '仅在 Web workspace 服务可用时归位' })),
    h(WbBlock, { title: '工作区归位与安全迁移',
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
    h(WbBlock, { title: 'DSH 原生会话台账',
      aside: '包括已解绑、历史、定时任务和孤儿会话' },
      h('form', { className: 'fgw-session-filters',
        onSubmit: e => { e.preventDefault(); void refresh() } },
        h('label', { className: 'fgw-session-filter' }, h('span', null, '会话状态'),
          h('select', { className: 'fga-input', value: query.status,
            onChange: e => filter('status', e.target.value) },
            [['all','全部'],['active','活跃'],['idle','空闲'],['unbound','未关联'],
              ['archived','已归档']].map(([value,label]) => h('option', {key:value,value},label)))),
        h('label', { className: 'fgw-session-filter' }, h('span', null, '会话来源'),
          h('select', { className: 'fga-input', value: query.type,
            onChange: e => filter('type', e.target.value) },
            [['all','全部'],['p2p','私聊'],['group','群聊'],['schedule','定时']].map(([value,label]) =>
              h('option', {key:value,value},label)))),
        h('label', { className: 'fgw-session-filter' }, h('span', null, '机器人 ID'),
          h('input', { className: 'fga-input', value: query.bot, maxLength: 32,
            onChange: e => filter('bot', e.target.value), placeholder: '所有机器人' })),
        h('label', { className: 'fgw-session-filter' }, h('span', null, '开始日期 (UTC)'),
          h('input', { className: 'fga-input', type: 'date', value: query.from,
            onChange: e => filter('from', e.target.value) })),
        h('label', { className: 'fgw-session-filter' }, h('span', null, '结束日期 (UTC)'),
          h('input', { className: 'fga-input', type: 'date', value: query.to,
            onChange: e => filter('to', e.target.value) })),
        h('label', { className: 'fgw-session-filter' }, h('span', null, '检索引用 / Bot / 定时任务'),
          h('input', { className: 'fga-input', value: query.search, maxLength:128,
            onChange: e => filter('search',e.target.value), placeholder: 'Session 引用、任务标题' })),
        h('label', { className: 'fga-check' },
          h('input', { type: 'checkbox', checked: query.orphan,
            onChange: e => filter('orphan', e.target.checked) }), '仅看孤儿'),
        h('label', { className: 'fga-check' },
          h('input', { type: 'checkbox', checked: reveal,
            onChange: e => setReveal(e.target.checked) }), '显示完整 Session ID（可能包含聊天标识）'),
        h('button', { type: 'submit', className:'fgw-refresh', disabled:busy }, busy?'加载中…':'刷新')),
      error && h('div',{className:'fgw-caution',role:'alert'},error),
      notice && h('div',{className:'fgw-caution',role:'status'},notice),
      !report?.available ? h(WbEmpty, {headline:'等待原生 Session 服务',description:report?.reason || '请确认 DSH Web 具备持久化和工作区服务。'}) :
      h(OpsTable, {rows:report.items, empty:'没有符合当前筛选条件的原生 Session',
        columns:[
          {key:'sessionTitle', title:'标题',render:x=>h('div',null,
            h('strong',null,x.sessionTitle || x.scheduleTitle || '未命名'),
            h('div',{className:'fgw-muted'},x.type==='schedule'?'定时':
              x.type==='group'?'群聊':'私聊',x.legacy?' · 旧工作区':'',
              x.orphan?' · 历史/孤儿':''))},
          {key:'sessionRef',title:'Session',render:x=>h('div',null,
            h('code',{title:reveal?x.sessionId:x.sessionRef},reveal?x.sessionId:x.sessionRef),
            reveal && x.sessionId && h('button',{type:'button',className:'fgw-refresh',
              onClick:()=>navigator.clipboard?.writeText(x.sessionId)},'复制'))},
          {key:'chatRef',title:'聊天',render:x=>x.chatName || (x.chatRef?h('code',null,x.chatRef):'—')},
          {key:'botId',title:'Bot'},
          {key:'lastActiveAt',title:'最后活动',render:x=>formatDate(x.lastActiveAt)},
          {key:'status',title:'状态',render:x=>h(WbState,{value:x.status})},
          {key:'actions',title:'归档',render:x=>
            h('button',{type:'button',className:'fgw-refresh',
              disabled:busy||!reveal||!x.orphan||x.status!=='unbound',
              title:!reveal?'先开启完整 Session ID 显示':undefined,
              onClick:()=>void archive(x)},'预览并归档')}
        ] }),
      report?.available && h('div',{className:'fgw-session-pages'},
        h('span',null,'共 '+wbCount(report.total)+' 条 · 第 '+query.page+'/'+Math.max(1,Math.ceil(report.total/25))+' 页'),
        h('button',{className:'fgw-refresh',type:'button',disabled:busy||query.page<=1,
          onClick:()=>setQuery(x=>({...x,page:x.page-1}))},'上一页'),
        h('button',{className:'fgw-refresh',type:'button',
          disabled:busy||query.page>=Math.ceil(report.total/25),
          onClick:()=>setQuery(x=>({...x,page:x.page+1}))},'下一页'))),
    h(OpsNote,null,'此台账与下方 Gateway 绑定管理互补：上方覆盖原生 DSH 历史；下方仅处理仍存在的飞书聊天绑定。所有操作均保留原生 Session 数据。'))
}
