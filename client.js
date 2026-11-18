/**
 * Project Journal (Client half).
 *
 * Three seats:
 *   - sidebar.footer.action  → the entry button
 *   - sidebar.workspaces.session.row.action → per-session "move" button
 *   - shell.overlay          → the full-screen journal panel
 *
 * All data comes from the Host half over /x-journal/api/*.
 */
window.__ModuleLoader__.load({
  id: '@pawsey0319/dsh-project-journal',
  factory(require) {
    const React = require('react')
    let ReactDOM = null
    try { ReactDOM = require('react-dom') } catch { ReactDOM = null }
    const h = React.createElement
    const { useState, useEffect, useMemo, useCallback, useRef } = React

    const ROUTES = ['/x-journal', '/x-journal-b', '/x-journal-c', '/x-journal-d']
    let base = null
    let basePromise = null

    async function ensureBase() {
      if (base !== null) return base
      if (basePromise !== null) return basePromise
      basePromise = (async () => {
        for (const route of ROUTES) {
          try {
            const response = await fetch(`${route}/api/health`)
            if (response.ok) {
              const payload = await response.json()
              if (payload?.ok === true) {
                base = route
                return route
              }
            }
          } catch {}
        }
        basePromise = null
        throw new Error('项目进展服务未就绪')
      })()
      return basePromise
    }

    // 服务端错误码 → 用户可读的中文。内部异常串（例如 "rmSync is not defined"）只留在
    // error.detail / 诊断信标里，不再直接糊到用户脸上。
    const ERROR_TEXT = {
      'project-missing': '项目不存在或已被移除',
      'phase-missing': '阶段不存在或已被删除',
      'session-missing': '会话不存在或已归档',
      'branch-missing': '分支不存在',
      'branch-not-empty': '分支里还有带内容的阶段',
      'branch-not-abandoned': '请先把分支标记为「已放弃」，再删除',
      'branch-not-merged': '分支还没有合并，无法撤销',
      'branch-limit': '分支数量已达上限',
      'branch-empty': '分支里还没有阶段',
      'branch-abandoned': '分支已放弃，先恢复为「进行中」再操作',
      'cannot-delete-main': '主线不能删除',
      'cannot-modify-main': '主线不能改名或改状态',
      'cannot-merge-main': '主线不能合并',
      'cannot-unmerge-main': '主线没有可撤销的合并',
      'need-confirm': '这个操作需要二次确认',
      'bad-request': '请求参数不完整或不合法',
      'bad-action': '不支持的操作',
      'unknown-action': '不支持的操作',
      'bad-file': '文件名不合法',
      'bad-path': '路径不合法',
      'bad-cwd': '项目目录不可用',
      'not-found': '目标不存在',
      'missing': '备份文件不存在',
      'unreadable': '文件无法读取',
      'not-a-journal': '这个文件不是项目进展备份',
      'write-failed': '写入失败，请检查磁盘权限',
      'internal': '服务内部错误，详情已记录到诊断信标',
      'target-missing': '目标项目或分支不存在',
      'target-equal': '源和目标是同一个位置',
      'cross-project': '会话不属于当前项目',
      'workspace-controller-unavailable': '工作区服务不可用，请重启 DSH 后再试',
      'session-controller-unavailable': '会话服务不可用，请重启 DSH 后再试',
      'migration-unavailable': '当前没有可迁移的旧数据',
      'prompt-failed': '读取会话内容失败',
      'archive-failed': '归档会话失败',
      'cancel-failed': '取消操作失败',
      'already-there': '会话已经在该项目里',
      'empty-statement': '问题描述不能为空',
      'busy': '有任务正在运行，请稍后再试',
      'revision-missing': '找不到这一版修订',
      'record-missing': '记录不存在',
      'project-path-missing': '项目目录不存在',
      'not-retryable': '这个会话不在失败状态，不需要重试',
      'confirm-required': '删除需要确认：这是不可撤销的记录操作',
      'reserved-project': '「未归属会话」是内置容器，不能删除',
      'project-has-sessions': '项目里还有会话，先把会话迁走再删记录',
      'project-path-in-workspace': '项目目录仍被工作区里的项目使用，不能删记录',
      'backup-failed': '删除前的备份没写成，已中止（数据未动）',
    }

    // ------------------------------------------------------- 纯函数（可直接单测）
    // 下面三段没有副作用，`test/routes.test.mjs` 的客户端纯函数节直接从本文件抽出源码来跑，
    // 避免「测试里另抄一份实现」的假覆盖（t6 F3）。

    // C5：条件请求头。只有真的拿到过 ETag 才回传 If-None-Match，否则退化成普通 GET。
    function conditionalHeaders(lastEtag) {
      if (typeof lastEtag !== 'string' || lastEtag === '') return {}
      return { 'If-None-Match': lastEtag }
    }

    // C8：300 ms 合并窗口。force 永远放行；窗口内且已经发过请求就合并成一次。
    const REFRESH_WINDOW_MS = 300
    function shouldCoalesceRefresh(lastAt, now, force) {
      if (force === true) return false
      if (typeof lastAt !== 'number' || lastAt <= 0) return false
      if (typeof now !== 'number') return false
      return now - lastAt < REFRESH_WINDOW_MS
    }

    // D4：Esc 分层。函数只返回「该做什么」，调用方负责执行，顺带让层级顺序可被单测锁定。
    const ESC_LAYERS = [
      // 0.5.0：右栏的固定页（设置/回收站/数据卫生）先退回阶段检视，再关面板。
      ['panePage', (value) => typeof value === 'string' && value !== '' && value !== 'phase', { panePage: 'phase' }],
      ['settings', (value) => value === true, { settings: false }],
      ['forkDraft', (value) => value !== null && value !== undefined, { forkDraft: null }],
      ['confirm', (value) => value !== null && value !== undefined, { confirm: null }],
      ['editingPhaseId', (value) => value !== null && value !== undefined, { editingPhaseId: null, editingPhaseProjectId: null }],
      ['editingProblemId', (value) => value !== null && value !== undefined, { editingProblemId: null }],
      ['attachFor', (value) => value !== null && value !== undefined, { attachFor: null }],
      ['phaseDraft', (value) => value !== null && value !== undefined, { phaseDraft: null }],
      ['stepDraft', (value) => value !== null && value !== undefined, { stepDraft: null }],
      ['renameDraft', (value) => value !== null && value !== undefined, { renameDraft: null }],
      ['moveSessionId', (value) => value !== null && value !== undefined, { moveSessionId: null }],
      ['gapsOpen', (value) => value === true, { gapsOpen: false }],
    ]
    function decideEscAction(state, inSearch) {
      if (inSearch === true) {
        // 搜索框里的 Esc 永远不关面板：有词清词，没词只失焦。
        return typeof state?.query === 'string' && state.query !== '' ? { clearSearch: true } : { blurSearch: true }
      }
      for (const [key, hit, patch] of ESC_LAYERS) {
        if (hit(state?.[key]) === true) return { patch }
      }
      return { closePanel: true }
    }

    async function api(path, params) {
      const route = await ensureBase()
      const query = new URLSearchParams()
      for (const [key, value] of Object.entries(params ?? {})) {
        if (value === undefined || value === null || value === '') continue
        query.set(key, String(value))
      }
      const suffix = query.toString() === '' ? '' : `?${query.toString()}`
      // 宿主 webServer 只把 GET 路由到插件 resource（POST 在宿主层就 405），
      // 所以写操作仍走 GET；跨站防护由服务端 Origin/Referer/Sec-Fetch-Site 同源校验兜底（t26 ⑥）。
      const response = await fetch(`${route}${path}${suffix}`)
      // 304/204 没有 body；无条件 response.json() 会把「没变化」变成一条错误横幅。
      let payload = {}
      if (response.status !== 204 && response.status !== 304) {
        const text = await response.text()
        if (text.trim() !== '') {
          try {
            payload = JSON.parse(text)
          } catch {
            payload = {}
          }
        }
      }
      if (!response.ok) {
        const code = typeof payload?.error === 'string' && payload.error !== '' ? payload.error : `http-${response.status}`
        const message = ERROR_TEXT[code] ?? (typeof payload?.error === 'string' && payload.error !== '' ? `操作失败（${payload.error}）` : `请求失败（HTTP ${response.status}）`)
        const error = new Error(message)
        error.code = code
        error.detail = payload?.detail ?? null
        throw error
      }
      return payload
    }

    // ------------------------------------------------------------------ store

    const store = {
      open: false,
      moveSessionId: null,
      migratePickerOf: null,
      selectedProjectId: null,
      // 0.5.0 UI：右栏检视对象与当前页
      selectedPhaseId: null,
      panePage: 'phase',
      insTab: 'detail',
      railQuery: '',
      tlFilter: 'all',
      tlOnlyOpen: false,
      menuOpen: false,
      bannerOpen: false,
      searchAll: false,
      problemDraftPhaseId: null,
      migrateQuery: '',
      migrateTargetId: null,
      data: null,
      loading: false,
      error: null,
      settings: false,
      branchOf: {},
      diffBranchId: null,
      forkDraft: null,
      editingPhaseId: null,
      editingProblemId: null,
      confirm: null,
      attachFor: null,
      phaseDraft: null,
      backups: null,
      query: '',
      stepDraft: null,
      renameDraft: null,
      gufaUnderlay: false,
      list: new Set(),
      // v0.4.0：条件请求与按需面板数据
      lastEtag: null,
      failureDismissed: false,
      revisions: {},
      orphans: null,
      stats: { refresh: 0, notModified: 0, coalesced: 0, failed: 0, lastAt: null },
    }
    const subscribers = new Set()
    function emit() {
      for (const fn of subscribers) fn()
    }
    function setState(patch) {
      Object.assign(store, patch)
      emit()
    }
    function subscribe(fn) {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    }

    // v0.4.0 C：/api/state 支持 ETag。先看状态码：304 = 内容没变，不解析 body、
    // 不把一整份 390 KiB 的 data 重新灌进 React 树。
    async function fetchState() {
      const route = await ensureBase()
      // C5：条件请求。带上上一次 200 返回的 ETag，内容没变服务端就回 304，
      // 客户端连 body 都不读：省的是 390 KiB 的序列化/传输/解析；200 会把新 data 灌进树、
      // 304 只把 stats 写进 store（两者都会触发一次渲染，差在是否替换数据，别夸大）。
      const headers = conditionalHeaders(store.lastEtag)
      const response = await fetch(`${route}/api/state`, { headers, cache: 'no-store' })
      if (response.status === 304) {
        return { notModified: true, etag: response.headers.get('etag') ?? store.lastEtag }
      }
      if (response.status === 204) return { notModified: true, etag: null }
      const text = await response.text()
      let payload = null
      try {
        payload = JSON.parse(text)
      } catch {
        throw new Error(`状态响应不是合法 JSON（HTTP ${response.status}）`)
      }
      if (!response.ok) {
        const code = typeof payload?.error === 'string' && payload.error !== '' ? payload.error : `http-${response.status}`
        const error = new Error(ERROR_TEXT[code] ?? `请求失败（HTTP ${response.status}）`)
        error.code = code
        throw error
      }
      return { notModified: false, etag: response.headers.get('etag'), data: payload }
    }

    let inflight = null
    let lastRequestAt = 0

    /**
     * options: { silent, force }
     *   silent  轮询用：不置 loading（避免整树重渲染），失败也只记 error 不闪加载条
     *   force   动作后强制重拉：跳过 300 ms 合并窗口与懒加载判断（写操作后必须看到新数据）
     * 同一时刻只允许一个请求在飞，避免 5s 轮询与手动刷新互相盖结果。
     */
    async function refresh(options) {
      const opts = options === true ? { silent: true } : (options ?? {})
      const silent = opts.silent === true
      const force = opts.force === true
      if (inflight !== null) {
        // 已经有请求在飞：普通刷新直接复用；动作后的强制刷新先等它落地，再发一次，
        // 否则刚写入的改动会被「在飞的那次（旧快照）」盖回去，要等下一个 5s 才出现。
        if (!force) return inflight
        try { await inflight } catch { /* 在飞那次失败也无所谓，下面会重新拉 */ }
      }
      // C8：双击/连点在 300 ms 内只发一次。in-flight 去重挡不住「第一次已经回来、
      // 第二次在 11 ms 后发出」的真实双击，所以再加一个 leading-edge 合并窗口。
      if (shouldCoalesceRefresh(lastRequestAt, Date.now(), force) === true) {
        const merged = { ...store.stats, coalesced: store.stats.coalesced + 1, lastAt: Date.now() }
        setState({ stats: merged })
        return store.data
      }
      if (!silent) setState({ loading: true, error: null })
      else if (store.error !== null) setState({ error: null })
      lastRequestAt = Date.now()
      inflight = (async () => {
        const nextStats = { ...store.stats, refresh: store.stats.refresh + 1 }
        try {
          const result = await fetchState()
          if (result.notModified === true) {
            nextStats.notModified += 1
            nextStats.lastAt = Date.now()
            setState({ loading: false, stats: nextStats })
            return store.data
          }
          nextStats.lastAt = Date.now()
          setState({ data: result.data, loading: false, error: null, lastEtag: result.etag, stats: nextStats })
          return result.data
        } catch (error) {
          nextStats.failed += 1
          nextStats.lastAt = Date.now()
          const message = String(error?.message ?? error)
          // 静默刷新失败不打断正在编辑的人：保留旧数据，只把错误放进横幅。
          setState({ loading: false, error: message, stats: nextStats, ...(force ? { data: store.data } : {}) })
          return store.data
        } finally {
          inflight = null
        }
      })()
      return inflight
    }

    function beacon(message) {
      const route = base ?? ROUTES[0]
      fetch(`${route}/api/beacon?e=${encodeURIComponent('ui:' + message)}`).catch(() => {})
    }

    function askConfirm(text, run) {
      setState({ confirm: { text, run } })
    }

    /**
     * 面板内每个可点控件的统一入口。
     *
     * 除了执行动作本身，还做两件事：
     *   1) 打一条 `ui:<action>` 诊断信标——验收/排障时可直接在 /x-journal/api/state 的
     *      beacons 里看到「这个控件真的被点到了」，不用猜点击是否被别的插件接走。
     *   2) 把同步/异步异常收敛成面板内的错误提示。异常不冒到 document，就不会触发其它
     *      插件挂在 document/window 上的全局点击处理（古法那类「点哪都进自己页面」的来源）。
     */
    function act(name, run) {
      return function onAct(event) {
        try {
          beacon(name)
          const result = typeof run === 'function' ? run(event) : undefined
          if (result !== null && typeof result === 'object' && typeof result.catch === 'function') {
            result.catch((error) => setState({ error: `操作失败：${String(error?.message ?? error).slice(0, 120)}` }))
          }
          return result
        } catch (error) {
          setState({ error: `操作失败：${String(error?.message ?? error).slice(0, 120)}` })
          return undefined
        }
      }
    }

    // 面板根节点只负责阻断冒泡（避免宿主/其它插件挂在 document 上的全局点击处理接走点击），
    // 它不是交互动作，所以不打信标；真正的控件点击都走 act()。
    // 编辑中/确认中不自动刷新：否则 5 秒一次的 setState 会把正在输入的草稿顶掉。
    function pollingLocked() {
      return [store.editingPhaseId, store.editingProblemId, store.phaseDraft, store.stepDraft, store.renameDraft, store.forkDraft, store.confirm, store.attachFor, store.moveSessionId].some((value) => value !== null && value !== undefined)
    }

    async function retrySummarize(sessionId) {
      await api('/api/summarize', { sessionId, retry: 1 })
      setState({ notice: '已重新排队，这次会重新尝试总结' })
      await refresh({ force: true })
    }

    function stopClickBubble(event) {
      event.stopPropagation()
    }

    // 古法编程的覆盖层只在它自己的 mode=1 时挂载；有它就是「面板下面压着古法 IDE」。
    function gufaOverlayActive() {
      try {
        return document.querySelector('.gufa-overlay-root') !== null
      } catch (error) {
        return false
      }
    }

    function openPanel(patch) {
      try {
        beacon('panel-open')
        const gufa = gufaOverlayActive()
        setState({ open: true, error: null, notice: null, failureDismissed: false, gufaUnderlay: gufa, ...(patch ?? {}) })
        if (gufa) beacon('panel-over-gufa')
        refresh()
      } catch (error) {
        setState({ error: `打开面板失败：${String(error?.message ?? error).slice(0, 120)}` })
      }
    }
    function closePanel() {
      beacon('panel-close')
      setState({ open: false, moveSessionId: null, forkDraft: null, editingPhaseId: null, editingProblemId: null, diffBranchId: null, gufaUnderlay: false })
    }

    function useStore() {
      const [, force] = useState(0)
      useEffect(() => {
        const unsubscribe = subscribe(() => force((value) => value + 1))
        return unsubscribe
      }, [])
    }

    // ----------------------------------------------------------------- styles

    const CSS = `
.pj-root{
  /* v0.4.0 语义 token 层：规则体只认 --pj-*，深/浅色只在这一层分叉。
     fallback 用系统色关键字，避免宿主没定义别名时退回「写死的深色」。 */
  --pj-text:var(--dsw-alias-label-primary,CanvasText);
  --pj-text-secondary:var(--dsw-alias-label-secondary,CanvasText);
  --pj-text-tertiary:var(--dsw-alias-label-tertiary,GrayText);
  --pj-border:var(--dsw-alias-border-l,GrayText);
  --pj-border-l1:var(--dsw-alias-border-l1,GrayText);
  --pj-border-strong:var(--dsw-alias-border-l2,GrayText);
  --pj-surface:var(--dsw-alias-bg-base,Canvas);
  --pj-surface-raise:var(--dsw-alias-bg-layer-1,Canvas);
  --pj-surface-sunken:var(--dsw-alias-bg-l1,Canvas);
  --pj-surface-sunken-2:var(--dsw-alias-bg-l2,Canvas);
  --pj-surface-platform:var(--dsw-alias-bg-module-platform,ButtonFace);
  --pj-hover:var(--dsw-alias-interactive-bg-hover,ButtonFace);
  --pj-accent:var(--dsw-alias-brand-primary,LinkText);
  --pj-warn:var(--dsw-alias-state-warn-primary,Mark);
  --pj-success:var(--dsw-alias-state-success-primary,ButtonText);
  --pj-danger:var(--dsw-alias-state-error-primary,ButtonText);
  --pj-label-warning:var(--dsw-alias-warning,Mark);
  --pj-on-accent:var(--dsw-alias-label-on-brand,ButtonText);
  --pj-on-warn:ButtonText;
}
.pj-root{position:fixed;inset:0;z-index:2147483640;pointer-events:auto;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5)}
.pj-panel{width:min(1180px,94vw);height:min(780px,90vh);display:flex;flex-direction:column;border-radius:14px;overflow:hidden;background:var(--pj-surface);color:var(--pj-text);border:1px solid var(--pj-border);box-shadow:0 24px 80px rgba(0,0,0,.55);font-size:13px}
.pj-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--pj-border)}
.pj-title{font-size:14px;font-weight:600}
.pj-sub{color:var(--pj-text-tertiary);font-size:12px}
.pj-spacer{flex:1}
.pj-btn{appearance:none;border:1px solid var(--pj-border);background:var(--pj-hover);color:inherit;border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer;line-height:1.4}
.pj-btn:hover{background:var(--pj-surface-raise)}
.pj-btn.primary{background:var(--pj-accent);border-color:transparent;color:var(--pj-on-accent)}
.pj-btn.ghost{background:transparent}
.pj-btn:disabled{opacity:.5;cursor:default}
.pj-body{flex:1;display:flex;min-height:0}
.pj-left{width:250px;border-right:1px solid var(--pj-border);overflow:auto;padding:8px}
.pj-proj{padding:9px 10px;border-radius:9px;cursor:pointer;margin-bottom:4px;border:1px solid transparent}
.pj-proj:hover{background:var(--pj-hover)}
.pj-proj.active{background:var(--pj-surface-raise);border-color:var(--pj-border)}
.pj-proj.picked{border-color:var(--pj-warn);background:color-mix(in srgb,var(--pj-warn) 12%,transparent)}
.pj-proj-title{font-weight:600;font-size:12.5px;display:flex;align-items:center;gap:6px}
.pj-proj-next{color:var(--pj-accent)}
.pj-proj-meta{color:var(--pj-text-tertiary);font-size:11px;margin-top:3px;display:flex;gap:8px;flex-wrap:wrap}
.pj-dot{width:6px;height:6px;border-radius:50%;background:var(--pj-warn);display:inline-block}
.pj-main{flex:1;overflow:auto;padding:16px 20px}
.pj-empty{color:var(--pj-text-tertiary);font-size:12.5px;padding:24px 4px;line-height:1.7}
.pj-chain{position:relative;margin-left:6px;padding-left:20px;border-left:1px dashed var(--pj-border)}
.pj-phase{position:relative;margin-bottom:14px;padding:12px 14px;border-radius:11px;background:var(--pj-surface-raise);border:1px solid var(--pj-border)}
.pj-phase::before{content:'';position:absolute;left:-26px;top:18px;width:9px;height:9px;border-radius:50%;background:var(--pj-text-tertiary);border:2px solid var(--pj-surface)}
.pj-phase.active::before{background:var(--pj-warn)}
.pj-phase.done::before{background:var(--pj-success)}
.pj-phase-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pj-seq{font-size:11px;color:var(--pj-text-tertiary);font-variant-numeric:tabular-nums}
.pj-phase-title{font-weight:600;font-size:13.5px}
.pj-chip{font-size:10.5px;padding:1px 7px;border-radius:999px;border:1px solid var(--pj-border);color:var(--pj-text-secondary)}
.pj-chip.active{color:var(--pj-warn);border-color:color-mix(in srgb,var(--pj-warn) 50%,transparent)}
.pj-chip.done{color:var(--pj-success);border-color:color-mix(in srgb,var(--pj-success) 50%,transparent)}
.pj-chip.current{color:var(--pj-text);border-color:var(--pj-border-strong);font-weight:600}
.pj-meta-line{margin-top:4px;font-size:11px;color:var(--pj-text-tertiary)}
.pj-phase-summary{margin-top:7px;line-height:1.75;color:var(--pj-text-secondary);white-space:pre-wrap}
.pj-problems{margin-top:9px;display:flex;flex-direction:column;gap:7px}
.pj-problem{border-left:2px solid var(--pj-warn);padding:2px 0 2px 9px}
.pj-problem.open{border-left-color:var(--pj-danger)}
.pj-problem-st{font-size:12.5px;line-height:1.6}
.pj-quote{font-size:11.5px;color:var(--pj-text-tertiary);margin-top:3px;font-style:italic;line-height:1.6}
.pj-res{font-size:12px;color:var(--pj-text-secondary);margin-top:3px;line-height:1.6}
.pj-artifacts{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap}
.pj-art-btn{cursor:pointer;border:1px solid var(--pj-border-l1);background:var(--pj-surface-sunken-2);font:inherit}
.pj-art-btn:hover{border-color:var(--pj-accent);color:var(--pj-accent)}
.pj-search{width:180px;height:26px;margin-left:8px;font-size:12px}
.pj-hits{display:flex;flex-direction:column;gap:8px}
.pj-hit{padding:9px 11px;border-radius:9px;border:1px solid var(--pj-border-l1);background:var(--pj-surface-sunken);cursor:pointer}
.pj-hit:hover{border-color:var(--pj-accent)}
.pj-hit-top{display:flex;gap:8px;align-items:center;margin-bottom:3px}
.pj-hit-title{font-size:12.5px;font-weight:600;color:var(--pj-text)}
.pj-hit-text{margin-top:5px;font-size:11.5px;line-height:1.55;color:var(--pj-text-secondary);white-space:pre-wrap}
.pj-suggest{margin:0 0 10px;padding:9px 11px;border-radius:9px;background:var(--pj-surface-sunken-2);border:1px solid var(--pj-label-warning)}
.pj-suggest-h{font-size:11.5px;font-weight:600;color:var(--pj-label-warning);margin-bottom:5px}
.pj-suggest-row{display:flex;gap:8px;align-items:center;justify-content:space-between;font-size:11.5px;color:var(--pj-text-secondary);padding:2px 0}
.pj-suggest-text{flex:1;word-break:break-all}
.pj-nextbar{margin:0 0 10px;padding:9px 11px;border-radius:9px;background:linear-gradient(180deg,var(--pj-surface-sunken-2),var(--pj-surface-sunken));border:1px solid var(--pj-border-l1)}
.pj-nextbar-h{font-size:11.5px;font-weight:600;color:var(--pj-text);margin-bottom:5px}
.pj-next{margin-top:9px;padding:7px 9px;border-radius:8px;background:var(--pj-surface-sunken-2);border:1px solid var(--pj-border-l1)}
.pj-next-h{font-size:11px;color:var(--pj-text-tertiary);margin-bottom:4px}
.pj-next-item{display:flex;align-items:flex-start;gap:6px;font-size:12px;line-height:1.55;color:var(--pj-text-secondary)}
.pj-next-dot{color:var(--pj-accent)}
.pj-next-text{flex:1;word-break:break-word}
.pj-next-x{padding:0 4px;font-size:11px;line-height:1.2;opacity:.55}
.pj-next-x:hover{opacity:1}
.pj-art{font-size:11px;padding:1px 6px;border-radius:5px;background:var(--pj-surface-platform);color:var(--pj-text-tertiary);font-family:ui-monospace,monospace}
.pj-art-missing{opacity:.5;text-decoration:line-through;border:1px dashed var(--pj-warn)}
.pj-art-prune{font-size:10.5px;margin-left:4px}
.pj-warn{color:var(--pj-warn)}
.pj-failures{margin-top:6px}
.pj-gaps{margin:6px 10px 0;font-size:11.5px;line-height:1.7}
.pj-gap-head{font-weight:600;margin-bottom:2px}
.pj-gap-list{max-height:160px;overflow:auto}
.pj-gap-row{display:flex;gap:8px;justify-content:space-between;border-bottom:1px dashed color-mix(in srgb,var(--pj-text) 8%,transparent);padding:1px 0}
.pj-gap-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px}
.pj-inferred{margin-top:6px;border-top:1px dashed color-mix(in srgb,var(--pj-text) 10%,transparent);padding-top:4px}
.pj-inferred-head{font-size:11px}
.pj-inferred-list{margin-top:4px;opacity:.8}
.pj-problem.inferred{border-left-color:var(--pj-text-tertiary)}
.pj-phase-actions{display:flex;gap:6px;margin-top:9px;opacity:.85}
.pj-input,.pj-area{width:100%;box-sizing:border-box;background:var(--pj-surface);color:inherit;border:1px solid var(--pj-border);border-radius:7px;padding:6px 8px;font-size:12.5px;font-family:inherit;line-height:1.55}
.pj-area{resize:vertical;min-height:64px}
.pj-form{display:flex;flex-direction:column;gap:7px;margin-top:9px}
.pj-row{display:flex;gap:7px;align-items:center}
.pj-banner{padding:8px 16px;background:color-mix(in srgb,var(--pj-warn) 14%,transparent);border-bottom:1px solid color-mix(in srgb,var(--pj-warn) 35%,transparent);font-size:12.5px;display:flex;gap:10px;align-items:center}
.pj-trash{margin-top:14px;border-top:1px dashed var(--pj-border-strong);padding-top:8px}
.pj-trash-toggle{background:transparent;border:0;color:var(--pj-text-secondary);font-size:11.5px;cursor:pointer;padding:2px 0}
.pj-trash-row{display:flex;gap:8px;align-items:center;padding:4px 0;font-size:11.5px;color:var(--pj-text-secondary)}
.pj-trash-title{color:var(--pj-text)}
.pj-revs{margin-top:10px;border-top:1px solid var(--pj-border-strong);padding-top:8px;max-height:230px;overflow:auto}
.pj-rev{border:1px solid var(--pj-border-strong);border-radius:8px;padding:6px 8px;margin-bottom:6px}
.pj-rev-head{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.pj-rev-time{font-size:11px;color:var(--pj-text-tertiary)}
.pj-rev-body{font-size:12px;color:var(--pj-text-secondary);margin-top:4px;line-height:1.5}
.pj-filters{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:8px 0}
.pj-filter{cursor:pointer;border:1px solid var(--pj-border-l1);background:transparent}
.pj-filter.on{border-color:var(--pj-accent);color:var(--pj-accent)}
.pj-note{font-size:11px;color:var(--pj-text-tertiary);margin-left:8px}
.pj-notice{padding:8px 16px;background:color-mix(in srgb,var(--pj-success) 14%,transparent);color:var(--pj-success);font-size:12px;display:flex;gap:12px;align-items:center;justify-content:space-between}
.pj-error{padding:8px 16px;background:color-mix(in srgb,var(--pj-danger) 14%,transparent);color:var(--pj-danger);font-size:12px}
.pj-foot{padding:7px 16px;border-top:1px solid var(--pj-border);color:var(--pj-text-tertiary);font-size:11px;display:flex;gap:14px;flex-wrap:wrap;align-items:center}
.pj-confirmbar{position:absolute;left:12px;right:12px;bottom:10px;padding:9px 11px;border-radius:10px;background:var(--pj-surface-raise);border:1px solid var(--pj-accent);display:flex;align-items:center;gap:9px;z-index:6;font-size:12px;box-shadow:0 12px 36px rgba(0,0,0,.45)}
.pj-settings{position:absolute;right:18px;top:56px;width:340px;background:var(--pj-surface);border:1px solid var(--pj-border);border-radius:11px;padding:14px;box-shadow:0 16px 40px rgba(0,0,0,.5);z-index:5;display:flex;flex-direction:column;gap:9px}
.pj-label{font-size:11px;color:var(--pj-text-tertiary);margin-bottom:-4px}
.pj-icon{width:16px;height:16px;display:block}
.pj-entry{appearance:none;border:1px solid transparent;background:transparent;color:var(--pj-text-secondary);border-radius:8px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:4px 7px;font-size:12px;line-height:1}
.pj-entry:hover{background:var(--pj-hover);color:var(--pj-text)}
.pj-rowbtn{appearance:none;border:none;background:transparent;color:var(--pj-text-tertiary);border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0}
.pj-rowbtn:hover{background:var(--pj-hover);color:var(--pj-text)}
.pj-tabs{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:12px;border-bottom:1px solid var(--pj-border);padding-bottom:9px}
.pj-tab{appearance:none;display:inline-flex;align-items:center;gap:6px;border:1px solid var(--pj-border);background:transparent;color:var(--pj-text-secondary);border-radius:8px;padding:4px 9px;font-size:12px;cursor:pointer;line-height:1.5}
.pj-tab:hover{background:var(--pj-hover)}
.pj-tab.active{background:var(--pj-surface-raise);border-color:var(--pj-accent);color:var(--pj-text)}
.pj-tab.abandoned{opacity:.55}
.pj-tabsrc{font-size:10.5px;color:var(--pj-text-tertiary)}
.pj-tabcount{font-size:10px;min-width:14px;height:14px;border-radius:999px;background:var(--pj-surface-platform);color:var(--pj-text-tertiary);display:inline-flex;align-items:center;justify-content:center;padding:0 4px}
.pj-phase.prefix{opacity:.5;background:transparent;border-style:dashed}
.pj-phase.prefix::before{background:var(--pj-text-tertiary)}
.pj-prefix-note{font-size:11px;color:var(--pj-text-tertiary);margin-bottom:6px}
.pj-sessions{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.pj-chip.session{cursor:pointer;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pj-chip.redo{color:var(--pj-warn);border-color:color-mix(in srgb,var(--pj-warn) 50%,transparent)}
.pj-chip.abandoned{color:var(--pj-text-tertiary)}
.pj-backups{display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto;margin-top:4px}
.pj-backup-row{display:flex;gap:8px;align-items:center;padding:6px 8px;border:1px solid var(--pj-border);border-radius:8px}
.pj-modal{position:absolute;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:8}
.pj-modal-box{width:min(560px,86vw);background:var(--pj-surface);border:1px solid var(--pj-border);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px;box-shadow:0 20px 60px rgba(0,0,0,.6)}
.pj-branchbar{display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap}
.pj-gap-inline{background:none;border:0;padding:0;cursor:pointer;font:inherit;text-align:left;max-width:46vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pj-inferred-note{font-size:10px;opacity:.75;margin-right:4px}
.pj-badge{font-size:10px;min-width:15px;height:15px;padding:0 4px;border-radius:999px;background:var(--pj-warn);color:var(--pj-on-warn);display:inline-flex;align-items:center;justify-content:center;font-weight:600}
/* ---------- 0.5.0 三栏：左项目 / 中时间线 / 右检视 ---------- */
.pj-panel2{width:min(1360px,96vw);height:min(880px,92vh);display:flex;flex-direction:column;border-radius:14px;overflow:hidden;background:var(--pj-surface);color:var(--pj-text);border:1px solid var(--pj-border);box-shadow:0 24px 80px rgba(0,0,0,.55);font-size:13px}
.pj-top{flex:0 0 54px;display:flex;align-items:center;gap:9px;padding:0 13px;border-bottom:1px solid var(--pj-border)}
.pj-top-title{font-size:15px;font-weight:600;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pj-top-tabs{display:flex;gap:4px;align-items:center;overflow:hidden}
.pj-top-tab{appearance:none;height:26px;padding:0 10px;border-radius:999px;border:1px solid transparent;background:transparent;color:var(--pj-text-secondary);cursor:pointer;font-size:12px;white-space:nowrap}
.pj-top-tab:hover{background:var(--pj-hover);color:var(--pj-text)}
.pj-top-tab.on{border-color:var(--pj-border-l1);background:var(--pj-surface-raise);color:var(--pj-text)}
.pj-top-search{width:190px;height:28px;border-radius:8px;border:1px solid var(--pj-border-l1);background:var(--pj-surface-platform);color:var(--pj-text);padding:0 9px;font-size:12px;outline:none}
.pj-top-search:focus{border-color:var(--pj-accent)}
.pj-top-status{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--pj-text-tertiary);cursor:default}
.pj-top-dot{width:7px;height:7px;border-radius:50%;background:var(--pj-success)}
.pj-grid{flex:1;min-height:0;display:grid;grid-template-columns:224px minmax(0,1fr) 360px}
.pj-rail{border-right:1px solid var(--pj-border);display:flex;flex-direction:column;min-height:0}
.pj-litem{appearance:none;border:0;background:transparent;color:var(--pj-text-secondary);font-size:12px;padding:6px 8px;border-radius:7px;cursor:pointer;display:flex;align-items:center;gap:7px}
.pj-litem:hover{background:var(--pj-hover);color:var(--pj-text)}
.pj-rt{color:var(--pj-text);letter-spacing:.01em}
.pj-rail-search{margin:9px 9px 5px}
.pj-rail-search input{width:100%;height:28px;border-radius:7px;border:1px solid var(--pj-border-l1);background:var(--pj-surface-platform);color:var(--pj-text);padding:0 9px;font-size:12px;outline:none}
.pj-rail-list{flex:1;overflow:auto;padding:0 7px}
.pj-rail-row{position:relative;display:block;width:100%;text-align:left;border:0;background:transparent;color:var(--pj-text);padding:8px 9px 8px 11px;border-radius:8px;cursor:pointer;margin-bottom:1px}
.pj-rail-row:hover{background:var(--pj-hover)}
.pj-rail-row.on{background:var(--pj-surface-raise)}
.pj-rail-row.on::before{content:"";position:absolute;left:0;top:7px;bottom:7px;width:2px;border-radius:2px;background:var(--pj-accent)}
.pj-rail-t{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pj-rail-m{display:flex;gap:7px;align-items:center;color:var(--pj-text-tertiary);font-size:11px;margin-top:1px}
.pj-rail-warn{color:var(--pj-warn)}
.pj-rail-foot{border-top:1px solid var(--pj-border);padding:5px 7px;display:flex;flex-direction:column;gap:1px}
.pj-tl{display:flex;flex-direction:column;min-height:0}
.pj-tl-scroll{flex:1;overflow:auto;padding:12px 16px 22px}
.pj-tl-fold{display:flex;align-items:center;gap:8px;color:var(--pj-text-tertiary);font-size:11.5px;padding:2px 0 12px 24px}
.pj-tl-fold i{height:1px;flex:1;background:var(--pj-border);display:block}
.pj-tl-node{position:relative;padding-left:24px;margin-bottom:6px}
.pj-tl-node::before{content:"";position:absolute;left:6px;top:0;bottom:-6px;width:2px;background:var(--pj-border)}
.pj-tl-node:last-child::before{bottom:50%}
.pj-tl-knob{position:absolute;left:1px;top:14px;width:12px;height:12px;border-radius:50%;background:var(--pj-surface);border:2px solid var(--pj-border-strong);z-index:1}
.pj-tl-node.on .pj-tl-knob{border-color:var(--pj-accent);background:var(--pj-accent)}
.pj-tl-node.done .pj-tl-knob{border-color:var(--pj-success)}
.pj-tl-card{border:1px solid var(--pj-border-l1);background:var(--pj-surface-raise);border-radius:10px;padding:9px 11px;cursor:pointer}
.pj-tl-card:hover{border-color:var(--pj-border-strong)}
.pj-tl-node.on .pj-tl-card{border-color:var(--pj-accent)}
.pj-tl-h{display:flex;align-items:center;gap:7px;min-width:0}
.pj-tl-idx{color:var(--pj-text-tertiary);font-size:11px;font-variant-numeric:tabular-nums;width:16px;flex:0 0 16px}
.pj-tl-title{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pj-tl-sum{color:var(--pj-text-secondary);font-size:11.5px;margin-top:3px;padding-left:23px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pj-tl-badges{display:flex;gap:5px;flex-wrap:wrap;padding-left:23px;margin-top:5px}
.pj-tl-badge{font-size:10.5px;color:var(--pj-text-tertiary);border:1px solid var(--pj-border);border-radius:6px;padding:0 5px}
.pj-tl-badge.warn{color:var(--pj-warn);border-color:color-mix(in srgb,var(--pj-warn) 45%,transparent)}
.pj-ins{border-left:1px solid var(--pj-border);display:flex;flex-direction:column;min-height:0}
.pj-ins-head{flex:0 0 42px;display:flex;align-items:center;gap:7px;padding:0 11px;border-bottom:1px solid var(--pj-border)}
.pj-ins-tabs{display:flex;gap:1px;padding:5px 7px 0;border-bottom:1px solid var(--pj-border);overflow:auto}
.pj-ins-tab{appearance:none;border:0;background:transparent;color:var(--pj-text-tertiary);font-size:12px;padding:6px 7px;border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap}
.pj-ins-tab.on{color:var(--pj-text);border-color:var(--pj-accent)}
.pj-ins-body{flex:1;overflow:auto;padding:11px 12px}
.pj-ins-foot{flex:0 0 50px;border-top:1px solid var(--pj-border);display:flex;gap:6px;align-items:center;padding:0 11px}
.pj-bannerbar{padding:0 12px}
.pj-bannerbar .pj-banner{margin:8px 0 0}
.pj-banner-more{margin-left:auto;border:0;background:transparent;color:inherit;cursor:pointer;font-size:11px;text-decoration:underline}
.pj-banner-list{margin:6px 0 0;padding:8px 10px;border:1px solid var(--pj-border);border-radius:8px;background:var(--pj-surface-raise);font-size:11.5px;color:var(--pj-text-secondary);display:flex;flex-direction:column;gap:5px}
.pj-toasts{position:fixed;right:22px;bottom:22px;display:flex;flex-direction:column;gap:6px;z-index:2147483646}
.pj-toast{background:var(--pj-surface-raise);border:1px solid var(--pj-accent);color:var(--pj-text);padding:8px 11px;border-radius:9px;font-size:12px;box-shadow:0 12px 36px rgba(0,0,0,.5);max-width:360px}
.pj-kv{display:flex;gap:7px;color:var(--pj-text-tertiary);font-size:11px;margin-bottom:9px;flex-wrap:wrap;align-items:center}
.pj-sec{margin-bottom:13px}
.pj-sec-h{font-size:11px;color:var(--pj-text-tertiary);font-weight:600;margin-bottom:5px}
.pj-empty2{color:var(--pj-text-tertiary);font-size:12px;padding:8px 0}
.pj-item{border:1px solid var(--pj-border-l1);border-radius:8px;padding:7px 8px;margin-bottom:5px;background:var(--pj-surface-platform)}
.pj-item-t{font-size:12.5px}
.pj-item-s{color:var(--pj-text-secondary);font-size:11.5px;margin-top:3px}
`

    function ensureStyle() {
      if (document.getElementById('pj-style') !== null) return
      const style = document.createElement('style')
      style.id = 'pj-style'
      style.textContent = CSS
      document.head.appendChild(style)
    }

    const Icon = ({ size = 16 }) =>
      h(
        'svg',
        { className: 'pj-icon', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M4 5.5h10M4 12h7M4 18.5h13' }),
        h('circle', { cx: 18.5, cy: 5.5, r: 1.6 }),
        h('circle', { cx: 14.5, cy: 12, r: 1.6 }),
        h('circle', { cx: 20.5, cy: 18.5, r: 1.6 }),
      )

    const MoveIcon = () =>
      h(
        'svg',
        { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M12 3v12' }),
        h('path', { d: 'm7 10 5 5 5-5' }),
        h('path', { d: 'M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2' }),
      )

    function timeText(value) {
      if (typeof value !== 'string' || value === '') return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    }

    function currentPhase(project) {
      const branchId = typeof project.activeBranchId === 'string' ? project.activeBranchId : 'main'
      const branch = (project.branches ?? []).find((item) => item.id === branchId)
      const phases = (project.phases ?? []).filter((phase) => (phase.branchId ?? 'main') === (branch?.status === 'active' ? branchId : 'main'))
      const ordered = phases.slice().sort((left, right) => left.seq - right.seq)
      return ordered.length === 0 ? null : ordered[ordered.length - 1]
    }

    // 0.5.0 UI：一条分支在界面上的阶段序列 = 主线前缀（只读）+ 本分支自有阶段。
    function projectChain(project, branchId) {
      const branches = Array.isArray(project?.branches) ? project.branches : []
      const main = { id: 'main', title: '主线', status: 'active', fromSeq: null }
      const branch = branches.find((item) => item.id === branchId) ?? branches.find((item) => item.id === 'main') ?? main
      const all = Array.isArray(project?.phases) ? project.phases : []
      const mainPhases = all.filter((phase) => (phase.branchId ?? 'main') === 'main')
      const own = branch.id === 'main' ? mainPhases : all.filter((phase) => phase.branchId === branch.id)
      const cut = typeof branch.fromSeq === 'number' ? branch.fromSeq : 0
      const prefix = branch.id === 'main' ? [] : mainPhases.filter((phase) => phase.seq < cut).map((phase) => ({ ...phase, prefix: true }))
      const chain = [...prefix, ...own]
      return { branch, prefix, own, chain }
    }

    function nextCount(project) {
      const phase = currentPhase(project)
      if (phase === null || phase.prefix === true) return 0
      return Array.isArray(phase.nextSteps) ? phase.nextSteps.length : 0
    }

    // t26 ②：只有带原话的问题才算「有证据」，没有原话的降级为推测，不计入未解决。
    function confidenceOf(problem) {
      if (problem?.confidence === 'evidenced' || problem?.confidence === 'inferred') return problem.confidence
      return typeof problem?.quote === 'string' && problem.quote.trim() !== '' ? 'evidenced' : 'inferred'
    }

    function evidencedProblems(phase) {
      return (phase.problems ?? []).filter((problem) => confidenceOf(problem) === 'evidenced')
    }

    function inferredProblems(phase) {
      return (phase.problems ?? []).filter((problem) => confidenceOf(problem) === 'inferred')
    }

    function problemOpenCount(project) {
      let count = 0
      for (const phase of project.phases) {
        for (const problem of evidencedProblems(phase)) if (problem.status === 'open') count += 1
      }
      return count
    }

    function inferredOpenCount(project) {
      let count = 0
      for (const phase of project.phases) for (const problem of inferredProblems(phase)) if (problem.status === 'open') count += 1
      return count
    }

    // J-02（t28）：头部直接点名待汇总会话（标题优先、无标题用 sessionId 末 8 位），超过 3 个折叠。
    function gapSummaryText(summary) {
      const gaps = Array.isArray(summary?.gaps) ? summary.gaps : []
      const pending = summary?.pending ?? gaps.length
      const label = (row) => {
        const title = typeof row?.title === 'string' && row.title.trim() !== '' ? row.title.trim() : ''
        const short = String(row?.sessionId ?? '').slice(-8)
        return title !== '' && title !== '未命名会话' ? title : `未命名会话·${short}`
      }
      const shown = gaps.slice(0, 3).map(label)
      const rest = pending - shown.length
      const head = `待汇总 ${pending}`
      if (shown.length === 0) return head
      return `${head}：${shown.join(' / ')}${rest > 0 ? ` 另有 ${rest} 个` : ''}`
    }

    function modelLabel(data) {
      const model = data?.model ?? null
      if (model === null) return '模型未知'
      const name = model.model ?? model.provider ?? '模型'
      if (model.providerState === 'ok') return `模型 ${name}`
      if (model.providerState === 'unreachable') return `模型不可达（provider:unreachable）`
      if (model.providerState === 'unverified') return `模型 ${name}（未探活）`
      if (model.error) return `模型不可用：${String(model.error).slice(0, 40)}`
      return '模型未探活'
    }

    // ------------------------------------------------------------ entry seats

    function FooterButton(props) {
      useStore()
      ensureStyle()
      const data = store.data
      // J-01（t28）：未解决统一读服务端同一字段 `evidence.problems.open`（evidenced 口径），
      // 推测读 `openInferred`；服务端没给（旧宿主）才回落到本地同口径计算。
      const evidenceProblems = data?.evidence?.problems
      const open = Number.isFinite(evidenceProblems?.open) ? evidenceProblems.open : (data?.projects ?? []).reduce((total, project) => total + problemOpenCount(project), 0)
      const inferred = Number.isFinite(evidenceProblems?.openInferred) ? evidenceProblems.openInferred : (data?.projects ?? []).reduce((total, project) => total + inferredOpenCount(project), 0)
      const nextTotal = (data?.projects ?? []).reduce((total, project) => total + nextCount(project), 0)
      const running = data?.backfill?.state === 'running'
      const inferredNote = inferred > 0 ? `（另有推测 ${inferred} 条，无原话，不计入未解决）` : ''
      return h(
        'button',
        {
          className: 'pj-entry',
          type: 'button',
          title: `${open} 个未解决问题${inferredNote} · ${nextTotal} 条下一步`,
          onClick: act('entry-click', () => openPanel()),
        },
        h(Icon),
        props.wide === true ? h('span', null, '进展') : null,
        open > 0 && props.wide === true && inferred > 0 ? h('span', { className: 'pj-sub pj-inferred-note', title: '无原话的条目按推测处理，不计入未解决；点开面板可看折叠区' }, `含推测 ${inferred}`) : null,
        open > 0 ? h('span', { className: 'pj-badge' }, String(open)) : nextTotal > 0 ? h('span', { className: 'pj-badge', style: { background: 'var(--pj-success)', color: 'var(--pj-on-accent)' } }, String(nextTotal)) : running ? h('span', { className: 'pj-badge', style: { background: 'var(--pj-accent)', color: 'var(--pj-on-accent)' } }, '…') : null,
      )
    }

    function RowButton(props) {
      useStore()
      ensureStyle()
      return h(
        'button',
        {
          className: 'pj-rowbtn',
          type: 'button',
          title: `移入其他项目 · ${props.displayTitle ?? ''}`,
          onClick: act('migrate-start', (event) => {
            event.stopPropagation()
            event.preventDefault()
            openPanel({ moveSessionId: props.sessionId })
          }),
        },
        h(MoveIcon),
      )
    }

    // ---------------------------------------------------------------- editors

    function PhaseEditor({ project, phase, done }) {
      const [title, setTitle] = useState(phase.title)
      const [summary, setSummary] = useState(phase.summary)
      const [status, setStatus] = useState(phase.status)
      const [steps, setSteps] = useState((phase.nextSteps ?? []).join('\n'))
      const [busy, setBusy] = useState(false)
      const save = async () => {
        setBusy(true)
        try {
          await api('/api/phase', { projectId: project.id, phaseId: phase.id, title, summary, status, nextSteps: steps.split('\n').map((line) => line.trim()).filter((line) => line !== '').join('|') })
          done()
          await refresh()
        } finally {
          setBusy(false)
        }
      }
      return h(
        'div',
        { className: 'pj-form' },
        h('input', { className: 'pj-input', value: title, onChange: (event) => setTitle(event.target.value) }),
        h('textarea', { className: 'pj-area', value: summary, onChange: (event) => setSummary(event.target.value) }),
        h('div', { className: 'pj-note' }, '下一步（一行一条，最多 6 条）'),
        h('textarea', { className: 'pj-area', value: steps, placeholder: '例如：补齐导出接口的失败重试', onChange: (event) => setSteps(event.target.value) }),
        h(
          'div',
          { className: 'pj-row' },
          h(
            'select',
            { className: 'pj-input', value: status, onChange: (event) => setStatus(event.target.value), style: { width: 120 } },
            h('option', { value: 'active' }, '进行中'),
            h('option', { value: 'done' }, '已完成'),
            h('option', { value: 'planned' }, '计划中'),
          ),
          h('button', { className: 'pj-btn primary', type: 'button', disabled: busy, onClick: act('form-save', save) }, '保存'),
          h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('form-done', done) }, '取消'),
        ),
      )
    }

    function changedLabels(before, after) {
      const labels = []
      if ((before?.title ?? '') !== (after?.title ?? '')) labels.push('标题')
      if ((before?.summary ?? '') !== (after?.summary ?? '')) labels.push('总结')
      if ((before?.status ?? '') !== (after?.status ?? '')) labels.push('状态')
      if (JSON.stringify(before?.nextSteps ?? []) !== JSON.stringify(after?.nextSteps ?? [])) labels.push('下一步')
      return labels.length === 0 ? ['无变化'] : labels
    }

    const AUTHOR_TEXT = { model: '模型', user: '你', restore: '回退', unknown: '未知' }

    function summaryMetaText(meta) {
      if (meta === null || meta === undefined) return ''
      const who = AUTHOR_TEXT[meta.by] ?? '未知'
      const name = meta.by === 'model' && typeof meta.model === 'string' && meta.model !== '' ? `${who}（${meta.model}）` : who
      const when = typeof meta.at === 'string' && meta.at !== '' ? new Date(meta.at).toLocaleString() : '时间未知'
      const inferred = meta.inferred === true ? ' · 旧数据推断' : ''
      const restored = typeof meta.restoredFrom === 'string' && meta.restoredFrom !== '' ? ` · 回到 ${new Date(meta.restoredFrom).toLocaleString()} 那一版` : ''
      return `作者：${name} · ${when}${restored}${inferred}`
    }

    // B1/B2：每张阶段卡都能看出「这段话是谁写的、什么时候写的」。
    function SummaryMetaLine({ phase }) {
      const meta = phase?.summaryMeta
      if (meta === null || meta === undefined) return null
      const text = summaryMetaText(meta)
      if (text === '') return null
      return h('div', { className: 'pj-meta-line', title: '模型自动总结 / 你手改 / 回退到旧版本，都会记在这里；旧数据没有记录时会标注「旧数据推断」' }, text)
    }

    function RevisionList({ project, phase }) {
      const [loading, setLoading] = useState(false)
      const [busy, setBusy] = useState(null)
      const key = `${project.id}:${phase.id}`
      const cached = store.revisions[key] ?? null
      const inline = Array.isArray(phase.revisions) ? [...phase.revisions].reverse() : []
      // C7/B3：首屏只显示 /api/state 带来的最近 5 条；「查看全部」再单独拉，避免把
      // 每个阶段的 20 条修订都塞进 390 KiB 的 state。
      const inlineTotal = Number.isFinite(phase.revisionCount) ? phase.revisionCount : inline.length
      const revisions = cached === null ? inline.slice(0, 5) : cached.revisions
      const total = cached === null ? inlineTotal : cached.revisionCount
      const loadAll = async () => {
        setLoading(true)
        try {
          const payload = await api('/api/phase/revisions', { projectId: project.id, phaseId: phase.id })
          setState({ revisions: { ...store.revisions, [key]: { revisions: payload.revisions ?? [], revisionCount: payload.revisionCount ?? 0, summaryMeta: payload.summaryMeta ?? null } } })
        } finally {
          setLoading(false)
        }
      }
      const restore = async (at) => {
        setBusy(at)
        try {
          await api('/api/phase/restore-revision', { projectId: project.id, phaseId: phase.id, at })
          setState({ revisions: { ...store.revisions, [key]: undefined } })
          await refresh({ force: true })
          setState({ notice: '已回到那一版，本次回退也记了一条修订' })
        } finally {
          setBusy(null)
        }
      }
      if (revisions.length === 0) return h('div', { className: 'pj-note', style: { marginTop: 10 } }, '还没有修订历史（保存过一次编辑后才会出现）。')
      return h(
        'div',
        { className: 'pj-revs' },
        h('div', { className: 'pj-note', style: { marginBottom: 4 } }, `修订历史 · 共 ${total} 条${cached === null && total > revisions.length ? `，先显示最近 ${revisions.length} 条` : ''}`),
        cached === null && total > revisions.length
          ? h('button', { className: 'pj-btn ghost', type: 'button', disabled: loading, onClick: act('revision-load-all', loadAll) }, loading ? '读取中…' : `查看全部 ${total} 条`)
          : null,
        revisions.map((item) =>
          h(
            'div',
            { className: 'pj-rev', key: item.at },
            h('div', { className: 'pj-rev-head' },
              h('span', { className: 'pj-rev-time' }, new Date(item.at).toLocaleString()),
              h('span', { className: 'pj-chip' }, changedLabels(item.before, item.after).join(' / ')),
              item.by === 'restore' || item.restoredFrom ? h('span', { className: 'pj-chip' }, '回退记录') : null,
            ),
            h('div', { className: 'pj-rev-body' },
              h('div', null, `改前：${item.before?.title ?? ''}`),
              h('div', null, `改后：${item.after?.title ?? ''}`),
            ),
            h('button', { className: 'pj-btn ghost', type: 'button', disabled: busy === item.at, onClick: act('revision-restore', () => restore(item.at)) }, busy === item.at ? '回退中…' : '回到这一版'),
          ),
        ),
      )
    }

    function PhaseEditModal({ project }) {
      const phase = (project?.phases ?? []).find((item) => item.id === store.editingPhaseId)
      if (phase === undefined) return null
      const close = () => setState({ editingPhaseId: null, editingPhaseProjectId: null })
      return h(
        'div',
        { className: 'pj-modal', style: { zIndex: 14 }, onMouseDown: (event) => { if (event.target === event.currentTarget) close() } },
        h(
          'div',
          { className: 'pj-modal-box', role: 'dialog', 'aria-modal': 'true', 'aria-label': '编辑阶段', style: { width: 'min(680px,92vw)' } },
          h('div', { className: 'pj-title' }, '编辑阶段'),
          h('div', { className: 'pj-sub', style: { marginBottom: 8 } }, '改的是进展记录本身（会话与对话历史不动），每次保存都会记一条修订历史；改后的标题/总结/下一步会进入后续归纳与开分支的上下文，所以它会实际影响之后的模型判断。'),
          h(PhaseEditor, { project, phase, done: close }),
          h(RevisionList, { project, phase }),
        ),
      )
    }

    function BranchDiff({ project, branchId, done }) {
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      useEffect(() => {
        let live = true
        api('/api/branch/diff', { projectId: project.id, branchId })
          .then((result) => { if (live) setData(result) })
          .catch((reason) => { if (live) setError(String(reason?.message ?? reason)) })
        return () => { live = false }
      }, [project.id, branchId])
      const row = (phase) => h('div', { className: 'pj-rev-body', key: phase.id }, `${phase.seq}. ${phase.title}${phase.status === 'active' ? '（进行中）' : ''}`)
      return h(
        'div',
        { className: 'pj-modal', style: { zIndex: 15 }, onMouseDown: (event) => { if (event.target === event.currentTarget) done() } },
        h(
          'div',
          { className: 'pj-modal-box', role: 'dialog', 'aria-modal': 'true', 'aria-label': '新建分支', style: { width: 'min(720px,94vw)' } },
          h('div', { className: 'pj-title' }, '分支 vs 主线'),
          error !== null ? h('div', { className: 'pj-error' }, error) : null,
          data === null
            ? h('div', { className: 'pj-note' }, '加载中…')
            : h(
              'div',
              null,
              h('div', { className: 'pj-sub' }, `${data.branch.title ?? '分支'} · 状态 ${data.branch.status} · 从主线第 ${Number(data.branch.fromSeq)} 阶段之后分叉`),
              h('div', { className: 'pj-rev' },
                h('div', { className: 'pj-rev-head' }, h('span', { className: 'pj-chip' }, `分支阶段 ${data.branchPhases.length}`), h('span', { className: 'pj-chip' }, `主线后续阶段 ${data.mainAfterFork.length}`), h('span', { className: 'pj-chip' }, `未解决问题 分支 ${data.openProblems.branch} / 主线 ${data.openProblems.mainAfterFork}`),
                  (data.inferredProblems?.branch ?? 0) + (data.inferredProblems?.mainAfterFork ?? 0) > 0
                    ? h('span', { className: 'pj-chip', title: '无原话的条目按推测处理，不计入未解决' }, `推测 分支 ${data.inferredProblems?.branch ?? 0} / 主线 ${data.inferredProblems?.mainAfterFork ?? 0}`)
                    : null,),
                data.branchPhases.length === 0 ? h('div', { className: 'pj-note' }, '分支上还没有阶段。') : data.branchPhases.map(row),
              ),
              h('div', { className: 'pj-rev' },
                h('div', { className: 'pj-rev-head' }, h('span', { className: 'pj-chip' }, '主线在分叉点之后')),
                data.mainAfterFork.length === 0 ? h('div', { className: 'pj-note' }, '主线在分叉点之后没有新阶段。') : data.mainAfterFork.map(row),
              ),
              data.branchProblemTitles.length > 0
                ? h('div', { className: 'pj-rev' }, h('div', { className: 'pj-rev-head' }, h('span', { className: 'pj-chip' }, '分支未解决问题')), data.branchProblemTitles.map((text) => h('div', { className: 'pj-rev-body', key: text }, text)))
                : null,
            ),
          h('div', { className: 'pj-row', style: { justifyContent: 'flex-end' } }, h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('form-done', done) }, '关闭')),
        ),
      )
    }

    function BranchRename({ project, branchId, initial, done }) {
      const [text, setText] = useState(initial ?? '')
      const [busy, setBusy] = useState(false)
      const save = async () => {
        if (text.trim() === '') return
        setBusy(true)
        try {
          await api('/api/branch/status', { projectId: project.id, branchId, action: 'rename', title: text.trim().slice(0, 40) })
          done()
          await refresh()
        } finally {
          setBusy(false)
        }
      }
      return h(
        'div',
        { className: 'pj-row' },
        h('input', {
          className: 'pj-input',
          autoFocus: true,
          style: { width: 180 },
          value: text,
          onChange: (event) => setText(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') save()
            if (event.key === 'Escape') done()
          },
        }),
        h('button', { className: 'pj-btn primary', type: 'button', disabled: busy, onClick: act('form-save', save) }, '改名'),
        h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('form-done', done) }, '取消'),
      )
    }

    function StepForm({ project, phase, done }) {
      const [text, setText] = useState('')
      const [busy, setBusy] = useState(false)
      const save = async () => {
        if (text.trim() === '') return
        setBusy(true)
        try {
          const next = [...(phase.nextSteps ?? []), text.trim().slice(0, 120)].slice(0, 6)
          await api('/api/phase', { projectId: project.id, phaseId: phase.id, nextSteps: next.join('|') })
          done()
          await refresh()
        } finally {
          setBusy(false)
        }
      }
      return h(
        'div',
        { className: 'pj-row' },
        h('input', {
          className: 'pj-input',
          autoFocus: true,
          placeholder: '例如：补齐导出接口的失败重试',
          value: text,
          onChange: (event) => setText(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') save()
            if (event.key === 'Escape') done()
          },
        }),
        h('button', { className: 'pj-btn primary', type: 'button', disabled: busy, onClick: act('form-save', save) }, '加'),
        h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('form-done', done) }, '取消'),
      )
    }

    function ProblemForm({ project, phase, problem, done }) {
      const [statement, setStatement] = useState(problem?.statement ?? '')
      const [resolution, setResolution] = useState(problem?.resolution ?? '')
      const [status, setStatus] = useState(problem?.status ?? 'solved')
      const [busy, setBusy] = useState(false)
      const save = async () => {
        if (statement.trim() === '') return
        setBusy(true)
        try {
          await api('/api/problem', { projectId: project.id, phaseId: phase.id, problemId: problem?.id, statement, resolution, status })
          done()
          await refresh()
        } finally {
          setBusy(false)
        }
      }
      return h(
        'div',
        { className: 'pj-form' },
        h('input', {
          className: 'pj-input',
          placeholder: '遇到的问题（一句话）',
          value: statement,
          onChange: (event) => setStatement(event.target.value),
        }),
        h('input', {
          className: 'pj-input',
          placeholder: '怎么处理的',
          value: resolution,
          onChange: (event) => setResolution(event.target.value),
        }),
        h(
          'div',
          { className: 'pj-row' },
          h(
            'select',
            { className: 'pj-input', value: status, onChange: (event) => setStatus(event.target.value), style: { width: 110 } },
            h('option', { value: 'solved' }, '已解决'),
            h('option', { value: 'open' }, '未解决'),
          ),
          h('button', { className: 'pj-btn primary', type: 'button', disabled: busy, onClick: act('form-save', save) }, '保存'),
          h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('form-done', done) }, '取消'),
        ),
      )
    }

    // ------------------------------------------------------------------ panel

    function Settings({ data, close }) {
      const [provider, setProvider] = useState(data?.model?.provider ?? '')
      const [model, setModel] = useState(data?.model?.model ?? '')
      const [auto, setAuto] = useState(data?.config?.auto !== false)
      const [busy, setBusy] = useState(false)
      const save = async () => {
        setBusy(true)
        try {
          const result = await api('/api/config', { provider, model, auto: auto ? 1 : 0 })
          if (Array.isArray(result?.ignored) && result.ignored.length > 0) {
            setState({ notice: `这些数值不合法，已保留原值：${result.ignored.join('、')}` })
          }
          await refresh()
        } finally {
          setBusy(false)
        }
      }
      const backfill = async (action) => {
        setBusy(true)
        try {
          await api('/api/backfill', { action })
          await refresh()
        } finally {
          setBusy(false)
        }
      }
      const state = data?.backfill?.state ?? 'idle'
      const [backups, setBackups] = useState(store.backups ?? null)
      const loadBackups = async () => {
        try {
          const result = await api('/api/backups')
          setBackups(result?.backups ?? [])
          setState({ backups: result?.backups ?? [] })
        } catch (error) {
          setBackups([])
        }
      }
      const createBackup = async () => {
        setBusy(true)
        try {
          await api('/api/backup', { action: 'create' })
          await loadBackups()
        } finally {
          setBusy(false)
        }
      }
      const restore = (file) => {
        askConfirm(`从备份「${file}」恢复项目进展？当前进展会先自动备份一份，然后被这份快照替换。`, async () => {
          setBusy(true)
          try {
            await api('/api/backup/restore', { file })
            await refresh()
            await loadBackups()
            setState({ notice: `已从 ${file} 恢复` })
          } finally {
            setBusy(false)
          }
        })
      }
      if (backups === null) void loadBackups()
      return h(
        'div',
        { className: 'pj-settings', role: 'dialog', 'aria-label': '项目进展设置' },
        h('div', { className: 'pj-label' }, '摘要模型 provider / model（留空自动选择）'),
        h('div', { className: 'pj-row' },
          h('input', { className: 'pj-input', value: provider, placeholder: 'provider id', onChange: (event) => setProvider(event.target.value) }),
          h('input', { className: 'pj-input', value: model, placeholder: 'model id', onChange: (event) => setModel(event.target.value) }),
        ),
        h('div', { className: 'pj-row' },
          h('input', { type: 'checkbox', checked: auto, onChange: (event) => setAuto(event.target.checked), id: 'pj-auto' }),
          h('label', { htmlFor: 'pj-auto', style: { fontSize: 12 } }, '会话结束后自动总结'),
        ),
        h('div', { className: 'pj-row' },
          h('button', { className: 'pj-btn primary', type: 'button', disabled: busy, onClick: act('form-save', save) }, '保存设置'),
          h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('form-close', close) }, '关闭'),
        ),
        h('div', { className: 'pj-label' }, `历史回填：${state}${data?.backfill?.total ? `（${data.backfill.processed}/${data.backfill.total}）` : ''}`),
        h('div', { className: 'pj-row' },
          h('button', { className: 'pj-btn', type: 'button', disabled: busy, onClick: act('backfill-start', () => backfill('start')) }, '开始/继续'),
          h('button', { className: 'pj-btn', type: 'button', disabled: busy, onClick: act('backfill-pause', () => backfill('pause')) }, '暂停'),
          h('button', { className: 'pj-btn', type: 'button', disabled: busy, onClick: act('backfill-reset', () => backfill('reset')) }, '全部重来'),
        ),
        h('div', { className: 'pj-label', style: { marginTop: 4 } }, '备份与恢复（journal 快照，恢复前会自动再备份一份）'),
        h('div', { className: 'pj-row' },
          h('button', { className: 'pj-btn ghost', type: 'button', disabled: busy, onClick: act('backup-create', createBackup) }, '立即备份'),
          h('button', { className: 'pj-btn ghost', type: 'button', disabled: busy, onClick: act('backup-refresh', () => { setBackups(null); setState({ backups: null }); void loadBackups() }) }, '刷新列表'),
        ),
        h('div', { className: 'pj-backups' },
          backups === null
            ? h('div', { className: 'pj-sub' }, '读取备份列表…')
            : backups.length === 0
              ? h('div', { className: 'pj-sub' }, '还没有备份。迁移/开分支/恢复前会自动备份，也可以点上面「立即备份」。')
              : backups.slice(0, 30).map((item) =>
                  h('div', { className: 'pj-backup-row', key: item.file },
                    h('span', { className: 'pj-sub' }, `${item.at.replace('T', ' ').slice(0, 19)} · ${item.kind}${item.projects !== undefined ? ` · ${item.projects}项目/${item.sessions}会话` : ''} · ${Math.round((item.size ?? 0) / 1024)}KB`),
                    h('span', { className: 'pj-spacer', style: { flex: 1 } }),
                    item.restorable === true
                      ? h('button', { className: 'pj-btn ghost', type: 'button', disabled: busy, onClick: act('backup-restore', () => restore(item.file)) }, '恢复')
                      : h('span', { className: 'pj-seq' }, item.kind === 'workspace' ? '仅存档' : '不可恢复'),
                  ),
                ),
        ),
        h(DataHygiene, { data }),
        data?.model?.error ? h('div', { className: 'pj-error', style: { borderRadius: 8 } }, data.model.error) : null,
      )
    }


    function Trash({ project }) {
      const items = Array.isArray(project.trash) ? project.trash : []
      const [open, setOpen] = useState(false)
      const [stats, setStats] = useState(null)
      const restore = async (id) => {
        await api('/api/phase', { projectId: project.id, phaseId: id, action: 'restore' }).catch((error) => setState({ error: String(error?.message ?? error) }))
        await refresh()
      }
      const purge = (id, title) => {
        askConfirm(`永久删除阶段「${title}」？进展记录彻底移除，产物留在回收站不再被项目读取，会话记录与对话历史仍在；永久删除后不可恢复。`, async () => {
          await api('/api/phase', { projectId: project.id, phaseId: id, action: 'delete', hard: 1 }).catch((error) => setState({ error: String(error?.message ?? error) }))
          await refresh()
        })
      }
      useEffect(() => {
        if (open !== true) return () => {}
        let live = true
        api('/api/trash').then((result) => { if (live) setStats(result) }).catch(() => {})
        return () => { live = false }
      }, [open, project.id])
      if (items.length === 0) return null
      const emptyTrash = () => {
        const human = stats === null ? '' : `${(stats.bytes / 1024).toFixed(1)} KB / ${stats.files} 个文件`
        askConfirm(`清空回收站里本项目的产物（${human}）？文件会被真正删除，之后「恢复阶段」只能恢复记录、文件回不来。`, async () => {
          await api('/api/trash/empty', { confirm: 1, projectId: project.id }).catch((error) => setState({ error: String(error?.message ?? error) }))
          setStats(null)
          await refresh()
        })
      }
      return h(
        'div',
        { className: 'pj-trash' },
        h(
          'button',
          { className: 'pj-trash-toggle', type: 'button', onClick: act('trash-toggle', () => setOpen(open !== true)) },
          `${open === true ? '▾' : '▸'} 已删除的阶段 ${items.length}（可恢复）`,
        ),
        open !== true
          ? null
          : h(
              'div',
              null,
              h(
                'div',
                { className: 'pj-trash-row', style: { opacity: 0.85 } },
                h('span', { className: 'pj-sub' }, stats === null ? '回收站占用：统计中…' : `回收站占用：${(stats.bytes / 1024).toFixed(1)} KB / ${stats.files} 个文件`),
                h('span', { className: 'pj-spacer', style: { flex: 1 } }),
                h('button', { className: 'pj-btn ghost', type: 'button', disabled: stats === null || stats.files === 0, onClick: act('trash-empty', emptyTrash) }, '清空本项目回收站'),
              ),
            ),
        open !== true
          ? null
          : items.map((item) =>
              h(
                'div',
                { className: 'pj-trash-row', key: item.id },
                h('span', { className: 'pj-trash-title' }, `${item.title}（${item.problemCount} 问题 · ${item.sessions.length} 会话${item.trashed.length > 0 ? ` · ${item.trashed.length} 个产物已在回收站` : ''}）`),
                h('span', { className: 'pj-sub' }, `删除于 ${String(item.deletedAt).replace('T', ' ').slice(0, 16)}`),
                h('span', { className: 'pj-spacer', style: { flex: 1 } }),
                h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('trash-restore', () => restore(item.id)) }, '恢复'),
                h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('trash-purge', () => purge(item.id, item.title)) }, '永久删除'),
              ),
            ),
      )
    }

    function ConsistencyBar({ project }) {
      const info = project.consistency
      if (info === undefined || info === null || info.count === 0) return null
      const issues = Array.isArray(info.issues) ? info.issues : []
      const label = (issue) => {
        if (issue.kind === 'session-points-to-missing-phase') return `会话 ${String(issue.sessionId).slice(-6)} 指向已不存在的阶段 ${issue.phaseId}`
        if (issue.kind === 'phase-lists-missing-session') return `阶段 ${issue.phaseId} 列着找不到的会话 ${String(issue.sessionId).slice(-6)}`
        if (issue.kind === 'phase-session-in-other-project') return `阶段 ${issue.phaseId} 的会话 ${String(issue.sessionId).slice(-6)} 属于其它项目`
        return issue.kind
      }
      const fix = async () => {
        try {
          const result = await api('/api/consistency/fix', { projectId: project.id })
          if (result.noop === true || (result.changed ?? 0) === 0) {
            setState({ notice: result.remaining > 0 ? `没有可自动修正的项，还有 ${result.remaining} 处需要手工处理` : '没有需要修正的项' })
          } else {
            setState({ notice: `已修正：阶段里移除 ${result.removedFromPhase} 条、会话里移除 ${result.removedFromRecord} 条残留指针${result.remaining > 0 ? `；还剩 ${result.remaining} 处` : ''}` })
          }
          await refresh()
        } catch (error) {
          setState({ error: String(error?.message ?? error) })
        }
      }
      return h(
        'div',
        { className: 'pj-suggest', style: { borderColor: 'var(--pj-label-warning)' } },
        h('div', { className: 'pj-suggest-h' }, `进展记录与真实会话有 ${info.count} 处对不上（多为删除/迁移后的残留指针）`),
        issues.slice(0, 5).map((issue, index) => h('div', { className: 'pj-suggest-row', key: index }, h('span', { className: 'pj-suggest-text' }, label(issue)))),
        h(
          'div',
          { className: 'pj-row', style: { marginTop: 6 } },
          h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('consistency-fix', () => { void fix() }) }, '自动修正残留指针'),
        ),
      )
    }

    function branchSelected(project) {
      const id = store.branchOf[project.id]
      const branches = project.branches ?? []
      if (typeof id === 'string' && branches.some((branch) => branch.id === id)) return id
      const active = branches.find((branch) => branch.id === project.activeBranchId)
      if (active !== undefined && (active.status !== 'abandoned' || active.phaseCount > 0)) return active.id
      return 'main'
    }

    function BranchTabs({ project, currentId, onPick }) {
      const branches = project.branches ?? []
      if (branches.length <= 1) return null
      return h(
        'div',
        { className: 'pj-tabs' },
        branches.map((branch) =>
          h(
            'button',
            {
              key: branch.id,
              type: 'button',
              className: `pj-tab ${branch.id === currentId ? 'active' : ''} ${branch.status !== 'active' ? branch.status : ''}`,
              title: branch.fromPhaseId ? `从阶段 ${branch.fromSeq} 分叉，原阶段保留在主线` : '主线（从阶段 1 开始）',
              onClick: act('branch-pick', () => onPick(branch.id)),
            },
            h('span', null, branch.id === 'main' ? '主线' : branch.title),
            branch.id === 'main' ? null : h('span', { className: 'pj-tabsrc' }, `从阶段${branch.fromSeq}分叉`),
            branch.status === 'merged' ? h('span', { className: 'pj-chip done' }, '已合并') : null,
            branch.status === 'abandoned' ? h('span', { className: 'pj-chip abandoned' }, '已放弃') : null,
            h('span', { className: 'pj-tabcount' }, String(branch.phaseCount ?? 0)),
          ),
        ),
      )
    }

    function ForkDialog({ project, close }) {
      const draft = store.forkDraft
      const [title, setTitle] = useState(draft?.title ?? '')
      const [prompt, setPrompt] = useState(draft?.prompt ?? '')
      const [withSession, setWithSession] = useState(project.locked !== true)
      const [inherit, setInherit] = useState(project.locked !== true)
      const [busy, setBusy] = useState(false)
      if (draft === null) return null
      const confirm = async () => {
        setBusy(true)
        try {
          let context = draft?.context ?? null
          if (inherit && withSession && context === null) {
            try {
              const seed = await api('/api/branch/seed', { projectId: project.id, phaseId: draft.phaseId })
              context = seed?.context ?? null
            } catch {
              context = null
            }
          }
          const forkIt = inherit && withSession && context !== null
          const result = await api('/api/branch', {
            projectId: project.id,
            phaseId: draft.phaseId,
            title,
            withSession: withSession ? 1 : 0,
            mode: forkIt ? 'fork' : 'blank',
            prompt: forkIt && prompt === draft?.prompt ? '' : prompt,
          })
          const inheritedCount = result.mode === 'fork' && context !== null ? Number(context.seq ?? 0) + 1 : 0
          setState({
            forkDraft: null,
            branchOf: { ...store.branchOf, [project.id]: result.branchId },
            notice: result.mode === 'fork'
              ? `已开分支，新会话已继承 ${inheritedCount} 条历史事件，直接接着该阶段继续即可`
              : result.mode === 'blank'
                ? '已开分支，新会话是空白会话（未能分叉上下文）'
                : '已开分支（未新建会话）',
          })
          if (result.warning) {
            beacon(`branch-warning:${result.warning}`)
            setState({ error: result.warning === 'fork-failed'
              ? '分叉上下文失败，已改为新开空白会话；可再试一次或检查该阶段所属会话是否仍可读'
              : `开分支提示：${result.warning}` })
          }
          await refresh()
        } catch (error) {
          setState({ error: String(error?.message ?? error) })
        } finally {
          setBusy(false)
        }
      }
      return h(
        'div',
        { className: 'pj-modal', onMouseDown: (event) => { if (event.target === event.currentTarget) close() } },
        h(
          'div',
          { className: 'pj-modal-box', role: 'dialog', 'aria-modal': 'true', 'aria-label': '进展记录' },
          h('div', { className: 'pj-title' }, `从「${draft.phaseTitle ?? ''}」开一条重做分支`),
          h('div', { className: 'pj-sub' }, '原来的阶段不会删除；新分支从这一步重新做，进展链里两条线都能看。勾选「承接上下文」时，新会话会继承该阶段结束时的对话历史。代码文件不会被改动。'),
          draft?.isRedo === true
            ? h('div', { className: 'pj-sub', style: { color: 'var(--pj-label-warning)' } }, '提示：这是「重做」阶段本身，从这里再开分支会形成二级重做，分支名默认带「重做²」，避免和上一个重做分支同名。')
            : null,
          h('div', { className: 'pj-label' }, '分支名'),
          h('input', { className: 'pj-input', value: title, onChange: (event) => setTitle(event.target.value) }),
          h(
            'div',
            { className: 'pj-row' },
            h('input', { type: 'checkbox', id: 'pj-with-session', checked: withSession, disabled: project.locked === true, onChange: (event) => setWithSession(event.target.checked) }),
            h('label', { htmlFor: 'pj-with-session', style: { fontSize: 12 } }, project.locked === true ? '未归属项目不能新开会话' : '同时新开一个会话，从这一步继续（推荐）'),
          ),
          h(
            'div',
            { className: 'pj-row' },
            h('input', { type: 'checkbox', id: 'pj-inherit', checked: inherit, disabled: project.locked === true, onChange: (event) => setInherit(event.target.checked) }),
            h('label', { htmlFor: 'pj-inherit', style: { fontSize: 12 } },
              draft?.context === null || draft?.context === undefined
                ? '承接该阶段的上下文（提交时会自动确认该阶段所属会话，可分叉则继承此前全部对话）'
                : `承接该阶段的上下文（分叉该阶段所在会话，共 ${draft.context.total ?? 0} 条事件，切到第 ${Number(draft.context.seq ?? -1) + 1} 条）`),
          ),
          h('div', { className: 'pj-label' }, inherit && withSession ? '可选：新会话的第一条消息（留空则直接承接上下文，等你来问）' : '发给新会话的第一条消息（可改）'),
          h('textarea', { className: 'pj-area', style: { minHeight: 120 }, value: prompt, onChange: (event) => setPrompt(event.target.value) }),
          h(
            'div',
            { className: 'pj-row' },
            h('button', { className: 'pj-btn primary', type: 'button', disabled: busy, onClick: act('fork-submit', confirm) }, busy ? '创建中…' : '开分支'),
            h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('form-close', close) }, '取消'),
            h('span', { className: 'pj-spacer', style: { flex: 1 } }),
            h('span', { className: 'pj-seq' }, `原阶段 ${draft.fromSeq ?? ''}`),
          ),
        ),
      )
    }


    function ConfirmModal() {
      const item = store.confirm
      const [busy, setBusy] = useState(false)
      useEffect(() => { setBusy(false) }, [item])
      if (item === null) return null
      return h(
        'div',
        { className: 'pj-modal', style: { zIndex: 12 }, onMouseDown: (event) => { if (event.target === event.currentTarget) setState({ confirm: null }) } },
        h(
          'div',
          { className: 'pj-modal-box', role: 'dialog', 'aria-modal': 'true', 'aria-label': '确认', style: { width: 'min(440px,86vw)' } },
          h('div', { className: 'pj-title' }, '确认操作'),
          h('div', { className: 'pj-sub', style: { lineHeight: 1.7 } }, item.text),
          h(
            'div',
            { className: 'pj-row' },
            h('button', {
              className: 'pj-btn primary',
              type: 'button',
              disabled: busy,
              onClick: act('confirm-accept', async () => {
                setBusy(true)
                try {
                  await item.run()
                } catch (error) {
                  setState({ error: String(error?.message ?? error) })
                } finally {
                  setBusy(false)
                  // run() 里可能又弹了下一步确认（如「删分支」的两步确认）：只有当前确认仍是这一条时才关闭。
                  if (store.confirm === item) setState({ confirm: null })
                }
              }),
            }, busy ? '处理中…' : '确认'),
            h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('confirm-cancel', () => setState({ confirm: null })) }, '取消'),
          ),
        ),
      )
    }

    function AttachModal({ project }) {
      const item = store.attachFor
      const [busy, setBusy] = useState(false)
      if (item === null || item.projectId !== project.id) return null
      const candidates = (project.sessions ?? []).filter((session) => session.branchId !== item.branchId)
      // 其它项目的会话也可以直接拉进来：先迁移侧边栏归属，再挂分支。
      const others = (store.data?.projects ?? [])
        .filter((other) => other.id !== project.id && other.locked !== true)
        .flatMap((other) => (other.sessions ?? []).map((session) => ({ ...session, projectTitle: other.title })))
        .slice(0, 20)
      const attach = async (sessionId, move) => {
        setBusy(true)
        try {
          const result = await api('/api/branch/attach', { projectId: project.id, branchId: item.branchId, sessionId, move: move === true ? 1 : undefined })
          setState({ attachFor: null, notice: result.movedFrom !== null && result.movedFrom !== undefined ? '已把会话迁入本项目并挂到该分支' : '已把会话挂到该分支' })
          await refresh()
        } catch (error) {
          setState({ error: String(error?.message ?? error) })
        } finally {
          setBusy(false)
        }
      }
      return h(
        'div',
        { className: 'pj-modal', style: { zIndex: 12 }, onMouseDown: (event) => { if (event.target === event.currentTarget) setState({ attachFor: null }) } },
        h(
          'div',
          { className: 'pj-modal-box', role: 'dialog', 'aria-modal': 'true', 'aria-label': '进展记录' },
          h('div', { className: 'pj-title' }, '把一个已有会话挂到这条分支'),
          h('div', { className: 'pj-sub' }, '挂上后，该会话之后新增的对话会归纳进这条分支的当前阶段；会话原来的阶段归属不变。'),
          others.length > 0
            ? h(
                'div',
                { style: { marginBottom: 8 } },
                h('div', { className: 'pj-note' }, '其它项目的会话（点击会先迁入本项目，再挂到这条分支）'),
                others.map((session) =>
                  h(
                    'button',
                    {
                      key: session.sessionId,
                      className: 'pj-btn ghost',
                      type: 'button',
                      disabled: busy,
                      style: { justifyContent: 'flex-start', textAlign: 'left', display: 'flex', width: '100%', marginBottom: 4 },
                      onClick: act('attach-other-session', () => attach(session.sessionId, true)),
                    },
                    `${String(session.title ?? session.sessionId).slice(0, 36)} · ${session.projectTitle}`,
                  ),
                ),
              )
            : null,
          candidates.length === 0
            ? h('div', { className: 'pj-empty' }, '这个项目里没有可挂的其它会话。')
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflow: 'auto' } },
                candidates.map((session) =>
                  h(
                    'button',
                    {
                      key: session.sessionId,
                      className: 'pj-btn ghost',
                      type: 'button',
                      disabled: busy,
                      style: { justifyContent: 'flex-start', textAlign: 'left' },
                      onClick: act('attach-session', () => attach(session.sessionId)),
                    },
                    `${String(session.title ?? session.sessionId).slice(0, 40)} · ${session.branchId === 'main' ? '主线' : '其它分支'}`,
                  ),
                ),
              ),
          h(
            'div',
            { className: 'pj-row' },
            h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('attach-cancel', () => setState({ attachFor: null })) }, '取消'),
          ),
        ),
      )
    }

    function PhaseCreateModal({ project }) {
      const item = store.phaseDraft
      const [busy, setBusy] = useState(false)
      const [title, setTitle] = useState('')
      const [summary, setSummary] = useState('')
      if (item === null || item.projectId !== project.id) return null
      const submit = async () => {
        setBusy(true)
        try {
          await api('/api/phase/create', { projectId: project.id, branchId: item.branchId, title, summary })
          setState({ phaseDraft: null, notice: '已新建阶段' })
          await refresh()
        } catch (error) {
          setState({ error: String(error?.message ?? error) })
        } finally {
          setBusy(false)
        }
      }
      return h(
        'div',
        { className: 'pj-modal', style: { zIndex: 12 }, onMouseDown: (event) => { if (event.target === event.currentTarget) setState({ phaseDraft: null }) } },
        h(
          'div',
          { className: 'pj-modal-box', role: 'dialog', 'aria-modal': 'true', 'aria-label': '进展记录' },
          h('div', { className: 'pj-title' }, '手动新建一个阶段'),
          h('div', { className: 'pj-sub' }, '适合两种场景：会话没被自动归纳出阶段，或你想先记下当前进展。新建后上一个进行中的阶段会置为已完成。'),
          h('div', { className: 'pj-label' }, '阶段标题'),
          h('input', { className: 'pj-input', value: title, onChange: (event) => setTitle(event.target.value) }),
          h('div', { className: 'pj-label' }, '这个阶段做了什么（可留空）'),
          h('textarea', { className: 'pj-area', value: summary, onChange: (event) => setSummary(event.target.value) }),
          h(
            'div',
            { className: 'pj-row' },
            h('button', { className: 'pj-btn primary', type: 'button', disabled: busy || title.trim() === '', onClick: act('form-submit', submit) }, busy ? '创建中…' : '新建'),
            h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('form-close', () => setState({ phaseDraft: null })) }, '取消'),
          ),
        ),
      )
    }

    function searchHits(projects, query) {
      const needle = query.trim().toLowerCase()
      if (needle === '') return []
      const hits = []
      for (const project of projects) {
        const branches = project.branches ?? []
        for (const phase of project.phases ?? []) {
          const branch = branches.find((item) => item.id === (phase.branchId ?? 'main')) ?? null
          const problems = Array.isArray(phase.problems) ? phase.problems : []
          const problem = problems.find((item) => `${item.statement ?? ''} ${item.resolution ?? ''}`.toLowerCase().includes(needle)) ?? null
          const text = `${phase.title ?? ''} ${phase.summary ?? ''} ${(phase.nextSteps ?? []).join(' ')} ${problems.map((item) => `${item.statement ?? ''} ${item.resolution ?? ''}`).join(' ')}`.toLowerCase()
          if (!text.includes(needle) && !(branch?.title ?? '').toLowerCase().includes(needle)) continue
          const statement = problem !== null ? problem.statement : (phase.summary ?? phase.title ?? '')
          hits.push({ projectId: project.id, projectTitle: project.title, branchId: phase.branchId ?? 'main', branchTitle: branch?.title ?? '主线', phaseId: phase.id, phaseTitle: phase.title, status: phase.status, snippet: String(statement).slice(0, 120), problem: problem?.statement ?? null })
        }
      }
      return hits.slice(0, 40)
    }

    function SearchResults({ projects, query }) {
      const hits = searchHits(projects, query)
      if (hits.length === 0) return h('div', { className: 'pj-empty' }, `没有匹配「${query.trim()}」的阶段或问题。`)
      return h(
        'div',
        { className: 'pj-hits' },
        h('div', { className: 'pj-sub' }, `${hits.length} 条匹配`),
        hits.map((hit) =>
          h(
            'div',
            {
              className: 'pj-hit',
              key: `${hit.phaseId}:${hit.problem ?? ''}`,
              onClick: act('search-hit-open', () => setState({ selectedProjectId: hit.projectId, branchOf: { ...store.branchOf, [hit.projectId]: hit.branchId }, query: '' })),
            },
            h('div', { className: 'pj-hit-top' }, h('span', { className: 'pj-hit-title' }, hit.phaseTitle), h('span', { className: 'pj-chip' }, hit.status === 'done' ? '已完成' : hit.status === 'active' ? '进行中' : '计划中')),
            h('div', { className: 'pj-sub' }, `${hit.projectTitle} · ${hit.branchTitle}`),
            h('div', { className: 'pj-hit-text' }, hit.snippet),
          ),
        ),
      )
    }

    // client-v10 (hmr)
    // client-v12 (hmr)
    // client-v24 (hmr)
    // client-v25 (hmr)：修复面板点击被古法覆盖层劫持（portal 宿主幂等归位 + 控件动作诊断信标）
    // client-v26 (hmr)：补齐剩余点击的 act() 覆盖（回退 / 挂会话 / 分支状态 / 项目与搜索命中），包名公开化 + 中英 locale
    // client-v27 (hmr)：0.5.0 三栏重写（左项目 / 中时间线 / 右检视器 + 页面态 Esc 分层）
    // B4/B5：失败横幅只统计真的失败（state==='error'）；skipped 单独列原因、不给重试按钮。
    function FailureBanner({ projects }) {
      const [busy, setBusy] = useState(null)
      const failed = []
      const skipped = []
      for (const project of projects ?? []) {
        for (const session of project.sessions ?? []) {
          if (session.state === 'error') failed.push({ project, session })
          else if (session.state === 'skipped') skipped.push({ project, session })
        }
      }
      if (store.failureDismissed === true) return null
      if (failed.length === 0 && skipped.length === 0) return null
      const retry = async (session) => {
        setBusy(session.sessionId)
        try {
          await retrySummarize(session.sessionId)
        } catch (error) {
          setState({ error: String(error?.message ?? error) })
        } finally {
          setBusy(null)
        }
      }
      return h(
        'div',
        { className: 'pj-notice pj-failures', role: 'status', 'aria-live': 'polite' },
        h('div', { className: 'pj-gap-head' }, `总结失败的会话 ${failed.length} 个${skipped.length > 0 ? ` · 已跳过 ${skipped.length} 个` : ''}`),
        failed.slice(0, 5).map(({ project, session }) =>
          h(
            'div',
            { className: 'pj-gap-row', key: session.sessionId },
            h('span', { className: 'pj-gap-title', title: session.lastError ?? '' }, `${session.title ?? session.sessionId} · ${String(session.sessionId).slice(-8)}`),
            h('span', { className: 'pj-sub' }, session.lastError ? String(session.lastError).slice(0, 90) : '没记下失败原因'),
            h('button', { className: 'pj-btn ghost', type: 'button', 'aria-label': `重试总结 ${session.title ?? session.sessionId}`, disabled: busy === session.sessionId, onClick: act('summary-retry', () => retry(session)) }, busy === session.sessionId ? '重试中…' : '重试'),
          ),
        ),
        skipped.length > 0
          ? h('div', { className: 'pj-sub' }, `已跳过、不会自动重试：${skipped.slice(0, 5).map(({ session }) => `${session.title ?? String(session.sessionId).slice(-8)}（${String(session.lastError ?? '达到重试上限或没有可总结内容').slice(0, 40)}）`).join('；')}`)
          : null,
        h('div', { className: 'pj-row' },
          h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('failure-dismiss', () => setState({ failureDismissed: true })) }, '本次先不显示'),
        ),
      )
    }

    // D7：古法皮肤激活时，项目页头部也常显迁移入口，不依赖会话行 hover。

    function DataHygiene() {
      const [busy, setBusy] = useState(false)
      const orphans = store.orphans
      useEffect(() => {
        if (orphans !== null) return
        api('/api/project/orphans')
          .then((payload) => setState({ orphans: payload }))
          .catch(() => {})
      }, [])
      const remove = (orphan) => {
        askConfirm(`删除项目记录「${orphan.title}」？只删进展记录（阶段/问题/会话索引），不动项目目录，删前会自动备份 journal。不可撤销。`, async () => {
          setBusy(true)
          try {
            const result = await api('/api/project/delete', { projectId: orphan.projectId, confirm: 1 })
            setState({ notice: `已删除「${orphan.title}」的记录（备份 ${result.backup}）` })
            const payload = await api('/api/project/orphans')
            setState({ orphans: payload })
            await refresh({ force: true })
          } catch (error) {
            setState({ error: String(error?.message ?? error) })
          } finally {
            setBusy(false)
          }
        })
      }
      const list = orphans?.orphans ?? null
      return h(
        'div',
        { className: 'pj-hygiene' },
        h('div', { className: 'pj-label', style: { marginTop: 8 } }, '数据卫生（孤儿项目记录）'),
        list === null
          ? h('div', { className: 'pj-sub' }, '读取中…')
          : list.length === 0
            ? h('div', { className: 'pj-sub' }, '没有孤儿项目记录。')
            : h('div', null, list.map((orphan) =>
                h('div', { className: 'pj-backup-row', key: orphan.projectId },
                  h('span', { className: 'pj-sub' }, `${orphan.title} · ${orphan.phases}阶段/${orphan.problems}问题/${orphan.sessions}会话`),
                  h('span', { className: 'pj-spacer', style: { flex: 1 } }),
                  orphan.deletable === true
                    ? h('button', { className: 'pj-btn ghost', type: 'button', disabled: busy, onClick: act('orphan-delete', () => remove(orphan)) }, '删除记录')
                    : h('span', { className: 'pj-seq' }, Number(orphan.sessions ?? 0) > 0 ? '有会话，先迁走' : '目录在用，不能删'),
                ),
              )),
        h('div', { className: 'pj-sub' }, `本次会话刷新统计：共 ${store.stats.refresh} 次，未变更 ${store.stats.notModified} 次，失败 ${store.stats.failed} 次`),
      )
    }

    function Panel() {
      useStore()
      ensureStyle()
      // C3/C4：5 秒一次的条件刷新——页面不可见、正在编辑、或上一次请求还没回来时都不打扰。
      useEffect(() => {
        if (store.open !== true) return undefined
        const tick = () => {
          try {
            if (document.visibilityState === 'hidden') return
          } catch {}
          if (pollingLocked()) return
          refresh({ silent: true }).catch(() => {})
        }
        const timer = setInterval(tick, 5000)
        const onVisible = () => { if (document.visibilityState === 'visible') tick() }
        document.addEventListener('visibilitychange', onVisible)
        return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
      }, [store.open])
      // 诊断：面板打开后量一次「谁在最上层」，用于排查点击被别的插件浮层接走的问题。
      useEffect(() => {
        if (store.open !== true) return undefined
        const timer = setTimeout(() => {
          try {
            const el = document.querySelector('.pj-root')
            if (el === null) return
            const rect = el.getBoundingClientRect()
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
            const inside = hit !== null && typeof el.contains === 'function' && el.contains(hit)
            const gufa = document.getElementById('gufa-portal-root')
            const gufaInfo = gufa === null ? 'gufa-none' : `gufa:${gufa.childElementCount}`
            const chain = []
            let node = el
            for (let i = 0; i < 4 && node !== null; i += 1) {
              const cs = window.getComputedStyle(node)
              chain.push(`${node.tagName}.${String(node.className || '').split(' ')[0]}:${cs.zIndex || '-'}:${cs.pointerEvents || '-'}`)
              node = node.parentElement
            }
            let hidden = ''
            let probe = el
            for (let i = 0; i < 8 && probe !== null; i += 1) {
              const cs = window.getComputedStyle(probe)
              if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') { hidden = `hidden@${probe.tagName}.${String(probe.className || '').split(' ')[0]}`; break }
              if (cs.transform !== 'none') hidden += `${hidden === '' ? '' : ','}tf@${probe.tagName}.${String(probe.className || '').split(' ')[0]}`
              probe = probe.parentElement
            }
            const host = el.parentElement === null ? 'no-parent' : String(el.parentElement.id || el.parentElement.tagName)
            beacon(`stack:${inside ? 'in' : 'out'}:${gufaInfo}:host=${host}:${hidden === '' ? 'plain' : hidden}:${chain.join('|')}`)
          } catch {}
        }, 400)
        return () => clearTimeout(timer)
      }, [store.open])
      // 面板打开期间持续守护 portal 宿主：任何时刻它被移出 body 都立刻纠正回来，
      // 否则面板会静默退回低层叠上下文，下一次点击就被别的插件的 body 级浮层接走。
      useEffect(() => {
        if (store.open !== true) return undefined
        const tick = () => {
          try { overlayHost() } catch (error) { /* 守护失败不影响面板本身 */ }
        }
        tick()
        const timer = setInterval(tick, 1200)
        return () => clearInterval(timer)
      }, [store.open])
      // D3/D4：Esc 分层关闭 + Tab 焦点留在面板内；关闭后焦点回到打开前的元素。
      const panelRef = useRef(null)
      const returnFocusRef = useRef(null)
      useEffect(() => {
        if (store.open !== true) return undefined
        try { returnFocusRef.current = document.activeElement } catch {}
        const focusFirst = () => {
          const root = panelRef.current
          if (root === null || typeof root.querySelector !== 'function') return
          const target = root.querySelector('[data-pj-autofocus]') ?? root
          try { target.focus?.() } catch {}
        }
        const timer = setTimeout(focusFirst, 30)
        const onKey = (event) => {
          if (event.key === 'Tab') {
            const root = panelRef.current
            if (root === null) return
            const nodes = Array.from(root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
              .filter((node) => node.disabled !== true && node.getAttribute?.('aria-hidden') !== 'true')
            if (nodes.length === 0) return
            const first = nodes[0]
            const last = nodes[nodes.length - 1]
            if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) {
              event.preventDefault()
              last.focus()
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault()
              first.focus()
            }
            return
          }
          if (event.key !== 'Escape') return
          // D4：搜索框里的 Esc 归搜索框。document 是 capture 阶段，比输入框自己的
          // onKeyDown 更早，所以这一支必须写在这里，否则 Esc 会先关掉整个面板。
          // 有词就先清词并留在搜索框；已经空了就只退出焦点，面板仍然不动。
          const target = event.target
          const inSearch = target !== null && typeof target === 'object' && typeof target.closest === 'function' && target.closest('[data-pj-search]') !== null
          const decision = decideEscAction(store, inSearch)
          event.preventDefault()
          event.stopPropagation()
          if (decision.clearSearch === true || decision.blurSearch === true) {
            if (decision.clearSearch === true) setState({ query: '' })
            else { try { target.blur?.() } catch { /* 退出焦点失败不影响面板 */ } }
            return
          }
          if (decision.patch !== undefined && decision.patch !== null) {
            setState(decision.patch)
            return
          }
          closePanel()
        }
        document.addEventListener('keydown', onKey, true)
        return () => {
          clearTimeout(timer)
          document.removeEventListener('keydown', onKey, true)
          try { returnFocusRef.current?.focus?.() } catch {}
        }
      }, [store.open])
      if (store.open !== true) return null
      const data = store.data
      const projects = data?.projects ?? []
      let selected = projects.find((project) => project.id === store.selectedProjectId) ?? projects[0] ?? null
      if (selected !== null && selected.id !== store.selectedProjectId) {
        setTimeout(() => setState({ selectedProjectId: selected.id }), 0)
      }
      const branchId = selected === null ? 'main' : branchSelected(selected)
      const { branch, chain } = selected === null ? { branch: { id: 'main', title: '主线', status: 'active' }, chain: [] } : projectChain(selected, branchId)
      // 选中阶段：显式选中优先；失效则退回当前阶段（该分支最后一个）。
      let phase = chain.find((item) => item.id === store.selectedPhaseId) ?? null
      if (phase === null) {
        const fallback = chain.slice(-1)[0] ?? null
        phase = fallback
        if (fallback !== null && store.selectedPhaseId !== fallback.id) {
          setTimeout(() => setState({ selectedPhaseId: fallback.id }), 0)
        }
      }
      const panePage = store.panePage ?? 'phase'
      const insTab = store.insTab ?? 'detail'
      const query = (store.query ?? '').trim()
      const tlFilter = store.tlFilter ?? 'all'
      const visibleChain = chain.filter((item) => {
        if (item.prefix === true) return true
        if (tlFilter !== 'all' && item.status !== tlFilter) return false
        if (store.tlOnlyOpen === true && !(item.problems ?? []).some((problem) => problem.status === 'open')) return false
        if (query !== '') {
          const hay = `${item.title}\n${item.summary ?? ''}\n${(item.problems ?? []).map((problem) => problem.statement ?? '').join('\n')}`
          if (!hay.includes(query)) return false
        }
        return true
      })
      const railQuery = (store.railQuery ?? '').trim()
      const railProjects = railQuery === '' ? projects : projects.filter((project) => String(project.title).includes(railQuery))
      const setPhase = (id) => setState({ selectedPhaseId: id, panePage: 'phase', insTab: 'detail' })
      const counts = {
        all: chain.length,
        active: chain.filter((item) => item.status === 'active').length,
        done: chain.filter((item) => item.status === 'done').length,
      }
      const banners = []
      if (store.error !== null && store.error !== undefined) banners.push({ kind: 'error', text: String(store.error) })
      if (data?.journalError) banners.push({ kind: 'error', text: `进展数据文件读取失败，原文件已另存为 ${data.journalError.file}；可在「设置 → 从备份恢复」里恢复。` })
      const pendingSessions = Number(data?.summary?.pending ?? 0)
      if (pendingSessions > 0) banners.push({ kind: 'warn', text: `还有 ${pendingSessions} 个会话没有汇总到最新（never ${data.summary.never ?? 0} / stale ${data.summary.stale ?? 0}）` })
      const move = store.moveSessionId
      if (move !== null && move !== undefined) {
        const moving = projects.flatMap((project) => project.sessions ?? []).find((session) => session.sessionId === move)
        banners.push({ kind: 'action', text: `迁移「${moving?.title ?? move}」：在左栏点目标项目的「迁到这里」` })
      }
      const headBanner = banners.length === 0 ? null : h(
        'div',
        { className: `pj-banner ${banners[0].kind === 'error' ? 'pj-banner-error' : ''}`, role: banners[0].kind === 'error' ? 'alert' : undefined },
        h('span', null, banners[0].text),
        banners.length > 1
          ? h('button', { className: 'pj-banner-more', type: 'button', onClick: act('banner-toggle', () => setState({ bannerOpen: store.bannerOpen !== true })) }, `另有 ${banners.length - 1} 条`)
          : null,
        move !== null && move !== undefined
          ? h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('migrate-cancel', () => setState({ moveSessionId: null })) }, '取消迁移')
          : null,
        banners[0].kind === 'error' && store.error !== null
          ? h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('error-dismiss', () => setState({ error: null })) }, '知道了')
          : null,
      )
      const bannerList = store.bannerOpen === true && banners.length > 1
        ? h('div', { className: 'pj-banner-list' }, banners.slice(1).map((item, index) => h('div', { key: index }, item.text)))
        : null
      const menuItems = [
        ['reproject', data?.reproject?.running === true ? '停止归纳' : '重新归纳本项目'],
        ['export', '导出 Markdown'],
        ['search-all', '在所有项目里搜…'],
        ['trash', '回收站'],
        ['hygiene', '数据卫生'],
        ['settings', '设置'],
        ['refresh', '刷新'],
      ]
      const onMenu = (key) => {
        setState({ menuOpen: false })
        if (key === 'settings') return setState({ panePage: 'settings', settings: true })
        if (key === 'trash') return setState({ panePage: 'trash' })
        if (key === 'hygiene') return setState({ panePage: 'hygiene' })
        if (key === 'refresh') return refresh({ force: true })
        if (key === 'export') return void exportMarkdownOf(selected)
        if (key === 'reproject') return void toggleReprojectOf(selected, data)
        if (key === 'search-all') return setState({ query: '', railQuery: '', searchAll: true })
        return undefined
      }
      return h(
        'div',
        {
          className: 'pj-root',
          ref: panelRef,
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '项目进展面板',
          tabIndex: -1,
          style: { zIndex: 2147483640 },
          onMouseDown: (event) => { event.stopPropagation(); if (event.target === event.currentTarget) closePanel() },
          onClick: stopClickBubble,
          onDoubleClick: (event) => { event.stopPropagation() },
          onPointerDown: (event) => { event.stopPropagation() },
          onPointerUp: (event) => { event.stopPropagation() },
          onWheel: (event) => { event.stopPropagation() },
        },
        h(
          'div',
          { className: 'pj-panel pj-panel2', style: { position: 'relative' } },
          h(
            'div',
            { className: 'pj-top' },
            h(Icon),
            h('span', { className: 'pj-top-title', title: selected?.title ?? '' }, selected?.title ?? '项目进展'),
            h(
              'div',
              { className: 'pj-top-tabs' },
              selected === null ? null : (selected.branches ?? [{ id: 'main', title: '主线' }]).map((item) =>
                h('button', {
                  key: item.id,
                  className: `pj-top-tab ${item.id === branchId ? 'on' : ''}`,
                  type: 'button',
                  onClick: act('branch-pick', () => setState({ branchOf: { ...store.branchOf, [selected.id]: item.id }, selectedPhaseId: null })),
                }, item.title),
              ),
              selected === null ? null : h('button', { className: 'pj-top-tab', type: 'button', title: '从当前阶段开一条新分支', onClick: act('top-fork', () => { const last = chain.slice(-1)[0]; if (last) void startForkOf(selected, last) }) }, '＋'),
            ),
            h('span', { className: 'pj-spacer', style: { flex: 1 } }),
            h('input', {
              className: 'pj-top-search',
              placeholder: '筛选当前项目的阶段…',
              'aria-label': '筛选阶段',
              'data-pj-search': '1',
              value: store.query ?? '',
              onChange: (event) => setState({ query: event.target.value }),
              onKeyDown: (event) => { if (event.key === 'Escape') { event.stopPropagation(); if ((store.query ?? '') !== '') setState({ query: '' }) } },
            }),
            h('span', { className: 'pj-top-status', title: data?.model?.ready === true ? `模型 ${data.model.model}` : '模型未就绪' },
              h('span', { className: 'pj-top-dot', style: { background: data?.model?.ready === true ? 'var(--pj-success)' : 'var(--pj-warn)' } }),
              data?.model?.ready === true ? '就绪' : '模型待配置',
            ),
            h('button', { className: 'pj-btn primary', type: 'button', onClick: act('migrate-open', () => setState({ moveSessionId: null, migrateTargetId: null, migratePickerOf: selected?.id ?? null })) }, '迁移'),
            h('button', { className: 'pj-btn', type: 'button', onClick: act('phase-create-open', () => setState({ phaseDraft: { projectId: selected?.id, branchId } })) }, '新建阶段'),
            h('button', { className: 'pj-btn ghost', type: 'button', 'aria-expanded': store.menuOpen === true, onClick: act('menu-toggle', () => setState({ menuOpen: store.menuOpen !== true })) }, '⋯'),
            store.menuOpen === true
              ? h('div', { className: 'pj-settings', style: { top: 48, right: 12, width: 190, padding: 5 } },
                  menuItems.map(([key, label]) => h('button', { key, className: 'pj-btn ghost', type: 'button', style: { display: 'block', width: '100%', textAlign: 'left' }, onClick: act(`menu-${key}`, () => onMenu(key)) }, label)))
              : null,
            h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('close-click', closePanel) }, '关闭'),
          ),
          h('div', { className: 'pj-bannerbar' }, headBanner, bannerList),
          h(
            'div',
            { className: 'pj-grid' },
            h(
              'div',
              { className: 'pj-rail' },
              h('div', { className: 'pj-rail-search' }, h('input', { placeholder: '找项目…', 'aria-label': '找项目', value: store.railQuery ?? '', onChange: (event) => setState({ railQuery: event.target.value }) })),
              h('div', { className: 'pj-rail-list' }, railProjects.map((project) => h('button', {
                key: project.id,
                className: `pj-rail-row ${selected?.id === project.id ? 'on' : ''}`,
                type: 'button',
                onClick: act('project-click', () => setState({ selectedProjectId: project.id, selectedPhaseId: null, panePage: 'phase', insTab: 'detail' })),
              },
                h('div', { className: 'pj-rail-t' }, project.title, project.locked === true ? h('span', { className: 'pj-chip', style: { marginLeft: 5 } }, '待归属') : null),
                h('div', { className: 'pj-rail-m' },
                  h('span', null, `${(project.phases ?? []).filter((item) => !item.deletedAt).length} 阶段`),
                  problemOpenCount(project) > 0 ? h('span', { className: 'pj-rail-warn' }, `● ${problemOpenCount(project)} 未解决`) : null,
                ),
                move !== null && move !== undefined && project.id !== selected?.id
                  ? h('span', {
                      className: `pj-chip ${store.migrateTargetId === project.id ? 'on' : ''}`,
                      style: { marginTop: 4 },
                      onClick: (event) => { event.stopPropagation(); setState({ migrateTargetId: project.id }) },
                    }, store.migrateTargetId === project.id ? '已选定' : '迁到这里')
                  : null,
              ))),
              h('div', { className: 'pj-rail-foot' },
                h('button', { className: 'pj-litem', type: 'button', style: { textAlign: 'left' }, onClick: act('page-trash', () => setState({ panePage: 'trash' })) }, '回收站'),
                h('button', { className: 'pj-litem', type: 'button', style: { textAlign: 'left' }, onClick: act('page-hygiene', () => setState({ panePage: 'hygiene' })) }, '数据卫生'),
                h('button', { className: 'pj-litem', type: 'button', style: { textAlign: 'left' }, onClick: act('page-settings', () => setState({ panePage: 'settings', settings: true })) }, '设置'),
              ),
            ),
            h(
              'div',
              { className: 'pj-tl' },
              h('div', { className: 'pj-tl-scroll' },
                h('div', { className: 'pj-filters', style: { margin: '0 0 10px 24px' } },
                  ...[['all', `全部 ${counts.all}`], ['active', `进行中 ${counts.active}`], ['done', `已完成 ${counts.done}`]].map(([key, label]) =>
                    h('button', { key, className: `pj-chip pj-filter ${tlFilter === key ? 'on' : ''}`, type: 'button', onClick: act(`tl-filter-${key}`, () => setState({ tlFilter: key })) }, label)),
                  h('button', { className: `pj-chip pj-filter ${store.tlOnlyOpen === true ? 'on' : ''}`, type: 'button', 'aria-pressed': store.tlOnlyOpen === true, onClick: act('tl-open-only', () => setState({ tlOnlyOpen: store.tlOnlyOpen !== true })) }, '只看未解决'),
                ),
                branchId !== 'main' ? h('div', { className: 'pj-tl-fold' }, h('span', null, `主线已走过 ${Math.max(0, (branch.fromSeq ?? 1) - 1)} 段 · 只读`), h('i')) : null,
                visibleChain.length === 0
                  ? h('div', { className: 'pj-empty2', style: { paddingLeft: 24 } }, query !== '' || tlFilter !== 'all' || store.tlOnlyOpen === true ? '当前筛选下没有阶段' : '这个分支还没有阶段：会话结束后会自动归纳，或点右上「新建阶段」手动记一条。')
                  : visibleChain.map((item, index) => h('div', {
                      key: `${item.prefix ? 'p' : 'b'}-${item.id}`,
                      className: `pj-tl-node ${item.status} ${item.id === phase?.id ? 'on' : ''}`,
                      onClick: act('phase-select', () => setPhase(item.id)),
                    },
                      h('span', { className: 'pj-tl-knob' }),
                      h('div', { className: 'pj-tl-card' },
                        h('div', { className: 'pj-tl-h' },
                          h('span', { className: 'pj-tl-idx' }, String(index + 1).padStart(2, '0')),
                          h('span', { className: 'pj-tl-title' }, item.title),
                          h('span', { className: `pj-chip ${item.status}` }, item.status === 'done' ? '已完成' : item.status === 'active' ? '进行中' : '计划中'),
                          item.redoOf ? h('span', { className: 'pj-chip redo' }, '↺') : null,
                          item.prefix ? h('span', { className: 'pj-chip' }, '主线') : null,
                          h('span', { className: 'pj-spacer', style: { flex: 1 } }),
                          h('span', { className: 'pj-chip' }, timeText(item.startedAt)),
                        ),
                        h('div', { className: 'pj-tl-sum' }, item.summary ?? '（还没有总结）'),
                        h('div', { className: 'pj-tl-badges' },
                          evidencedProblems(item).filter((problem) => problem.status === 'open').length > 0
                            ? h('span', { className: 'pj-tl-badge warn' }, `${evidencedProblems(item).filter((problem) => problem.status === 'open').length} 未解决`)
                            : null,
                          (item.nextSteps ?? []).length > 0 ? h('span', { className: 'pj-tl-badge' }, `${item.nextSteps.length} 下一步`) : null,
                          (item.artifacts ?? []).length > 0 ? h('span', { className: 'pj-tl-badge' }, `${item.artifacts.length} 产物`) : null,
                          (item.sessions ?? []).length > 0 ? h('span', { className: 'pj-tl-badge' }, `${item.sessions.length} 会话`) : null,
                        ),
                      ),
                    )),
              ),
            ),
            h(Inspector, { project: selected, data, phase, branch, panePage, insTab, chain }),
          ),
          h(
            'div',
            { className: 'pj-foot' },
            h('span', null, data?.migration?.available === true ? '迁移：可用' : `迁移：不可用（${data?.migration?.source ?? 'unknown'}）`),
            h('span', null, '每个项目只读自己的会话，跨项目不混'),
            h('span', { style: { flex: 1 } }),
            h('span', null, data?.generatedAt ? `更新于 ${new Date(data.generatedAt).toLocaleTimeString('zh-CN')}` : ''),
          ),
          h(MigratePicker, { project: selected, data }),
          move !== null && move !== undefined && store.migrateTargetId !== null
            ? h('div', { className: 'pj-confirmbar' },
                h('span', null, `把「${(selected?.sessions ?? []).find((row) => row.sessionId === move)?.title ?? move}」迁到「${(data.projects ?? []).find((item) => item.id === store.migrateTargetId)?.title ?? ''}」？`),
                h('span', { className: 'pj-spacer', style: { flex: 1 } }),
                h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('migrate-abort', () => setState({ moveSessionId: null, migrateTargetId: null })) }, '取消'),
                h('button', { className: 'pj-btn primary', type: 'button', onClick: act('migrate-confirm', () => {
                  const target = store.migrateTargetId
                  setState({ moveSessionId: null, migrateTargetId: null, migratePickerOf: null })
                  void api('/api/migrate', { sessionId: move, targetProjectId: target })
                    .then(() => refresh({ force: true }))
                    .then(() => setState({ notice: '已迁移会话' }))
                    .catch((error) => setState({ error: String(error?.message ?? error) }))
                }) }, '确认迁移'),
              )
            : null,
          h(ConfirmModal),
          selected !== null ? h(AttachModal, { project: selected }) : null,
          selected !== null ? h(PhaseCreateModal, { project: selected }) : null,
          selected !== null && typeof store.editingPhaseId === 'string' ? h(PhaseEditModal, { project: selected }) : null,
          store.forkDraft !== null && store.forkDraft !== undefined ? h(ForkDialog, { project: selected, close: () => setState({ forkDraft: null }) }) : null,
        ),
      )
    }

    // 0.5.0：右栏检视器。中栏只负责扫，内容与修改都在这里。
    // 0.5.0：迁移是「先选会话、再选目标、最后确认」。会话列表只列当前项目与「未归属」里
    // 还没隐藏的会话，避免把已裁剪上下文的会话又搬出来。
    function MigratePicker({ project, data }) {
      if (project === undefined || project === null) return null
      if (store.migratePickerOf !== project.id || store.moveSessionId !== null) return null
      const unassigned = (data?.projects ?? []).find((item) => item.id === 'unassigned')
      const rows = [...(project.sessions ?? []), ...(unassigned?.sessions ?? [])].filter((row) => row.hidden !== true)
      const q = (store.migrateQuery ?? '').trim()
      const list = rows.filter((row) => q === '' || `${row.title ?? ''} ${row.sessionId}`.includes(q))
      const close = () => setState({ migratePickerOf: null, migrateQuery: '' })
      return h('div', { className: 'pj-settings', style: { left: 12, right: 'auto', top: 58, maxHeight: '62%', overflow: 'auto', zIndex: 7 } },
        h('div', { className: 'pj-row' }, h('span', { style: { fontWeight: 600 } }, '先选一条会话'), h('span', { className: 'pj-spacer', style: { flex: 1 } }), h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('migrate-cancel', close) }, '取消')),
        h('input', { placeholder: '搜标题或 sessionId…', 'aria-label': '搜会话', value: store.migrateQuery ?? '', onChange: (event) => setState({ migrateQuery: event.target.value }) }),
        h('div', { className: 'pj-sub' }, `来源：${project.title}${(unassigned?.sessions ?? []).length > 0 ? ` + 未归属` : ''} · ${rows.length} 条`),
        rows.length === 0
          ? h('div', { className: 'pj-sub' }, '这个项目还没有会话可迁。')
          : list.map((row) => h('button', {
              key: row.sessionId,
              className: 'pj-litem',
              type: 'button',
              style: { width: '100%' },
              onClick: act('migrate-pick', () => setState({ moveSessionId: row.sessionId, migratePickerOf: null, migrateQuery: '', migrateTargetId: null })),
            },
              h('span', { style: { flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.title ?? row.sessionId),
              row.projectId === 'unassigned' || project.id === 'unassigned' ? h('span', { className: 'pj-chip' }, '未归属') : null,
            )),
        h('div', { className: 'pj-sub' }, '选完在左栏点目标项目的「迁到这里」，底部会再确认一次。'),
      )
    }

    function Inspector({ project, data, phase, branch, panePage, insTab, chain }) {
      const openSession = (sessionId) => { void openSessionById(sessionId) }
      if (project === null) return h('div', { className: 'pj-ins' }, h('div', { className: 'pj-ins-body' }, h('div', { className: 'pj-empty2' }, '还没有项目')))
      if (panePage === 'trash') {
        return h('div', { className: 'pj-ins' },
          h('div', { className: 'pj-ins-head' }, h('span', { className: 'pj-rt', style: { fontSize: 12.5, fontWeight: 600 } }, '回收站'), h('span', { className: 'pj-spacer', style: { flex: 1 } }), h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('page-back', () => setState({ panePage: 'phase' })) }, '返回')),
          h('div', { className: 'pj-ins-body' }, h(Trash, { project })),
        )
      }
      if (panePage === 'hygiene') {
        return h('div', { className: 'pj-ins' },
          h('div', { className: 'pj-ins-head' }, h('span', { style: { fontSize: 12.5, fontWeight: 600 } }, '数据卫生'), h('span', { className: 'pj-spacer', style: { flex: 1 } }), h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('page-back', () => setState({ panePage: 'phase' })) }, '返回')),
          h('div', { className: 'pj-ins-body' }, h(DataHygiene, null)),
        )
      }
      if (panePage === 'settings') {
        return h('div', { className: 'pj-ins' },
          h('div', { className: 'pj-ins-head' }, h('span', { style: { fontSize: 12.5, fontWeight: 600 } }, '设置'), h('span', { className: 'pj-spacer', style: { flex: 1 } }), h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('page-back', () => setState({ panePage: 'phase' })) }, '返回')),
          h('div', { className: 'pj-ins-body' }, h(Settings, { data, close: () => setState({ panePage: 'phase', settings: false }) })),
        )
      }
      if (phase === null) return h('div', { className: 'pj-ins' }, h('div', { className: 'pj-ins-body' }, h('div', { className: 'pj-empty2' }, '从左栏选一个项目，或建一个新阶段')))
      const readOnly = phase.prefix === true
      const artifacts = Array.isArray(phase.artifactStatus) ? phase.artifactStatus : (phase.artifacts ?? []).map((name) => ({ name, exists: true }))
      const evidenced = evidencedProblems(phase)
      const inferred = inferredProblems(phase)
      const nexts = Array.isArray(phase.nextSteps) ? phase.nextSteps : []
      const tabs = [
        ['detail', '详情'],
        ['problems', `问题 ${evidenced.length}`],
        ['next', `下一步 ${nexts.length}`],
        ['artifacts', `产物 ${artifacts.length}`],
        ['sessions', `会话 ${phase.sessions.length}`],
        ['revisions', '修订'],
      ]
      const remove = () => askConfirm(`把阶段「${phase.title}」移入回收站，并裁剪它的真实上下文？已登记的产物会移出项目目录，相关会话从项目列表隐藏且不再自动归纳；会话日志本身不删，可在回收站恢复。`, async () => {
        await api('/api/phase', { projectId: project.id, phaseId: phase.id, action: 'delete' })
        await refresh({ force: true })
        setState({ selectedPhaseId: null })
      })
      let body = null
      if (insTab === 'detail') {
        body = h('div', null,
          h('div', { className: 'pj-kv' },
            h('span', null, timeText(phase.startedAt) || '—'),
            h('span', null, `· 作者 ${phase.manual === true ? '你' : '模型'}`),
            h('span', null, `· ${branch.title}`),
            phase.revisionCount > 0 ? h('span', null, `· 手改 ${phase.revisionCount}`) : null,
          ),
          h(SummaryMetaLine, { phase }),
          h('div', { className: 'pj-sec' },
            h('div', { className: 'pj-sec-h' }, '阶段总结'),
            phase.summary ? h('div', { className: 'pj-p', style: { whiteSpace: 'pre-wrap', color: 'var(--pj-text-secondary)' } }, phase.summary) : h('div', { className: 'pj-empty2' }, '还没有总结'),
          ),
          evidenced.length > 0
            ? h('div', { className: 'pj-sec' }, h('div', { className: 'pj-sec-h' }, '问题'), evidenced.slice(0, 3).map((problem) => h('div', { className: `pj-item`, key: problem.id }, h('div', { className: 'pj-item-t' }, problem.statement), problem.resolution ? h('div', { className: 'pj-item-s' }, `处理：${problem.resolution}`) : null)))
            : null,
          readOnly ? null : h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
            h('button', { className: 'pj-btn', type: 'button', onClick: act('phase-edit-open', () => setState({ editingPhaseId: phase.id, editingPhaseProjectId: project.id })) }, '改阶段'),
            h('button', { className: 'pj-btn', type: 'button', onClick: act('fork-open', () => { void startForkOf(project, phase) }) }, '从这开分支'),
            h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('phase-delete-confirm', remove) }, '删除阶段'),
          ),
        )
      }
      if (insTab === 'problems') {
        body = h('div', null,
          evidenced.map((problem) => h('div', { className: 'pj-item', key: problem.id },
            store.editingProblemId === problem.id
              ? h(ProblemForm, { project, phase, problem, done: () => setState({ editingProblemId: null }) })
              : h('div', null,
                  h('div', { className: 'pj-item-t' }, problem.statement),
                  problem.quote ? h('div', { className: 'pj-quote', style: { marginTop: 4 } }, `「${problem.quote}」`) : null,
                  problem.resolution ? h('div', { className: 'pj-item-s' }, `处理：${problem.resolution}`) : null,
                  readOnly ? null : h('div', { className: 'pj-phase-actions' },
                    h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('problem-edit-open', () => setState({ editingProblemId: problem.id })) }, '修正'),
                    h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('problem-delete-confirm', () => askConfirm('删除这条问题记录？不可撤销。', async () => { await api('/api/problem', { projectId: project.id, phaseId: phase.id, problemId: problem.id, action: 'delete' }); await refresh({ force: true }) })) }, '删除'),
                  ),
                ),
          )),
          inferred.length > 0 ? h('div', { className: 'pj-note' }, `另有 ${inferred.length} 条无原话的推测，不计入未解决`) : null,
          readOnly ? null : h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('problem-create-open', () => setState({ problemDraftPhaseId: phase.id })) }, '+ 补一条问题记录'),
          store.problemDraftPhaseId === phase.id ? h(ProblemForm, { project, phase, done: () => setState({ problemDraftPhaseId: null }) }) : null,
        )
      }
      if (insTab === 'next') {
        body = h('div', null,
          nexts.length === 0 ? h('div', { className: 'pj-empty2' }, '还没有下一步') : nexts.map((step, index) => h('div', { className: 'pj-item', key: index, style: { display: 'flex', gap: 8, alignItems: 'flex-start' } },
            h('span', { className: 'pj-item-t', style: { flex: 1 } }, `${index + 1}. ${step}`),
            readOnly ? null : h('button', { className: 'pj-btn ghost', type: 'button', title: '移除', onClick: act('next-remove', async () => { const rest = nexts.filter((item, i) => i !== index); await api('/api/phase', { projectId: project.id, phaseId: phase.id, nextSteps: rest.join('|') }); await refresh({ force: true }) }) }, '×'),
          )),
          readOnly ? null : (store.stepDraft === phase.id
            ? h(StepForm, { project, phase, done: () => setState({ stepDraft: null }) })
            : h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('step-open', () => setState({ stepDraft: phase.id })) }, '+ 加一条下一步')),
        )
      }
      if (insTab === 'artifacts') {
        body = h('div', null,
          artifacts.length === 0 ? h('div', { className: 'pj-empty2' }, '没有登记的产物') : artifacts.map((entry, index) => h('div', { className: 'pj-item', key: index, style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('span', { className: 'pj-item-t', style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: entry.name }, `📄 ${entry.name}`),
            h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('artifact-open', (event) => { event.stopPropagation(); return openArtifact(project, entry.name) }) }, entry.exists === true ? '打开' : '已丢失'),
          )),
          readOnly ? null : h('div', { style: { display: 'flex', gap: 6 } },
            h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('rescan-artifacts', async () => { const result = await api('/api/phase/rescan', { projectId: project.id, phaseId: phase.id }); setState({ notice: (result.added ?? []).length > 0 ? `补记 ${result.added.length} 个产物` : '没有发现新产物' }); await refresh({ force: true }) }) }, '重扫产物'),
          ),
        )
      }
      if (insTab === 'sessions') {
        body = h('div', null,
          phase.sessions.length === 0 ? h('div', { className: 'pj-empty2' }, '这个阶段还没有会话') : phase.sessions.map((sessionId) => {
            const rec = (project.sessions ?? []).find((item) => item.sessionId === sessionId)
            return h('div', { className: 'pj-item', key: sessionId, style: { display: 'flex', gap: 8, alignItems: 'center' } },
              h('span', { className: 'pj-item-t', style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: rec?.cwd ?? '' }, rec?.title ?? `未命名会话 · ${String(sessionId).slice(-8)}`),
              h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('session-open', () => openSession(sessionId)) }, '打开'),
            )
          }),
        )
      }
      if (insTab === 'revisions') {
        body = h(RevisionList, { project, phase })
      }
      return h(
        'div',
        { className: 'pj-ins' },
        h('div', { className: 'pj-ins-head' },
          h('span', { style: { fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, phase.title),
          h('span', { className: 'pj-spacer', style: { flex: 1 } }),
          h('span', { className: 'pj-chip' }, branch.title),
        ),
        h('div', { className: 'pj-ins-tabs' }, tabs.map(([key, label]) => h('button', { key, className: `pj-ins-tab ${insTab === key ? 'on' : ''}`, type: 'button', onClick: act(`ins-tab-${key}`, () => setState({ insTab: key })) }, label))),
        h('div', { className: 'pj-ins-body' }, body),
        h('div', { className: 'pj-ins-foot' },
          h('button', { className: 'pj-btn', type: 'button', onClick: act('phase-edit-open', () => setState({ editingPhaseId: phase.id, editingPhaseProjectId: project.id })) }, '改阶段'),
          h('button', { className: 'pj-btn', type: 'button', onClick: act('fork-open', () => { void startForkOf(project, phase) }) }, '从这开分支'),
          h('span', { style: { flex: 1 } }),
          phase.sessions.length > 0 ? h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('session-open-first', () => openSession(phase.sessions[phase.sessions.length - 1])) }, '打开会话') : null,
        ),
      )
    }

    async function startForkOf(project, phase) {
      try {
        const seed = await api('/api/branch/seed', { projectId: project.id, phaseId: phase.id })
        setState({ forkDraft: { projectId: project.id, phaseId: phase.id, phaseTitle: phase.title, isRedo: phase.redoOf !== null && phase.redoOf !== undefined, fromSeq: seed.fromSeq, title: seed.title, prompt: seed.prompt, context: seed.context ?? null } })
      } catch (error) {
        beacon('fork-error:' + String(error?.message ?? error).slice(0, 80))
        setState({ error: String(error?.message ?? error) })
      }
    }

    async function exportMarkdownOf(project) {
      if (project === null) return
      try {
        const base = await ensureBase()
        const response = await fetch(`${base}/api/export?projectId=${encodeURIComponent(project.id)}`)
        const text = await response.text()
        try { if (navigator?.clipboard?.writeText) await navigator.clipboard.writeText(text) } catch {}
        const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = `${String(project.title).replace(/[\\/:*?"<>|]/g, '_')}-进展.md`
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        setTimeout(() => URL.revokeObjectURL(url), 4000)
        setState({ notice: '已导出 Markdown' })
      } catch (error) {
        setState({ error: String(error?.message ?? error) })
      }
    }

    async function toggleReprojectOf(project, data) {
      if (project === null) return
      const busy = data?.reproject?.running === true && data?.reproject?.projectId === project.id
      try {
        await api('/api/reproject', { projectId: project.id, action: busy ? 'stop' : 'start', rebuild: (project.phases ?? []).length === 0 ? 1 : 0 })
        await refresh({ force: true })
      } catch (error) {
        setState({ error: String(error?.message ?? error) })
      }
    }

    // A render error inside a slot must never take the surrounding app down:
    // report it once per unique message, then render nothing.
    const reported = new Set()
    function guard(label, render) {
      return function guarded(props) {
        try {
          return render(props)
        } catch (error) {
          const key = `${label}:${String(error).slice(0, 80)}`
          if (!reported.has(key)) {
            reported.add(key)
            const route = base ?? ROUTES[0]
            fetch(`${route}/api/beacon?e=render-error&d=${encodeURIComponent(key)}`).catch(() => {})
            setTimeout(() => setState({ error: `面板渲染出错（${label}）：${String(error?.message ?? error).slice(0, 120)}` }), 0)
          }
          // 出错时退化成可读提示，而不是静默空白——否则用户会以为「点了没反应」。
          return h('div', { className: 'pj-root', style: { padding: 16, fontSize: 12, color: 'var(--pj-label-warning)' } }, `这块内容渲染失败（${label}），右上角关掉面板再打开可重试。`)
        }
      }
    }

    let uiWorkspace = null

    function openSessionById(sessionId) {
      try {
        beacon('open-session')
        const ui = uiWorkspace
        if (ui === null || typeof ui.openSession !== 'function') {
          setState({ error: '会话跳转不可用（客户端未暴露 uiWorkspace），请在左侧边栏手动打开该会话' })
          return
        }
        ui.openSession(sessionId)
        setState({ open: false })
      } catch (error) {
        setState({ error: `打开会话失败：${String(error?.message ?? error).slice(0, 80)}` })
      }
    }

    async function openArtifact(project, name) {
      try {
        const base = await ensureBase()
        const response = await fetch(`${base}/api/artifact/open?projectId=${encodeURIComponent(project.id)}&name=${encodeURIComponent(name)}`)
        const result = await response.json()
        if (result?.ok !== true) {
          setState({ notice: `没找到文件「${name}」：它可能已被移动或删除；可先在项目目录里找一下。` })
        }
      } catch (error) {
        setState({ error: `打开文件失败：${String(error?.message ?? error).slice(0, 80)}` })
      }
    }

    const GuardedPanel = guard('panel', Panel)
    // shell.overlay 的容器自带较低 z-index，子元素再高也压不过古法挂在 body 上的浮层；
    // 所以把面板 portal 到 body 自己的宿主里（业界做法与古法一致）。
    const OVERLAY_HOST_STYLE = 'position:fixed;inset:0;z-index:2147483640;pointer-events:none;'
    function overlayHost() {
      let host = document.getElementById('pj-overlay-host')
      if (host === null) {
        host = document.createElement('div')
        host.id = 'pj-overlay-host'
        document.body.appendChild(host)
      }
      // 宿主必须始终是 body 的直接子节点：一旦被移走（宿主重排、其它插件挪 DOM、HMR 重建），
      // 面板就会退回 shell.overlay 那个 z-index:20 的层叠上下文，被 body 级浮层
      // （古法的 #gufa-portal-root / .gufa-overlay-root）盖住——症状正是「点哪都跳到古法」。
      // 这里每次渲染都幂等纠正，代价是一次 parentNode 比较。
      if (host.parentNode !== document.body) document.body.appendChild(host)
      if (host.style.cssText !== OVERLAY_HOST_STYLE) host.style.cssText = OVERLAY_HOST_STYLE
      return host
    }
    function Portal(props) {
      if (ReactDOM === null || typeof ReactDOM.createPortal !== 'function') return props.children
      return ReactDOM.createPortal(props.children, overlayHost())
    }
    function PortalPanel() {
      return h(Portal, null, h(Panel))
    }
    const GuardedPanelHost = guard('panel-portal', PortalPanel)
    const GuardedFooter = guard('footer', FooterButton)
    const GuardedRow = guard('row', RowButton)

    // --------------------------------------------------------------- register

    function note(message) {
      const route = base ?? ROUTES[0]
      fetch(`${route}/api/beacon?e=${encodeURIComponent(message)}`).catch(() => {})
    }

    function apply(ctx) {
      note(`client-boot:${document.visibilityState}`)
      try {
        uiWorkspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null
        note(`ui-workspace:${uiWorkspace === null ? 'missing' : 'ready'}`)
      } catch (error) {
        note(`ui-workspace-error:${String(error).slice(0, 60)}`)
      }
      note('client-v27')
      window.__pjDebug = { open: () => openPanel(), close: () => closePanel(), store, stats: () => store.stats }
      const mount = (slot, definition, component) => {
        try {
          ctx.slots.inject(slot, () => ctx.slots.register(definition, component))
          note(`slot-ok:${slot}`)
        } catch (error) {
          note(`slot-fail:${slot}:${String(error).slice(0, 70)}`)
        }
      }
      mount('shell.overlay', { name: 'shell.overlay', id: 'project-journal-panel' }, GuardedPanelHost)
      mount(
        'sidebar.footer.action',
        {
          name: 'sidebar.footer.action',
          id: 'project-journal-entry',
          order: 25,
          inject: (ownerProps) => ({ wide: ownerProps?.wide === true }),
        },
        GuardedFooter,
      )
      mount(
        'sidebar.workspaces.session.row.action',
        {
          name: 'sidebar.workspaces.session.row.action',
          id: 'project-journal-move',
          order: 300,
          inject: (ownerProps) => ({ sessionId: ownerProps?.sessionId, displayTitle: ownerProps?.displayTitle }),
        },
        GuardedRow,
      )
    }

    return {
      name: 'dsh-project-journal-client',
      inject: ['slots'],
      apply,
    }
  },
})
