/**
 * Project Journal — durable store + deterministic merge rules.
 *
 * Everything in this file is free of Cordis dependencies so it can be exercised
 * directly with `node -e` while iterating on merge behaviour.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
    if (raw === null || typeof raw !== 'object') return emptyJournal()
    const state = { ...emptyJournal(), ...raw }
    state.config = { ...emptyJournal().config, ...(raw.config ?? {}) }
    state.projects = raw.projects ?? {}
    state.sessions = raw.sessions ?? {}
    state.backfill = { ...emptyJournal().backfill, ...(raw.backfill ?? {}) }
    for (const record of Object.values(state.sessions)) {
      if (record.state === 'summarizing' || record.state === 'queued') record.state = 'idle'
    }
    migrateJournal(state)
    return state
  } catch {
    return emptyJournal()
  }
}

export function saveJournal(state) {
  mkdirSync(DIR, { recursive: true })
  state.updatedAt = new Date().toISOString()
  const tmp = `${FILE}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  renameSync(tmp, FILE)
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
        }
      } else {
        phase.problems.push({
          id: newId('pb'),
          statement,
          quote,
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

export function phaseBrief(phase) {
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
    manual: phase.manual === true,
    nextSteps: Array.isArray(phase.nextSteps) ? phase.nextSteps : [],
    problems: phase.problems,
    revisions: Array.isArray(phase.revisions) ? phase.revisions.slice(-5) : [],
    revisionCount: Array.isArray(phase.revisions) ? phase.revisions.length : 0,
  }
}
