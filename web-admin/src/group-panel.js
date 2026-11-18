/* Group chat management.
 * OpenClaw-style layered configuration: one global policy, one trusted-member
 * allowlist, then optional per-group overrides that stay collapsed until needed.
 * Advanced fields are never shown for every group at once. */
const GROUP_POLICIES = [
  { value: 'disabled', icon: '⊘', title: '关闭', desc: '不响应任何群消息 · 默认最安全' },
  { value: 'allowlist', icon: '☷', title: '白名单群', desc: '只响应下方已登记并启用的群 · 推荐' },
  { value: 'open', icon: '◎', title: '所有群', desc: '任意群可接入，仍受成员白名单限制' },
]
const GROUP_SCOPES = [
  { value: 'group_sender', label: '按群 + 成员（推荐）' },
  { value: 'group_topic_sender', label: '按群 + 话题 + 成员' },
  { value: 'group', label: '群共享（高风险）' },
  { value: 'group_topic', label: '按话题共享' },
]
const GROUP_OPEN_ID_RE = /^ou_[A-Za-z0-9_-]{2,128}$/
const GROUP_CHAT_ID_RE = /^oc_[A-Za-z0-9_-]{2,128}$/

function GroupManagementPanel({ onChanged, onDirtyChange }) {
  const [snapshot, setSnapshot] = useState(null)
  const [policy, setPolicy] = useState('disabled')
  const [senders, setSenders] = useState([])
  const [senderDraft, setSenderDraft] = useState('')
  const [senderHint, setSenderHint] = useState('')
  const [groups, setGroups] = useState([])
  const [expanded, setExpanded] = useState({})
  const [query, setQuery] = useState('')
  const [baseline, setBaseline] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const parseList = value => [...new Set(String(value || '')
    .split(/[\s,，\n]+/).map(x => x.trim()).filter(Boolean))]
  const signature = (p, s, g) => JSON.stringify({ p, s, g })
  // A pasted open_id that has not yet been committed to the chip list is
  // still user input; do not silently drop it on navigation.
  const dirty = !!snapshot && (baseline !== signature(policy, senders, groups) ||
    Boolean(senderDraft.trim()))
  useEffect(() => {
    onDirtyChange?.(dirty)
    return () => onDirtyChange?.(false)
  }, [dirty, onDirtyChange])
  const enabledCount = groups.filter(g => g.enabled).length
  const activePolicy = GROUP_POLICIES.find(p => p.value === policy) || GROUP_POLICIES[0]

  const fetchState = useCallback(async () => {
    setError('')
    try {
      const data = await request('/state')
      setSnapshot(data)
      const cfg = data.config || {}
      const p = cfg.groupPolicy || 'disabled'
      const s = Array.isArray(cfg.groupSenderAllowlist) ? [...cfg.groupSenderAllowlist] : []
      const g = (cfg.groups || []).map(x => ({
        chatId: x.chatId || '', name: x.name || '', enabled: x.enabled !== false,
        requireMention: x.requireMention !== false,
        senderAllowlist: (x.senderAllowlist || []).join('\n'),
        sessionScope: x.sessionScope || 'group_sender',
      }))
      setPolicy(p); setSenders(s); setGroups(g)
      setSenderDraft(''); setSenderHint(''); setExpanded({})
      setBaseline(signature(p, s, g))
    } catch (e) { setError(e.message || String(e)) }
  }, [])
  useEffect(() => { void fetchState() }, [fetchState])
  const refreshWithGuard = () => {
    if (busy || (dirty && !window.confirm('群聊设置还有未保存的修改，刷新会放弃这些内容。确定继续吗？'))) return
    setNotice('')
    void fetchState()
  }

  const edit = (index, key, value) => setGroups(old =>
    old.map((g, i) => i === index ? { ...g, [key]: value } : g))
  const toggleExpand = index => setExpanded(old => ({ ...old, [index]: !old[index] }))
  const add = () => {
    const index = groups.length
    setGroups(old => [...old, {
      chatId: '', name: '', enabled: true, requireMention: true,
      senderAllowlist: '', sessionScope: 'group_sender',
    }])
    setExpanded(old => ({ ...old, [index]: true }))
  }
  const remove = index => {
    setGroups(old => old.filter((_, i) => i !== index))
    // Expansion uses list positions; rebase after removing a row so a
    // different group never inherits the deleted row's expanded fields.
    setExpanded(old => Object.fromEntries(Object.entries(old)
      .filter(([i]) => Number(i) !== index)
      .map(([i, value]) => [Number(i) > index ? Number(i) - 1 : Number(i), value])))
  }

  const commitSenders = () => {
    const items = parseList(senderDraft)
    if (!items.length) { setSenderHint(''); return }
    const valid = items.filter(x => GROUP_OPEN_ID_RE.test(x))
    const invalid = items.filter(x => !GROUP_OPEN_ID_RE.test(x))
    if (valid.length) setSenders(old => [...new Set([...old, ...valid])])
    setSenderDraft(invalid.join('\n'))
    setSenderHint(invalid.length
      ? '仅接受 ou_ 开头的 open_id；格式不符的内容已留在输入框待修正。'
      : '')
  }

  const save = async () => {
    if (!snapshot || busy) return
    setError(''); setNotice('')
    if (senderDraft.trim()) {
      setError('还有尚未加入白名单的成员 ID。请先点击「添加成员」，修正无效 ID，或清空输入框。')
      return
    }
    if (policy !== 'disabled' && senders.length === 0) {
      setError('启用群聊前，请先添加至少一位可信成员的 open_id 白名单。')
      return
    }
    const bad = groups.find(g => !GROUP_CHAT_ID_RE.test(g.chatId.trim()))
    if (bad) {
      setError('每个群组都需要有效的 oc_… chat_id（' +
        (bad.name.trim() || bad.chatId.trim() || '新群组') + '）。')
      return
    }
    const opening = policy === 'open' && snapshot.config?.groupPolicy !== 'open'
    if (opening && !window.confirm('确认开启 open 群聊模式？所有群均可被接入，但只有白名单成员能够触发 Agent。推荐先使用 allowlist。')) return
    const next = { ...(snapshot.config || {}),
      groupPolicy: policy, groupSenderAllowlist: senders,
      groups: groups.map(g => ({
        chatId: g.chatId.trim(), ...(g.name.trim() ? { name: g.name.trim() } : {}),
        enabled: g.enabled, requireMention: g.requireMention, sessionScope: g.sessionScope,
        ...(parseList(g.senderAllowlist).length
          ? { senderAllowlist: parseList(g.senderAllowlist) } : {}),
      })) }
    setBusy(true)
    try {
      await request('/config', 'PUT', {
        expectedRevision: snapshot.revision, config: next,
        ...(opening ? { confirmOpenGroups: true } : {}),
      })
      setNotice('群聊策略已保存。重启独立飞书 Gateway 后生效。')
      setBaseline(signature(policy, senders, groups))
      await fetchState()
      onChanged?.()
    } catch (e) { setError(e.message || String(e)) }
    finally { setBusy(false) }
  }

  const shortId = id => id.length > 18 ? id.slice(0, 15) + '…' : (id || '未填写 chat_id')
  const scopeLabel = value => (GROUP_SCOPES.find(s => s.value === value) || GROUP_SCOPES[0]).label
  const visible = groups.map((g, i) => ({ g, i })).filter(({ g }) => {
    const q = query.trim().toLowerCase()
    return !q || g.chatId.toLowerCase().includes(q) || g.name.toLowerCase().includes(q)
  })
  const input = (value, onChange, placeholder) => h('input', {
    className: 'fga-input', value, placeholder, spellCheck: false, autoComplete: 'off',
    onChange: e => onChange(e.target.value),
  })
  const field = (title, control, hint) => h('label', { className: 'fgw-group-field' },
    h('span', { className: 'fgw-group-field-title' }, title), control,
    hint && h('span', { className: 'fgw-muted' }, hint))
  const toggle = (checked, onChange, label, title) => h('label', {
    className: 'fgw-group-toggle', title,
  },
    h('input', { type: 'checkbox', checked, onChange: e => onChange(e.target.checked),
      'aria-label': title }),
    h('span', { className: 'fgw-group-toggle-track', 'aria-hidden': true }),
    label && h('span', { className: 'fgw-group-toggle-text' }, label))

  const groupRow = ({ g, i }) => h('div', {
    className: 'fgw-group-row' + (g.enabled ? '' : ' is-off'), key: i,
  },
    h('div', { className: 'fgw-group-row-main' },
      h('div', { className: 'fgw-group-row-lead' },
        toggle(g.enabled, v => edit(i, 'enabled', v), '', '启用该群'),
        h('button', {
          type: 'button', className: 'fgw-group-row-open',
          'aria-expanded': !!expanded[i],
          'aria-label': (expanded[i] ? '收起 ' : '展开 ') + (g.name || g.chatId || '新群组'),
          onClick: () => toggleExpand(i),
        },
          h('span', { className: 'fgw-group-row-name' }, g.name.trim() || g.chatId || '新群组'),
          h('code', { className: 'fgw-group-row-id' }, shortId(g.chatId)),
          h('span', { className: 'fgw-group-row-tags' },
            h('span', { className: 'fgw-group-tag' + (g.enabled ? ' is-on' : '') },
              g.enabled ? '已启用' : '已停用'),
            h('span', { className: 'fgw-group-tag' },
              scopeLabel(g.sessionScope).replace('（推荐）', '')),
            parseList(g.senderAllowlist).length
              ? h('span', { className: 'fgw-group-tag' },
                '额外成员 ' + parseList(g.senderAllowlist).length) : null),
          h('span', { className: 'fgw-group-chevron', 'aria-hidden': true },
            expanded[i] ? '⌃' : '⌄'))),
      h('div', { className: 'fgw-group-row-actions' },
        toggle(g.requireMention, v => edit(i, 'requireMention', v), '@才回复',
          '切换是否必须 @机器人 才回复'),
        h('button', { type: 'button', className: 'fgw-refresh', disabled: busy,
          onClick: () => remove(i), 'aria-label': '移除该群组' }, '移除'))),
    expanded[i] && h('div', { className: 'fgw-group-detail' },
      h('div', { className: 'fgw-group-grid' },
        field('飞书群 ID（chat_id）', input(g.chatId, v => edit(i, 'chatId', v), 'oc_...'),
          '飞书群唯一标识，必填'),
        field('备注名称', input(g.name, v => edit(i, 'name', v), '例如：项目协作群'),
          '仅本地显示标签，不会向飞书查询'),
        field('聊天上下文共享方式', h('select', { className: 'fga-input',
          value: g.sessionScope, onChange: e => edit(i, 'sessionScope', e.target.value) },
          GROUP_SCOPES.map(s => h('option', { key: s.value, value: s.value }, s.label))),
          '决定群成员之间是否共享对话上下文'),
        field('额外允许的群成员（可选）', h('textarea', {
          className: 'fga-input fga-textarea', rows: 3, value: g.senderAllowlist,
          onChange: e => edit(i, 'senderAllowlist', e.target.value),
          placeholder: '留空则继承全局白名单',
        }), '只能进一步收紧，不能放宽全局白名单'))))

  return h('div', { className: 'fgw-group-panel' },
    h('div', { className: 'fgw-group-summary' },
      h('div', { className: 'fgw-group-summary-text' },
        h('h2', null, '群聊管理'),
        h('p', { className: 'fgw-muted' },
          '依次设置哪些群可以使用机器人、哪些成员允许触发，以及群内回复方式。保存后需重启飞书通道。')),
      h('div', { className: 'fgw-group-metrics' },
        h('div', { className: 'fgw-group-metric' },
          h('span', null, '当前策略'), h('strong', null, activePolicy.title)),
        h('div', { className: 'fgw-group-metric' },
          h('span', null, '已启用群'),
          h('strong', null, enabledCount + ' / ' + groups.length)),
        h('div', { className: 'fgw-group-metric' },
          h('span', null, '可信成员'), h('strong', null, String(senders.length))))),

    h('section', { className: 'fgw-block' },
      h('div', { className: 'fgw-block-head' },
        h('h3', null, '接入策略'),
        h('span', { className: 'fgw-muted' }, '与飞书权限、成员白名单共同生效')),
      h('div', { className: 'fgw-block-body' },
        h('div', { className: 'fgw-group-policy-grid', role: 'radiogroup',
          'aria-label': '群聊接入策略' },
          GROUP_POLICIES.map(p => h('label', {
            key: p.value,
            className: 'fgw-group-policy' + (policy === p.value ? ' is-active' : ''),
          },
            h('input', { type: 'radio', name: 'fgw-group-policy', value: p.value,
              checked: policy === p.value, onChange: () => setPolicy(p.value) }),
            h('span', { className: 'fgw-group-policy-icon', 'aria-hidden': true }, p.icon),
            h('span', { className: 'fgw-group-policy-text' },
              h('strong', null, p.title), h('small', null, p.desc))))),
        policy === 'open' && h('div', { className: 'fga-warning fgw-group-warning' },
          '开放模式风险：机器人可能被任意群拉入；仅全局白名单成员可触发。请优先选择 allowlist。'),
        h('div', { className: 'fgw-group-senders' },
          h('div', { className: 'fgw-group-subhead' },
            h('strong', null, '可信成员白名单'),
            h('span', { className: 'fgw-muted' },
              'open_id · 全局生效，空列表会拒绝所有群消息')),
          h('div', { className: 'fgw-group-chips' },
            senders.map((id, i) => h('span', { className: 'fgw-group-chip', key: id + '#' + i },
              h('span', null, id),
              h('button', { type: 'button', 'aria-label': '移除 ' + id,
                onClick: () => setSenders(old => old.filter((_, j) => j !== i)) }, '×'))),
            h('input', { className: 'fgw-group-chip-input', value: senderDraft,
              placeholder: senders.length ? '继续添加…' : '粘贴 ou_…（回车或逗号添加，可多行）',
              spellCheck: false, autoComplete: 'off', 'aria-label': '添加可信成员 open_id',
              onChange: e => setSenderDraft(e.target.value),
              onKeyDown: e => {
                if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
                  e.preventDefault(); commitSenders()
                }
              }, onBlur: commitSenders })),
          h('p', { className: 'fgw-muted' + (senderHint ? ' fgw-group-hint-warn' : '') },
            senderHint || '支持批量粘贴；点 × 可移除单个成员。独立于私聊白名单。')))),

    h('section', { className: 'fgw-block' },
      h('div', { className: 'fgw-block-head' },
        h('h3', null, '已登记群组'),
        h('div', { className: 'fgw-group-head-actions' },
          h('input', { className: 'fga-input fgw-group-search', value: query,
            placeholder: '搜索群名或 chat_id', 'aria-label': '搜索群组',
            onChange: e => setQuery(e.target.value) }),
          h('button', { className: 'fgw-refresh fgw-ops-cta', type: 'button',
            disabled: busy || groups.length >= 200, onClick: add }, '+ 添加群组'))),
      h('div', { className: 'fgw-block-body fgw-group-list' },
        groups.length === 0
          ? h(WbEmpty, { headline: '尚未登记任何群',
            description: 'allowlist 模式下不会响应群消息。点击「添加群组」填入 oc_… chat_id。' })
          : visible.length === 0
            ? h('p', { className: 'fgw-muted' }, '没有匹配的群组，换个关键词试试。')
            : visible.map(groupRow))),

    h('p', { className: 'fgw-group-footnote fgw-muted' },
      '权限提示：订阅 im.message.receive_v1。仅 @ 模式需 im:message.group_at_msg:readonly；' +
      '免 @ 自动回复需 im:message.group_msg:readonly（或等效权限）。' +
      '群聊权限在入站、恢复执行、命令和审批卡片阶段均会检查，bot 自发消息不会触发 Agent。'),

    h('section', { className: 'fgw-group-savebar' },
      h('div', { className: 'fgw-group-savebar-status' },
        dirty
          ? h('span', { className: 'fgw-group-dirty' }, '● 有未保存的修改')
          : h('span', { className: 'fgw-muted' }, '配置已是最新'),
        error && h('div', { role: 'alert', className: 'fga-error' }, error),
        notice && h('div', { role: 'status', className: 'fga-notice' }, notice)),
      h('div', { className: 'fgw-group-savebar-actions' },
        h('button', { className: 'fgw-refresh fgw-refresh-action', type: 'button', disabled: busy,
          onClick: refreshWithGuard }, '刷新'),
        h('button', { className: 'fgw-refresh fgw-ops-cta fgw-group-save', type: 'button',
          disabled: busy || !snapshot, onClick: save }, busy ? '保存中…' : '保存群聊策略'))))
}
