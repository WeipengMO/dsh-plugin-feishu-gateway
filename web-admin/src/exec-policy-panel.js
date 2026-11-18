/* Execution-permission (command/file sandbox) editor.
 * Embedded inside 飞书管理 → 安全与权限. No standalone nav entry. */
const EXEC_MODES_UI = [
  { value: 'read-only', title: '只读', desc: '命令可执行，但不能写任何文件（最安全）' },
  { value: 'workspace-write', title: '工作区可写', desc: '可写工作区与额外目录；超出范围需审批（推荐）' },
  { value: 'danger-full-access', title: '完全访问', desc: '关闭文件沙箱，可读写任意路径（仅高信任时使用）' },
]
const EXEC_APPROVALS_UI = [
  { value: 'ask', label: '需要时审批' },
  { value: 'never', label: '从不审批' },
]
const execModeTitle = v => (EXEC_MODES_UI.find(x => x.value === v) || {}).title || v
const execApprovalTitle = v => (EXEC_APPROVALS_UI.find(x => x.value === v) || {}).label || v

function ExecPolicyPanel({ onDirtyChange }) {
  const [policy, setPolicy] = useState(null)
  const [baseline, setBaseline] = useState(null)
  const [meta, setMeta] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const data = await request('/exec-policy')
      const p = data.policy || {}
      const normalized = {
        mode: EXEC_MODES_UI.some(x => x.value === p.mode) ? p.mode : 'workspace-write',
        approvalPolicy: p.approvalPolicy === 'never' ? 'never' : 'ask',
        additionalWritableRoots: Array.isArray(p.additionalWritableRoots) ? p.additionalWritableRoots.slice() : [],
      }
      setPolicy(normalized)
      setBaseline(JSON.stringify(normalized))
      setMeta(data)
      setError('')
    } catch (e) { setError(e.message || String(e)) }
  }, [])
  useEffect(() => { void load() }, [load])
  const dirty = policy !== null && baseline !== null && JSON.stringify(policy) !== baseline
  useEffect(() => {
    onDirtyChange?.(dirty)
    return () => onDirtyChange?.(false)
  }, [dirty, onDirtyChange])

  if (error && !policy) return h('div', { className: 'fgw-alert', role: 'alert' }, '读取执行权限失败：', error)
  if (!policy) return h('div', { className: 'fgw-caution' }, '正在读取执行权限…')

  const roots = policy.additionalWritableRoots
  const writable = policy.mode === 'workspace-write'
  const setMode = mode => setPolicy(p => ({ ...p, mode }))
  const setApproval = approvalPolicy => setPolicy(p => ({ ...p, approvalPolicy }))
  const setRoot = (i, v) => setPolicy(p => ({ ...p,
    additionalWritableRoots: p.additionalWritableRoots.map((x, j) => j === i ? v : x) }))
  const addRoot = () => setPolicy(p => ({ ...p, additionalWritableRoots: [...p.additionalWritableRoots, ''] }))
  const delRoot = i => setPolicy(p => ({ ...p,
    additionalWritableRoots: p.additionalWritableRoots.filter((_, j) => j !== i) }))

  const persist = async (restart) => {
    if (policy.mode === 'danger-full-access' &&
      !window.confirm('“完全访问”会关闭文件沙箱，Agent 命令可读写任意路径。确认继续？')) return
    if (restart && !window.confirm('保存后将重启飞书通道以使改动生效（会短暂中断飞书收发）。继续？')) return
    setBusy(true); setMessage(''); setError('')
    try {
      const payload = {
        mode: policy.mode,
        approvalPolicy: policy.approvalPolicy,
        additionalWritableRoots: policy.additionalWritableRoots.map(s => String(s).trim()).filter(Boolean),
      }
      await request('/exec-policy', 'POST', payload)
      if (restart) { await request('/restart', 'POST', {}); setMessage('已保存并重启飞书通道，几秒后生效。') }
      else setMessage('已保存；将在下次重启飞书通道后生效。')
      await load()
    } catch (e) { setError(e.message || String(e)) }
    finally { setBusy(false) }
  }

  return h('section', { className: 'fgw-block' },
    h('div', { className: 'fgw-block-head' }, h('h3', null, '执行权限'),
      h('span', { className: 'fgw-muted' },
        meta && meta.source === 'managed' ? '来源：管理后台' : '来源：Profile 配置')),
    h('div', { className: 'fgw-block-body' },
      // Current-state summary chips
      h('div', { className: 'fga-chips' },
        h('span', { className: 'fga-chip' }, '模式 ', h('strong', null, execModeTitle(policy.mode))),
        h('span', { className: 'fga-chip' }, '审批 ', h('strong', null, execApprovalTitle(policy.approvalPolicy))),
        h('span', { className: 'fga-chip' }, '额外可写目录 ', h('strong', null, String(roots.length)))),
      dirty && h('p', { className: 'fgw-dirty-hint', role: 'status' }, '执行权限有未保存的修改。'),
      meta?.restartRequired && h('div', { className: 'fgw-caution' }, '有尚未生效的修改，请重启飞书通道。'),
      message && h('div', { className: 'fga-notice', role: 'status' }, message),
      error && h('div', { className: 'fga-error', role: 'alert' }, error),

      h('p', { className: 'fga-subhead' }, '沙箱模式（命令能写哪些文件）'),
      h('div', { className: 'fga-exec-grid' },
        ...EXEC_MODES_UI.map(opt => h('button', {
          key: opt.value, type: 'button', disabled: busy,
          className: 'fga-mode-card' + (policy.mode === opt.value ? ' is-active' : ''),
          'aria-pressed': policy.mode === opt.value,
          onClick: () => setMode(opt.value),
        },
          h('span', { className: 'fga-mode-card-title' }, h('span', { className: 'fga-mode-dot' }), opt.title),
          h('span', { className: 'fga-mode-card-desc' }, opt.desc)))),
      policy.mode === 'danger-full-access' && h('div', { className: 'fga-warning fga-danger-card' },
        '⚠ 完全访问会关闭文件沙箱：Agent 命令可读写任意路径，仅在你完全信任该会话时使用。'),

      h('p', { className: 'fga-subhead' }, '审批策略（超出沙箱范围时）'),
      h('div', { className: 'fga-seg', role: 'group', 'aria-label': '审批策略' },
        ...EXEC_APPROVALS_UI.map(opt => h('button', {
          key: opt.value, type: 'button', disabled: busy,
          className: 'fga-seg-btn' + (policy.approvalPolicy === opt.value ? ' is-active' : ''),
          'aria-pressed': policy.approvalPolicy === opt.value,
          onClick: () => setApproval(opt.value),
        }, opt.label))),

      h('p', { className: 'fga-subhead' }, '额外可写目录'),
      h('p', { className: 'fga-hint' }, writable
        ? '仅“工作区可写”模式生效；必须是服务器上真实存在的目录，不能是软链接。'
        : '当前模式不使用额外可写目录；切换到“工作区可写”后这些目录才会生效。'),
      h('div', { className: 'fga-roots' },
        roots.length === 0 && h('p', { className: 'fga-hint' }, '暂无额外可写目录。'),
        ...roots.map((r, i) => h('div', { className: 'fga-root-row', key: i },
          textInput(r, v => setRoot(i, v), '/绝对路径，如 /home/ubuntu/.lark-cli'),
          action('删除', () => delRoot(i), busy, true))),
        h('div', { className: 'fga-inline-actions' }, action('新增目录', addRoot, busy, true))),

      h('div', { className: 'fga-savebar' },
        h('span', { className: 'fga-savebar-status' }, '修改对新建会话生效；已在运行的会话保持原权限。'),
        h('div', { className: 'fga-inline-actions' },
          action('保存并重启飞书通道', () => persist(true), busy || !dirty, true),
          action('仅保存', () => persist(false), busy || !dirty)))))
}
