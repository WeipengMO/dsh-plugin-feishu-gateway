/* Feishu-only Agent workspace editor: compact file rail + one focused document pane.
 * Preserve DSH-authenticated APIs. Markdown preview is intentionally text-only.
 */
const AGENT_PROFILE_GROUPS = [
  { label: '身份与人格', names: ['IDENTITY.md', 'SOUL.md', 'USER.md'] },
  { label: '工作规则', names: ['AGENTS.md', 'TOOLS.md'] },
  { label: '长期记忆', names: ['MEMORY.md'] },
]
const PROFILE_LOADABLE = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'MEMORY.md']
const PROFILE_INFO = {
  'IDENTITY.md': ['身份设定', '名称、形象与角色定位'],
  'SOUL.md': ['人格风格', '表达方式、价值与行为边界'],
  'USER.md': ['用户偏好', '交流习惯、背景和长期偏好'],
  'AGENTS.md': ['工作规则', 'DSH 原生加载的 Agent 指令'],
  'TOOLS.md': ['工具约定', '工具、项目与环境使用规范'],
  'MEMORY.md': ['长期记忆', '经整理的重要事实和决策'],
}
function profileLocalToday() {
  const now = new Date()
  const two = value => String(value).padStart(2, '0')
  return now.getFullYear() + '-' + two(now.getMonth() + 1) + '-' + two(now.getDate())
}
function profileBytes(value) {
  return typeof TextEncoder === 'function' ? new TextEncoder().encode(value).length : value.length
}
function profileFormatBytes(value) {
  return Number(value || 0).toLocaleString('en-US') + ' B'
}
function ProfilePreview({ value }) {
  const lines = value.split('\n')
  let fenced = false
  return h('article', { className: 'fgw-profile-preview' },
    !value.trim() && h('div', { className: 'fgw-profile-preview-empty' }, '当前文件没有内容。可以切换到「编辑」开始编写。'),
    lines.slice(0, 1500).map((line, i) => {
      if (/^\s*(\x60{3}|~{3})/.test(line)) { fenced = !fenced; return h('pre', { key: i }, line) }
      if (fenced) return h('pre', { key: i }, line || ' ')
      const title = /^(#{1,4})\s+(.+)$/.exec(line)
      if (title) return h('div', { key: i, className: 'fgw-profile-h' + title[1].length }, title[2])
      if (/^\s*[-*]\s+/.test(line)) return h('div', { key: i, className: 'fgw-profile-list' }, '• ' + line.replace(/^\s*[-*]\s+/, ''))
      if (/^\s*>/.test(line)) return h('blockquote', { key: i }, line.replace(/^\s*>\s?/, ''))
      return h('div', { key: i, className: 'fgw-profile-line' }, line || ' ')
    }),
    lines.length > 1500 && h('p', { className: 'fgw-muted' }, '预览最多展示 1,500 行；保存仍保留完整文本。'))
}
function AgentProfilePanel({ onDirtyChange }) {
  const [profile, setProfile] = useState(null)
  const [selected, setSelected] = useState('IDENTITY.md')
  const [file, setFile] = useState(null)
  const [draft, setDraft] = useState('')
  const [history, setHistory] = useState([])
  const [tab, setTab] = useState('edit')
  const [settings, setSettings] = useState(null)
  const [date, setDate] = useState(profileLocalToday())
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [fileLoading, setFileLoading] = useState(true)
  const [mobileFiles, setMobileFiles] = useState(false)
  const requestId = React.useRef(0)
  const dirty = !!file && draft !== file.content
  const bytes = profileBytes(draft)
  const maxFileBytes = profile?.maxFileBytes || 24576
  const tooLarge = bytes > maxFileBytes
  const settingsChanged = !!settings && !!profile && (
    Number(settings.maxBytes) !== profile.settings.maxBytes ||
    Number(settings.perFileBytes) !== profile.settings.perFileBytes ||
    PROFILE_LOADABLE.some(name => settings.enabled[name] !== profile.settings.enabled[name]))
  const validSettings = !!settings &&
    Number.isInteger(Number(settings.maxBytes)) && Number(settings.maxBytes) >= 1024 &&
    Number(settings.maxBytes) <= 32768 && Number.isInteger(Number(settings.perFileBytes)) &&
    Number(settings.perFileBytes) >= 512 && Number(settings.perFileBytes) <= Number(settings.maxBytes)

  useEffect(() => {
    onDirtyChange?.(dirty || settingsChanged)
    return () => onDirtyChange?.(false)
  }, [dirty, settingsChanged, onDirtyChange])

  const loadProfile = useCallback(async (resetSettings = true) => {
    try {
      const data = (await request('/agent-profile')).profile
      setProfile(data)
      if (resetSettings) setSettings({ enabled: { ...data.settings.enabled }, maxBytes: data.settings.maxBytes,
        perFileBytes: data.settings.perFileBytes })
      setError('')
      return data
    } catch (e) { setError(e.message || String(e)); return null }
    finally { setLoading(false) }
  }, [])
  const loadFile = useCallback(async name => {
    const id = ++requestId.current
    setFileLoading(true)
    try {
      const [result, versions] = await Promise.all([
        request('/agent-profile/file?name=' + encodeURIComponent(name)),
        request('/agent-profile/history?name=' + encodeURIComponent(name)),
      ])
      if (id !== requestId.current) return
      setFile(result.file); setDraft(result.file.content); setHistory(versions.history)
    } catch (e) {
      if (id !== requestId.current) return
      setFile(null); setHistory([]); setError(e.message || String(e))
    } finally {
      if (id === requestId.current) setFileLoading(false)
    }
  }, [])
  useEffect(() => { void loadProfile() }, [loadProfile])
  useEffect(() => {
    void loadFile(selected)
    return () => { requestId.current++ }
  }, [selected, loadFile])
  useEffect(() => {
    if (!dirty) return
    const guard = event => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty])

  const pick = name => {
    if (name === selected || busy) return
    if (dirty && !window.confirm('当前文件有未保存的修改，确定放弃并切换文件？')) return
    setFile(null); setDraft(''); setHistory([])
    setSelected(name); setTab('edit'); setNotice(''); setError(''); setMobileFiles(false)
  }
  const save = async () => {
    if (!file || !dirty || busy || fileLoading || tooLarge) return
    setBusy(true); setError(''); setNotice('')
    try {
      await request('/agent-profile/file', 'PUT', {
        name: selected, content: draft, expectedRevision: file.revision,
      })
      await Promise.all([loadProfile(!settingsChanged), loadFile(selected)])
      setNotice('文件已保存并同步。新 Session 会读取更新后的内容；已有 Session 请使用 /new。')
    } catch (e) {
      setError('保存结果未确认：' + (e.message || String(e)) + '。请刷新核对文件及同步状态。')
    } finally { setBusy(false) }
  }
  const restore = async id => {
    if (!file || busy || dirty || !window.confirm('确认恢复该历史版本？当前版本会先保留为历史记录。')) return
    setBusy(true); setError(''); setNotice('')
    try {
      await request('/agent-profile/restore', 'POST', { name: selected, id,
        expectedRevision: file.revision })
      await Promise.all([loadProfile(), loadFile(selected)])
      setNotice('历史版本已恢复并同步；新 Session 生效。')
    } catch (e) { setError(e.message || String(e)) }
    finally { setBusy(false) }
  }
  const sync = async () => {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      await request('/agent-profile/sync', 'POST', {})
      await loadProfile(!settingsChanged)
      setNotice('已同步至飞书专属 AGENTS.local.md。新 Session 生效，已有 Session 不会热更新。')
    } catch (e) { setError(e.message || String(e)) }
    finally { setBusy(false) }
  }
  const detachLegacy = async () => {
    if (!profile?.legacy?.detected || busy) return
    if (!window.confirm('将备份普通 DSH 工作区的 AGENTS.local.md，然后仅移除旧飞书托管区块。其他规则和档案文件保持不变。确认继续？')) return
    setBusy(true); setError(''); setNotice('')
    try {
      await request('/agent-profile/detach-legacy', 'POST', { expectedRevision: profile.legacy.revision })
      await loadProfile(!settingsChanged)
      setNotice('旧共享区块已备份并移除。请新建普通 DSH Session 以应用变化。')
    } catch (e) { setError('旧共享区块清理失败：' + (e.message || String(e))) }
    finally { setBusy(false) }
  }
  const saveSettings = async () => {
    if (!profile || !validSettings || !settingsChanged || busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      await request('/agent-profile/settings', 'PUT', {
        settings: { enabled: settings.enabled, maxBytes: Number(settings.maxBytes),
          perFileBytes: Number(settings.perFileBytes) },
        expectedRevision: profile.settings.revision,
      })
      await loadProfile()
      setNotice('上下文加载规则已保存并同步。新 Session 生效。')
    } catch (e) { setError(e.message || String(e)) }
    finally { setBusy(false) }
  }
  const refresh = async () => {
    if (busy) return
    if (dirty && !window.confirm('当前文件有未保存的修改，确认放弃并刷新？')) return
    if (settingsChanged && !window.confirm('未保存的加载规则会丢失，确认刷新？')) return
    setBusy(true); setNotice('')
    try { await Promise.all([loadProfile(), loadFile(selected)]) }
    finally { setBusy(false) }
  }
  useEffect(() => {
    const shortcut = event => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return
      if (!event.target?.closest?.('.fgw-agent-profile')) return
      event.preventDefault()
      if (tab === 'loading') void saveSettings()
      else void save()
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [tab, save, saveSettings])

  const files = profile?.files || []
  const loaded = profile?.loaded || []
  const currentMeta = files.find(x => x.name === selected)
  const description = PROFILE_INFO[selected] || ['每日记忆', '该日期的工作日志与临时上下文']
  const search = filter.trim().toLowerCase()
  const visibleFile = name => !search ||
    name.toLowerCase().includes(search) ||
    (PROFILE_INFO[name] || []).join(' ').toLowerCase().includes(search)
  const fileButtons = name => {
    const meta = files.find(x => x.name === name)
    const exists = meta?.exists === true
    const active = selected === name
    return h('button', { key: name, type: 'button', disabled: busy,
      className: 'fgw-profile-file' + (active ? ' is-active' : ''),
      'aria-current': active ? 'page' : undefined,
      onClick: () => pick(name) },
      h('span', { className: 'fgw-profile-file-glyph', 'aria-hidden': true }, name.startsWith('memory/') ? '◷' : '▤'),
      h('span', { className: 'fgw-profile-file-main' },
        h('strong', null, name),
        h('small', null, PROFILE_INFO[name]?.[0] || '每日记录')),
      h('span', { className: 'fgw-profile-file-presence' + (exists ? ' is-present' : ''),
        title: exists ? '已创建' : '尚未创建', 'aria-label': exists ? '已创建' : '未创建' }))
  }
  const nav = h('aside', { className: 'fgw-profile-nav' + (mobileFiles ? ' is-mobile-open' : ''),
    'aria-label': 'Agent 档案文件列表' },
    h('div', { className: 'fgw-profile-nav-head' },
      h('strong', null, '工作区文件'),
      h('span', { className: 'fgw-muted' }, files.filter(x => x.exists).length, ' 个已创建')),
    h('input', { className: 'fgw-profile-search', type: 'search', value: filter,
      placeholder: '查找文件…', 'aria-label': '查找 Agent 档案文件',
      onChange: event => setFilter(event.target.value) }),
    h('div', { className: 'fgw-profile-nav-scroll' },
      AGENT_PROFILE_GROUPS.map(group => h('section', { key: group.label },
        h('h3', null, group.label),
        group.names.filter(visibleFile).map(fileButtons))),
      h('section', null, h('h3', null, '每日记忆'),
        h('div', { className: 'fgw-profile-date-row' },
          h('input', { type: 'date', value: date, 'aria-label': '每日记忆日期',
            onChange: event => setDate(event.target.value) }),
          h('button', { type: 'button', disabled: busy, onClick: () => {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { setError('日期无效'); return }
            pick('memory/' + date + '.md')
          } }, '打开')),
        files.filter(item => item.name.startsWith('memory/') && visibleFile(item.name))
          .map(item => fileButtons(item.name)))),
    h('div', { className: 'fgw-profile-nav-foot' },
      h('span', null, '仅管理飞书 Agent 工作区'),
      h('small', null, '未创建的文件不会加载到上下文')))

  const loadUsed = Math.min(100, Math.round((profile?.contextBytes || 0) /
    Math.max(1, profile?.settings.maxBytes || 16000) * 100))
  const statusLine = h('div', { className: 'fgw-profile-summary' },
    h('div', { className: 'fgw-profile-path' },
      h('span', { className: 'fgw-profile-path-label' }, 'FEISHU WORKSPACE'),
      h('code', { title: profile?.workspace || '' }, profile?.workspace || '正在读取工作区…')),
    h('div', { className: 'fgw-profile-summary-right' },
      h('span', { className: 'fgw-profile-sync' + (profile?.syncNeeded ? ' is-pending' : '') },
        h('span', { className: 'fgw-profile-sync-dot' }), profile?.syncNeeded ? '待同步' : '已同步'),
      h('span', { className: 'fgw-profile-context-summary' },
        loaded.length + ' 个加载 · ' + profileFormatBytes(profile?.contextBytes) +
        ' / ' + profileFormatBytes(profile?.settings.maxBytes || 16000)),
      profile?.syncNeeded && h('button', { type: 'button', className: 'fgw-refresh',
        disabled: busy, onClick: () => void sync() }, '同步'),
      h('button', { type: 'button', className: 'fgw-refresh', disabled: busy,
        onClick: () => void refresh() }, busy ? '处理中…' : '刷新')))

  let body
  if (tab === 'preview') {
    body = h('div', { className: 'fgw-profile-document-scroll fgw-profile-preview-scroll' },
      h('p', { className: 'fgw-profile-section-note' }, '实时预览当前草稿，不会运行 Markdown 中的 HTML 或脚本。'),
      h(ProfilePreview, { value: draft }))
  } else if (tab === 'history') {
    body = h('div', { className: 'fgw-profile-document-scroll fgw-profile-history-pane' },
      h('p', { className: 'fgw-profile-section-note' }, '最近 30 个历史版本。恢复需要确认，且不能覆盖当前未保存的修改。'),
      history.length ? history.map(entry => h('div', { className: 'fgw-profile-history', key: entry.id },
        h('div', null, h('strong', null, new Date(entry.timestamp).toLocaleString()),
          h('small', null, entry.revision.slice(0, 12) + ' · ' + profileFormatBytes(entry.size))),
        h('button', { type: 'button', className: 'fgw-refresh', disabled: busy || dirty || fileLoading,
          onClick: () => void restore(entry.id) }, '恢复此版本'))) :
        h(WbEmpty, { headline: '暂无历史版本', description: '首次保存文件后，历史快照会在这里出现。' }))
  } else if (tab === 'loading') {
    body = h('div', { className: 'fgw-profile-document-scroll fgw-profile-settings-pane' },
      h('h3', null, '上下文加载'),
      h('p', { className: 'fgw-profile-section-note' },
        '启用且非空的文件会同步到飞书专属 AGENTS.local.md。AGENTS.md 由 DSH 原生加载；每日记忆按需读取。'),
      h('div', { className: 'fgw-profile-settings-grid' },
        h('div', { className: 'fgw-profile-setting-card' },
          h('h4', null, '注入文件'),
          settings && PROFILE_LOADABLE.map(name => {
            const meta = files.find(x => x.name === name)
            const current = loaded.find(x => x.name === name)
            return h('label', { className: 'fgw-profile-check', key: name },
              h('span', null, h('strong', null, name),
                h('small', null, !meta?.exists ? '未创建' : current?.truncated ? '上下文中已截断' :
                  current ? '已纳入上下文' : '未纳入上下文')),
              h('input', { type: 'checkbox', checked: settings.enabled[name] === true,
                disabled: busy,
                onChange: event => setSettings(prev => ({
                  ...prev, enabled: { ...prev.enabled, [name]: event.target.checked },
                })) }))
          })),
        h('div', { className: 'fgw-profile-setting-card' },
          h('h4', null, '加载预算'),
          h('p', { className: 'fgw-muted' }, '按 UTF-8 字节控制上下文大小，不等同于 Token 数。'),
          h('div', { className: 'fgw-profile-usage-row' },
            h('strong', null, profileFormatBytes(profile?.contextBytes)),
            h('span', null, ' / ', profileFormatBytes(profile?.settings.maxBytes))),
          h('div', { className: 'fgw-profile-usage-track' },
            h('div', { className: 'fgw-profile-usage-fill', style: { width: loadUsed + '%' } })),
          h('label', { className: 'fgw-profile-num' }, '总预算（B）',
            h('input', { type: 'number', min: 1024, max: 32768, step: 512,
              value: settings?.maxBytes ?? '', disabled: busy,
              onChange: event => setSettings(prev => ({ ...prev, maxBytes: event.target.value })) })),
          h('label', { className: 'fgw-profile-num' }, '单文件上限（B）',
            h('input', { type: 'number', min: 512, max: 32768, step: 512,
              value: settings?.perFileBytes ?? '', disabled: busy,
              onChange: event => setSettings(prev => ({ ...prev, perFileBytes: event.target.value })) })),
          !validSettings && h('p', { className: 'fgw-profile-limit-warning' },
            '总预算应在 1,024–32,768 B，单文件上限应在 512 B 到总预算之间。'),
          h('button', { type: 'button', className: 'fgw-refresh fgw-ops-cta',
            disabled: busy || !settingsChanged || !validSettings,
            onClick: () => void saveSettings() }, busy ? '保存中…' : settingsChanged ? '保存加载配置' : '加载配置已保存'))))
  } else {
    body = h('div', { className: 'fgw-profile-editor-body' },
      h('textarea', { className: 'fgw-profile-textarea', value: draft, disabled: fileLoading || busy,
        onChange: event => setDraft(event.target.value), spellCheck: false,
        'aria-label': selected + ' Markdown 编辑器',
        placeholder: '# ' + selected + '\n\n在这里编写 Markdown。未创建的文件将在保存时创建。' }))
  }

  const canSave = !!file && dirty && !busy && !fileLoading && !tooLarge
  return h('div', { className: 'fgw-agent-profile' },
    statusLine,
    error && h('div', { className: 'fgw-alert', role: 'alert' }, error),
    notice && h('div', { className: 'fgw-profile-notice', role: 'status' }, notice),
    !profile && (loading ? h('div', { className: 'fgw-caution' }, '正在读取飞书工作区…') :
      h(OpsUnavailable, { title: '飞书专属工作区不可访问' })),
    profile && h(React.Fragment, null,
      profile.legacy?.detected && h('div', { className: 'fgw-profile-legacy', role: 'alert' },
        h('div', null, h('strong', null, '发现旧版共享指令'),
          h('p', null, '普通 DSH 工作区中仍有旧飞书托管区块。可先备份原文件，再仅移除该区块。')),
        h('button', { type: 'button', className: 'fgw-refresh', disabled: busy,
          onClick: () => void detachLegacy() }, '备份并移除')),
      h('div', { className: 'fgw-profile-shell' },
        h('div', { className: 'fgw-profile-mobile-files' },
          h('button', { type: 'button', className: 'fgw-refresh', onClick: () => setMobileFiles(v => !v) },
            mobileFiles ? '收起文件列表' : '文件列表 · ' + selected)),
        nav,
        h('section', { className: 'fgw-profile-document', 'aria-label': 'Agent 档案编辑区域' },
          h('div', { className: 'fgw-profile-document-header' },
            h('div', { className: 'fgw-profile-document-identity' },
              h('span', { className: 'fgw-profile-kicker' }, description[0]),
              h('h2', null, selected),
              h('p', null, description[1])),
            h('div', { className: 'fgw-profile-document-actions' },
              h('span', { className: 'fgw-profile-exists' + (currentMeta?.exists ? ' is-present' : '') },
                currentMeta?.exists ? '已创建' : '未创建'),
              dirty && h('span', { className: 'fgw-profile-dirty' }, '未保存'),
              h('button', { type: 'button', className: 'fgw-refresh fgw-profile-primary',
                disabled: !canSave, onClick: () => void save() },
                busy ? '保存中…' : currentMeta?.exists ? '保存修改' : '创建并保存'))),
          h('div', { className: 'fgw-profile-tabs', role: 'tablist', 'aria-label': '档案操作' },
            [['edit', '编辑'], ['preview', '预览'], ['history', '版本历史'], ['loading', '加载配置']]
              .map(([id, label]) => h('button', { key: id, type: 'button', role: 'tab',
                'aria-selected': tab === id, className: tab === id ? 'is-active' : '',
                onClick: () => setTab(id) }, label, id === 'history' && history.length > 0 &&
                h('span', { className: 'fgw-profile-tab-count' }, history.length)))),
          fileLoading ? h('div', { className: 'fgw-profile-loading-file' }, '正在加载文件…') : body,
          h('div', { className: 'fgw-profile-document-footer' },
            h('div', { className: 'fgw-profile-footer-data' },
              h('span', { className: tooLarge ? 'fgw-profile-limit-warning' : '' },
                profileFormatBytes(bytes) + ' / ' + profileFormatBytes(maxFileBytes)),
              h('span', null, file?.revision === 'absent' ? '新文件' :
                '版本 ' + (file?.revision?.slice(0, 10) || '—')),
              tab === 'edit' && h('span', null, 'Ctrl / ⌘ + S 保存')),
            h('div', { className: 'fgw-profile-footer-actions' },
              tooLarge && h('strong', { className: 'fgw-profile-limit-warning' }, '文件超过上限'),
              h('span', null, '保存后新 Session 生效'),
              tab === 'edit' && dirty && h('button', { type: 'button',
                className: 'fgw-profile-discard', disabled: busy,
                onClick: () => {
                  if (window.confirm('放弃未保存的修改？')) setDraft(file?.content || '')
                } }, '放弃修改')))))))
}
