/* Feishu Skills UI: owner-only, no marketplace, installers or DSH global config.
 * Uses the existing authenticated request helper and MarkdownCodeEditor.
 */
const SKILL_TEMPLATE = [
  '---',
  'name: my-skill',
  'description: 描述这个技能在什么请求下适合使用',
  '---',
  '',
  '# 技能说明',
  '',
  '当用户提出相关请求时，按照以下步骤完成：',
  '',
  '1. 确认用户目标。',
  '2. 根据现有工具和权限执行任务。',
  '3. 清楚说明结果。',
  '',
].join('\n')

function SkillsPanel({ onDirtyChange }) {
  const [catalog, setCatalog] = useState(null)
  const [selected, setSelected] = useState('')
  const [loaded, setLoaded] = useState(null)
  const [draft, setDraft] = useState('')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [mode, setMode] = useState('edit')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [mobileList, setMobileList] = useState(false)
  const [newMode, setNewMode] = useState('create')
  const dirty = selected === '__new__' ? !!draft.trim() : !!loaded && draft !== loaded.content
  const bytes = typeof TextEncoder === 'function' ? new TextEncoder().encode(draft).length : draft.length
  const maxFile = catalog?.maxFileBytes || 12288
  const nameInDraft = /^name:\s*([a-z][a-z0-9-]*)\s*$/m.exec(draft)?.[1] || ''
  const list = (catalog?.items || []).filter(item =>
    (filter === 'all' || (filter === 'enabled') === item.enabled) &&
    (item.name + ' ' + item.description).toLowerCase().includes(search.trim().toLowerCase()))
  const count = catalog?.items?.length || 0
  const enabledCount = catalog?.enabled || 0

  useEffect(() => {
    onDirtyChange?.(dirty)
    return () => onDirtyChange?.(false)
  }, [dirty, onDirtyChange])

  const refresh = useCallback(async () => {
    try {
      const response = await request('/skills')
      setCatalog(response.catalog)
      setError('')
      return response.catalog
    } catch (e) { setError(e.message || String(e)); return null }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  const mayLeave = () => !dirty || window.confirm('技能内容尚未保存。确定放弃修改吗？')
  const loadSkill = async name => {
    if (!mayLeave()) return
    setSelected(name)
    setLoaded(null)
    setDraft('')
    setMode('edit')
    setMobileList(false)
    if (!name) return
    try {
      const result = await request('/skills/file?name=' + encodeURIComponent(name))
      setLoaded(result.skill)
      setDraft(result.skill.content)
      setError('')
    } catch (e) { setError(e.message || String(e)) }
  }
  const begin = importMode => {
    if (!mayLeave()) return
    setNewMode(importMode ? 'import' : 'create')
    setLoaded(null)
    setSelected('__new__')
    setDraft(importMode ? '' : SKILL_TEMPLATE)
    setMode('edit')
    setNotice('')
    setError('')
    setMobileList(false)
  }
  const save = async () => {
    if (!nameInDraft) { setError('请在 SKILL.md 顶部填写合法的 name（小写英文、数字和连字符）。'); return }
    if (selected !== '__new__' && selected !== nameInDraft) {
      setError('已保存技能不能直接更名。请另建一个技能，再删除旧技能。'); return
    }
    setBusy(true); setError(''); setNotice('')
    try {
      const response = await request('/skills/file', 'PUT', {
        name: nameInDraft, content: draft, expectedRevision: loaded?.revision || 'absent',
      })
      setLoaded(response.result.skill)
      setSelected(nameInDraft)
      setNotice('已保存。新飞书会话将使用最新启用的技能。')
      await refresh()
    } catch (e) { setError(e.message || String(e)) }
    finally { setBusy(false) }
  }
  const toggle = async item => {
    if (selected === item.name && dirty && !mayLeave()) return
    setBusy(true); setError(''); setNotice('')
    try {
      await request('/skills/enabled', 'PUT', { name: item.name, enabled: !item.enabled, expectedRevision: item.revision })
      const data = await refresh()
      if (selected === item.name && data) {
        const result = await request('/skills/file?name=' + encodeURIComponent(item.name))
        setLoaded(result.skill); setDraft(result.skill.content)
      }
      setNotice(item.enabled ? '已停用该技能。' : '已启用该技能；新飞书会话生效。')
    } catch (e) { setError(e.message || String(e)) }
    finally { setBusy(false) }
  }
  const remove = async () => {
    if (!loaded || busy) return
    if (!window.confirm('确定删除技能「' + loaded.name + '」？此操作无法撤销。')) return
    setBusy(true); setError(''); setNotice('')
    try {
      await request('/skills/delete', 'POST', { name: loaded.name, expectedRevision: loaded.revision })
      setSelected(''); setLoaded(null); setDraft('')
      await refresh()
      setNotice('技能已删除，已同步更新飞书 Agent 指令。')
    } catch (e) { setError(e.message || String(e)) }
    finally { setBusy(false) }
  }
  const sync = async () => {
    setBusy(true); setError(''); setNotice('')
    try {
      await request('/skills/sync', 'POST', {})
      await refresh()
      setNotice('飞书 Agent 技能清单已同步。')
    } catch (e) { setError(e.message || String(e)) }
    finally { setBusy(false) }
  }
  const readable = value => (Number(value || 0) / 1024).toFixed(1) + ' KB'

  return h('section', { className: 'fgw-skills' },
    h('div', { className: 'fgw-skills-summary' },
      h('div', null,
        h('strong', null, '飞书 Agent 技能库'),
        h('p', null, '启用常用技能，让飞书 Agent 在新对话中按指定方式完成任务；不会改变普通 DSH 的技能设置')),
      h('div', { className: 'fgw-skills-stats' },
        h('span', null, h('b', null, count), ' 个技能'),
        h('span', null, h('b', null, enabledCount), ' 个启用'),
        h('span', null, readable(catalog?.contextBytes), ' / 24 KB 上下文'))),
    catalog?.syncNeeded && h('div', { className: 'fgw-caution', role: 'status' },
      '技能清单与 Agent 指令尚未同步。',
      h('button', { type: 'button', disabled: busy, onClick: sync }, '重新同步')),
    error && h('div', { className: 'fgw-alert', role: 'alert' }, error),
    notice && h('div', { className: 'fgw-skills-notice', role: 'status' }, notice),
    loading && h('div', { className: 'fgw-muted' }, '正在读取技能库…'),
    h('div', { className: 'fgw-skills-shell' + (mobileList ? ' show-list' : '') },
      h('aside', { className: 'fgw-skills-rail' },
        h('div', { className: 'fgw-skills-rail-top' },
          h('span', null, '技能列表'),
          h('button', { className: 'fgw-skills-add', type: 'button', disabled: busy || count >= (catalog?.limit || 24),
            onClick: () => begin(false) }, '+ 新建')),
        h('input', { className: 'fgw-skills-search', type: 'search', value: search,
          onChange: e => setSearch(e.target.value), placeholder: '搜索名称或用途…', 'aria-label': '搜索技能' }),
        h('div', { className: 'fgw-skills-filters', role: 'group', 'aria-label': '技能状态筛选' },
          [['all', '全部'], ['enabled', '已启用'], ['disabled', '已停用']].map(([key, text]) =>
            h('button', { key, type: 'button', className: filter === key ? 'active' : '',
              onClick: () => setFilter(key) }, text))),
        h('div', { className: 'fgw-skills-items' },
          list.map(item => h('div', { key: item.name, className: 'fgw-skills-item' + (selected === item.name ? ' selected' : '') },
            h('button', { type: 'button', className: 'fgw-skills-open',
              onClick: () => loadSkill(item.name) },
              h('strong', null, item.name),
              h('small', null, item.description)),
            h('button', { type: 'button', role: 'switch', 'aria-checked': item.enabled,
              'aria-label': (item.enabled ? '停用 ' : '启用 ') + item.name,
              disabled: busy, className: 'fgw-skills-switch' + (item.enabled ? ' on' : ''),
              onClick: () => toggle(item) }, h('span', null)))),
          !loading && !list.length && h('div', { className: 'fgw-skills-empty-list' },
            count ? '没有符合筛选条件的技能' : '技能库还是空的。新建第一个技能，或粘贴已有 SKILL.md。')),
        h('div', { className: 'fgw-skills-rail-foot' },
          h('button', { type: 'button', disabled: busy || count >= (catalog?.limit || 24),
            onClick: () => begin(true) }, '粘贴导入 SKILL.md'),
          h('button', { type: 'button', disabled: busy, onClick: refresh }, '刷新'))),
      h('div', { className: 'fgw-skills-main' },
        h('button', { type: 'button', className: 'fgw-skills-mobile-list',
          onClick: () => setMobileList(!mobileList) }, '技能列表'),
        !selected ? h('div', { className: 'fgw-skills-empty' },
          h('h3', null, '选择一个技能开始管理'),
          h('p', null, '技能说明采用标准 SKILL.md 文本。启用后会同步到独立的飞书 Agent 工作区，仅在新会话中保证生效。'),
          h('button', { type: 'button', className: 'fgw-skills-primary', onClick: () => begin(false) }, '创建技能'))
        : h(React.Fragment, null,
          h('div', { className: 'fgw-skills-document-head' },
            h('div', { className: 'fgw-skills-heading' },
              h('span', null, selected === '__new__' ? (newMode === 'import' ? '导入 SKILL.md' : '创建技能') : '技能说明'),
              h('h2', null, selected === '__new__' ? '新的技能' : selected),
              h('p', null, selected === '__new__' ? '粘贴完整的 SKILL.md，包含 name 和 description。默认停用。' :
                (loaded?.enabled ? '已启用 · ' : '已停用 · ') + '变更在新飞书会话中生效')),
            h('div', { className: 'fgw-skills-actions' },
              loaded && h('button', { type: 'button', disabled: busy, className: 'fgw-skills-danger',
                onClick: remove }, '删除'),
              h('button', { type: 'button', disabled: busy || !dirty || bytes > maxFile || !draft.trim(),
                className: 'fgw-skills-primary', onClick: save }, busy ? '保存中…' : '保存技能'))),
          selected === '__new__' && h('p', { className: 'fgw-skills-create-hint' },
             '开始使用：先修改文档顶部的 name（技能标识）与 description（适用场景），再填写执行步骤。保存后可在左侧开启此技能。'),
           h('div', { className: 'fgw-skills-editor-tabs', role: 'tablist' },
            [['edit', '编辑'], ['preview', '预览']].map(([key, text]) => h('button', { key, type: 'button', role: 'tab',
              'aria-selected': mode === key, className: mode === key ? 'active' : '', onClick: () => setMode(key) }, text))),
          h('div', { className: 'fgw-skills-editor' },
            mode === 'edit'
              ? h(MarkdownCodeEditor, { value: draft, onChange: setDraft, disabled: busy, fileName: 'SKILL.md' })
              : h(ProfilePreview, { value: draft })),
          h('div', { className: 'fgw-skills-document-foot' },
            h('span', null, readable(bytes), ' / ', readable(maxFile), dirty ? ' · 未保存' : ' · 已保存'),
            h('span', null, '仅文本说明，不支持脚本自动安装或执行'))))
  ))
}
