/**
 * Project Journal — durable store + deterministic merge rules.
 *
 * Everything in this file is free of Cordis dependencies so it can be exercised
 * directly with `node -e` while iterating on merge behaviour.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export const DIR = join(homedir(), '.dsh', 'project-journal')
export const FILE = join(DIR, 'journal.json')
export const BACKUP_DIR = join(DIR, 'backups')
export const TRASH_DIR = join(DIR, 'trash')
export const UNASSIGNED = 'unassigned'
export const MAIN_BRANCH = 'main'
export const MAX_BRANCHES = 20
export const MAX_BRANCH_PHASES = 50

const MAX_BACKUPS = 8
const MAX_PHASE_TITLE = 40
const MAX_PHASE_SUMMARY = 900
const MAX_PROBLEM_TEXT = 600
const STATUSES = new Set(['done', 'active', 'planned'])

/** Last loadJournal() failure (corrupt file), or null when loading was fine. */
let loadError = null

const CORRUPT_PREFIX = 'journal.json.corrupt-'

/** Timestamp of the last successful backup restore (ms), recorded on disk. */
export const RESTORE_RECORD = join(DIR, 'journal.last-restore.json')

export function journalLoadError() {
  return loadError
}

/**
 * Corrupt journal files kept next to journal.json (newest first). Only the
 * file name, size and mtime are read — never the payload.
 */
export function corruptBackups() {
  let names = []
  try {
    names = readdirSync(DIR)
  } catch {
    return []
  }
  const list = []
  for (const name of names) {
    if (!name.startsWith(CORRUPT_PREFIX)) continue
    const path = join(DIR, name)
    try {
      const stats = statSync(path)
      if (!stats.isFile()) continue
      list.push({ path, bytes: stats.size, at: new Date(stats.mtimeMs).toISOString(), mtimeMs: stats.mtimeMs })
    } catch {}
  }
  return list.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

function lastRestoreAt() {
  try {
    const raw = JSON.parse(readFileSync(RESTORE_RECORD, 'utf8'))
    const ms = Date.parse(raw?.at)
    return Number.isFinite(ms) ? ms : null
  } catch {
    return null
  }
}

/** Remember that a backup restore superseded every corrupt copy older than now. */
export function recordRestore() {
  try {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(RESTORE_RECORD, JSON.stringify({ at: new Date().toISOString() }, null, 2))
  } catch {}
}

/**
 * Corrupt copies that still need to be surfaced. `.corrupt-*` files are written
 * before the boot path persists its empty recovery journal, so their mtime is
 * OLDER than journal.json on the next boot — comparing against journal.json
 * would hide them. A restore record instead marks "everything up to here was
 * resolved"; anything newer is a fresh corruption and re-arms the warning.
 */
function pendingCorruptBackups() {
  const restoredAt = lastRestoreAt()
  const list = corruptBackups()
  return restoredAt === null ? list : list.filter((entry) => Math.floor(entry.mtimeMs) > restoredAt)
}

/**
 * Clear the remembered load failure after the journal has been written back in
 * a known-good shape (a successful restore), so the panel banner disappears.
 */
export function clearJournalLoadError() {
  loadError = null
}

/** Total bytes / file count below a directory tree (missing dirs count as zero). */
export function dirBytes(root) {
  let total = 0
  let files = 0
  const walk = (dir, depth) => {
    if (depth > 6) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      try {
        total += statSync(full).size
        files += 1
      } catch {}
    }
  }
  walk(root, 0)
  return { bytes: total, files }
}

/**
 * Delete the on-disk trash of one project (or every project when projectId is
 * null). Returns what was removed and which project dirs were touched, so the
 * caller never has to touch the filesystem itself (and tests can call it).
 */
export function purgeTrash(projectId = null) {
  let targets = []
  try {
    targets = readdirSync(TRASH_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return { removed: { bytes: 0, files: 0 }, projects: [] }
  }
  const chosen = projectId === null || projectId === undefined ? targets : targets.filter((id) => id === String(projectId))
  let bytes = 0
  let files = 0
  for (const id of chosen) {
    const stats = dirBytes(join(TRASH_DIR, id))
    bytes += stats.bytes
    files += stats.files
    rmSync(join(TRASH_DIR, id), { recursive: true, force: true })
  }
  return { removed: { bytes, files }, projects: chosen }
}

export function emptyJournal() {
  return {
    version: 3,
    updatedAt: new Date().toISOString(),
    config: {
      provider: '',
      model: '',
      auto: true,
      idleDelayMs: 25000,
      minNewEvents: 3,
      maxInputChars: 60000,
      maxPhaseContext: 12,
      throttleMs: 1500,
    },
    projects: {},
    sessions: {},
    backfill: { state: 'idle', projectId: null, processed: 0, total: 0, startedAt: null },
  }
}

export function loadJournal() {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'))
    if (raw === null || typeof raw !== 'object') throw new Error('journal.json 顶层不是对象')
    const state = { ...emptyJournal(), ...raw }
    state.config = { ...emptyJournal().config, ...(raw.config ?? {}) }
    state.projects = raw.projects ?? {}
    state.sessions = raw.sessions ?? {}
    state.backfill = { ...emptyJournal().backfill, ...(raw.backfill ?? {}) }
    for (const record of Object.values(state.sessions)) {
      if (record.state === 'summarizing' || record.state === 'queued') record.state = 'idle'
    }
    migrateJournal(state)
    const pending = pendingCorruptBackups()[0]
    loadError =
      pending === undefined
        ? null
        : {
            at: pending.at,
            original: FILE,
            file: pending.path,
            bytes: pending.bytes,
            reason: 'corrupt-backup-present',
          }
    return state
  } catch (error) {
    // A corrupt journal must never be silently replaced by an empty one: keep the
    // original bytes aside so the user can still recover from disk, and expose the
    // failure so the panel can tell them what happened.
    if (existsSync(FILE)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const corrupt = `${FILE}.corrupt-${stamp}`
      try {
        renameSync(FILE, corrupt)
        loadError = {
          at: new Date().toISOString(),
          original: FILE,
          file: corrupt,
          reason: String(error?.message ?? error),
        }
        console.warn('[project-journal] journal.json 无法解析，已另存为', corrupt, loadError.reason)
      } catch (renameError) {
        loadError = { at: new Date().toISOString(), file: FILE, reason: `无法解析且无法另存：${String(renameError?.message ?? renameError)}` }
      }
    } else {
      // journal.json is gone but corrupt copies may still be on disk (the user
      // deleted the empty recovery file, or a restore never happened). Surface
      // them here too, otherwise the panel would silently show an empty project
      // list while recoverable data sits next to it.
      const pending = pendingCorruptBackups()[0]
      loadError =
        pending === undefined
          ? null
          : {
              at: pending.at,
              original: FILE,
              file: pending.path,
              bytes: pending.bytes,
              reason: 'corrupt-backup-present',
            }
    }
    return emptyJournal()
  }
}

export function saveJournal(state) {
  mkdirSync(DIR, { recursive: true })
  state.updatedAt = new Date().toISOString()
  const tmp = `${FILE}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  renameSync(tmp, FILE)
  // A successful write alone does not clear the corrupt-file banner: the boot
  // path persists an empty recovery state right after a bad load, and clearing
  // there would hide the warning before the user sees it. Only an explicit
  // clearJournalLoadError() (e.g. after restoring a backup) resets it.
}

/** One file copy per call, keeping the newest MAX_BACKUPS snapshots. */
export function backupJournal(tag = 'journal') {
  try {
    if (!existsSync(FILE)) return null
    mkdirSync(BACKUP_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = join(BACKUP_DIR, `${tag}-${stamp}.json`)
    writeFileSync(target, readFileSync(FILE))
    pruneBackups(tag)
    return target
  } catch {
    return null
  }
}

function pruneBackups(tag) {
  try {
    const files = readdirSync(BACKUP_DIR)
      .filter((name) => name.startsWith(`${tag}-`) && name.endsWith('.json'))
      .sort()
    for (const name of files.slice(0, Math.max(0, files.length - MAX_BACKUPS))) {
      unlinkSync(join(BACKUP_DIR, name))
    }
  } catch {}
}

export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}


export function mainBranch() {
  return {
    id: MAIN_BRANCH,
    title: '主线',
    fromPhaseId: null,
    fromSeq: null,
    status: 'active',
    createdAt: new Date().toISOString(),
    note: '',
    seedSessionId: null,
  }
}

/**
 * Bring an older journal (v1/v2, single-line phases) up to the branch model.
 * Idempotent: every project ends up with a `main` branch and every phase and
 * session carries a branchId.
 */
export function migrateJournal(state) {
  const now = new Date().toISOString()
  for (const project of Object.values(state.projects ?? {})) {
    if (!Array.isArray(project.branches) || project.branches.length === 0) {
      project.branches = [mainBranch()]
    }
    const known = new Set(project.branches.map((branch) => branch.id))
    if (!known.has(MAIN_BRANCH)) project.branches.unshift(mainBranch())
    for (const branch of project.branches) {
      if (typeof branch.status !== 'string') branch.status = 'active'
      if (!Array.isArray(branch.sessions)) branch.sessions = []
    }
    project.phases = (project.phases ?? []).filter((phase) => {
      if (typeof phase.branchId !== 'string' || phase.branchId === '') phase.branchId = MAIN_BRANCH
      if (phase.redoOf === undefined) phase.redoOf = null
      // 软删收口（t26 ⑤）：早期版本只写 deletedAt，raw.status 仍是 active/planned/done。
      // 读时归一成 status:'deleted'，并把原状态存进 statusBeforeDelete 供恢复使用。
      if (phase.deletedAt !== undefined && phase.deletedAt !== null) {
        if (typeof phase.statusBeforeDelete !== 'string' || phase.statusBeforeDelete === 'deleted') {
          phase.statusBeforeDelete = typeof phase.status === 'string' && phase.status !== 'deleted' ? phase.status : 'active'
        }
        phase.status = 'deleted'
      } else if (phase.status === 'deleted') {
        // 没有 deletedAt 却标 deleted 的脏数据：就当没删过，别让阶段凭空消失。
        phase.status = typeof phase.statusBeforeDelete === 'string' && phase.statusBeforeDelete !== 'deleted' ? phase.statusBeforeDelete : 'active'
        delete phase.statusBeforeDelete
      }
      // 问题档案的置信度：读时补齐（只加字段，不改写 statement/quote 历史）。
      for (const problem of Array.isArray(phase.problems) ? phase.problems : []) {
        if (problem === null || typeof problem !== 'object') continue
        if (problem.confidence !== 'evidenced' && problem.confidence !== 'inferred') {
          problem.confidence = typeof problem.quote === 'string' && problem.quote.trim() !== '' ? 'evidenced' : 'inferred'
        }
      }
      // 作者元信息（v0.4.0）：迁移阶段**不补** summaryMeta。旧阶段缺失时由
      // phaseSummaryMeta() 在读期推断（inferred:true），绝不把推断值写进磁盘——
      // 一旦落盘，「作者：未知 · 旧数据推断」就变成了假的历史记录。
      return known.has(phase.branchId)
    })
    const active = project.branches.find((branch) => branch.id === project.activeBranchId)
    if (active === undefined || active.status !== 'active') project.activeBranchId = MAIN_BRANCH
    if (project.updatedAt === undefined) project.updatedAt = now
  }
  for (const record of Object.values(state.sessions ?? {})) {
    if (typeof record.branchId !== 'string' || record.branchId === '') record.branchId = MAIN_BRANCH
  }
  state.version = 3
  return state
}

export function branchOf(project, branchId) {
  return (project.branches ?? []).find((branch) => branch.id === branchId)
}

/** Phases of one branch, in branch-local seq order. */
export function branchPhases(project, branchId) {
  return (project.phases ?? [])
    .filter((phase) => (phase.branchId ?? MAIN_BRANCH) === branchId)
    .filter((phase) => phase.deletedAt === undefined || phase.deletedAt === null)
}

export function emptyProject(id, title, path, order) {
  return { id, title, path, order, updatedAt: null, phases: [], branches: [mainBranch()], activeBranchId: MAIN_BRANCH }
}

export function ensureProject(state, { id, title, path }, order) {
  let project = state.projects[id]
  if (project === undefined) {
    project = emptyProject(id, title, path, order)
    state.projects[id] = project
  } else {
    project.title = title
    project.path = path
    project.order = order
  }
  if (!Array.isArray(project.phases)) project.phases = []
  if (!Array.isArray(project.branches) || project.branches.length === 0) project.branches = [mainBranch()]
  if (typeof project.activeBranchId !== 'string' || project.activeBranchId === '') project.activeBranchId = MAIN_BRANCH
  project.phases.forEach((phase) => {
    if (typeof phase.branchId !== 'string' || phase.branchId === '') phase.branchId = MAIN_BRANCH
  })
  return project
}

/** Keep each branch's phases ordered by start time; seq is branch-local. */
export function resequence(project) {
  const groups = new Map()
  for (const phase of project.phases) {
    if (phase.deletedAt !== undefined && phase.deletedAt !== null) continue
    const branchId = phase.branchId ?? MAIN_BRANCH
    if (!groups.has(branchId)) groups.set(branchId, [])
    groups.get(branchId).push(phase)
  }
  const ordered = []
  for (const branch of project.branches ?? [mainBranch()]) {
    const phases = groups.get(branch.id) ?? []
    phases.sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')) || a.seq - b.seq)
    phases.forEach((phase, index) => {
      phase.seq = index + 1
      ordered.push(phase)
    })
  }
  for (const [branchId, phases] of groups) {
    if ((project.branches ?? []).some((branch) => branch.id === branchId)) continue
    phases.sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')) || a.seq - b.seq)
    phases.forEach((phase, index) => {
      phase.seq = index + 1
      ordered.push(phase)
    })
  }
  const kept = project.phases.filter((phase) => phase.deletedAt !== undefined && phase.deletedAt !== null)
  project.phases = [...ordered, ...kept]
}

function clampText(value, max) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function normalizeKey(value) {
  return String(value ?? '')
    .replace(/[\s，。、；：！？,.;:!?（）()「」“”"'`~·\-—]/g, '')
    .toLowerCase()
}

export function phaseContext(project, maxPhases) {
  const phases = project.phases
    .filter((phase) => phase.deletedAt === undefined || phase.deletedAt === null)
    .slice(-Math.max(1, maxPhases))
  if (phases.length === 0) return '（还没有阶段：这是该项目的第一个阶段）'
  return phases
    .map((phase) => {
      const problems = phase.problems.length === 0 ? '' : `；问题：${phase.problems.map((p) => p.statement).join(' / ')}`
      const next = Array.isArray(phase.nextSteps) && phase.nextSteps.length > 0 ? `；下一步：${phase.nextSteps.slice(0, 3).join(' / ')}` : ''
      return `${phase.seq}. [${phase.id}] ${phase.title}（${phase.status}）— ${clampText(phase.summary, 120)}${problems}${next}`
    })
    .join('\n')
}

export function branchContext(project, branchId, maxPhases) {
  const phases = branchPhases(project, branchId)
  if (phases.length === 0) return '（这条分支还没有阶段：这是它的第一个阶段）'
  return phases
    .slice(-Math.max(1, maxPhases))
    .map((phase) => {
      const problems = phase.problems.length === 0 ? '' : `；问题：${phase.problems.map((p) => p.statement).join(' / ')}`
      const next = Array.isArray(phase.nextSteps) && phase.nextSteps.length > 0 ? `；下一步：${phase.nextSteps.slice(0, 3).join(' / ')}` : ''
      return `${phase.seq}. [${phase.id}] ${phase.title}（${phase.status}）— ${clampText(phase.summary, 120)}${problems}${next}`
    })
    .join('\n')
}

export function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Turn the raw session log into a compact digest for the summarizer.
 * Only the delta after `cursorSeq` is considered, and the digest keeps the
 * newest lines when it exceeds `maxChars`.
 */
export function buildDigest(events, cursorSeq, options) {
  const maxChars = Math.max(4000, Number(options?.maxChars ?? 60000))
  const cursor = Number.isFinite(Number(cursorSeq)) ? Number(cursorSeq) : -1
  const userTexts = []
  const lines = []
  let maxSeq = cursor
  let userEvents = 0
  let newCount = 0
  for (const event of Array.isArray(events) ? events : []) {
    const seq = Number(event?.seq ?? 0)
    if (!Number.isFinite(seq) || seq <= cursor) continue
    maxSeq = Math.max(maxSeq, seq)
    const data = event.data ?? {}
    if (event.type === 'user/message') {
      const text = contentText(data.content)
      if (text === '') continue
      userEvents += 1
      userTexts.push(text)
      lines.push(`U: ${clampText(text, 1200)}`)
      newCount += 1
    } else if (event.type === 'assistant/message') {
      const message = data.message ?? {}
      if (data.stream === true) continue
      const text = contentText(message.content)
      if (text === '') continue
      lines.push(`A: ${clampText(text, 1500)}`)
      newCount += 1
    } else if (event.type === 'tool/result') {
      const error = data.error
      if (error === undefined || error === null) continue
      const name = clampText(data.name ?? data.message?.toolName ?? 'tool', 40)
      const reason = clampText(error.reason ?? error.message ?? error.code ?? '', 160)
      lines.push(`E: ${name} 失败 ${reason}`)
      newCount += 1
    }
  }
  const header = []
  if (options?.session) {
    header.push(`[会话] ${options.session.title ?? ''}`)
  }
  if (options?.phaseContext) header.push(`[已有阶段链]\n${options.phaseContext}`)
  header.push('[本次新增]')
  const head = header.join('\n')
  let body = lines.join('\n')
  if (head.length + body.length > maxChars) {
    const room = Math.max(1000, maxChars - head.length)
    body = body.slice(Math.max(0, body.length - room))
    body = body.slice(Math.max(0, body.indexOf('\n', 0) + 1))
  }
  return {
    text: `${head}\n${body}`,
    maxSeq,
    newCount,
    userEvents,
    userText: userTexts.join('\n'),
  }
}

function problemVocabulary(phase) {
  const keys = new Set()
  for (const problem of phase.problems) keys.add(normalizeKey(problem.statement))
  return keys
}

/**
 * Apply one model answer. All model output is treated as untrusted: unknown
 * ids create phases, manual fields stay untouched, and a problem quote is only
 * kept when it actually appears in the user text we sent.
 */
export function applySummary(state, input) {
  const { project, sessionId, sessionStart, parsed, userText } = input
  const source = input.source === undefined || input.source === null ? null : input.source
  const branchId = typeof input.branchId === 'string' && input.branchId !== '' ? input.branchId : MAIN_BRANCH
  const local = branchPhases(project, branchId)
  const now = new Date().toISOString()
  const created = []
  const touched = new Set()
  const phases = Array.isArray(parsed?.phases) ? parsed.phases : []
  for (const candidate of phases) {
    if (candidate === null || typeof candidate !== 'object') continue
    const title = clampText(candidate.title, MAX_PHASE_TITLE)
    if (title === '') continue
    let phase
    if (typeof candidate.id === 'string' && candidate.id !== '') {
      phase = local.find((item) => item.id === candidate.id)
    }
    if (phase === undefined) {
      phase = local.find((item) => normalizeKey(item.title) === normalizeKey(title))
    }
    if (phase === undefined) {
      phase = {
        id: newId('ph'),
        seq: local.length + 1,
        branchId,
        redoOf: null,
        title,
        summary: '',
        status: 'active',
        startedAt: candidate.startedAt ?? sessionStart ?? now,
        endedAt: null,
        sessions: [],
        artifacts: [],
        manual: false,
        nextSteps: [],
        problems: [],
        sourceSessionId: source?.sessionId ?? null,
        sourceSeq: Number.isFinite(Number(source?.seq)) ? Number(source.seq) : null,
      }
      const previousActive = [...local].reverse().find((item) => item.status === 'active')
      if (previousActive !== undefined && previousActive.id !== phase.id) {
        previousActive.status = 'done'
        previousActive.endedAt = phase.startedAt
      }
      project.phases.push(phase)
      local.push(phase)
      created.push(phase.id)
    }
    touched.add(phase.id)
    if ((phase.sourceSessionId === undefined || phase.sourceSessionId === null) && typeof source?.sessionId === 'string') {
      phase.sourceSessionId = source.sessionId
      phase.sourceSeq = Number.isFinite(Number(source?.seq)) ? Number(source.seq) : null
    }
    if (phase.manual !== true) {
      if (phase.redoOf === null || phase.redoOf === undefined) phase.title = title
      if (typeof candidate.summary === 'string' && candidate.summary.trim() !== '') {
        phase.summary = clampText(candidate.summary, MAX_PHASE_SUMMARY)
      }
      if (STATUSES.has(candidate.status)) {
        phase.status = candidate.status
        if (candidate.status === 'done' && phase.endedAt === null) phase.endedAt = now
      }
      // 作者元信息（v0.4.0）：只有模型真的改写了这条阶段内容才记一笔。
      // manual 阶段内容没动，作者仍应显示上次手改的人（§14 Q3）。
      // F5：没有真实作者信息（连模型名都没有）时干脆不写字段——让 phaseBrief 读时给
      // `inferred: true` 的兜底，而不是往磁盘里塞一条 `by:'model', model:null` 的假记录。
      const meta = input.meta === null || typeof input.meta !== 'object' ? {} : input.meta
      const author = typeof meta.model === 'string' ? meta.model.trim() : ''
      if (author !== '') {
        phase.summaryMeta = {
          v: 1,
          by: 'model',
          at: now,
          model: author,
          provider: typeof meta.provider === 'string' && meta.provider !== '' ? meta.provider : null,
          sessionId: sessionId === undefined || sessionId === null ? null : String(sessionId),
          seq: Number.isFinite(Number(source?.seq)) ? Number(source.seq) : null,
          restoredFrom: null,
        }
      }
    }
    if (Array.isArray(candidate.nextSteps) && phase.manual !== true) {
      const steps = candidate.nextSteps
        .map((step) => clampText(step, 120))
        .filter((step) => step !== '')
        .slice(0, 6)
      if (steps.length > 0) phase.nextSteps = steps
    }
    if (Array.isArray(candidate.artifacts)) {
      for (const artifact of candidate.artifacts) {
        const value = clampText(artifact, 160)
        if (value !== '' && !phase.artifacts.includes(value)) phase.artifacts.push(value)
      }
      phase.artifacts = phase.artifacts.slice(0, 12)
    }
    if (sessionId !== undefined && sessionId !== null && !phase.sessions.includes(String(sessionId))) {
      phase.sessions.push(String(sessionId))
    }
    const known = problemVocabulary(phase)
    for (const candidateProblem of Array.isArray(candidate.problems) ? candidate.problems : []) {
      if (candidateProblem === null || typeof candidateProblem !== 'object') continue
      const statement = clampText(candidateProblem.statement, MAX_PROBLEM_TEXT)
      if (statement === '') continue
      const quote = typeof candidateProblem.quote === 'string' && userText.includes(candidateProblem.quote.trim())
        ? clampText(candidateProblem.quote, MAX_PROBLEM_TEXT)
        : ''
      const confidence = quote === '' ? 'inferred' : 'evidenced'
      const resolution = clampText(candidateProblem.resolution, MAX_PROBLEM_TEXT)
      const status = candidateProblem.status === 'open' ? 'open' : 'solved'
      const key = normalizeKey(statement)
      const existing = phase.problems.find((problem) => normalizeKey(problem.statement) === key)
      if (existing !== undefined) {
        if (existing.manual !== true) {
          existing.statement = statement
          existing.resolution = resolution
          existing.status = status
          if (quote !== '') existing.quote = quote
          // 有原话就是有证据；没有就显式降级为推测（t26 ②）。
          existing.confidence = quote === '' ? problemConfidence(existing) : 'evidenced'
        }
      } else {
        phase.problems.push({
          id: newId('pb'),
          statement,
          quote,
          confidence,
          resolution,
          status,
          at: now,
          sessionId: String(sessionId ?? ''),
          manual: false,
        })
        known.add(key)
      }
    }
    // active 阶段没有 nextSteps 时，用未解决的问题兜底，保证「接下来做什么」不为空。
    if (phase.manual !== true && phase.status === 'active' && (!Array.isArray(phase.nextSteps) || phase.nextSteps.length === 0)) {
      const open = (Array.isArray(phase.problems) ? phase.problems : [])
        .filter((problem) => problem.status === 'open')
        .map((problem) => `处理：${String(problem.statement || '').slice(0, 110)}`)
        .filter((step) => step.trim() !== '处理：')
        .slice(0, 3)
      if (open.length > 0) phase.nextSteps = open
    }
  }
  if (created.length > 0) resequence(project)
  project.updatedAt = now
  return { created, touched: [...touched] }
}

/**
 * 问题档案的可信度（t26 ②）：有原话（quote）才算「有证据」，否则降级为推测。
 * 旧数据没有 confidence 字段，读时按 quote 是否存在推导——不重写历史记录。
 */
export function problemConfidence(problem) {
  if (problem === null || typeof problem !== 'object') return 'inferred'
  if (problem.confidence === 'evidenced' || problem.confidence === 'inferred') return problem.confidence
  return typeof problem.quote === 'string' && problem.quote.trim() !== '' ? 'evidenced' : 'inferred'
}

/** 一条 artifacts 记录的磁盘存在性（t26 ③）：面板据此置灰并提供清理。 */
export function artifactEntries(projectPath, phase) {
  const list = Array.isArray(phase?.artifacts) ? phase.artifacts : []
  const root = typeof projectPath === 'string' ? projectPath : ''
  return list.map((name) => {
    const label = String(name ?? '')
    const path = label === '' ? '' : isAbsolute(label) ? label : join(root, label)
    let exists = false
    if (path !== '') {
      try {
        exists = existsSync(path)
      } catch {
        exists = false
      }
    }
    return { name: label, path, exists }
  })
}

/**
 * 归纳/手改/回退的作者四态（v0.4.0，设计 §5.2）。
 * `model` 由摘要模型写入，`user` 是面板手改，`restore` 是回退一版，`unknown` 是旧数据推断。
 */
export const SUMMARY_AUTHORS = ['model', 'user', 'restore', 'unknown']

/**
 * 面板/导出看到的作者元信息：永远返回一个对象。
 * 旧数据缺失或非法时给兜底并标 `inferred:true`——兜底只在内存里，不回写磁盘。
 */
export function phaseSummaryMeta(phase) {
  const meta = phase?.summaryMeta
  if (meta !== null && typeof meta === 'object' && typeof meta.at === 'string' && meta.at !== '') {
    return {
      v: 1,
      by: SUMMARY_AUTHORS.includes(meta.by) ? meta.by : 'unknown',
      at: meta.at,
      model: typeof meta.model === 'string' && meta.model !== '' ? meta.model : null,
      provider: typeof meta.provider === 'string' && meta.provider !== '' ? meta.provider : null,
      sessionId: typeof meta.sessionId === 'string' && meta.sessionId !== '' ? meta.sessionId : null,
      seq: Number.isFinite(Number(meta.seq)) ? Number(meta.seq) : null,
      restoredFrom: typeof meta.restoredFrom === 'string' && meta.restoredFrom !== '' ? meta.restoredFrom : null,
      inferred: false,
    }
  }
  const at = typeof phase?.updatedAt === 'string' && phase.updatedAt !== ''
    ? phase.updatedAt
    : (typeof phase?.startedAt === 'string' && phase.startedAt !== '' ? phase.startedAt : null)
  return {
    v: 1,
    by: phase?.manual === true ? 'user' : 'unknown',
    at,
    model: null,
    provider: null,
    sessionId: null,
    seq: null,
    restoredFrom: null,
    inferred: true,
  }
}

export function phaseBrief(phase, projectPath) {
  return {
    id: phase.id,
    seq: phase.seq,
    branchId: phase.branchId ?? MAIN_BRANCH,
    redoOf: phase.redoOf ?? null,
    title: phase.title,
    summary: phase.summary,
    status: phase.status,
    startedAt: phase.startedAt,
    endedAt: phase.endedAt,
    sessions: phase.sessions,
    artifacts: phase.artifacts,
    artifactStatus: artifactEntries(projectPath, phase),
    manual: phase.manual === true,
    summaryMeta: phaseSummaryMeta(phase),
    nextSteps: Array.isArray(phase.nextSteps) ? phase.nextSteps : [],
    problems: (Array.isArray(phase.problems) ? phase.problems : []).map((problem) => ({
      ...problem,
      confidence: problemConfidence(problem),
    })),
    revisions: Array.isArray(phase.revisions) ? phase.revisions.slice(-5) : [],
    revisionCount: Array.isArray(phase.revisions) ? phase.revisions.length : 0,
  }
}
