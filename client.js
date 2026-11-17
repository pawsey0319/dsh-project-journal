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
    const { useState, useEffect, useMemo, useCallback } = React

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
    }

    async function api(path, params) {
      const route = await ensureBase()
      const query = new URLSearchParams()
      for (const [key, value] of Object.entries(params ?? {})) {
        if (value === undefined || value === null || value === '') continue
        query.set(key, String(value))
      }
      const suffix = query.toString() === '' ? '' : `?${query.toString()}`
      const response = await fetch(`${route}${path}${suffix}`)
      const payload = await response.json().catch(() => ({}))
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
      selectedProjectId: null,
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

    async function refresh() {
      setState({ loading: true, error: null })
      try {
        const data = await api('/api/state')
        setState({ data, loading: false })
      } catch (error) {
        setState({ loading: false, error: String(error?.message ?? error) })
      }
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
        setState({ open: true, error: null, notice: null, gufaUnderlay: gufa, ...(patch ?? {}) })
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
.pj-root{position:fixed;inset:0;z-index:2147483640;pointer-events:auto;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5)}
.pj-panel{width:min(1180px,94vw);height:min(780px,90vh);display:flex;flex-direction:column;border-radius:14px;overflow:hidden;background:var(--dsw-alias-bg-base,#191919);color:var(--dsw-alias-label-primary,#f2f2f2);border:1px solid var(--dsw-alias-border-l,#333);box-shadow:0 24px 80px rgba(0,0,0,.55);font-size:13px}
.pj-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l,#2c2c2c)}
.pj-title{font-size:14px;font-weight:600}
.pj-sub{color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:12px}
.pj-spacer{flex:1}
.pj-btn{appearance:none;border:1px solid var(--dsw-alias-border-l,#3a3a3a);background:var(--dsw-alias-interactive-bg-hover,#242424);color:inherit;border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer;line-height:1.4}
.pj-btn:hover{background:var(--dsw-alias-bg-layer-1,#2d2d2d)}
.pj-btn.primary{background:var(--dsw-alias-brand-primary,#4c6ef5);border-color:transparent;color:#fff}
.pj-btn.ghost{background:transparent}
.pj-btn:disabled{opacity:.5;cursor:default}
.pj-body{flex:1;display:flex;min-height:0}
.pj-left{width:250px;border-right:1px solid var(--dsw-alias-border-l,#2c2c2c);overflow:auto;padding:8px}
.pj-proj{padding:9px 10px;border-radius:9px;cursor:pointer;margin-bottom:4px;border:1px solid transparent}
.pj-proj:hover{background:var(--dsw-alias-interactive-bg-hover,#232323)}
.pj-proj.active{background:var(--dsw-alias-bg-layer-1,#262626);border-color:var(--dsw-alias-border-l,#3a3a3a)}
.pj-proj.picked{border-color:var(--dsw-alias-state-warn-primary,#e8a33d);background:rgba(232,163,61,.12)}
.pj-proj-title{font-weight:600;font-size:12.5px;display:flex;align-items:center;gap:6px}
.pj-proj-next{color:var(--dsw-alias-brand-primary,#7aa2ff)}
.pj-proj-meta{color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:11px;margin-top:3px;display:flex;gap:8px;flex-wrap:wrap}
.pj-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#e8a33d);display:inline-block}
.pj-main{flex:1;overflow:auto;padding:16px 20px}
.pj-empty{color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:12.5px;padding:24px 4px;line-height:1.7}
.pj-chain{position:relative;margin-left:6px;padding-left:20px;border-left:1px dashed var(--dsw-alias-border-l,#3a3a3a)}
.pj-phase{position:relative;margin-bottom:14px;padding:12px 14px;border-radius:11px;background:var(--dsw-alias-bg-layer-1,#212121);border:1px solid var(--dsw-alias-border-l,#303030)}
.pj-phase::before{content:'';position:absolute;left:-26px;top:18px;width:9px;height:9px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#666);border:2px solid var(--dsw-alias-bg-base,#191919)}
.pj-phase.active::before{background:var(--dsw-alias-state-warn-primary,#e8a33d)}
.pj-phase.done::before{background:var(--dsw-alias-state-success-primary,#39b980)}
.pj-phase-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pj-seq{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-variant-numeric:tabular-nums}
.pj-phase-title{font-weight:600;font-size:13.5px}
.pj-chip{font-size:10.5px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l,#3a3a3a);color:var(--dsw-alias-label-secondary,#b5b5b5)}
.pj-chip.active{color:var(--dsw-alias-state-warn-primary,#e8a33d);border-color:rgba(232,163,61,.5)}
.pj-chip.done{color:var(--dsw-alias-state-success-primary,#39b980);border-color:rgba(57,185,128,.5)}
.pj-chip.current{color:var(--dsw-alias-label-primary,#f2f2f2);border-color:var(--dsw-alias-border-l2,#6a6a6a);font-weight:600}
.pj-phase-summary{margin-top:7px;line-height:1.75;color:var(--dsw-alias-label-secondary,#c9c9c9);white-space:pre-wrap}
.pj-problems{margin-top:9px;display:flex;flex-direction:column;gap:7px}
.pj-problem{border-left:2px solid var(--dsw-alias-state-warn-primary,#e8a33d);padding:2px 0 2px 9px}
.pj-problem.open{border-left-color:var(--dsw-alias-state-error-primary,#e5534b)}
.pj-problem-st{font-size:12.5px;line-height:1.6}
.pj-quote{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#9a9a9a);margin-top:3px;font-style:italic;line-height:1.6}
.pj-res{font-size:12px;color:var(--dsw-alias-label-secondary,#b9b9b9);margin-top:3px;line-height:1.6}
.pj-artifacts{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap}
.pj-art-btn{cursor:pointer;border:1px solid var(--dsw-alias-border-l1,#444);background:var(--dsw-alias-bg-l2,#1d1d1d);font:inherit}
.pj-art-btn:hover{border-color:var(--dsw-alias-brand-primary,#7aa2ff);color:var(--dsw-alias-brand-primary,#7aa2ff)}
.pj-search{width:180px;height:26px;margin-left:8px;font-size:12px}
.pj-hits{display:flex;flex-direction:column;gap:8px}
.pj-hit{padding:9px 11px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1,#333);background:var(--dsw-alias-bg-l1,#181818);cursor:pointer}
.pj-hit:hover{border-color:var(--dsw-alias-brand-primary,#7aa2ff)}
.pj-hit-top{display:flex;gap:8px;align-items:center;margin-bottom:3px}
.pj-hit-title{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary,#f2f2f2)}
.pj-hit-text{margin-top:5px;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary,#cfcfcf);white-space:pre-wrap}
.pj-suggest{margin:0 0 10px;padding:9px 11px;border-radius:9px;background:var(--dsw-alias-bg-l2,#1e1e1e);border:1px solid var(--dsw-alias-warning,#8a6d3b)}
.pj-suggest-h{font-size:11.5px;font-weight:600;color:var(--dsw-alias-warning,#e0b25a);margin-bottom:5px}
.pj-suggest-row{display:flex;gap:8px;align-items:center;justify-content:space-between;font-size:11.5px;color:var(--dsw-alias-label-secondary,#cfcfcf);padding:2px 0}
.pj-suggest-text{flex:1;word-break:break-all}
.pj-nextbar{margin:0 0 10px;padding:9px 11px;border-radius:9px;background:linear-gradient(180deg,var(--dsw-alias-bg-l2,#1e1e1e),var(--dsw-alias-bg-l1,#181818));border:1px solid var(--dsw-alias-border-l1,#333)}
.pj-nextbar-h{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-primary,#f2f2f2);margin-bottom:5px}
.pj-next{margin-top:9px;padding:7px 9px;border-radius:8px;background:var(--dsw-alias-bg-l2,#1d1d1d);border:1px solid var(--dsw-alias-border-l1,#333)}
.pj-next-h{font-size:11px;color:var(--dsw-alias-label-tertiary,#a0a0a0);margin-bottom:4px}
.pj-next-item{display:flex;align-items:flex-start;gap:6px;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary,#cfcfcf)}
.pj-next-dot{color:var(--dsw-alias-brand-primary,#7aa2ff)}
.pj-next-text{flex:1;word-break:break-word}
.pj-next-x{padding:0 4px;font-size:11px;line-height:1.2;opacity:.55}
.pj-next-x:hover{opacity:1}
.pj-art{font-size:11px;padding:1px 6px;border-radius:5px;background:var(--dsw-alias-bg-module-platform,#2a2a2a);color:var(--dsw-alias-label-tertiary,#a0a0a0);font-family:ui-monospace,monospace}
.pj-phase-actions{display:flex;gap:6px;margin-top:9px;opacity:.85}
.pj-input,.pj-area{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-base,#141414);color:inherit;border:1px solid var(--dsw-alias-border-l,#3a3a3a);border-radius:7px;padding:6px 8px;font-size:12.5px;font-family:inherit;line-height:1.55}
.pj-area{resize:vertical;min-height:64px}
.pj-form{display:flex;flex-direction:column;gap:7px;margin-top:9px}
.pj-row{display:flex;gap:7px;align-items:center}
.pj-banner{padding:8px 16px;background:rgba(232,163,61,.14);border-bottom:1px solid rgba(232,163,61,.35);font-size:12.5px;display:flex;gap:10px;align-items:center}
.pj-trash{margin-top:14px;border-top:1px dashed var(--dsw-alias-border-l2,#4a4a4a);padding-top:8px}
.pj-trash-toggle{background:transparent;border:0;color:var(--dsw-alias-label-secondary,#b4b4b4);font-size:11.5px;cursor:pointer;padding:2px 0}
.pj-trash-row{display:flex;gap:8px;align-items:center;padding:4px 0;font-size:11.5px;color:var(--dsw-alias-label-secondary,#b4b4b4)}
.pj-trash-title{color:var(--dsw-alias-label-primary,#f2f2f2)}
.pj-revs{margin-top:10px;border-top:1px solid var(--dsw-alias-border-l2,#3a3a3a);padding-top:8px;max-height:230px;overflow:auto}
.pj-rev{border:1px solid var(--dsw-alias-border-l2,#3a3a3a);border-radius:8px;padding:6px 8px;margin-bottom:6px}
.pj-rev-head{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.pj-rev-time{font-size:11px;color:var(--dsw-alias-label-tertiary,#a0a0a0)}
.pj-rev-body{font-size:12px;color:var(--dsw-alias-label-secondary,#c8c8c8);margin-top:4px;line-height:1.5}
.pj-filters{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:8px 0}
.pj-filter{cursor:pointer;border:1px solid var(--dsw-alias-border-l1,#444);background:transparent}
.pj-filter.on{border-color:var(--dsw-alias-brand-primary,#7aa2ff);color:var(--dsw-alias-brand-primary,#7aa2ff)}
.pj-note{font-size:11px;color:var(--dsw-alias-label-tertiary,#a0a0a0);margin-left:8px}
.pj-notice{padding:8px 16px;background:rgba(57,185,128,.14);color:var(--dsw-alias-state-success-primary,#7ee0b0);font-size:12px;display:flex;gap:12px;align-items:center;justify-content:space-between}
.pj-error{padding:8px 16px;background:rgba(229,83,75,.14);color:var(--dsw-alias-state-error-primary,#f0857d);font-size:12px}
.pj-foot{padding:7px 16px;border-top:1px solid var(--dsw-alias-border-l,#2c2c2c);color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:11px;display:flex;gap:14px;flex-wrap:wrap;align-items:center}
.pj-settings{position:absolute;right:18px;top:56px;width:340px;background:var(--dsw-alias-bg-base,#1c1c1c);border:1px solid var(--dsw-alias-border-l,#3a3a3a);border-radius:11px;padding:14px;box-shadow:0 16px 40px rgba(0,0,0,.5);z-index:5;display:flex;flex-direction:column;gap:9px}
.pj-label{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a);margin-bottom:-4px}
.pj-icon{width:16px;height:16px;display:block}
.pj-entry{appearance:none;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,#b5b5b5);border-radius:8px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:4px 7px;font-size:12px;line-height:1}
.pj-entry:hover{background:var(--dsw-alias-interactive-bg-hover,#262626);color:var(--dsw-alias-label-primary,#eee)}
.pj-rowbtn{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8a8a);border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0}
.pj-rowbtn:hover{background:var(--dsw-alias-interactive-bg-hover,#2b2b2b);color:var(--dsw-alias-label-primary,#eee)}
.pj-tabs{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:12px;border-bottom:1px solid var(--dsw-alias-border-l,#2c2c2c);padding-bottom:9px}
.pj-tab{appearance:none;display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l,#3a3a3a);background:transparent;color:var(--dsw-alias-label-secondary,#b5b5b5);border-radius:8px;padding:4px 9px;font-size:12px;cursor:pointer;line-height:1.5}
.pj-tab:hover{background:var(--dsw-alias-interactive-bg-hover,#262626)}
.pj-tab.active{background:var(--dsw-alias-bg-layer-1,#262626);border-color:var(--dsw-alias-brand-primary,#4c6ef5);color:var(--dsw-alias-label-primary,#f2f2f2)}
.pj-tab.abandoned{opacity:.55}
.pj-tabsrc{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.pj-tabcount{font-size:10px;min-width:14px;height:14px;border-radius:999px;background:var(--dsw-alias-bg-module-platform,#2e2e2e);color:var(--dsw-alias-label-tertiary,#a0a0a0);display:inline-flex;align-items:center;justify-content:center;padding:0 4px}
.pj-phase.prefix{opacity:.5;background:transparent;border-style:dashed}
.pj-phase.prefix::before{background:var(--dsw-alias-label-tertiary,#555)}
.pj-prefix-note{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a);margin-bottom:6px}
.pj-sessions{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.pj-chip.session{cursor:pointer;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pj-chip.redo{color:var(--dsw-alias-state-warn-primary,#e8a33d);border-color:rgba(232,163,61,.5)}
.pj-chip.abandoned{color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.pj-backups{display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto;margin-top:4px}
.pj-backup-row{display:flex;gap:8px;align-items:center;padding:6px 8px;border:1px solid var(--dsw-alias-border-l,#2c2c2c);border-radius:8px}
.pj-modal{position:absolute;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:8}
.pj-modal-box{width:min(560px,86vw);background:var(--dsw-alias-bg-base,#1c1c1c);border:1px solid var(--dsw-alias-border-l,#3a3a3a);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px;box-shadow:0 20px 60px rgba(0,0,0,.6)}
.pj-branchbar{display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap}
.pj-badge{font-size:10px;min-width:15px;height:15px;padding:0 4px;border-radius:999px;background:var(--dsw-alias-state-warn-primary,#e8a33d);color:#1a1a1a;display:inline-flex;align-items:center;justify-content:center;font-weight:600}
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

    function nextCount(project) {
      const phase = currentPhase(project)
      if (phase === null || phase.prefix === true) return 0
      return Array.isArray(phase.nextSteps) ? phase.nextSteps.length : 0
    }

    function problemOpenCount(project) {
      let count = 0
      for (const phase of project.phases) for (const problem of phase.problems) if (problem.status === 'open') count += 1
      return count
    }

    // ------------------------------------------------------------ entry seats

    function FooterButton(props) {
      useStore()
      ensureStyle()
      const data = store.data
      const open = (data?.projects ?? []).reduce(
        (total, project) => total + project.phases.reduce((sum, phase) => sum + phase.problems.filter((problem) => problem.status === 'open').length, 0),
        0,
      )
      const nextTotal = (data?.projects ?? []).reduce((total, project) => total + nextCount(project), 0)
      const running = data?.backfill?.state === 'running'
      return h(
        'button',
        {
          className: 'pj-entry',
          type: 'button',
          title: `${open} 个未解决问题 · ${nextTotal} 条下一步`,
          onClick: act('entry-click', () => openPanel()),
        },
        h(Icon),
        props.wide === true ? h('span', null, '进展') : null,
        open > 0 ? h('span', { className: 'pj-badge' }, String(open)) : nextTotal > 0 ? h('span', { className: 'pj-badge', style: { background: '#3f6f5a', color: '#fff' } }, String(nextTotal)) : running ? h('span', { className: 'pj-badge', style: { background: '#4c6ef5', color: '#fff' } }, '…') : null,
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

    function RevisionList({ project, phase }) {
      const [busy, setBusy] = useState(null)
      const revisions = Array.isArray(phase.revisions) ? [...phase.revisions].reverse() : []
      if (revisions.length === 0) return h('div', { className: 'pj-note', style: { marginTop: 10 } }, '还没有修订历史（保存过一次编辑后才会出现）。')
      const restore = async (at) => {
        setBusy(at)
        try {
          await api('/api/phase/restore-revision', { projectId: project.id, phaseId: phase.id, at })
          await refresh()
          setState({ notice: '已回到那一版，本次回退也记了一条修订' })
        } finally {
          setBusy(null)
        }
      }
      return h(
        'div',
        { className: 'pj-revs' },
        h('div', { className: 'pj-note', style: { marginBottom: 4 } }, `修订历史 · 共 ${phase.revisionCount ?? revisions.length} 条，最近 ${revisions.length} 条`),
        revisions.map((item) =>
          h(
            'div',
            { className: 'pj-rev', key: item.at },
            h('div', { className: 'pj-rev-head' },
              h('span', { className: 'pj-rev-time' }, new Date(item.at).toLocaleString()),
              h('span', { className: 'pj-chip' }, changedLabels(item.before, item.after).join(' / ')),
              item.restoredFrom ? h('span', { className: 'pj-chip' }, '回退记录') : null,
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
          { className: 'pj-modal-box', style: { width: 'min(680px,92vw)' } },
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
          { className: 'pj-modal-box', style: { width: 'min(720px,94vw)' } },
          h('div', { className: 'pj-title' }, '分支 vs 主线'),
          error !== null ? h('div', { className: 'pj-error' }, error) : null,
          data === null
            ? h('div', { className: 'pj-note' }, '加载中…')
            : h(
              'div',
              null,
              h('div', { className: 'pj-sub' }, `${data.branch.title ?? '分支'} · 状态 ${data.branch.status} · 从主线第 ${Number(data.branch.fromSeq)} 阶段之后分叉`),
              h('div', { className: 'pj-rev' },
                h('div', { className: 'pj-rev-head' }, h('span', { className: 'pj-chip' }, `分支阶段 ${data.branchPhases.length}`), h('span', { className: 'pj-chip' }, `主线后续阶段 ${data.mainAfterFork.length}`), h('span', { className: 'pj-chip' }, `未解决问题 分支 ${data.openProblems.branch} / 主线 ${data.openProblems.mainAfterFork}`)),
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
        { className: 'pj-settings' },
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
        data?.model?.error ? h('div', { className: 'pj-error', style: { borderRadius: 8 } }, data.model.error) : null,
      )
    }

    function PhaseCard({ project, phase, index, onFork }) {
      const [problemDraft, setProblemDraft] = useState(null)
      const [busy, setBusy] = useState(false)
      const remove = () => {
        askConfirm(`把阶段「${phase.title}」移入回收站，并裁剪它的真实上下文？该阶段已登记的产物会移出项目目录（后续会话/检索读不到），相关会话从项目列表隐藏且不再自动归纳；会话日志本身不删。注意：只裁剪登记在「产物」里的文件——如果这个阶段有产出没记进来，先点「重扫产物」补登记。误删可在阶段链底部「已删除」里恢复。`, async () => {
          setBusy(true)
          try {
            await api('/api/phase', { projectId: project.id, phaseId: phase.id, action: 'delete' })
            await refresh()
          } finally {
            setBusy(false)
          }
        })
      }
      const rescan = async () => {
        try {
          const result = await api('/api/phase/rescan', { projectId: project.id, phaseId: phase.id })
          setState({ notice: result.added.length > 0 ? `补记了 ${result.added.length} 个产物：${result.added.join('、')}` : '没有发现新的产物文件' })
          await refresh()
        } catch (error) {
          setState({ error: String(error?.message ?? error) })
        }
      }
      const readOnly = phase.prefix === true
      return h(
        'div',
        { className: `pj-phase ${phase.status}${readOnly ? ' prefix' : ''}` },
        h(
          'div',
          { className: 'pj-phase-top' },
          h('span', { className: 'pj-seq' }, String(index + 1).padStart(2, '0')),
          h('span', { className: 'pj-phase-title' }, phase.title),
          h('span', { className: `pj-chip ${phase.status}` }, phase.status === 'done' ? '已完成' : phase.status === 'active' ? '进行中' : '计划中'),
          phase.redoOf ? h('span', { className: 'pj-chip redo' }, '↺ 重做') : null,
          phase.current ? h('span', { className: 'pj-chip current' }, '当前阶段') : null,
          readOnly ? h('span', { className: 'pj-chip abandoned' }, '主线已走过') : null,
          phase.manual === true
            ? h('span', { className: 'pj-chip', title: '这条进展记录被手动改过，修订历史保留在数据里，后续自动总结不会覆盖' }, `手改${Number(phase.revisionCount ?? 0) > 0 ? ` ${phase.revisionCount}` : ''}`)
            : null,
          h('span', { className: 'pj-spacer', style: { flex: 1 } }),
          h('span', { className: 'pj-seq' }, timeText(phase.startedAt)),
        ),
        phase.summary ? h('div', { className: 'pj-phase-summary' }, phase.summary) : null,
        phase.artifacts.length > 0
          ? h(
              'div',
              { className: 'pj-artifacts' },
              phase.artifacts.map((artifact, index) =>
                h(
                  'button',
                  {
                    className: 'pj-art pj-art-btn',
                    type: 'button',
                    key: index,
                    title: `打开 ${artifact}`,
                    onClick: act('artifact-open', (event) => {
                      event.stopPropagation()
                      return openArtifact(project, artifact)
                    }),
                  },
                  artifact,
                ),
              ),
            )
          : null,
        phase.status === 'active' && (phase.nextSteps ?? []).length === 0 && readOnly !== true
          ? h('div', { className: 'pj-note', style: { marginTop: 4 } }, '这个阶段还没有「下一步」——点下面的「+ 下一步」补一条。')
          : null,
        (phase.nextSteps ?? []).length > 0
          ? h(
              'div',
              { className: 'pj-next' },
              h('div', { className: 'pj-next-h' }, `下一步 · ${phase.nextSteps.length}`),
              phase.nextSteps.map((step, stepIndex) =>
                h(
                  'div',
                  { className: 'pj-next-item', key: stepIndex },
                  h('span', { className: 'pj-next-dot' }, '·'),
                  h('span', { className: 'pj-next-text' }, step),
                  readOnly
                    ? null
                    : h(
                        'button',
                        {
                          className: 'pj-btn ghost pj-next-x',
                          type: 'button',
                          title: '移除这一条',
                          onClick: act('next-step-remove', async () => {
                            const next = phase.nextSteps.filter((item, index2) => index2 !== stepIndex)
                            await api('/api/phase', { projectId: project.id, phaseId: phase.id, nextSteps: next.join('|') })
                            await refresh()
                          }),
                        },
                        '×',
                      ),
                ),
              ),
            )
          : null,
        h(
          'div',
          { className: 'pj-problems' },
          phase.problems.map((problem) =>
            h(
              'div',
              { className: `pj-problem ${problem.status === 'open' ? 'open' : ''}`, key: problem.id },
              store.editingProblemId === problem.id
                ? h(ProblemForm, { project, phase, problem, done: () => setState({ editingProblemId: null }) })
                : h(
                    'div',
                    null,
                    h('div', { className: 'pj-problem-st' }, problem.statement),
                    problem.quote ? h('div', { className: 'pj-quote' }, `「${problem.quote}」`) : null,
                    problem.resolution ? h('div', { className: 'pj-res' }, `处理：${problem.resolution}`) : null,
                    h(
                      'div',
                      { className: 'pj-phase-actions' },
                      h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('problem-edit-open', () => setState({ editingProblemId: problem.id })) }, '修正'),
                      h(
                        'button',
                        {
                          className: 'pj-btn ghost',
                          type: 'button',
                          onClick: act('problem-delete-confirm', () => {
                            askConfirm('删除这条问题记录？不可撤销。', async () => {
                              await api('/api/problem', { projectId: project.id, phaseId: phase.id, problemId: problem.id, action: 'delete' })
                              await refresh()
                            })
                          }),
                        },
                        '删除',
                      ),
                    ),
                  ),
            ),
          ),
          readOnly ? null : problemDraft === phase.id
            ? h(ProblemForm, { project, phase, done: () => setProblemDraft(null) })
            : h('button', { className: 'pj-btn ghost', type: 'button', style: { alignSelf: 'flex-start', fontSize: 11.5 }, onClick: act('problem-create-open', () => setProblemDraft(phase.id)) }, '+ 补一条问题记录'),
        ),
        h(
          'div',
          { className: 'pj-phase-actions' },
          readOnly ? null : h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('phase-edit-open', () => setState({ editingPhaseId: phase.id, editingPhaseProjectId: project.id })) }, '改阶段'),
          readOnly
            ? null
            : store.stepDraft === phase.id
              ? h(StepForm, { project, phase, done: () => setState({ stepDraft: null }) })
              : h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('step-open', () => setState({ stepDraft: phase.id })) }, '+ 下一步'),
          h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('fork-open', () => onFork(phase)) }, readOnly ? '从主线此阶段开分支' : '从此阶段开分支'),
          readOnly
            ? null
            : h('button', { className: 'pj-btn ghost', type: 'button', title: '重新扫描项目目录，把该阶段之后产出、但没记进产物的文件补进来（否则删除阶段时不会被裁剪）', onClick: act('rescan-artifacts', () => { void rescan() }) }, '重扫产物'),
          readOnly ? null : h('button', { className: 'pj-btn ghost', type: 'button', disabled: busy, onClick: act('phase-delete-confirm', remove) }, '删除阶段'),
          phase.sessions.length === 0
            ? h('span', { className: 'pj-seq' }, '无会话')
            : h(
                'div',
                { className: 'pj-sessions' },
                phase.sessions.map((sessionId) => {
                  const rec = (project.sessions ?? []).find((item) => item.sessionId === sessionId)
                  return h(
                    'button',
                    {
                      key: sessionId,
                      className: 'pj-chip session',
                      type: 'button',
                      title: `${rec?.title ?? sessionId}\n${rec?.cwd ?? ''}\n点击打开会话`,
                      onClick: act('session-chip', () => openSessionById(sessionId)),
                    },
                    `会话 ${(rec?.title ?? sessionId).slice(0, 18)}`,
                  )
                }),
              ),
        ),
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
        { className: 'pj-suggest', style: { borderColor: '#7a5a2e' } },
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
          { className: 'pj-modal-box' },
          h('div', { className: 'pj-title' }, `从「${draft.phaseTitle ?? ''}」开一条重做分支`),
          h('div', { className: 'pj-sub' }, '原来的阶段不会删除；新分支从这一步重新做，进展链里两条线都能看。勾选「承接上下文」时，新会话会继承该阶段结束时的对话历史。代码文件不会被改动。'),
          draft?.isRedo === true
            ? h('div', { className: 'pj-sub', style: { color: 'var(--dsw-alias-label-warning,#e0a030)' } }, '提示：这是「重做」阶段本身，从这里再开分支会形成二级重做，分支名默认带「重做²」，避免和上一个重做分支同名。')
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

    function ProjectDetail({ project, data }) {
      const move = store.moveSessionId
      const branches = project.branches ?? []
      const currentId = branchSelected(project)
      const branch = branches.find((item) => item.id === currentId) ?? branches[0] ?? { id: 'main', title: '主线', status: 'active', fromSeq: null }
      const mainPhases = project.phases.filter((phase) => (phase.branchId ?? 'main') === 'main')
      const ownPhases = currentId === 'main' ? mainPhases : project.phases.filter((phase) => phase.branchId === currentId)
      const prefixPhases = currentId === 'main' ? [] : mainPhases.filter((phase) => phase.seq < (branch.fromSeq ?? 0)).map((phase) => ({ ...phase, prefix: true }))
      const chainPhases = [...prefixPhases, ...ownPhases]
      const pickBranch = (id) => setState({ branchOf: { ...store.branchOf, [project.id]: id } })
      const startFork = async (phase) => {
        try {
          const seed = await api('/api/branch/seed', { projectId: project.id, phaseId: phase.id })
          setState({ forkDraft: { projectId: project.id, phaseId: phase.id, phaseTitle: phase.title, isRedo: phase.redoOf !== null && phase.redoOf !== undefined, fromSeq: seed.fromSeq, title: seed.title, prompt: seed.prompt, context: seed.context ?? null } })
        } catch (error) {
          beacon('fork-error:' + String(error?.message ?? error).slice(0, 80))
          setState({ error: String(error?.message ?? error) })
        }
      }
      const setBranch = async (action) => {
        try {
          await api('/api/branch/status', { projectId: project.id, branchId: currentId, action })
          await refresh()
        } catch (error) {
          setState({ error: String(error?.message ?? error) })
        }
      }
      const dropBranch = () => {
        const remove = async (force) => {
          const result = await api('/api/branch/delete', { projectId: project.id, branchId: currentId, force: force ? 1 : undefined })
          setState({ branchOf: { ...store.branchOf, [project.id]: 'main' }, notice: force
            ? `分支已删除；${result.softDeleted ?? 0} 个阶段移进回收站，${result.sessionsMoved ?? 0} 个会话回到主线`
            : `分支已删除` })
          await refresh()
        }
        askConfirm(`删除分支「${branch.title}」？分支里的阶段会一起移进回收站（不论有没有内容，阶段链底部「已删除」可恢复），有内容的阶段还会从项目视角隐藏相关会话，但对话历史不删。`, async () => {
          try {
            await remove(false)
          } catch (error) {
            if (error?.code !== 'branch-not-empty') {
              setState({ error: String(error?.message ?? error) })
              return
            }
            askConfirm('这个分支里还有会话或总结。继续删除会把它们转进回收站（可在「已删除」里恢复），并从主线视角隐藏相关会话。确定继续？', async () => {
              try {
                await remove(true)
              } catch (inner) {
                setState({ error: String(inner?.message ?? inner) })
              }
            })
          }
        })
      }
      const mergeIntoMain = () => {
        askConfirm(`把分支「${branch.title}」的阶段按顺序并入主线？并入后这些阶段会出现在主线链里，分支保留为「已合并」可查看。`, async () => {
          try {
            const result = await api('/api/branch/merge', { projectId: project.id, branchId: currentId })
            const conflicts = Array.isArray(result.conflicts) ? result.conflicts : []
            setState({ branchOf: { ...store.branchOf, [project.id]: 'main' }, notice: conflicts.length === 0
              ? `已把 ${result.moved} 个阶段并入主线`
              : `已把 ${result.moved} 个阶段并入主线；有 ${conflicts.length} 个阶段和主线同名（${conflicts.map((item) => item.phaseTitle).join('、')}），建议在主线里合并或删掉重复的那份` })
            await refresh()
          } catch (error) {
            setState({ error: String(error?.message ?? error) })
          }
        })
      }
      const openAttach = async () => {
        try {
          const result = await api('/api/backups').catch(() => null)
          void result
          setState({ attachFor: { projectId: project.id, branchId: currentId } })
        } catch (error) {
          setState({ error: String(error?.message ?? error) })
        }
      }
      const addPhase = () => setState({ phaseDraft: { projectId: project.id, branchId: currentId } })
      const exportMarkdown = async () => {
        try {
          const base = await ensureBase()
          const response = await fetch(`${base}/api/export?projectId=${encodeURIComponent(project.id)}`)
          const text = await response.text()
          try {
            if (navigator?.clipboard?.writeText) await navigator.clipboard.writeText(text)
          } catch {}
          const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = `${String(project.title).replace(/[\\/:*?"<>|]/g, '_')}-进展.md`
          document.body.appendChild(anchor)
          anchor.click()
          anchor.remove()
          setTimeout(() => URL.revokeObjectURL(url), 4000)
          setState({ notice: '已导出 Markdown（同时尝试复制到剪贴板）' })
        } catch (error) {
          setState({ error: String(error?.message ?? error) })
        }
      }
      const startRename = () => setState({ renameDraft: currentId })
      const unmergeFromMain = async () => {
        try {
          const result = await api('/api/branch/unmerge', { projectId: project.id, branchId: currentId })
          const restored = Number(result?.restored ?? 0)
          setState({ notice: restored > 0 ? `已撤销合并，${restored} 个阶段回到该分支` : '已撤销合并（该分支没有可回退的阶段）' })
          await refresh()
        } catch (error) {
          setState({ error: String(error?.message ?? error) })
        }
      }
      const repro = data?.reproject ?? null
      const reprojectBusy = repro?.running === true && repro?.projectId === project.id
      const reprojectLabel = reprojectBusy
        ? `归纳中 ${repro.done}/${repro.total} · 停止`
        : '重新归纳本项目'
      const toggleReproject = async () => {
        try {
          await api('/api/reproject', {
            projectId: project.id,
            action: reprojectBusy ? 'stop' : 'start',
            rebuild: project.phases.length === 0 ? 1 : 0,
          })
          await refresh()
        } catch (error) {
          setState({ error: String(error?.message ?? error) })
        } finally {
          setTimeout(() => { refresh() }, 1200)
        }
      }
      const filter = store.phaseFilter ?? 'all'
      const onlyOpen = store.onlyOpen === true
      const visiblePhases = chainPhases.filter((phase) => {
        if (filter !== 'all' && phase.status !== filter) return false
        if (onlyOpen && !(phase.problems ?? []).some((problem) => problem.status === 'open')) return false
        return true
      })
      const counts = {
        all: chainPhases.length,
        active: chainPhases.filter((phase) => phase.status === 'active').length,
        done: chainPhases.filter((phase) => phase.status === 'done').length,
        planned: chainPhases.filter((phase) => phase.status === 'planned').length,
      }
      const filterBar = h(
        'div',
        { className: 'pj-filters' },
        h('span', { className: 'pj-note' }, '筛选：'),
        ...[
          ['all', `全部 ${counts.all}`],
          ['active', `进行中 ${counts.active}`],
          ['done', `已完成 ${counts.done}`],
          ['planned', `计划中 ${counts.planned}`],
        ].map(([key, label]) =>
          h(
            'button',
            { key, className: `pj-chip pj-filter ${filter === key ? 'on' : ''}`, type: 'button', onClick: act(`filter-${key}`, () => setState({ phaseFilter: key })) },
            label,
          ),
        ),
        h(
          'button',
          { className: `pj-chip pj-filter ${onlyOpen ? 'on' : ''}`, type: 'button', onClick: act('filter-open-only', () => setState({ onlyOpen: onlyOpen !== true })) },
          '只看有未解决问题',
        ),
      )
      const chain = h(
        'div',
        { className: 'pj-chain' },
        visiblePhases.length === 0
          ? h('div', { className: 'pj-empty' }, filter !== 'all' || onlyOpen ? '当前筛选下没有阶段，换个筛选条件试试。' :
              currentId === 'main'
                ? project.locked === true
                  ? '这个项目是「未归属会话」（不属于任何工作区）。点右上「重新归纳本项目」可以让模型按会话自身目标归纳阶段；也可以「新建阶段」手动记一条，或把会话迁进某个项目。'
                  : '这个项目还没有阶段。会话结束后会自动归纳；也可以点右上「新建阶段」手动记一条，或到设置里启动历史回填。'
                : '这条分支还没有阶段。新会话结束后会自动归纳到这里，也可以点右上「新建阶段」手动加一条。')
          : visiblePhases.map((phase, index) => h(PhaseCard, { project, phase, index, key: `${phase.prefix ? 'p' : 'b'}-${phase.id}`, onFork: startFork })),
      )
      const suggestions = Array.isArray(project.suggestions) ? project.suggestions : []
      const suggestBar = suggestions.length === 0
        ? null
        : h(
            'div',
            { className: 'pj-suggest' },
            h('div', { className: 'pj-suggest-h' }, `有 ${suggestions.length} 个会话的工作目录不属于当前项目`),
            suggestions.map((item) =>
              h(
                'div',
                { className: 'pj-suggest-row', key: item.sessionId },
                h('span', { className: 'pj-suggest-text' }, `「${item.title}」的目录是 ${item.cwd}，更像「${item.targetTitle}」`),
                h(
                  'button',
                  {
                    className: 'pj-btn',
                    type: 'button',
                    onClick: act('migrate-suggest', async () => {
                      try {
                        await api('/api/migrate', { sessionId: item.sessionId, targetProjectId: item.targetProjectId })
                        await refresh()
                      } catch (error) {
                        setState({ error: String(error?.message ?? error) })
                      }
                    }),
                  },
                  `迁到「${item.targetTitle}」`,
                ),
              ),
            ),
          )
      const groups = (() => {
        if (project.locked !== true) return []
        const map = new Map()
        for (const session of project.sessions ?? []) {
          const key = typeof session.cwd === 'string' && session.cwd !== '' ? session.cwd : '（未知目录）'
          map.set(key, (map.get(key) ?? 0) + 1)
        }
        return [...map.entries()].sort((left, right) => right[1] - left[1])
      })()
      const groupBar = groups.length === 0
        ? null
        : h(
            'div',
            { className: 'pj-suggest', style: { borderColor: '#3f4a5f' } },
            h('div', { className: 'pj-suggest-h' }, `未归属会话来自 ${groups.length} 个目录（迁进对应项目后才会按项目隔离）`),
            groups.map(([cwd, count]) => h('div', { className: 'pj-suggest-row', key: cwd }, h('span', { className: 'pj-suggest-text' }, `${cwd} · ${count} 个会话`))),
          )
      const activePhase = chainPhases.filter((phase) => phase.current === true).slice(-1)[0] ?? chainPhases.slice(-1)[0] ?? null
      const canPlan = activePhase !== null && activePhase.prefix !== true && project.locked !== true
      const nextSteps = canPlan ? (activePhase.nextSteps ?? []) : []
      const nextBar = activePhase === null || activePhase.prefix === true
        ? null
        : h(
            'div',
            { className: 'pj-nextbar' },
            h('div', { className: 'pj-nextbar-h' }, '接下来', h('span', { className: 'pj-sub' }, ` · 来自「${activePhase.title}」`)),
            nextSteps.length === 0
              ? h('div', { className: 'pj-sub' }, project.locked === true
                  ? '未归属会话默认不排下一步；迁进项目后可在这里补。'
                  : '还没有下一步。会话结束后由模型补，也可以现在手动加一条。')
              : nextSteps.map((step, index) => h('div', { className: 'pj-next-item', key: index }, h('span', { className: 'pj-next-dot' }, `${index + 1}.`), h('span', { className: 'pj-next-text' }, step))),
            canPlan === false
              ? null
              : store.stepDraft === activePhase.id
                ? h(StepForm, { project, phase: activePhase, done: () => setState({ stepDraft: null }) })
                : h('button', { className: 'pj-btn ghost', type: 'button', style: { alignSelf: 'flex-start', fontSize: 11.5 }, onClick: act('step-create-open', () => setState({ stepDraft: activePhase.id })) }, nextSteps.length === 0 ? '+ 加一条下一步' : '+ 再加一条'),
          )
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'pj-row', style: { marginBottom: 10, flexWrap: 'wrap' } },
          h('div', { className: 'pj-title' }, project.title),
          h('span', { className: 'pj-sub' }, project.path || '未归属会话'),
          h('span', { className: 'pj-spacer', style: { flex: 1 } }),
          h('span', { className: 'pj-sub' }, `${project.sessions.length} 会话 · ${mainPhases.length} 阶段 · ${problemOpenCount(project)} 个未解决`),
          h('button', { className: 'pj-btn', type: 'button', onClick: act('reproject-toggle', toggleReproject) }, reprojectLabel),
          repro !== null && repro?.projectId === project.id && repro?.running !== true && typeof repro?.error === 'string' && repro.error !== ''
            ? h('span', { className: 'pj-note' }, repro.error)
            : null,
          h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('phase-create-open', addPhase) }, '新建阶段'),
          h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('export-md', exportMarkdown) }, '导出 MD'),
        ),
        suggestBar,
        nextBar,
        h(BranchTabs, { project, currentId, onPick: pickBranch }),
        currentId !== 'main'
          ? h(
              'div',
              { className: 'pj-branchbar' },
              h('span', { className: 'pj-sub' }, `分支「${branch.title}」从阶段 ${branch.fromSeq} 分叉；主线原阶段保留。`),
              branch.seedSessionId ? h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('branch-session-open', () => openSessionById(branch.seedSessionId)) }, '打开分支会话') : null,
              h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('attach-open', openAttach) }, '挂已有会话'),
              h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('branch-diff-open', () => setState({ diffBranchId: currentId })) }, '与主线对比'),
              h('span', { className: 'pj-spacer', style: { flex: 1 } }),
              store.renameDraft === currentId
                ? h(BranchRename, { project, branchId: currentId, initial: branch.title, done: () => setState({ renameDraft: null }) })
                : h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('branch-rename', startRename) }, '重命名'),
              branch.status === 'merged'
                ? h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('branch-unmerge', unmergeFromMain) }, '撤销合并')
                : h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('branch-merge-main', mergeIntoMain) }, '阶段并入主线'),
              branch.status === 'merged' ? null : h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('branch-mark-merged', () => setBranch('merged')) }, '标记已合并'),
              branch.status === 'abandoned' ? h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('branch-mark-active', () => setBranch('active')) }, '恢复为进行中') : h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('branch-mark-abandoned', () => setBranch('abandoned')) }, '放弃分支'),
              branch.status === 'abandoned' ? h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('branch-drop', dropBranch) }, '删除分支') : null,
            )
          : null,
        move !== null && project.id !== store.selectedProjectId
          ? null
          : move !== null
            ? h('div', { className: 'pj-banner', style: { marginBottom: 12, borderRadius: 9 } },
                h('span', null, '正在选择迁移目标：点左侧任意项目即可把会话迁过去'),
                h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('move-cancel', () => setState({ moveSessionId: null })) }, '取消迁移'),
              )
            : null,
        groupBar,
        filterBar,
        h(ForkDialog, { project, close: () => setState({ forkDraft: null }) }),
        store.diffBranchId !== null && store.diffBranchId !== undefined
          ? h(BranchDiff, { project, branchId: store.diffBranchId, done: () => setState({ diffBranchId: null }) })
          : null,
        h(ConsistencyBar, { project }),
        chain,
        h(Trash, { project }),
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
          { className: 'pj-modal-box', style: { width: 'min(440px,86vw)' } },
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
          { className: 'pj-modal-box' },
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
          { className: 'pj-modal-box' },
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
    function Panel() {
      useStore()
      ensureStyle()
      useEffect(() => {
        if (store.open !== true) return undefined
        const timer = setInterval(() => {
          refresh().catch(() => {})
        }, 5000)
        return () => clearInterval(timer)
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
      if (store.open !== true) return null
      const data = store.data
      const projects = data?.projects ?? []
      let selected = projects.find((project) => project.id === store.selectedProjectId) ?? projects[0] ?? null
      if (selected !== null && selected.id !== store.selectedProjectId) {
        setTimeout(() => setState({ selectedProjectId: selected.id }), 0)
      }
      const move = store.moveSessionId
      const movingSession = move === null ? null : projects.flatMap((project) => project.sessions).find((session) => session.sessionId === move)
      const onProjectClick = (project) => {
        try {
          if (move !== null) {
            if (project.id === selected?.id) {
              beacon('migrate-commit')
              api('/api/migrate', { sessionId: move, targetProjectId: project.id })
                .then(() => refresh())
                .then(() => setState({ moveSessionId: null }))
                .catch((error) => setState({ error: String(error?.message ?? error) }))
              return
            }
            beacon('migrate-pick')
            setState({ selectedProjectId: project.id })
            return
          }
          setState({ selectedProjectId: project.id })
        } catch (error) {
          setState({ error: `切换项目失败：${String(error?.message ?? error).slice(0, 120)}` })
        }
      }
      return h(
        'div',
        {
          className: 'pj-root',
          style: { zIndex: 2147483640 },
          // 面板是浮在宿主之上的模态层：阻断冒泡，避免宿主/其它插件挂在 document 上的
          // 全局点击处理（例如古法皮肤的「点哪都进自己的页面」）抢走我们的点击。
          onMouseDown: (event) => { event.stopPropagation(); if (event.target === event.currentTarget) closePanel() },
          onClick: stopClickBubble,
          onDoubleClick: (event) => { event.stopPropagation() },
          onPointerDown: (event) => { event.stopPropagation() },
          onPointerUp: (event) => { event.stopPropagation() },
          onWheel: (event) => { event.stopPropagation() },
        },
        h(
          'div',
          { className: 'pj-panel', style: { position: 'relative' } },
          h(
            'div',
            { className: 'pj-head' },
            h(Icon),
            h('span', { className: 'pj-title' }, '项目进展'),
            h('input', {
              className: 'pj-input pj-search',
              placeholder: '搜索阶段 / 问题…',
              value: store.query ?? '',
              onChange: (event) => setState({ query: event.target.value }),
              onKeyDown: (event) => { if (event.key === 'Escape') setState({ query: '' }) },
            }),
            h('span', { className: 'pj-sub' }, data?.model?.ready === true ? `模型 ${data.model.model}` : '模型未就绪'),
            data?.backfill?.state === 'running' ? h('span', { className: 'pj-sub' }, `回填中 ${data.backfill.processed}/${data.backfill.total}`) : null,
            h('span', { className: 'pj-spacer' }),
            h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('settings-toggle', () => setState({ settings: store.settings !== true })) }, '设置'),
            h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('refresh', () => refresh()) }, '刷新'),
            h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('close-click', closePanel) }, '关闭'),
          ),
          store.settings ? h(Settings, { data, close: () => setState({ settings: false }) }) : null,
          move !== null
            ? h('div', { className: 'pj-banner' }, h('span', null, `迁移会话「${movingSession?.title ?? move}」：在左侧点目标项目（再点一次确认）`), h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('migrate-cancel', () => setState({ moveSessionId: null })) }, '取消'))
            : null,
          store.gufaUnderlay === true
            ? h('div', { className: 'pj-notice' }, h('span', null, '检测到古法编程覆盖层处于开启状态：本面板已置顶显示在它上面，面板内的点击由本插件处理。'), h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('gufa-hint-dismiss', () => setState({ gufaUnderlay: false })) }, '知道了'))
            : null,
          store.notice ? h('div', { className: 'pj-notice' }, h('span', null, store.notice), h('button', { className: 'pj-btn ghost', type: 'button', onClick: act('notice-dismiss', () => setState({ notice: null })) }, '知道了')) : null,
          store.error ? h('div', { className: 'pj-error' }, store.error) : null,
          store.data?.journalError
            ? h(
                'div',
                { className: 'pj-error' },
                `进展数据文件读取失败，原文件已另存为 ${store.data.journalError.file}（当前显示空数据）。可在「设置 → 从备份恢复」里选一份备份恢复。`,
                h(
                  'button',
                  {
                    className: 'pj-btn ghost',
                    type: 'button',
                    // 会话内隐藏：服务端只丢内存标记，.corrupt-* 文件与日志保留，重启后仍会告警。
                    onClick: act('dismiss-error', async () => {
                      await api('/api/journal/dismiss-error?confirm=1')
                      await refresh()
                    }),
                  },
                  '知道了',
                ),
              )
            : null,
          h(ConfirmModal),
          selected !== null ? h(AttachModal, { project: selected }) : null,
          selected !== null ? h(PhaseCreateModal, { project: selected }) : null,
          selected !== null && typeof store.editingPhaseId === 'string' ? h(PhaseEditModal, { project: selected }) : null,
          h(
            'div',
            { className: 'pj-body' },
            h(
              'div',
              { className: 'pj-left' },
              projects.map((project) =>
                h(
                  'div',
                  {
                    key: project.id,
                    className: `pj-proj ${selected?.id === project.id ? 'active' : ''} ${move !== null && selected?.id === project.id ? 'picked' : ''}`,
                    onClick: act('project-click', () => onProjectClick(project)),
                  },
                  h(
                    'div',
                    { className: 'pj-proj-title' },
                    project.title,
                    project.locked === true ? h('span', { className: 'pj-chip' }, '待归属') : null,
                    project.phases.length > 0 ? h('span', { className: 'pj-dot' }) : null,
                  ),
                  h(
                    'div',
                    { className: 'pj-proj-meta' },
                    h('span', null, `${project.phases.length} 阶段`),
                    (project.branches ?? []).length > 1 ? h('span', null, `${project.branches.length - 1} 分支`) : null,
                    h('span', null, `${project.sessions.length} 会话`),
                    problemOpenCount(project) > 0 ? h('span', null, `${problemOpenCount(project)} 未解决`) : null,
                    nextCount(project) > 0 ? h('span', { className: 'pj-proj-next' }, `下一步 ${nextCount(project)}`) : null,
                  ),
                ),
              ),
            ),
            h('div', { className: 'pj-main' }, store.loading && data === null ? h('div', { className: 'pj-empty' }, '加载中…') : selected === null ? h('div', { className: 'pj-empty' }, '还没有项目。') : (store.query ?? '').trim() !== '' ? h(SearchResults, { projects, query: store.query }) : h(ProjectDetail, { project: selected, data })),
          ),
          h(
            'div',
            { className: 'pj-foot' },
            h('span', null, data?.migration?.available === true ? '迁移：可用（live workspace 域）' : `迁移：不可用（${data?.migration?.source ?? 'unknown'}）`),
            h('span', null, `提示：每个项目只看自己的会话，跨项目不混`),
            h('span', { className: 'pj-spacer', style: { flex: 1 } }),
            h('span', null, data?.generatedAt ? `更新于 ${new Date(data.generatedAt).toLocaleTimeString('zh-CN')}` : ''),
          ),
        ),
      )
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
          return h('div', { className: 'pj-root', style: { padding: 16, fontSize: 12, color: 'var(--dsw-alias-label-warning,#e0a030)' } }, `这块内容渲染失败（${label}），右上角关掉面板再打开可重试。`)
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
      note('client-v26')
      window.__pjDebug = { open: () => openPanel(), close: () => closePanel(), store }
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
