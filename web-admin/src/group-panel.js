/* Group chat management: explicit administrator intent, strict server-side validation. */
function GroupManagementPanel({ onChanged }) {
  const [snapshot, setSnapshot] = useState(null)
  const [policy, setPolicy] = useState('disabled')
  const [senders, setSenders] = useState('')
  const [groups, setGroups] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const list = value => [...new Set(String(value || '').split(/[\n,]/).map(x => x.trim()).filter(Boolean))]
  const fetchState = useCallback(async () => {
    setError('')
    try {
      const data = await request('/state')
      setSnapshot(data)
      const cfg = data.config || {}
      setPolicy(cfg.groupPolicy || 'disabled')
      setSenders(Array.isArray(cfg.groupSenderAllowlist) ? cfg.groupSenderAllowlist.join('\n') : '')
      setGroups((cfg.groups || []).map(g => ({
        chatId: g.chatId, name: g.name || '', enabled: g.enabled !== false,
        requireMention: g.requireMention !== false,
        senderAllowlist: (g.senderAllowlist || []).join('\n'),
        sessionScope: g.sessionScope || 'group_sender',
      })))
    } catch (e) { setError(e.message || String(e)) }
  }, [])
  useEffect(() => { void fetchState() }, [fetchState])
  const edit = (index, key, value) => setGroups(old =>
    old.map((g, i) => i === index ? { ...g, [key]: value } : g))
  const save = async () => {
    if (!snapshot || busy) return
    if (policy !== 'disabled' && list(senders).length === 0) {
      setError('必须先添加至少一位群聊成员的 open_id 白名单，才可启用群聊。')
      return
    }
    const opening = policy === 'open' && snapshot.config?.groupPolicy !== 'open'
    if (opening && !window.confirm('确认开启 open 群聊模式？所有群均可被接入，但只有白名单成员能够触发 Agent。推荐先使用 allowlist。')) return
    const next = { ...(snapshot.config || {}),
      groupPolicy: policy, groupSenderAllowlist: list(senders),
      groups: groups.map(g => ({
        chatId: g.chatId.trim(), ...(g.name.trim() ? { name: g.name.trim() } : {}),
        enabled: g.enabled, requireMention: g.requireMention,
        sessionScope: g.sessionScope,
        ...(list(g.senderAllowlist).length ? { senderAllowlist: list(g.senderAllowlist) } : {}),
      })) }
    setBusy(true); setError(''); setNotice('')
    try {
      await request('/config', 'PUT', {
        expectedRevision: snapshot.revision, config: next,
        ...(opening ? { confirmOpenGroups: true } : {}),
      })
      setNotice('群聊策略已保存。重启独立飞书 Gateway 后生效。')
      await fetchState()
      onChanged?.()
    } catch (e) { setError(e.message || String(e)) }
    finally { setBusy(false) }
  }
  const add = () => setGroups(old => [...old, {
    chatId: '', name: '', enabled: true, requireMention: true,
    senderAllowlist: '', sessionScope: 'group_sender',
  }])
  const input = (value, onChange, placeholder) => h('input', {
    className: 'fga-input', value, placeholder,
    onChange: e => onChange(e.target.value),
  })
  const field = (title, control, hint) => h('div', { className: 'fgw-group-field' },
    h('label', null, title), control, hint && h('p', { className: 'fgw-muted' }, hint))
  return h('div', { className: 'fgw-group-management' },
    h('div', { className: 'fgw-block' },
      h('div', { className: 'fgw-block-head' },
        h('h3', null, '群聊接入策略'),
        h('span', { className: 'fgw-muted' }, '默认关闭 · 配置仅在 Gateway 重启后生效')),
      h('div', { className: 'fgw-group-grid' },
        field('全局策略', h('select', { className: 'fga-input', value: policy,
          onChange: e => setPolicy(e.target.value) },
          h('option', { value: 'disabled' }, 'disabled · 全部拒绝'),
          h('option', { value: 'allowlist' }, 'allowlist · 只允许已登记群'),
          h('option', { value: 'open' }, 'open · 所有群（仍限制成员）'))),
        field('全局群聊成员白名单（open_id）',
          h('textarea', { className: 'fga-input fga-textarea', rows: 4, value: senders,
            onChange: e => setSenders(e.target.value), placeholder: 'ou_...，每行一个' }),
          '独立于私聊白名单。空列表拒绝全部群消息；每个群可进一步收紧。')),
      policy === 'open' && h('div', { className: 'fga-warning' },
        '开放模式风险：机器人可能被任意群拉入；仅全局白名单成员可触发。请优先选择 allowlist。')),
    h('div', { className: 'fgw-block' },
      h('div', { className: 'fgw-block-head' }, h('h3', null, '已登记群组'),
        h('button', { className: 'fgw-refresh', type: 'button', onClick: add,
          disabled: busy || groups.length >= 200 }, '添加群组')),
      groups.length === 0 && h('p', { className: 'fgw-muted' }, '暂无群组。allowlist 模式不会响应任何群消息。'),
      groups.map((g, i) => h('div', { className: 'fgw-group-entry', key: i },
        h('div', { className: 'fgw-group-entry-head' },
          h('strong', null, g.name.trim() || g.chatId || '新群组'),
          h('button', { type: 'button', className: 'fgw-refresh',
            onClick: () => setGroups(old => old.filter((_, j) => i !== j)), disabled: busy }, '移除')),
        h('div', { className: 'fgw-group-grid' },
          field('群 chat_id', input(g.chatId, v => edit(i, 'chatId', v), 'oc_...')),
          field('备注名称', input(g.name, v => edit(i, 'name', v), '例如：项目协作群')),
          field('Session 隔离范围', h('select', { className: 'fga-input', value: g.sessionScope,
            onChange: e => edit(i, 'sessionScope', e.target.value) },
            h('option', { value: 'group_sender' }, '按群 + 成员（推荐）'),
            h('option', { value: 'group_topic_sender' }, '按群 + 话题 + 成员'),
            h('option', { value: 'group' }, '群共享（高风险）'),
            h('option', { value: 'group_topic' }, '按话题共享'))),
          field('额外允许的群成员（可选）',
            h('textarea', { className: 'fga-input fga-textarea', rows: 3,
              value: g.senderAllowlist, onChange: e => edit(i, 'senderAllowlist', e.target.value),
              placeholder: '留空继承全局白名单' })),
          h('label', { className: 'fga-check' },
            h('input', { type: 'checkbox', checked: g.enabled,
              onChange: e => edit(i, 'enabled', e.target.checked) }), '启用该群'),
          h('label', { className: 'fga-check' },
            h('input', { type: 'checkbox', checked: g.requireMention,
              onChange: e => edit(i, 'requireMention', e.target.checked) }), '必须明确 @机器人 才回复'))))),
    h('div', { className: 'fgw-block' },
      h('h3', null, '飞书权限和安全'),
      h('p', { className: 'fgw-muted' },
        '订阅 im.message.receive_v1：仅 @ 模式需 im:message.group_at_msg:readonly；无需 @ 自动回复需 im:message.group_msg:readonly（或等效权限）。未开通权限不会收到普通消息。'),
      h('p', { className: 'fgw-muted' },
        '群聊权限在入站、恢复执行、命令和审批卡片阶段均会检查。bot 自发消息不会触发 Agent。'),
      error && h('div', { role: 'alert', className: 'fga-error' }, error),
      notice && h('div', { role: 'status', className: 'fga-notice' }, notice),
      h('div', { className: 'fgw-row-inline' },
        h('button', { className: 'fgw-refresh fgw-ops-cta', type: 'button',
          disabled: busy || !snapshot, onClick: save }, busy ? '保存中…' : '保存群聊策略'),
        h('button', { className: 'fgw-refresh', type: 'button', disabled: busy,
          onClick: () => void fetchState() }, '刷新'))))
}
