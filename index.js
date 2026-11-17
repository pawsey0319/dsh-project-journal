/**
 * Project Journal (Host half).
 *
 * Responsibilities:
 *   - reconcile DSH workspaces (projects) into a durable journal;
 *   - summarize finished sessions into project phases + problem records;
 *   - backfill history, one session at a time;
 *   - move a session between projects by rewriting the live workspace domain;
 *   - expose everything over one HTTP prefix for the client half.
 */
import { execFile } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import {
  BACKUP_DIR,
  TRASH_DIR,
  FILE,
  MAIN_BRANCH,
  MAX_BRANCHES,
  UNASSIGNED,
  applySummary,
  branchContext,
  branchOf,
  branchPhases,
  backupJournal,
  buildDigest,
  contentText,
  dirBytes,
  ensureProject,
  journalLoadError,
  loadJournal,
  migrateJournal,
  newId,
  phaseBrief,
  phaseContext,
  purgeTrash,
  resequence,
  saveJournal,
} from './journal-store.js'

export const name = 'dsh-project-journal'
export const inject = ['webServer', 'storageDomain', 'sessionQuery', 'llm']

const PREFERRED = ['/x-journal', '/x-journal-b', '/x-journal-c', '/x-journal-d']
const WORKSPACE_FILE = join(homedir(), '.dsh', 'storages', 'workspace.json')
const ARTIFACT_EXT = new Set(['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.pdf', '.pages', '.numbers', '.key'])
const ARTIFACT_SKIP = new Set(['node_modules', '.git', '.cache', 'dist', 'build', 'out', '.next', 'Library', '.Trash', '.npm'])

function findFileByName(root, name, limit = 1) {
  const target = String(name ?? '')
  if (target === '') return []
  const found = []
  const walk = (dir, depth) => {
    if (depth > 5 || found.length >= limit) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= limit) return
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') continue
      const full = `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (entry.isFile() && entry.name === target) found.push(full)
    }
  }
  walk(root, 0)
  return found
}

function scanArtifacts(root, sinceMs, limit = 24) {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 3 || found.length >= limit) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= limit) return
      if (entry.name.startsWith('.')) continue
      const full = `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        if (ARTIFACT_SKIP.has(entry.name)) continue
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile() || entry.name.startsWith('~$')) continue
      const dot = entry.name.lastIndexOf('.')
      if (dot < 0) continue
      const ext = entry.name.slice(dot).toLowerCase()
      if (!ARTIFACT_EXT.has(ext)) continue
      try {
        const info = statSync(full)
        if (info.mtimeMs < sinceMs) continue
        found.push({ name: entry.name, path: full, at: Math.round(info.mtimeMs), kind: ext })
      } catch {}
    }
  }
  walk(root, 0)
  return found
}

const MAX_ATTEMPTS = 3

// 数值配置的合法区间：越界或非数字一律忽略（保留旧值），绝不把 NaN 写进 journal。
const NUMERIC_BOUNDS = {
  idleDelayMs: [1000, 600000],
  minNewEvents: [1, 100],
  maxInputChars: [1000, 400000],
  maxPhaseContext: [1, 50],
  throttleMs: [0, 60000],
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function parseModelJson(text) {
  let value = String(text ?? '').trim()
  const fence = value.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence !== null) value = fence[1].trim()
  const start = value.indexOf('{')
  const end = value.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(value.slice(start, end + 1))
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.phases)) return null
    return parsed
  } catch {
    return null
  }
}

export function apply(ctx) {
  const state = loadJournal()
  const beacons = []
  const queue = []
  const queued = new Set()
  const timers = new Map()
  let workerRunning = false
  let stopping = false
  let routePath = null
  let modelCache = null
  let modelError = null

  function note(message, detail) {
    const entry = { at: new Date().toISOString(), message, detail: detail ?? null }
    beacons.push(entry)
    if (beacons.length > 40) beacons.shift()
    console.log('[project-journal]', message, detail === undefined ? '' : JSON.stringify(detail))
  }

  // ---------------------------------------------------------------- workspaces

  function workspaceRows() {
    const domain = ctx.get('storageDomain')?.get('workspace')
    const rows = []
    let ids = []
    if (domain !== undefined && domain !== null) {
      try {
        for (const [id, record] of domain.table('workspaces').entries()) {
          rows.push({ id, path: record.path, title: record.title, sessionIds: [...(record.sessionIds ?? [])] })
        }
        const global = domain.global.get()
        ids = Array.isArray(global?.workspaceIds) ? global.workspaceIds : []
        return { rows, ids, migration: true, source: 'live' }
      } catch (error) {
        note('读取 workspace 域失败', { reason: String(error) })
      }
    }
    try {
      const raw = JSON.parse(readFileSync(WORKSPACE_FILE, 'utf8'))
      const table = raw?.tables?.workspaces ?? {}
      for (const [id, record] of Object.entries(table)) {
        rows.push({ id, path: record.path, title: record.title, sessionIds: [...(record.sessionIds ?? [])] })
      }
      return { rows, ids: raw?.global?.workspaceIds ?? [], migration: false, source: 'file' }
    } catch {
      return { rows, ids, migration: false, source: 'none' }
    }
  }

  function archivedSessions() {
    // 归档 ≠ 删除：会话仍能出现在 listSessions 里，但它已经不属于任何项目的可见列表，
    // 不该再被同步回「未归属」或项目里，否则删掉/归档的会话会反复复活。
    try {
      const domain = ctx.get('storageDomain')?.get('workspace')
      if (domain !== undefined && domain !== null) {
        const global = domain.global.get()
        return new Set(Array.isArray(global?.archivedSessionIds) ? global.archivedSessionIds : [])
      }
    } catch {}
    try {
      const raw = JSON.parse(readFileSync(WORKSPACE_FILE, 'utf8'))
      return new Set(Array.isArray(raw?.global?.archivedSessionIds) ? raw.global.archivedSessionIds : [])
    } catch {
      return new Set()
    }
  }

  function orderedRows() {
    const snap = workspaceRows()
    const rank = new Map(snap.ids.map((id, index) => [id, index]))
    snap.rows.sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999) || String(a.path).localeCompare(String(b.path)))
    return snap
  }

  function projectTitle(row) {
    const title = typeof row.title === 'string' && row.title.trim() !== '' ? row.title.trim() : basename(String(row.path ?? ''))
    return title === '' ? '未命名项目' : title
  }

  function reconcile() {
    const snap = orderedRows()
    snap.rows.forEach((row, index) => {
      ensureProject(state, { id: row.id, title: projectTitle(row), path: row.path }, index)
    })
    const unassigned = ensureProject(state, { id: UNASSIGNED, title: '未归属会话', path: '' }, 999)
    unassigned.locked = true
    return snap
  }

  function visibleProjects() {
    const snap = reconcile()
    const list = snap.rows.map((row) => state.projects[row.id])
    const unassigned = state.projects[UNASSIGNED]
    const hasUnassignedSessions = Object.values(state.sessions).some((record) => record.projectId === UNASSIGNED)
    if (hasUnassignedSessions) list.push(unassigned)
    return { list, snap }
  }

  async function syncSessions() {
    let named = 0
    const snap = orderedRows()
    const owner = new Map()
    for (const row of snap.rows) for (const id of row.sessionIds) owner.set(id, row.id)
    let list = []
    try {
      const result = await ctx.sessionQuery.listSessions()
      list = Array.isArray(result) ? result : []
    } catch (error) {
      note('listSessions 失败', { reason: String(error) })
    }
    const archived = archivedSessions()
    let changed = false
    for (const item of list) {
      const header = item?.header
      if (header === undefined || header === null || typeof header.id !== 'string') continue
      const origin = String(header.origin ?? '')
      if (origin.includes('subagent')) continue
      const id = header.id
      if (archived.has(id)) continue
      const projectId = owner.get(id) ?? UNASSIGNED
      const existing = state.sessions[id]
      if (existing === undefined) {
        state.sessions[id] = {
          sessionId: id,
          projectId,
          branchId: MAIN_BRANCH,
          title: '',
          cwd: header.cwd ?? '',
          createdAt: header.createdAt ?? new Date().toISOString(),
          updatedAt: null,
          cursorSeq: -1,
          lastSummarizedAt: null,
          state: 'new',
          attempts: 0,
          lastError: null,
          phaseIds: [],
        }
        changed = true
      } else {
        if (existing.projectId !== projectId) {
          existing.projectId = projectId
          changed = true
        }
        const cwd = typeof header.cwd === 'string' ? header.cwd : ''
        if (cwd !== '' && existing.cwd !== cwd) {
          existing.cwd = cwd
          changed = true
        }
      }
    }
    for (const record of Object.values(state.sessions)) {
      if (record.title !== '' && record.title !== undefined) continue
      if (named++ >= 4) break
      try {
        const title = await ctx.sessionQuery.readTitle(record.sessionId)
        if (typeof title === 'string' && title.trim() !== '') {
          record.title = title.trim().slice(0, 60)
          changed = true
          continue
        }
        const snapshot = await ctx.sessionQuery.readSession(record.sessionId)
        for (const event of snapshot.events) {
          if (event.type !== 'user/message') continue
          const text = contentText(event.data?.content).replace(/\s+/g, ' ').trim()
          if (text !== '') {
            record.title = text.slice(0, 42)
            changed = true
            break
          }
        }
      } catch {}
    }
    // 清理已不存在（被删除/归档）的会话记录：避免项目会话数虚高。
    // 仅当本轮确实拿到非空列表、且该记录没有被任何阶段引用时才删，防止误删。
    if (list.length > 0) {
      const present = new Set()
      for (const item of list) {
        const id = item?.header?.id
        if (typeof id === 'string') present.add(id)
      }
      if (present.size > 0) {
        const referenced = new Set()
        for (const project of Object.values(state.projects ?? {})) {
          for (const phase of project.phases ?? []) for (const id of phase.sessions ?? []) referenced.add(id)
        }
        for (const record of Object.values(state.sessions)) {
          if (present.has(record.sessionId) && !archived.has(record.sessionId)) continue
          if (referenced.has(record.sessionId)) continue
          delete state.sessions[record.sessionId]
          changed = true
        }
      }
    }
    // 自愈：旧版本永久删除阶段时只清了 phaseIds，没清 hidden/hiddenBy，导致会话永久隐藏。
    // 只要 hiddenBy 指向的阶段已经不存在，就把会话放回可见列表。
    const livePhaseIds = new Set()
    for (const project of Object.values(state.projects ?? {})) {
      for (const phase of project.phases ?? []) livePhaseIds.add(phase.id)
    }
    for (const record of Object.values(state.sessions)) {
      if (record.hidden === true && typeof record.hiddenBy === 'string' && !livePhaseIds.has(record.hiddenBy)) {
        delete record.hidden
        delete record.hiddenBy
        changed = true
      }
    }
    return changed
  }

  // --------------------------------------------------------------- summarizer

  async function resolveModel() {
    if (modelCache !== null) return modelCache
    modelError = null
    try {
      const providers = await Promise.resolve(ctx.llm.listProviders())
      if (!Array.isArray(providers) || providers.length === 0) {
        modelError = '没有可用的模型 provider'
        return null
      }
      const wanted = state.config.provider
      const provider = providers.find((item) => item.id === wanted) ?? providers.find((item) => item.id === 'deepseek') ?? providers[0]
      const models = await Promise.resolve(ctx.llm.listModels(provider.id))
      if (!Array.isArray(models) || models.length === 0) {
        modelError = `provider ${provider.id} 没有可用模型`
        return null
      }
      const wantedModel = state.config.model
      const model = models.find((item) => item.id === wantedModel) ?? models.find((item) => /chat/i.test(item.id)) ?? models[0]
      modelCache = { provider: provider.id, model: model.id, label: model.name ?? model.id }
      return modelCache
    } catch (error) {
      modelError = String(error?.message ?? error)
      return null
    }
  }

  function buildPrompt(project, digest) {
    const system = [
      '你是项目日志整理器，把一段会话记录整理成项目阶段链。只输出 JSON，不要解释。',
      '阶段 = 项目目标、方案或交付物发生变化的节点，通常几轮会话才产生一个；不要按会话轮次切阶段，不要把单个任务当阶段。',
      '如果本次内容只是延续已有阶段，就复用该阶段 id 更新它；只有确实进入新阶段才新增（新阶段 id 留空）。',
      'summary 写“做了什么、为什么这样做”，让几个月后的人能读懂；problems 记录用户当时遇到的真实问题与处理方式。',
      'nextSteps 写“接下来还需要做什么”（用户视角、可执行的具体动作，最多 3 条，各≤40字）；status=active 的阶段至少给 1 条，status=done 可留空。',
      'quote 必须逐字复制下面 U: 行里的一段连续原文，找不到就留空字符串，绝不改写。不要编造任何事实。',
      '输出格式：{"phases":[{"id":"已有阶段id或空","title":"阶段名≤20字","summary":"≤200字","status":"done|active","artifacts":["产物"],"nextSteps":["接下来做什么"],"problems":[{"statement":"问题","quote":"用户原话","resolution":"怎么处理","status":"solved|open"}]}]}',
      '没有阶段变化但可补充问题时，返回该阶段的 id 并只写 problems。',
      project.locked === true
        ? '这是「未归属会话」（不属于任何项目，可能是一次性咨询/试验/临时排障）：仍要按会话自身的目标归纳 1–3 个阶段，phases 不能为空；如果确实无法判断目标，就用会话主题命名一个阶段，summary 写清楚这次到底在做什么。'
        : '若本次只是零散问答、没有可归纳的阶段变化，phases 返回空数组。',
    ].join('\n')
    const user = [
      project.locked === true ? '会话归属：未归属（临时会话）、仍请归纳阶段' : `项目：${project.title}`,
      '',
      digest.text,
      '',
      '请输出 JSON。',
    ].join('\n')
    return { system, user }
  }

  async function summarizeSession(sessionId) {
    const record = state.sessions[sessionId]
    if (record === undefined) return
    // 阶段被删除后会话被标记 hidden：不再自动归纳，避免把已裁剪的内容又写回进展。
    if (record.hidden === true) return
    if (state.projects[record.projectId] === undefined) reconcile()
    const project = state.projects[record.projectId]
    if (project === undefined || (project.locked === true && record.projectId !== UNASSIGNED)) {
      record.state = 'skipped'
      record.lastError = '所属项目不存在'
      saveJournal(state)
      return
    }
    record.state = 'summarizing'
    saveJournal(state)
    try {
      if (record.title === '' || record.title === undefined) {
        try {
          const title = await ctx.sessionQuery.readTitle(sessionId)
          if (typeof title === 'string' && title.trim() !== '') record.title = title.trim()
        } catch {}
      }
      const snapshot = await ctx.sessionQuery.readSession(sessionId)
      if (record.title === '' || record.title === undefined) {
        for (const event of snapshot.events) {
          if (event.type !== 'user/message') continue
          const text = contentText(event.data?.content).replace(/\s+/g, ' ').trim()
          if (text !== '') {
            record.title = text.slice(0, 42)
            break
          }
        }
      }
      const branchId = branchOf(project, record.branchId) === undefined ? MAIN_BRANCH : record.branchId
      record.branchId = branchId
      const digest = buildDigest(snapshot.events, record.cursorSeq, {
        maxChars: state.config.maxInputChars,
        session: { title: record.title },
        phaseContext: branchContext(project, branchId, state.config.maxPhaseContext),
      })
      if (digest.newCount === 0) {
        record.state = 'done'
        record.cursorSeq = Math.max(record.cursorSeq, digest.maxSeq)
        record.lastError = null
        saveJournal(state)
        return
      }
      if (digest.userEvents === 0) {
        record.state = 'done'
        record.cursorSeq = digest.maxSeq
        record.lastError = null
        saveJournal(state)
        return
      }
      const model = await resolveModel()
      if (model === null) {
        record.state = 'idle'
        record.lastError = modelError ?? '模型不可用'
        saveJournal(state)
        return
      }
      const { system, user } = buildPrompt(project, digest)
      // 长会话偶发被截断/夹带解释，重试一次并要求「只输出 JSON」；仍失败才算这次总结失败。
      let parsed = null
      let firstText = ''
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 120000)
        let text = ''
        try {
          const stream = ctx.llm.stream({
            provider: model.provider,
            model: model.model,
            reasoningEffort: 'off',
            temperature: attempt === 0 ? 0.2 : 0,
            maxTokens: attempt === 0 ? 2400 : 3200,
            system: attempt === 0 ? system : `${system}\n\n只输出一个 JSON 对象，不要解释、不要代码块、不要前后缀。`,
            messages: [{ role: 'user', content: [{ type: 'text', text: attempt === 0 ? user : `${user}\n\n上次输出不是合法 JSON。请重新输出且只输出 JSON。` }] }],
            signal: controller.signal,
            purpose: 'project-journal',
          })
          for await (const chunk of stream) {
            if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
            else if (chunk?.type === 'finish') break
          }
        } finally {
          clearTimeout(timer)
        }
        if (attempt === 0) firstText = text
        parsed = parseModelJson(text)
        if (parsed !== null) break
      }
      if (parsed === null) {
        throw new Error(`模型输出不是合法 JSON（已重试一次，首轮 ${firstText.length} 字）`)
      }
      const result = applySummary(state, {
        project,
        sessionId,
        sessionStart: record.createdAt,
        parsed,
        userText: digest.userText,
        branchId,
        source: { sessionId, seq: digest.maxSeq },
      })
      record.cursorSeq = digest.maxSeq
      record.lastSummarizedAt = new Date().toISOString()
      record.state = 'done'
      record.attempts = 0
      record.lastError = null
      if (project.locked !== true) {
        try {
          const since = Date.parse(record.createdAt ?? '') || Date.now() - 86400000
          const files = scanArtifacts(project.path, since - 60000)
          if (files.length > 0) {
            for (const phase of project.phases) {
              if (result.touched.includes(phase.id) !== true) continue
              const known = new Set((phase.artifacts ?? []).map((item) => String(item)))
              for (const file of files) {
                const label = file.name
                if (known.has(label)) continue
                known.add(label)
                phase.artifacts.push(label)
              }
              if (phase.artifacts.length > 8) phase.artifacts = phase.artifacts.slice(-8)
            }
            note('阶段产物已补', { sessionId, files: files.length })
          }
        } catch (error) {
          note('产物扫描失败', { sessionId, error: String(error?.message ?? error) })
        }
      }
      record.phaseIds = [...new Set([...(record.phaseIds ?? []), ...result.touched])]
      saveJournal(state)
      backupJournal('journal')
      note('会话已总结', { sessionId, phases: result.touched.length, created: result.created.length, model: model.label })
    } catch (error) {
      record.attempts = (record.attempts ?? 0) + 1
      record.state = record.attempts >= MAX_ATTEMPTS ? 'skipped' : 'error'
      record.lastError = String(error?.message ?? error)
      saveJournal(state)
      note('会话总结失败', { sessionId, attempts: record.attempts, reason: record.lastError })
    }
  }

  function nextCandidate() {
    while (queue.length > 0) {
      const id = queue.shift()
      queued.delete(id)
      if (state.sessions[id] !== undefined) return id
    }
    if (state.config.auto !== true) return null
    if (state.backfill.state !== 'running') return null
    const records = Object.values(state.sessions)
      .filter((record) => record.state !== 'done' && record.state !== 'skipped' && record.state !== 'summarizing')
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    return records[0]?.sessionId ?? null
  }

  async function worker() {
    if (workerRunning) return
    workerRunning = true
    try {
      while (stopping !== true) {
        const sessionId = nextCandidate()
        if (sessionId === null) break
        await summarizeSession(sessionId)
        if (state.backfill.state === 'running') {
          const records = Object.values(state.sessions)
          state.backfill.total = records.length
          state.backfill.processed = records.filter((record) => record.state === 'done').length
        }
        await sleep(state.config.throttleMs)
      }
    } finally {
      workerRunning = false
      if (state.backfill.state === 'running') {
        const remaining = Object.values(state.sessions).some(
          (record) => record.state !== 'done' && record.state !== 'skipped',
        )
        state.backfill.state = remaining ? 'running' : 'done'
        saveJournal(state)
      }
    }
  }

  function schedule(sessionId, delayMs) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (timers.has(sessionId)) clearTimeout(timers.get(sessionId))
    const wait = Math.max(1000, Number(delayMs ?? state.config.idleDelayMs))
    const timer = setTimeout(() => {
      timers.delete(sessionId)
      const record = state.sessions[sessionId]
      if (record === undefined) return
      if (record.state === 'summarizing') return
      record.state = 'queued'
      if (!queued.has(sessionId)) {
        queued.add(sessionId)
        queue.push(sessionId)
      }
      worker()
    }, wait)
    timers.set(sessionId, timer)
  }

  // ----------------------------------------------------------------- migration

  function copyWorkspaceFileBackup() {
    try {
      mkdirSync(BACKUP_DIR, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const target = join(BACKUP_DIR, `workspace-${stamp}.json`)
      writeFileSync(target, readFileSync(WORKSPACE_FILE))
      return target
    } catch {
      return null
    }
  }

  function planMigration(sessionId, targetProjectId) {
    const record = state.sessions[sessionId]
    if (record === undefined) return { error: 'session-missing' }
    if (state.projects[targetProjectId] === undefined) return { error: 'target-missing' }
    const snap = workspaceRows()
    if (!snap.migration) return { error: 'migration-unavailable', source: snap.source }
    const from = snap.rows.find((row) => row.sessionIds.includes(sessionId))?.id ?? null
    const target = snap.rows.find((row) => row.id === targetProjectId)
    return {
      ok: true,
      dryRun: true,
      sessionId,
      from,
      to: targetProjectId,
      sameProject: from === targetProjectId,
      targetExists: target !== undefined,
      journalFrom: record.projectId,
    }
  }

  function migrateSession(sessionId, targetProjectId) {
    const domain = ctx.get('storageDomain')?.get('workspace')
    if (domain === undefined || domain === null) return { error: 'migration-unavailable' }
    const table = domain.table('workspaces')
    const targetRecord = table.get(targetProjectId)
    if (targetRecord === undefined || targetRecord === null) return { error: 'target-missing' }
    const snap = workspaceRows()
    const sourceRow = snap.rows.find((row) => row.sessionIds.includes(sessionId))
    const sourceId = sourceRow?.id ?? null
    if (sourceId === targetProjectId) return { error: 'already-there' }
    const journalBackup = backupJournal('migrate')
    const workspaceBackup = copyWorkspaceFileBackup()
    const now = new Date().toISOString()
    try {
      table.update(targetProjectId, (record) => ({
        ...record,
        sessionIds: [...new Set([...(record.sessionIds ?? []), sessionId])],
        updatedAt: now,
      }))
      if (sourceId !== null) {
        table.update(sourceId, (record) => ({
          ...record,
          sessionIds: (record.sessionIds ?? []).filter((id) => id !== sessionId),
          updatedAt: now,
        }))
      }
      // The session's phases travel with it: the target chain shows the work
      // that session contributed, and the source chain stops claiming it.
      const record = state.sessions[sessionId]
      // 会话不在任何 workspace 行里（典型：未归属会话）时，sourceId 是 null，
      // 但它的阶段还记在「未归属」项目里。只改 record.projectId 会让阶段和会话分家
      // （会话指向本项目、阶段留在未归属），所以这里把未归属当成隐式来源一并搬走。
      const journalSourceId = sourceId === null && record !== undefined && record.projectId === UNASSIGNED ? UNASSIGNED : sourceId
      const sourceProject = journalSourceId === null ? undefined : state.projects[journalSourceId]
      const targetProject = state.projects[targetProjectId]
      const moved = new Set(record?.phaseIds ?? [])
      const carried = []
      if (sourceProject !== undefined) {
        const kept = []
        for (const phase of sourceProject.phases) {
          if (!moved.has(phase.id)) {
            kept.push(phase)
            continue
          }
          const others = (phase.sessions ?? []).filter((id) => id !== sessionId)
          if (others.length > 0) {
            phase.sessions = others
            kept.push(phase)
            carried.push({ ...phase, id: newId('ph'), sessions: [sessionId], problems: phase.problems.map((problem) => ({ ...problem, id: newId('pb') })) })
          } else {
            carried.push(phase)
          }
        }
        sourceProject.phases = kept
        resequence(sourceProject)
        sourceProject.updatedAt = now
        if (record !== undefined) record.phaseIds = (record.phaseIds ?? []).filter((id) => !moved.has(id) || carried.some((phase) => phase.id === id))
      }
      if (targetProject !== undefined && carried.length > 0) {
        const present = new Set(targetProject.phases.map((phase) => phase.id))
        const targetBranches = targetProject.branches ?? (targetProject.branches = [])
        if (targetBranches.length === 0) targetBranches.push({ id: MAIN_BRANCH, title: '主线', fromPhaseId: null, fromSeq: null, status: 'active', createdAt: now, note: '', seedSessionId: null })
        let landedBranchId = null
        for (const phase of carried) {
          if (present.has(phase.id)) continue
          const wantBranch = phase.branchId ?? MAIN_BRANCH
          if (wantBranch !== MAIN_BRANCH) {
            let cloned = targetBranches.find((item) => item.id === wantBranch)
            if (cloned === undefined) {
              const sourceBranch = sourceProject === undefined ? undefined : branchOf(sourceProject, wantBranch)
              const title = sourceBranch?.title ?? '迁入分支'
              cloned = targetBranches.find((item) => item.title === title && item.status !== 'abandoned')
              if (cloned === undefined) {
                cloned = {
                  ...(sourceBranch ?? {}),
                  id: newId('br'),
                  title: title.slice(0, 60),
                  status: 'active',
                  createdAt: now,
                  note: '随会话迁入',
                  seedSessionId: null,
                }
                targetBranches.push(cloned)
              }
            }
            phase.branchId = cloned.id
            landedBranchId = cloned.id
          }
          phase.seq = targetProject.phases.length + 1
          targetProject.phases.push(phase)
          if (record !== undefined && !record.phaseIds.includes(phase.id)) record.phaseIds.push(phase.id)
        }
        if (record !== undefined && landedBranchId !== null) record.branchId = landedBranchId
        resequence(targetProject)
        targetProject.updatedAt = now
      }
      if (record !== undefined) {
        record.projectId = targetProjectId
        record.state = record.state === 'skipped' ? 'new' : record.state
      }
      saveJournal(state)
      note('会话已迁移', { sessionId, from: sourceId, to: targetProjectId, phases: carried.length })
      return { ok: true, from: sourceId, to: targetProjectId, phases: carried.length, journalBackup, workspaceBackup }
    } catch (error) {
      note('迁移失败', { sessionId, reason: String(error?.message ?? error) })
      return { error: 'write-failed', detail: String(error?.message ?? error) }
    }
  }

  // ------------------------------------------------------------------ branches

  /**
   * 找到某个阶段“结束那一刻”的会话与事件序号：分支会话要 fork 到这里，才能承接当时的上下文。
   * 优先级：阶段自身记录的 sourceSessionId/sourceSeq → 阶段贡献会话 → 分支种子会话 → 分支来源阶段的会话。
   * 没有 sourceSeq 的老阶段，用「下一个阶段的开始时间」作为切点，回退到整个会话结尾。
   */
  async function snapToTurnEnd(sessionId, seq) {
  try {
    const snap = await ctx.get('sessionQuery').readSession(sessionId)
    const events = snap?.events ?? []
    let best = null
    for (const event of events) {
      const at = Number(event?.seq)
      if (!Number.isFinite(at) || at > seq) continue
      if (event.type === 'turn/end') best = at
    }
    return best
  } catch {
    return null
  }
}

async function resolvePhaseSource(project, phase) {
    const seen = new Set()
    const candidates = []
    const push = (id) => {
      if (typeof id !== 'string' || id === '' || seen.has(id)) return
      seen.add(id)
      candidates.push(id)
    }
    push(phase.sourceSessionId)
    for (const id of phase.sessions ?? []) push(id)
    const branch = branchOf(project, phase.branchId)
    push(branch?.seedSessionId)
    const parent = branch?.fromPhaseId === undefined ? undefined : project.phases.find((item) => item.id === branch.fromPhaseId)
    for (const id of parent?.sessions ?? []) push(id)
    push(project.branches?.find((item) => item.seedSessionId !== null && item.seedSessionId !== undefined)?.seedSessionId)
    const sessionId = candidates[0]
    if (sessionId === undefined) return null
    let events = []
    try {
      const snapshot = await ctx.sessionQuery.readSession(sessionId)
      events = Array.isArray(snapshot?.events) ? snapshot.events : []
    } catch (error) {
      note('读取阶段来源会话失败', { sessionId, reason: String(error?.message ?? error) })
      return null
    }
    const lastSeq = events.length === 0 ? -1 : Number(events[events.length - 1].seq)
    if (Number.isFinite(Number(phase.sourceSeq))) {
      return { sessionId, seq: Number(phase.sourceSeq), total: events.length }
    }
    const later = branchPhases(project, phase.branchId)
      .filter((item) => item.seq > phase.seq)
      .sort((a, b) => a.seq - b.seq)
    const boundary = later[0]?.startedAt ?? phase.endedAt ?? null
    let cutSeq = lastSeq
    if (typeof boundary === 'string' && boundary !== '') {
      const at = Date.parse(boundary)
      if (Number.isFinite(at)) {
        let found = -1
        for (const event of events) {
          const time = typeof event.time === 'number' ? event.time : Date.parse(String(event.time ?? ''))
          if (!Number.isFinite(time)) continue
          if (time <= at) found = Number(event.seq)
        }
        if (found >= 0) cutSeq = found
      }
    }
    return { sessionId, seq: cutSeq, total: events.length }
  }

  function buildSeed(project, phase) {
    const open = phase.problems.filter((problem) => problem.status === 'open')
    const solved = phase.problems.filter((problem) => problem.status !== 'open')
    const artifacts = phase.artifacts.length === 0 ? '（无）' : phase.artifacts.join('、')
    const openText = open.length === 0 ? '（无）' : open.map((problem) => problem.statement).join('\n- ')
    const solvedText = solved.length === 0 ? '（无）' : solved.map((problem) => `${problem.statement}${problem.resolution ? ` → ${problem.resolution}` : ''}`).join('\n- ')
    return [
      `项目：${project.title}${project.path ? `（${project.path}）` : ''}`,
      `我们要从「阶段 ${phase.seq} · ${phase.title}」重新开始一条分支，不要重做这之前的阶段。`,
      '',
      `当时的目标：${phase.summary || '（未记录）'}`,
      `阶段产物：${artifacts}`,
      `阶段留下的下一步：${Array.isArray(phase.nextSteps) && phase.nextSteps.length > 0 ? phase.nextSteps.join(' / ') : '（无）'}`,
      '仍未解决的问题：',
      `- ${openText}`,
      '已解决的问题：',
      `- ${solvedText}`,
      '',
      '请先确认你理解的起点，再给出这条分支的第一步。',
    ].join('\n')
  }

  async function createBranch(sessionId, projectId, phaseId, rawTitle, withSession, rawPrompt, rawMode) {
    const project = state.projects[projectId]
    if (project === undefined) return { error: 'project-missing' }
    const phase = project.phases.find((item) => item.id === phaseId)
    if (phase === undefined) return { error: 'phase-missing' }
    const branches = project.branches ?? (project.branches = [])
    if (branches.length >= MAX_BRANCHES) return { error: 'branch-limit', limit: MAX_BRANCHES }
    const now = new Date().toISOString()
    // 从「重做」阶段再开分支会形成二级重做：标题加「重做²」，避免和一级重做同名，看起来像重复分支。
    const baseTitle = String(phase.title ?? '').replace(/^重做 · /, '')
    const redoTitle = phase.redoOf === null || phase.redoOf === undefined
      ? `重做 · ${baseTitle}`
      : `重做² · ${baseTitle}`
    const title = String(rawTitle ?? '').trim().slice(0, 40) || redoTitle.slice(0, 40)
    const branch = {
      id: newId('br'),
      title,
      fromPhaseId: phase.id,
      fromSeq: phase.seq,
      status: 'active',
      createdAt: now,
      note: '',
      seedSessionId: null,
    }
    branches.push(branch)
    const redo = {
      id: newId('ph'),
      seq: 1,
      branchId: branch.id,
      redoOf: phase.id,
      title: (phase.title.startsWith('重做 · ') ? phase.title : `重做 · ${phase.title}`).slice(0, 40),
      summary: '',
      status: 'active',
      startedAt: now,
      endedAt: null,
      sessions: [],
      artifacts: [],
      manual: false,
      problems: [],
    }
    project.phases.push(redo)
    resequence(project)
    project.activeBranchId = branch.id
    project.updatedAt = now
    saveJournal(state)
    backupJournal('branch')

    let warning = null
    let mode = 'none'
    if (withSession === true) {
      const controller = ctx.get('sessionController')
      if (controller === undefined) {
        warning = 'session-unavailable'
      } else if (projectId === UNASSIGNED) {
        warning = 'unassigned-cannot-create-session'
      } else {
        const text = String(rawPrompt ?? '').trim()
        const wantFork = String(rawMode ?? 'fork') !== 'blank'
        let source = null
        if (wantFork) {
          try {
            source = await resolvePhaseSource(project, phase)
          } catch (error) {
            note('定位阶段来源失败', { phaseId, reason: String(error?.message ?? error) })
          }
        }
        let newSessionId = null
        const forkErrors = []
        if (source !== null && Number.isFinite(Number(source.seq)) && Number(source.seq) >= 0) {
          const snapped = await snapToTurnEnd(source.sessionId, Number(source.seq))
          const cuts = []
          if (snapped !== null && snapped !== Number(source.seq)) cuts.push(snapped)
          cuts.push(Number(source.seq))
          cuts.push(undefined)
          for (const cut of cuts) {
            if (newSessionId !== null) break
            try {
              const request = { sessionId: source.sessionId }
              if (cut !== undefined) request.atSeq = cut
              const forked = await controller.fork(request)
              const id = forked?.sessionId
              if (typeof id === 'string' && id !== '') {
                newSessionId = id
                mode = 'fork'
                if (cut !== undefined) source.seq = cut
              }
            } catch (error) {
              forkErrors.push(`atSeq=${cut === undefined ? 'latest' : cut}: ${String(error?.message ?? error)}`)
            }
          }
          if (newSessionId === null) {
            warning = 'fork-failed'
            note('分叉上下文失败', { phaseId, source: source.sessionId, seq: source.seq, errors: forkErrors })
          }
        }
        if (newSessionId === null) {
          try {
            const created = await controller.create({ workspaceId: projectId })
            const id = created?.sessionId
            if (typeof id !== 'string' || id === '') throw new Error('create 未返回 sessionId')
            newSessionId = id
            mode = 'blank'
          } catch (error) {
            warning = warning ?? 'session-create-failed'
            note('开分支建会话失败', { projectId, reason: String(error?.message ?? error) })
          }
        }
        if (newSessionId !== null) {
          const inherited = mode === 'fork' ? Number(source.seq) : -1
          state.sessions[newSessionId] = {
            sessionId: newSessionId,
            projectId,
            branchId: branch.id,
            title: (phase.title.startsWith('重做 · ') ? phase.title : `重做 · ${phase.title}`).slice(0, 42),
            cwd: project.path ?? '',
            createdAt: now,
            updatedAt: null,
            cursorSeq: inherited,
            lastSummarizedAt: null,
            state: 'new',
            attempts: 0,
            lastError: null,
            phaseIds: [redo.id],
            inheritedFrom: mode === 'fork' ? source.sessionId : null,
            inheritedSeq: mode === 'fork' ? inherited : null,
          }
          redo.sessions = [newSessionId]
          branch.seedSessionId = newSessionId
          saveJournal(state)
          const outgoing = text !== '' ? text : mode === 'fork' ? '' : buildSeed(project, phase)
          if (outgoing !== '') {
            try {
              const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(30000) : new AbortController().signal
              await controller.prompt(
                {
                  requestId: globalThis.crypto?.randomUUID?.() ?? newId('req'),
                  sessionId: newSessionId,
                  mode: 'queue',
                  content: [{ type: 'text', text: outgoing }],
                },
                signal,
              )
            } catch (error) {
              warning = 'seed-prompt-failed'
              note('种子消息发送失败', { sessionId: newSessionId, reason: String(error?.message ?? error) })
            }
          }
          branch.mode = mode
        }
      }
    }
    saveJournal(state)
    note('已开分支', { projectId, branchId: branch.id, from: phaseId, withSession: withSession === true, warning })
    return {
      ok: true,
      projectId,
      branchId: branch.id,
      phaseId: redo.id,
      fromPhaseId: phase.id,
      seedSessionId: branch.seedSessionId,
      mode,
      warning,
    }
  }

  function setBranchStatus(projectId, branchId, action, rawTitle) {
    const project = state.projects[projectId]
    if (project === undefined) return { error: 'project-missing' }
    const branch = branchOf(project, branchId)
    if (branch === undefined) return { error: 'branch-missing' }
    if (branchId === MAIN_BRANCH) return { error: 'cannot-modify-main' }
    if (action === 'rename') {
      const title = String(rawTitle ?? '').trim()
      if (title !== '') branch.title = title.slice(0, 60)
      project.updatedAt = new Date().toISOString()
      saveJournal(state)
      return { ok: true, branchId, title: branch.title }
    }
    if (action === 'merged' || action === 'abandoned' || action === 'active') {
      branch.status = action
      if (action === 'active') project.activeBranchId = branchId
      else if (project.activeBranchId === branchId) project.activeBranchId = MAIN_BRANCH
    } else {
      return { error: 'unknown-action' }
    }
    project.updatedAt = new Date().toISOString()
    saveJournal(state)
    return { ok: true, branchId, status: branch.status }
  }

  function deleteBranch(projectId, branchId, force = false) {
    const project = state.projects[projectId]
    if (project === undefined) return { error: 'project-missing' }
    if (branchId === MAIN_BRANCH) return { error: 'cannot-delete-main' }
    const branch = branchOf(project, branchId)
    if (branch === undefined) return { error: 'branch-missing' }
    if (branch.status !== 'abandoned') return { error: 'branch-not-abandoned' }
    const phases = branchPhases(project, branchId)
    const busy = phases.filter(
      (phase) => (phase.sessions ?? []).length > 0 || (phase.problems ?? []).length > 0 || String(phase.summary ?? '') !== '',
    )
    // 分支里的阶段大多有会话/总结，直接拒绝会让「删除」变成死路。
    // 带 force=1 时：有内容的阶段转成软删除（产物进回收站、会话隐藏），再删分支本身。
    if (busy.length > 0 && force !== true) {
      return { error: 'branch-not-empty', phases: phases.length, busy: busy.length, hint: '带 force=1 可把这些阶段转进回收站后再删分支' }
    }
    const now = new Date().toISOString()
    let softDeleted = 0
    // 分支里的每个阶段都要进回收站：以前只处理「有内容」的阶段，空阶段被直接丢弃，
    // 用户既看不到也恢复不了（例如刚 fork 出来还没用的重做阶段）。
    for (const phase of phases) {
      phase.deletedAt = now
      phase.deletedBy = 'branch-delete'
      if (busy.includes(phase)) {
        phase.trashedArtifacts = trashPhaseArtifacts(project, phase)
        setSessionsHidden(project, phase, true)
      }
      phase.branchId = MAIN_BRANCH
      delete phase.mergedFrom
      softDeleted += 1
    }
    project.branches = project.branches.filter((item) => item.id !== branchId)
    // 软删除阶段挂到空分支会在下次加载时被当成孤儿清掉，所以统一挪到 main 保留进回收站。
    project.phases = project.phases.filter((phase) => phase.branchId !== branchId || phase.deletedAt !== undefined)
    for (const phase of project.phases) {
      if (phase.branchId === branchId) phase.branchId = MAIN_BRANCH
    }
    let sessionsMoved = 0
    for (const record of Object.values(state.sessions)) {
      if (record.branchId === branchId) {
        record.branchId = MAIN_BRANCH
        sessionsMoved += 1
      }
    }
    if (project.activeBranchId === branchId) project.activeBranchId = MAIN_BRANCH
    project.updatedAt = now
    saveJournal(state)
    return { ok: true, branchId, softDeleted, sessionsMoved }
  }

  function attachSessionToBranch(projectId, branchId, sessionId, allowMove = false) {
    const project = state.projects[projectId]
    if (project === undefined) return { error: 'project-missing' }
    const branch = branchOf(project, branchId ?? MAIN_BRANCH)
    if (branch === undefined) return { error: 'branch-missing' }
    const record = state.sessions[sessionId]
    if (record === undefined) return { error: 'session-missing' }
    let movedFrom = null
    if (record.projectId !== projectId) {
      // 跨项目「挂到分支」= 先把会话迁到本项目（侧边栏归属一起改），再挂分支。
      if (allowMove !== true) return { error: 'cross-project' }
      const migration = migrateSession(sessionId, projectId)
      if (migration.error !== undefined) return migration
      movedFrom = migration.from ?? null
    }
    const now = new Date().toISOString()
    for (const phase of project.phases) {
      if (!Array.isArray(phase.sessions)) phase.sessions = []
      phase.sessions = phase.sessions.filter((id) => id !== sessionId)
    }
    const target = branchPhases(project, branch.id).slice(-1)[0]
    if (target !== undefined) {
      target.sessions = [...(target.sessions ?? []), sessionId]
      record.phaseIds = [target.id]
    } else {
      record.phaseIds = []
    }
    record.branchId = branch.id
    if (!Number.isFinite(Number(record.cursorSeq))) record.cursorSeq = -1
    if (branch.seedSessionId === null || branch.seedSessionId === undefined) branch.seedSessionId = sessionId
    project.updatedAt = now
    saveJournal(state)
    return { ok: true, projectId, branchId: branch.id, sessionId, phaseId: target?.id ?? null, movedFrom }
  }

  function mergeBranch(projectId, branchId) {
    const project = state.projects[projectId]
    if (project === undefined) return { error: 'project-missing' }
    if (branchId === MAIN_BRANCH) return { error: 'cannot-merge-main' }
    const branch = branchOf(project, branchId)
    if (branch === undefined) return { error: 'branch-missing' }
    if (branch.status === 'abandoned') return { error: 'branch-abandoned' }
    const phases = branchPhases(project, branchId)
    if (phases.length === 0) return { error: 'branch-empty' }
    const now = new Date().toISOString()
    // 合并前先找「同义阶段」：分支上重做/新写的阶段，与主线在分叉点之后的阶段标题归一化后相同，
    // 说明两边可能在处理同一件事，合并会把两份记录并排放进主线——提示人工确认，而不是静默搬过去。
    const normalize = (text) => String(text ?? '').replace(/\s+/g, '').replace(/[·・.、,，:：()（）\[\]【】]/g, '').toLowerCase()
    const fromSeq = Number(branch.fromSeq ?? 0)
    const mainAfter = (project.phases ?? [])
      .filter((phase) => (phase.branchId ?? MAIN_BRANCH) === MAIN_BRANCH)
      .filter((phase) => (phase.deletedAt === undefined || phase.deletedAt === null))
      .filter((phase) => Number(phase.seq) > fromSeq)
    const conflicts = []
    for (const phase of phases) {
      const key = normalize(String(phase.title ?? '').replace(/^重做\s*·\s*/, ''))
      for (const other of mainAfter) {
        if (normalize(other.title) !== key) continue
        conflicts.push({ phaseId: phase.id, phaseTitle: phase.title, mainPhaseId: other.id, mainPhaseTitle: other.title })
      }
    }
    const moved = []
    for (const phase of phases) {
      phase.branchId = MAIN_BRANCH
      phase.mergedFrom = branchId
      phase.seq = Number(phase.seq)
      moved.push(phase.id)
    }
    for (const record of Object.values(state.sessions)) {
      if (record.branchId === branchId) record.branchId = MAIN_BRANCH
    }
    branch.status = 'merged'
    branch.mergedAt = now
    branch.mergedPhases = moved
    project.activeBranchId = MAIN_BRANCH
    resequence(project)
    project.updatedAt = now
    saveJournal(state)
    backupJournal('merge')
    return { ok: true, projectId, branchId, moved: moved.length, phaseIds: moved, conflicts }
  }

  function unmergeBranch(projectId, branchId) {
    const project = state.projects[projectId]
    if (project === undefined) return { error: 'project-missing' }
    if (branchId === MAIN_BRANCH) return { error: 'cannot-unmerge-main' }
    const branch = branchOf(project, branchId)
    if (branch === undefined) return { error: 'branch-missing' }
    if (branch.status !== 'merged') return { error: 'branch-not-merged' }
    const moved = (branch.mergedPhases ?? []).filter((id) => project.phases.some((phase) => phase.id === id && phase.mergedFrom === branchId))
    const movedSet = new Set(moved)
    for (const phase of project.phases) {
      if (movedSet.has(phase.id) !== true) continue
      phase.branchId = branchId
      delete phase.mergedFrom
    }
    for (const record of Object.values(state.sessions)) {
      if (record.branchId !== MAIN_BRANCH) continue
      const owned = Array.isArray(record.phaseIds) ? record.phaseIds : []
      if (owned.some((id) => movedSet.has(id))) record.branchId = branchId
    }
    branch.status = 'active'
    delete branch.mergedAt
    delete branch.mergedPhases
    if (project.activeBranchId === MAIN_BRANCH && moved.length > 0) project.activeBranchId = branchId
    resequence(project)
    project.updatedAt = new Date().toISOString()
    saveJournal(state)
    backupJournal('unmerge')
    return { ok: true, projectId, branchId, restored: moved.length, phaseIds: moved }
  }

  function createPhase(projectId, rawTitle, rawSummary, branchId) {
    const project = state.projects[projectId]
    if (project === undefined) return { error: 'project-missing' }
    const wanted = branchId ?? project.activeBranchId ?? MAIN_BRANCH
    const branch = branchOf(project, wanted) ?? branchOf(project, MAIN_BRANCH)
    if (branch === undefined) return { error: 'branch-missing' }
    const existing = branchPhases(project, branch.id)
    const now = new Date().toISOString()
    const seq = existing.length + 1
    const title = String(rawTitle ?? '').trim().slice(0, 40) || `阶段 ${seq}`
    for (const item of existing) {
      if (item.status === 'active') {
        item.status = 'done'
        if (item.endedAt === null) item.endedAt = now
      }
    }
    const phase = {
      id: newId('ph'),
      seq,
      branchId: branch.id,
      redoOf: null,
      title,
      summary: String(rawSummary ?? '').trim().slice(0, 900),
      status: 'active',
      startedAt: now,
      endedAt: null,
      sessions: [],
      artifacts: [],
      manual: true,
      nextSteps: [],
      problems: [],
    }
    project.phases.push(phase)
    resequence(project)
    project.updatedAt = now
    saveJournal(state)
    return { ok: true, projectId, phaseId: phase.id, branchId: branch.id, seq }
  }

  function listBackups() {
    try {
      const files = readdirSync(BACKUP_DIR).filter((name) => name.endsWith('.json'))
      return files
        .map((file) => {
          const full = join(BACKUP_DIR, file)
          let stat = null
          try {
            stat = statSync(full)
          } catch {}
          let meta = { kind: 'unknown' }
          try {
            const raw = JSON.parse(readFileSync(full, 'utf8'))
            if (raw?.projects !== undefined && raw?.sessions !== undefined) {
              meta = {
                kind: 'journal',
                version: raw.version ?? null,
                projects: Object.keys(raw.projects ?? {}).length,
                sessions: Object.keys(raw.sessions ?? {}).length,
                phases: Object.values(raw.projects ?? {}).reduce((sum, project) => sum + (project.phases?.length ?? 0), 0),
                restorable: true,
              }
            } else if (raw?.unit?.name === 'workspace' || raw?.tables?.workspaces !== undefined) {
              meta = { kind: 'workspace', workspaces: Object.keys(raw?.tables?.workspaces ?? {}).length, restorable: false }
            }
          } catch {
            meta = { kind: 'unreadable', restorable: false }
          }
          return { file, size: stat?.size ?? 0, at: (stat?.mtime ?? new Date(0)).toISOString(), ...meta }
        })
        .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    } catch {
      return []
    }
  }

  function restoreBackup(file) {
    const name = basename(String(file ?? ''))
    if (!name.endsWith('.json') || name.includes('/') || name.includes('..')) return { error: 'bad-file' }
    const full = join(BACKUP_DIR, name)
    if (!existsSync(full)) return { error: 'missing' }
    let raw = null
    try {
      raw = JSON.parse(readFileSync(full, 'utf8'))
    } catch {
      return { error: 'unreadable' }
    }
    if (typeof raw?.projects !== 'object' || raw.projects === null || typeof raw?.sessions !== 'object' || raw.sessions === null) {
      return { error: 'not-a-journal' }
    }
    backupJournal('pre-restore')
    state.config = { ...state.config, ...(raw.config ?? {}) }
    state.projects = raw.projects
    state.sessions = raw.sessions
    if (raw.backfill !== undefined && raw.backfill !== null) state.backfill = raw.backfill
    // 旧版备份（v1/v2）恢复后立即迁移，别让磁盘上留着一份旧结构直到下次保存或重启。
    migrateJournal(state)
    saveJournal(state)
    reconcile()
    return { ok: true, file: name, projects: Object.keys(state.projects).length, sessions: Object.keys(state.sessions).length }
  }

  // ------------------------------------------------------- project reproject

  const reproject = { running: false, projectId: null, done: 0, total: 0, current: null, startedAt: null, canceled: false, error: null }

  async function runReproject(projectId, rebuild = false) {
    const project = state.projects[projectId]
    if (project === undefined) return
    if (rebuild === true) {
      for (const record of Object.values(state.sessions)) {
        if (record.projectId !== projectId) continue
        record.cursorSeq = -1
        record.state = 'new'
      }
      saveJournal(state)
    }
    const ids = Object.values(state.sessions)
      .filter((record) => record.projectId === projectId && record.hidden !== true)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map((record) => record.sessionId)
    reproject.running = true
    reproject.projectId = projectId
    reproject.done = 0
    reproject.total = ids.length
    reproject.current = null
    reproject.startedAt = new Date().toISOString()
    reproject.canceled = false
    reproject.error = null
    for (const sessionId of ids) {
      if (reproject.canceled !== true) {
        reproject.current = sessionId
        try {
          await summarizeSession(sessionId)
        } catch (error) {
          note('重新归纳会话失败', { sessionId, reason: String(error?.message ?? error) })
        }
        reproject.done += 1
      }
    }
    reproject.running = false
    reproject.current = null
    saveJournal(state)
    // 模型对非项目型会话常返回空 phases；归纳完成后如实告知，别让用户以为「点了没动」。
    if ((state.projects[projectId]?.phases ?? []).length === 0) {
      reproject.error = '模型未产出可归纳的阶段，可用「新建阶段」手动补一条'
    }
    note('重新归纳完成', { projectId, done: reproject.done, total: reproject.total, canceled: reproject.canceled, hint: reproject.error })
  }

  function reprojectState() {
    return {
      running: reproject.running,
      projectId: reproject.projectId,
      done: reproject.done,
      total: reproject.total,
      current: reproject.current,
      startedAt: reproject.startedAt,
      canceled: reproject.canceled,
      error: reproject.error,
    }
  }

  // -------------------------------------------------------------------- state

  // 删除阶段 = 裁剪真实上下文：产物文件移出项目目录，后续会话/检索就读不到它了；
  // 会话记录同时标记 hidden，不再进入项目列表与重新归纳。恢复时原路移回。
  function trashPhaseArtifacts(project, phase) {
    const trashed = []
    if (typeof project.path !== 'string' || project.path === '') return trashed
    const others = (project.phases ?? []).filter(
      (item) => item.id !== phase.id && (item.deletedAt === undefined || item.deletedAt === null),
    )
    for (const raw of Array.isArray(phase.artifacts) ? phase.artifacts : []) {
      const label = String(raw)
      // 同一个文件若还被其它（未删除）阶段引用，就别挪走，避免把别人的产物弄丢。
      if (others.some((item) => (Array.isArray(item.artifacts) ? item.artifacts : []).map(String).includes(label))) {
        note('产物被其它阶段引用，未移入回收站', { label, phaseId: phase.id })
        continue
      }
      const from = label.startsWith('/') ? label : join(project.path, label)
      if (from !== project.path && !from.startsWith(`${project.path}/`)) continue
      if (!existsSync(from)) continue
      const rel = from.slice(project.path.length).replace(/^\/+/, '')
      const to = join(TRASH_DIR, project.id, phase.id, rel)
      try {
        mkdirSync(dirname(to), { recursive: true })
        renameSync(from, to)
        trashed.push({ label, from, to })
      } catch (error) {
        note('产物移入回收站失败', { label, reason: String(error?.message ?? error) })
      }
    }
    return trashed
  }

  function restorePhaseArtifacts(project, phase) {
    const restored = []
    for (const item of Array.isArray(phase.trashedArtifacts) ? phase.trashedArtifacts : []) {
      try {
        if (!existsSync(item.to)) continue
        mkdirSync(dirname(item.from), { recursive: true })
        renameSync(item.to, item.from)
        restored.push(item.label)
      } catch (error) {
        note('产物恢复失败', { label: item.label, reason: String(error?.message ?? error) })
      }
    }
    if (restored.length > 0) delete phase.trashedArtifacts
    return restored
  }

  function setSessionsHidden(project, phase, hidden) {
    for (const sessionId of Array.isArray(phase.sessions) ? phase.sessions : []) {
      const record = state.sessions[sessionId]
      if (record === undefined) continue
      if (hidden) {
        record.hidden = true
        record.hiddenBy = phase.id
      } else if (record.hiddenBy === phase.id) {
        delete record.hidden
        delete record.hiddenBy
      }
    }
  }

  // 一致性检查与修复必须共用同一口径，否则就会出现「横幅常驻但修 0 条」。
  // 软删除的阶段仍在项目里（只是进回收站），所以它算「存在的阶段」，不能算 missing。
  function consistencyIssues(project) {
    const ids = new Set(project.phases.map((phase) => phase.id))
    const issues = []
    for (const record of Object.values(state.sessions)) {
      if (record.projectId !== project.id) continue
      for (const phaseId of Array.isArray(record.phaseIds) ? record.phaseIds : []) {
        if (!ids.has(phaseId)) issues.push({ kind: 'session-points-to-missing-phase', sessionId: record.sessionId, phaseId })
      }
    }
    for (const phase of project.phases) {
      for (const sessionId of Array.isArray(phase.sessions) ? phase.sessions : []) {
        const record = state.sessions[sessionId]
        if (record === undefined) issues.push({ kind: 'phase-lists-missing-session', phaseId: phase.id, sessionId })
        else if (record.projectId !== project.id) issues.push({ kind: 'phase-session-in-other-project', phaseId: phase.id, sessionId })
      }
    }
    return issues
  }

  function buildState() {
    const { list, snap } = visibleProjects()
    const byPath = new Map()
    for (const project of Object.values(state.projects)) {
      if (typeof project.path === 'string' && project.path !== '') byPath.set(project.path, project)
    }
    const suggestionsFor = (project) =>
      Object.values(state.sessions)
        .filter((record) => record.projectId === project.id && typeof record.cwd === 'string' && record.cwd !== '' && record.cwd !== project.path)
        .map((record) => {
          const target = byPath.get(record.cwd)
          if (target === undefined || target.id === project.id) return null
          return { sessionId: record.sessionId, title: record.title || '未命名会话', cwd: record.cwd, targetProjectId: target.id, targetTitle: target.title }
        })
        .filter((item) => item !== null)
    const projects = list.map((project) => {
      const sessions = Object.values(state.sessions)
        .filter((record) => record.projectId === project.id && record.hidden !== true)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .map((record) => ({
          sessionId: record.sessionId,
          branchId: record.branchId ?? MAIN_BRANCH,
          cwd: record.cwd ?? '',
          title: record.title || '未命名会话',
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          state: record.state,
          summarized: record.state === 'done',
          lastSummarizedAt: record.lastSummarizedAt,
          lastError: record.lastError,
        }))
      return {
        id: project.id,
        title: project.title,
        path: project.path,
        order: project.order,
        locked: project.locked === true,
        updatedAt: project.updatedAt,
        activeBranchId: project.activeBranchId ?? MAIN_BRANCH,
        branches: (project.branches ?? []).map((branch) => ({
          ...branch,
          phaseCount: branchPhases(project, branch.id).length,
          sessionCount: Object.values(state.sessions).filter((record) => record.projectId === project.id && record.branchId === branch.id && record.hidden !== true).length,
        })),
        sessions,
        suggestions: suggestionsFor(project),
        phases: project.phases
          .filter((phase) => phase.deletedAt === undefined || phase.deletedAt === null)
          .map((phase) => ({
            ...phaseBrief(phase),
            current: phase === branchPhases(project, phase.branchId ?? MAIN_BRANCH).slice(-1)[0],
          })),
        trash: project.phases
          .filter((phase) => phase.deletedAt !== undefined && phase.deletedAt !== null)
          .map((phase) => ({
            id: phase.id,
            title: phase.title,
            branchId: phase.branchId ?? MAIN_BRANCH,
            deletedAt: phase.deletedAt,
            summary: phase.summary,
            sessions: Array.isArray(phase.sessions) ? phase.sessions : [],
            problemCount: Array.isArray(phase.problems) ? phase.problems.length : 0,
            trashed: Array.isArray(phase.trashedArtifacts) ? phase.trashedArtifacts.map((item) => item.label) : [],
          })),
        consistency: (() => {
          const issues = consistencyIssues(project)
          return { ok: issues.length === 0, count: issues.length, issues: issues.slice(0, 20) }
        })(),
      }
    })
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      projects,
      migration: { available: snap.migration, source: snap.source },
      model: {
        ready: modelCache !== null,
        provider: modelCache?.provider ?? state.config.provider,
        model: modelCache?.model ?? state.config.model,
        error: modelError,
      },
      config: { ...state.config },
      backfill: { ...state.backfill },
      reproject: reprojectState(),
      summarizing: Object.values(state.sessions)
        .filter((record) => record.state === 'summarizing')
        .map((record) => record.sessionId),
      beacons: beacons.slice(-12),
      journalError: journalLoadError(),
    }
  }

  // ------------------------------------------------------------------- routes

  ctx.effect(() => {
    const resource = async (request) => {
      const url = new URL(request.url, 'http://x')
      const pathname = url.pathname
      const q = url.searchParams
      const flag = (name) => q.get(name) === '1' || q.get(name) === 'true'
      try {
        if (pathname.endsWith('/api/health')) {
          let clientGraph = null
          try {
            const cm = ctx.get('clientModules')
            if (cm !== undefined && typeof cm.graph === 'function') {
              const graph = cm.graph()
              clientGraph = {
                entries: (graph?.entries ?? []).map((entry) => entry.id),
                ours: cm.clientPath('@pawsey0319/dsh-project-journal') ?? null,
              }
            }
          } catch (error) {
            clientGraph = { error: String(error?.message ?? error) }
          }
          const controller = ctx.get('sessionController')
          return json({
            ok: true,
            route: routePath,
            version: 3,
            file: FILE,
            clientGraph,
            sessionController: typeof controller?.create === 'function' && typeof controller?.prompt === 'function',
          })
        }
        if (pathname.endsWith('/api/diagnostics')) {
          const records = Object.values(state.sessions)
          const stats = { new: 0, queued: 0, summarizing: 0, done: 0, error: 0, skipped: 0 }
          for (const record of records) {
            if (stats[record.state] === undefined) stats[record.state] = 0
            stats[record.state] += 1
          }
          const failures = records
            .filter((record) => record.state === 'error' || record.state === 'skipped')
            .sort((a, b) => String(b.lastSummarizedAt ?? '').localeCompare(String(a.lastSummarizedAt ?? '')))
            .slice(0, 10)
            .map((record) => ({ sessionId: record.sessionId, projectId: record.projectId, state: record.state, error: record.lastError, attempts: record.attempts }))
          let fileBytes = null
          try {
            fileBytes = statSync(FILE).size
          } catch {}
          let backups = null
          try {
            backups = readdirSync(BACKUP_DIR).filter((name) => name.endsWith('.json')).length
          } catch {}
          const workspace = workspaceRows()
          const routeErrors = beacons
            .filter((entry) => entry.message === '路由异常')
            .slice(-5)
            .map((entry) => ({ at: entry.at, ...(entry.detail ?? {}) }))
          return json({
            ok: true,
            route: routePath,
            version: 3,
            uptimeSec: Math.round(process.uptime()),
            file: FILE,
            fileBytes,
            backups,
            projects: Object.keys(state.projects).length,
            projectsTotal: Object.keys(state.projects).length,
            projectsVisible: visibleProjects().list.length,
            phases: Object.values(state.projects).reduce((sum, project) => sum + project.phases.length, 0),
            problems: Object.values(state.projects).reduce((sum, project) => sum + project.phases.reduce((n, phase) => n + phase.problems.length, 0), 0),
            sessions: records.length,
            sessionStates: stats,
            failures,
            routeErrors,
            journalError: journalLoadError(),
            queue: queue.length,
            timers: timers.size,
            workerRunning,
            backfill: state.backfill,
            reproject: reprojectState(),
            model: { ready: modelCache !== null, cached: modelCache, error: modelError },
            workspaceSource: workspace.migration === true ? 'live-domain' : 'file-fallback',
            beacons: beacons.slice(-8),
          })
        }
        if (pathname.endsWith('/api/export')) {
          const projectId = q.get('projectId') ?? ''
          const project = state.projects[projectId]
          if (project === undefined) return json({ ok: false, error: 'project-missing' }, 404)
          // 回收站里的阶段不是项目进展：导出时必须排除，否则编号错乱、正文混入已删内容。
          const livePhases = project.phases.filter((phase) => phase.deletedAt === undefined || phase.deletedAt === null)
          const deletedCount = project.phases.length - livePhases.length
          const openProblems = livePhases.reduce((n, phase) => n + (phase.problems ?? []).filter((problem) => problem.status === 'open').length, 0)
          const deletedNote = deletedCount > 0 ? `（另有 ${deletedCount} 个回收站阶段未导出）` : ''
          const lines = [`# ${project.title} · 项目进展`, '', `> 导出时间 ${new Date().toISOString()} · 阶段 ${livePhases.length}${deletedNote} · 未解决问题 ${openProblems}`, '']
          const branches = Array.isArray(project.branches) && project.branches.length > 0 ? project.branches : [{ id: 'main', title: '主线', status: 'active' }]
          for (const branch of branches) {
            const phases = livePhases.filter((phase) => (phase.branchId ?? MAIN_BRANCH) === branch.id).sort((left, right) => left.seq - right.seq)
            if (phases.length === 0) continue
            lines.push(`## ${branch.title ?? branch.id}${branch.status === 'active' ? '' : `（${branch.status === 'merged' ? '已合并' : '已放弃'}）`}`, '')
            let index = 0
            for (const phase of phases) {
              index += 1
              lines.push(`### ${index}. ${phase.title}${phase.status === 'done' ? '' : phase.status === 'active' ? '（进行中）' : '（计划中）'}`)
              if (typeof phase.summary === 'string' && phase.summary !== '') lines.push('', phase.summary)
              const steps = Array.isArray(phase.nextSteps) ? phase.nextSteps : []
              if (steps.length > 0) lines.push('', '还要做：', ...steps.map((step) => `- ${step}`))
              if (Array.isArray(phase.problems) && phase.problems.length > 0) {
                lines.push('', '问题与处理：')
                for (const problem of phase.problems) {
                  const quote = typeof problem.quote === 'string' && problem.quote !== '' ? `「${problem.quote}」` : ''
                  const resolution = typeof problem.resolution === 'string' && problem.resolution !== '' ? ` → ${problem.resolution}` : ''
                  lines.push(`- [${problem.status === 'open' ? '未解决' : '已解决'}] ${problem.statement}${quote}${resolution}`)
                }
              }
              if (Array.isArray(phase.artifacts) && phase.artifacts.length > 0) lines.push('', `产物：${phase.artifacts.join('、')}`)
              lines.push('')
            }
          }
          return new Response(lines.join('\n'), { status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' } })
        }
        if (pathname.endsWith('/api/beacon')) {
          note(`client:${q.get('e') ?? ''}`, q.get('d') ?? null)
          return json({ ok: true })
        }
        if (pathname.endsWith('/api/state')) {
          if (state.backfill.state === 'running') worker()
          else void syncNow()
          return json(buildState())
        }
        if (pathname.endsWith('/api/model-probe')) {
          modelCache = null
          const resolved = await resolveModel()
          return json({ ok: resolved !== null, model: resolved, error: modelError })
        }
        if (pathname.endsWith('/api/config')) {
          const ignored = []
          for (const key of ['provider', 'model', 'auto', 'idleDelayMs', 'minNewEvents', 'maxInputChars', 'maxPhaseContext', 'throttleMs']) {
            const value = q.get(key)
            if (value === null) continue
            if (key === 'auto') state.config.auto = value === '1' || value === 'true'
            else if (NUMERIC_BOUNDS[key] !== undefined) {
              const num = Number(value)
              const bounds = NUMERIC_BOUNDS[key]
              if (Number.isFinite(num) && num >= bounds[0] && num <= bounds[1]) state.config[key] = Math.round(num)
              else ignored.push(key)
            } else state.config[key] = value
          }
          modelCache = null
          modelError = null
          if (state.config.auto === true && state.backfill.state !== 'done') state.backfill.state = 'running'
          saveJournal(state)
          if (state.config.auto === true) worker()
          return json({ ok: true, config: state.config, ignored })
        }
        if (pathname.endsWith('/api/backfill')) {
          const action = q.get('action')
          if (action === 'start') state.backfill = { state: 'running', projectId: null, processed: state.backfill.processed, total: state.backfill.total, startedAt: state.backfill.startedAt ?? new Date().toISOString() }
          else if (action === 'pause') state.backfill.state = 'paused'
          else if (action === 'reset') {
            for (const record of Object.values(state.sessions)) {
              record.cursorSeq = -1
              record.state = 'new'
              record.attempts = 0
            }
            state.backfill = { state: 'running', projectId: null, processed: 0, total: 0, startedAt: new Date().toISOString() }
          }
          else return json({ error: 'unknown-action' }, 400)
          saveJournal(state)
          worker()
          return json({ ok: true, backfill: state.backfill })
        }
        if (pathname.endsWith('/api/summarize')) {
          const sessionId = q.get('sessionId')
          const record = state.sessions[sessionId]
          if (record === undefined) return json({ error: 'session-missing' }, 404)
          if (flag('force')) record.attempts = 0
          record.state = 'queued'
          if (!queued.has(record.sessionId)) {
            queued.add(record.sessionId)
            queue.push(record.sessionId)
          }
          worker()
          return json({ ok: true })
        }
        if (pathname.endsWith('/api/migrate')) {
          const sessionId = q.get('sessionId')
          const targetProjectId = q.get('targetProjectId')
          if (sessionId === null || targetProjectId === null) return json({ error: 'bad-request' }, 400)
          if (q.get('dryRun') === '1') return json(planMigration(sessionId, targetProjectId))
          const result = migrateSession(sessionId, targetProjectId)
          return json(result, result.error === undefined ? 200 : 400)
        }
        if (pathname.endsWith('/api/workspace-create')) {
          // 维护用：把某个目录登记为项目（等价于在侧边栏新建项目）。必须显式 confirm=1。
          if (q.get('confirm') !== '1') return json({ error: 'need-confirm' }, 400)
          const controller = ctx.get('workspaceController')
          if (controller === undefined) return json({ error: 'workspace-controller-unavailable' }, 503)
          const path = String(q.get('path') ?? '')
          if (path === '' || !existsSync(path)) return json({ error: 'bad-path' }, 400)
          const result = await controller.create({ path })
          syncNow(true)
          return json({ ok: true, workspace: result?.workspace ?? null, created: result?.created === true })
        }
        if (pathname.endsWith('/api/workspace-delete')) {
          // 维护用：移除项目登记（保留文件与会话）。必须显式 confirm=1。
          if (q.get('confirm') !== '1') return json({ error: 'need-confirm' }, 400)
          const controller = ctx.get('workspaceController')
          if (controller === undefined) return json({ error: 'workspace-controller-unavailable' }, 503)
          const workspaceId = String(q.get('workspaceId') ?? '')
          if (workspaceId === '') return json({ error: 'bad-request' }, 400)
          const result = await controller.delete({ workspaceId })
          syncNow(true)
          return json({ ok: true, deleted: result?.deleted === true })
        }
        if (pathname.endsWith('/api/session-create')) {
          // 维护用：在指定目录新建一个会话并可立刻发第一条消息。必须显式 confirm=1。
          if (q.get('confirm') !== '1') return json({ error: 'need-confirm' }, 400)
          const controller = ctx.get('sessionController')
          if (controller === undefined) return json({ error: 'session-controller-unavailable' }, 503)
          const cwd = String(q.get('cwd') ?? '')
          const workspaceId = q.get('workspaceId')
          if (workspaceId === null && (cwd === '' || !existsSync(cwd))) return json({ error: 'bad-cwd' }, 400)
          const created = workspaceId !== null
            ? await controller.create({ workspaceId })
            : await controller.create({ cwd })
          const sessionId = created?.sessionId ?? null
          const text = String(q.get('prompt') ?? '').trim()
          if (sessionId !== null && text !== '') {
            await controller.prompt(
              { requestId: crypto.randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }] },
              AbortSignal.timeout(30000),
            )
          }
          return json({ ok: true, sessionId })
        }
        if (pathname.endsWith('/api/session-prompt')) {
          const controller = ctx.get('sessionController')
          const sessionId = q.get('sessionId') ?? ''
          const text = q.get('text') ?? ''
          if (controller === undefined || sessionId === '' || text === '') return json({ error: 'bad-request' }, 400)
          try {
            const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(30000) : new AbortController().signal
            await controller.prompt({ requestId: globalThis.crypto?.randomUUID?.() ?? newId('req'), sessionId, mode: 'queue', content: [{ type: 'text', text }] }, signal)
            return json({ ok: true })
          } catch (error) {
            return json({ error: 'prompt-failed', detail: String(error?.message ?? error) }, 400)
          }
        }
        if (pathname.endsWith('/api/session-cancel')) {
          const sessionId = q.get('sessionId')
          const controller = ctx.get('sessionController')
          if (sessionId === null || controller === undefined) return json({ error: 'bad-request' }, 400)
          try {
            await controller.cancel({ sessionId })
            return json({ ok: true })
          } catch (error) {
            return json({ error: 'cancel-failed', detail: String(error?.message ?? error) }, 400)
          }
        }
        if (pathname.endsWith('/api/session-archive')) {
          const sessionId = q.get('sessionId')
          const controller = ctx.get('workspaceController')
          if (sessionId === null || controller === undefined) return json({ error: 'bad-request' }, 400)
          try {
            const result = await controller.archiveSession({ sessionId, stopActivity: true })
            return json({ ok: true, archived: result.archivedSessionIds.length })
          } catch (error) {
            return json({ error: 'archive-failed', detail: String(error?.message ?? error) }, 400)
          }
        }
        if (pathname.endsWith('/api/session-record')) {
          const sessionId = q.get('sessionId')
          if (sessionId === null) return json({ error: 'bad-request' }, 400)
          if (q.get('action') !== 'delete') return json({ error: 'bad-action' }, 400)
          if (state.sessions[sessionId] === undefined) return json({ error: 'record-missing' }, 404)
          delete state.sessions[sessionId]
          saveJournal(state)
          return json({ ok: true, sessionId })
        }
        if (pathname.endsWith('/api/session-debug')) {
          const sessionId = q.get('sessionId')
          if (sessionId === null) return json({ error: 'bad-request' }, 400)
          const snapshot = await ctx.sessionQuery.readSession(sessionId)
          const users = snapshot.events.filter((event) => event.type === 'user/message')
          return json({
            ok: true,
            events: snapshot.events.length,
            turns: snapshot.events.filter((event) => event.type === 'turn/end').length,
            firstUser: users[0] === undefined ? null : contentText(users[0].data?.content).slice(0, 160),
            lastUser: users.length === 0 ? null : contentText(users[users.length - 1].data?.content).slice(0, 160),
          })
        }
        if (pathname.endsWith('/api/branch/seed')) {
          const project = state.projects[q.get('projectId')]
          const phase = project?.phases?.find((item) => item.id === q.get('phaseId'))
          if (project === undefined || phase === undefined) return json({ error: 'phase-missing' }, 404)
          let context = null
          if (project.locked !== true) {
            try {
              context = await resolvePhaseSource(project, phase)
            } catch {}
          }
          return json({
            ok: true,
            title: (() => {
              const base = String(phase.title ?? '').replace(/^重做 · /, '')
              return (phase.redoOf === null || phase.redoOf === undefined ? `重做 · ${base}` : `重做² · ${base}`).slice(0, 40)
            })(),
            fromSeq: phase.seq,
            prompt: buildSeed(project, phase),
            context,
          })
        }
        if (pathname.endsWith('/api/branch/attach')) {
          const result = attachSessionToBranch(q.get('projectId'), q.get('branchId'), q.get('sessionId'), flag('move'))
          return json(result, result.error === undefined ? 200 : 400)
        }
        if (pathname.endsWith('/api/branch/merge')) {
          const result = mergeBranch(q.get('projectId'), q.get('branchId'))
          return json(result, result.error === undefined ? 200 : 400)
        }
        if (pathname.endsWith('/api/branch/unmerge')) {
          const result = unmergeBranch(q.get('projectId'), q.get('branchId'))
          return json(result, result.error === undefined ? 200 : 400)
        }
        if (pathname.endsWith('/api/phase/create')) {
          const result = createPhase(q.get('projectId'), q.get('title'), q.get('summary'), q.get('branchId'))
          return json(result, result.error === undefined ? 200 : 400)
        }
        if (pathname.endsWith('/api/artifact/open')) {
          const projectId = q.get('projectId') ?? ''
          const name = q.get('name') ?? ''
          const project = state.projects[projectId]
          if (project === undefined) return json({ ok: false, error: 'project-missing' }, 404)
          const roots = Object.values(state.projects)
            .map((item) => item.path)
            .filter((path) => typeof path === 'string' && path !== '')
          const inside = (path) => roots.some((root) => path === root || path.startsWith(`${root}/`))
          let target = null
          const relative = name.includes('/') ? join(project.path, name) : null
          if (name.startsWith('/')) {
            if (existsSync(name) && inside(name)) target = name
          } else if (relative !== null && existsSync(relative) && inside(relative)) {
            target = relative
          } else {
            const [hit] = findFileByName(project.path, name.includes('/') ? basename(name) : name, 1)
            if (hit !== undefined) target = hit
          }
          if (target === null) return json({ ok: false, error: 'not-found', name }, 404)
          const reveal = q.get('reveal') === '1'
          execFile('open', reveal === true ? ['-R', target] : [target], { detached: true }, () => {})
          return json({ ok: true, path: target, reveal })
        }
        if (pathname.endsWith('/api/backups')) {
          return json({ ok: true, dir: BACKUP_DIR, backups: listBackups() })
        }
        if (pathname.endsWith('/api/backup/restore')) {
          const result = restoreBackup(q.get('file'))
          return json(result, result.error === undefined ? 200 : 400)
        }
        if (pathname.endsWith('/api/backup')) {
          if (q.get('action') !== 'create') return json({ error: 'bad-action' }, 400)
          const file = backupJournal('manual')
          return json({ ok: true, file: typeof file === 'string' ? basename(file) : null })
        }
        if (pathname.endsWith('/api/reproject')) {
          const projectId = q.get('projectId')
          if (projectId === null) return json({ error: 'bad-request' }, 400)
          if (q.get('action') === 'stop') {
            reproject.canceled = true
            return json({ ok: true, reproject: reprojectState() })
          }
          if (state.projects[projectId] === undefined) return json({ error: 'project-missing' }, 404)
          if (reproject.running === true) return json({ error: 'busy', reproject: reprojectState() }, 409)
          void runReproject(projectId, q.get('rebuild') === '1')
          return json({ ok: true, reproject: reprojectState() })
        }
        if (pathname.endsWith('/api/branch')) {
          const projectId = q.get('projectId')
          const phaseId = q.get('phaseId')
          if (projectId === null || phaseId === null) return json({ error: 'bad-request' }, 400)
          const result = await createBranch(q.get('sessionId'), projectId, phaseId, q.get('title'), flag('withSession'), q.get('prompt'), q.get('mode'))
          return json(result, result.error === undefined ? 200 : 400)
        }
        if (pathname.endsWith('/api/branch/status')) {
          const result = setBranchStatus(q.get('projectId'), q.get('branchId'), q.get('action'), q.get('title'))
          if (result.ok === true && q.get('action') === 'rename') result.title = (branchOf(state.projects[q.get('projectId')], q.get('branchId'))?.title ?? '')
          return json(result, result.error === undefined ? 200 : 400)
        }
        if (pathname.endsWith('/api/branch/delete')) {
          const result = deleteBranch(q.get('projectId'), q.get('branchId'), q.get('force') === '1')
          return json(result, result.error === undefined ? 200 : 400)
        }
        if (pathname.endsWith('/api/phase')) {
          const project = state.projects[q.get('projectId')]
          if (project === undefined) return json({ error: 'project-missing' }, 404)
          const phase = project.phases.find((item) => item.id === q.get('phaseId'))
          if (phase === undefined) return json({ error: 'phase-missing' }, 404)
          if (q.get('action') === 'restore') {
            if (phase.deletedAt !== undefined && phase.deletedAt !== null) {
              delete phase.deletedAt
              delete phase.deletedBy
              phase.restoredAt = new Date().toISOString()
              restorePhaseArtifacts(project, phase)
              setSessionsHidden(project, phase, false)
              resequence(project)
            }
            project.updatedAt = new Date().toISOString()
            saveJournal(state)
            return json({ ok: true, restored: phase.id })
          }
          if (q.get('action') === 'delete') {
            const removedPhaseId = q.get('phaseId')
            if (flag('hard')) {
              project.phases = project.phases.filter((item) => item.id !== removedPhaseId)
              // 永久删除后，任何「只因这个阶段而隐藏」的会话都必须回到项目/未归属列表，
              // 否则它会永久消失（不在项目里、不在未归属里、也不会再被自动归纳）。
              for (const record of Object.values(state.sessions)) {
                if (Array.isArray(record.phaseIds)) record.phaseIds = record.phaseIds.filter((id) => id !== removedPhaseId)
                if (record.hidden === true && record.hiddenBy === removedPhaseId) {
                  delete record.hidden
                  delete record.hiddenBy
                }
              }
            } else {
              // 软删除：进展记录进回收站，会话与对话历史不动，来源指针保留，可随时恢复。
              phase.deletedAt = new Date().toISOString()
              phase.deletedBy = 'user'
              phase.trashedArtifacts = trashPhaseArtifacts(project, phase)
              setSessionsHidden(project, phase, true)
            }
            resequence(project)
          } else {
            const before = {
              title: phase.title,
              summary: phase.summary,
              status: phase.status,
              nextSteps: Array.isArray(phase.nextSteps) ? [...phase.nextSteps] : [],
            }
            const title = q.get('title')
            if (title !== null && title.trim() !== '') phase.title = title.trim().slice(0, 40)
            const summary = q.get('summary')
            if (summary !== null) phase.summary = summary.trim().slice(0, 900)
            const nextSteps = q.get('nextSteps')
            if (nextSteps !== null) {
              phase.nextSteps = nextSteps
                .split('|')
                .map((step) => step.trim().slice(0, 120))
                .filter((step) => step !== '')
                .slice(0, 6)
            }
            const status = q.get('status')
            if (status === 'done' || status === 'active' || status === 'planned') {
              phase.status = status
              if (status === 'done' && phase.endedAt === null) phase.endedAt = new Date().toISOString()
            }
            phase.manual = true
            // 保留手改前的快照：只改「进展记录」，但改了什么要能追溯/回退，
            // 否则展示和真实上下文长期漂移就无从解释。
            const after = { title: phase.title, summary: phase.summary, status: phase.status, nextSteps: Array.isArray(phase.nextSteps) ? [...phase.nextSteps] : [] }
            if (JSON.stringify(before) !== JSON.stringify(after)) {
              phase.revisions = Array.isArray(phase.revisions) ? phase.revisions : []
              phase.revisions.push({ at: new Date().toISOString(), by: 'user', before, after })
              if (phase.revisions.length > 20) phase.revisions = phase.revisions.slice(-20)
            }
          }
          project.updatedAt = new Date().toISOString()
          saveJournal(state)
          return json({ ok: true })
        }
        if (pathname.endsWith('/api/phase/rescan')) {
          // 重新扫描该阶段的产物：防止「产出了文件但当时没记进 artifacts」，删除时漏裁剪。
          const project = state.projects[q.get('projectId')]
          if (project === undefined) return json({ error: 'project-missing' }, 404)
          const phase = project.phases.find((item) => item.id === q.get('phaseId'))
          if (phase === undefined) return json({ error: 'phase-missing' }, 404)
          if (typeof project.path !== 'string' || project.path === '' || !existsSync(project.path)) return json({ error: 'project-path-missing' }, 400)
          const startedMs = Date.parse(String(phase.startedAt ?? phase.at ?? ''))
          const sinceMs = Number.isFinite(startedMs) ? startedMs - 60_000 : 0
          const found = scanArtifacts(project.path, sinceMs, 40)
          const known = new Set((Array.isArray(phase.artifacts) ? phase.artifacts : []).map(String))
          const added = []
          for (const item of found) {
            const relative = item.path.startsWith(`${project.path}/`) ? item.path.slice(project.path.length + 1) : basename(item.path)
            if (known.has(relative)) continue
            known.add(relative)
            added.push(relative)
          }
          phase.artifacts = [...(Array.isArray(phase.artifacts) ? phase.artifacts : []), ...added].slice(0, 12)
          project.updatedAt = new Date().toISOString()
          saveJournal(state)
          return json({ ok: true, added, total: phase.artifacts.length })
        }
        if (pathname.endsWith('/api/trash')) {
          const perProject = []
          let bytes = 0
          let files = 0
          if (existsSync(TRASH_DIR)) {
            for (const entry of readdirSync(TRASH_DIR, { withFileTypes: true })) {
              if (!entry.isDirectory()) continue
              const size = dirBytes(`${TRASH_DIR}/${entry.name}`)
              const project = state.projects[entry.name]
              perProject.push({ projectId: entry.name, title: project?.title ?? entry.name, bytes: size.bytes, files: size.files })
              bytes += size.bytes
              files += size.files
            }
          }
          const trashedPhases = Object.values(state.projects).flatMap((project) =>
            (project.phases ?? [])
              .filter((phase) => phase.deletedAt !== undefined && phase.deletedAt !== null)
              .map((phase) => ({ projectId: project.id, projectTitle: project.title, phaseId: phase.id, title: phase.title, artifacts: phase.trashedArtifacts ?? [] })),
          )
          return json({ ok: true, dir: TRASH_DIR, bytes, files, perProject, trashedPhases })
        }
        if (pathname.endsWith('/api/trash/empty')) {
          if (q.get('confirm') !== '1') return json({ error: 'need-confirm' }, 400)
          const projectId = q.get('projectId')
          const purged = purgeTrash(projectId)
          for (const id of purged.projects) {
            // 文件已清空：保留回收站记录，但标记产物不可再恢复。
            const project = state.projects[id]
            if (project !== undefined) {
              for (const phase of project.phases ?? []) {
                if (Array.isArray(phase.trashedArtifacts) && phase.trashedArtifacts.length > 0) {
                  phase.trashedArtifactsPurgedAt = new Date().toISOString()
                  phase.trashedArtifacts = []
                }
              }
            }
          }
          saveJournal(state)
          return json({ ok: true, removed: purged.removed, projects: purged.projects })
        }
        if (pathname.endsWith('/api/consistency/fix')) {
          const projectId = q.get('projectId')
          const projects = projectId === null ? Object.values(state.projects) : [state.projects[projectId]].filter(Boolean)
          if (projects.length === 0) return json({ error: 'project-missing' }, 404)
          let removedFromPhase = 0
          let removedFromRecord = 0
          for (const project of projects) {
            // 用与横幅完全相同的判定来修，保证「报几条就能修几条」。
            for (const issue of consistencyIssues(project)) {
              if (issue.kind === 'session-points-to-missing-phase') {
                const record = state.sessions[issue.sessionId]
                if (record === undefined || !Array.isArray(record.phaseIds)) continue
                const before = record.phaseIds.length
                record.phaseIds = record.phaseIds.filter((id) => id !== issue.phaseId)
                removedFromRecord += before - record.phaseIds.length
                continue
              }
              const phase = project.phases.find((item) => item.id === issue.phaseId)
              if (phase === undefined || !Array.isArray(phase.sessions)) continue
              const before = phase.sessions.length
              phase.sessions = phase.sessions.filter((id) => id !== issue.sessionId)
              removedFromPhase += before - phase.sessions.length
            }
          }
          const changed = removedFromPhase + removedFromRecord
          const remaining = projects.reduce((total, project) => total + consistencyIssues(project).length, 0)
          if (changed > 0) saveJournal(state)
          return json({ ok: remaining === 0, removedFromPhase, removedFromRecord, changed, remaining, noop: changed === 0 })
        }
        if (pathname.endsWith('/api/phase/restore-revision')) {
          const project = state.projects[q.get('projectId')]
          if (project === undefined) return json({ error: 'project-missing' }, 404)
          const phase = project.phases.find((item) => item.id === q.get('phaseId'))
          if (phase === undefined) return json({ error: 'phase-missing' }, 404)
          const at = q.get('at')
          const revisions = Array.isArray(phase.revisions) ? phase.revisions : []
          const target = revisions.find((item) => item.at === at)
          if (target === undefined || target.before === undefined) return json({ error: 'revision-missing' }, 404)
          // 回到某一版 = 再做一次编辑：把当前值记成一条修订，然后写回那一版的 before。
          const before = {
            title: phase.title,
            summary: phase.summary,
            status: phase.status,
            nextSteps: Array.isArray(phase.nextSteps) ? [...phase.nextSteps] : [],
          }
          phase.title = String(target.before.title ?? phase.title).slice(0, 40)
          phase.summary = String(target.before.summary ?? '')
          if (target.before.status === 'done' || target.before.status === 'active' || target.before.status === 'planned') phase.status = target.before.status
          phase.nextSteps = Array.isArray(target.before.nextSteps) ? [...target.before.nextSteps] : []
          phase.manual = true
          const after = { title: phase.title, summary: phase.summary, status: phase.status, nextSteps: [...phase.nextSteps] }
          revisions.push({ at: new Date().toISOString(), by: 'user', before, after, restoredFrom: at })
          phase.revisions = revisions.slice(-20)
          project.updatedAt = new Date().toISOString()
          saveJournal(state)
          return json({ ok: true, phaseId: phase.id, restoredFrom: at })
        }
        if (pathname.endsWith('/api/branch/diff')) {
          const project = state.projects[q.get('projectId')]
          if (project === undefined) return json({ error: 'project-missing' }, 404)
          const branch = branchOf(project, q.get('branchId'))
          if (branch === undefined) return json({ error: 'branch-missing' }, 404)
          const all = project.phases ?? []
          const live = all.filter((phase) => phase.deletedAt === undefined || phase.deletedAt === null)
          const mainPhases = live.filter((phase) => (phase.branchId ?? MAIN_BRANCH) === MAIN_BRANCH).sort((a, b) => a.seq - b.seq)
          const branchPhasesOnly = live.filter((phase) => (phase.branchId ?? MAIN_BRANCH) === branch.id).sort((a, b) => a.seq - b.seq)
          const fromSeq = Number(branch.fromSeq ?? 0)
          const afterFork = mainPhases.filter((phase) => Number(phase.seq) > fromSeq)
          const ids = new Set(branchPhasesOnly.map((phase) => phase.id))
          const branchProblems = branchPhasesOnly.flatMap((phase) => (phase.problems ?? []).map((problem) => ({ ...problem, phaseTitle: phase.title })))
          const mainProblems = mainPhases.flatMap((phase) => (phase.problems ?? []).map((problem) => ({ ...problem, phaseTitle: phase.title })))
          return json({
            ok: true,
            branch: { id: branch.id, title: branch.title, status: branch.status, fromPhaseId: branch.fromPhaseId ?? null, fromSeq },
            branchPhases: branchPhasesOnly.map((phase) => ({ id: phase.id, seq: phase.seq, title: phase.title, status: phase.status, nextSteps: Array.isArray(phase.nextSteps) ? phase.nextSteps : [] })),
            mainAfterFork: afterFork.map((phase) => ({ id: phase.id, seq: phase.seq, title: phase.title, status: phase.status })),
            onlyInBranch: branchPhasesOnly.filter((phase) => !afterFork.some((item) => item.id === phase.id)).length,
            openProblems: { branch: branchProblems.filter((problem) => problem.status === 'open').length, mainAfterFork: mainProblems.filter((problem) => problem.status === 'open').length },
            branchProblemTitles: branchProblems.filter((problem) => problem.status === 'open').slice(0, 8).map((problem) => problem.statement),
            phaseIds: [...ids],
          })
        }
        if (pathname.endsWith('/api/problem')) {
          const project = state.projects[q.get('projectId')]
          const phase = project?.phases?.find((item) => item.id === q.get('phaseId'))
          if (phase === undefined) return json({ error: 'phase-missing' }, 404)
          if (q.get('action') === 'delete') {
            phase.problems = phase.problems.filter((item) => item.id !== q.get('problemId'))
          } else {
            const statement = String(q.get('statement') ?? '').trim().slice(0, 600)
            if (statement === '') return json({ error: 'empty-statement' }, 400)
            const problemId = q.get('problemId')
            const existing = problemId === null ? undefined : phase.problems.find((item) => item.id === problemId)
            const resolution = String(q.get('resolution') ?? '').trim().slice(0, 600)
            const status = q.get('status') === 'open' ? 'open' : 'solved'
            if (existing === undefined) {
              phase.problems.push({ id: newId('pb'), statement, quote: '', resolution, status, at: new Date().toISOString(), sessionId: '', manual: true })
            } else {
              existing.statement = statement
              existing.resolution = resolution
              existing.status = status
              existing.manual = true
            }
          }
          project.updatedAt = new Date().toISOString()
          saveJournal(state)
          return json({ ok: true })
        }
        return json({ error: 'not-found', pathname }, 404)
      } catch (error) {
        note('路由异常', { pathname, reason: String(error?.message ?? error) })
        return json({ error: 'internal', detail: String(error?.message ?? error) }, 500)
      }
    }

    let dispose = () => {}
    for (const candidate of PREFERRED) {
      try {
        dispose = ctx.webServer.register({ kind: 'prefix', path: candidate, resource })
        routePath = candidate
        break
      } catch (error) {
        note('路由前缀被占用', { candidate, reason: String(error?.message ?? error) })
      }
    }
    return () => {
      stopping = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      dispose()
    }
  })

  ctx.effect(() => {
    const onStatus = (sessionId, running) => {
      if (running === false) schedule(sessionId, state.config.idleDelayMs)
    }
    const off = ctx.on('api-session/status', onStatus)
    return () => {
      if (typeof off === 'function') off()
    }
  })

  let lastSync = 0
  async function syncNow(force = false) {
    const now = Date.now()
    if (force !== true && now - lastSync < 60000) return false
    lastSync = now
    try {
      const changed = await syncSessions()
      reconcile()
      if (changed) saveJournal(state)
      return changed
    } catch (error) {
      note('同步会话失败', { reason: String(error?.message ?? error) })
      return false
    }
  }

  void (async () => {
    const booted = reconcile()
    await syncNow(true)
    if (state.config.auto === true && state.backfill.state !== 'done' && state.backfill.state !== 'paused') {
      state.backfill.state = 'running'
      state.backfill.startedAt = state.backfill.startedAt ?? new Date().toISOString()
      state.backfill.total = Object.keys(state.sessions).length
      saveJournal(state)
      setTimeout(() => worker(), 2500)
    }
    resolveModel()
      .then((resolved) => {
        if (resolved !== null) note('模型就绪', { provider: resolved.provider, model: resolved.model })
        else note('模型不可用', { error: modelError })
      })
      .catch(() => {})
    note('已启动', { projects: booted.rows.length, sessions: Object.keys(state.sessions).length, route: routePath })
  })()
}
