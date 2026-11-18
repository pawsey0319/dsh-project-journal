/**
 * Host-half route regression tests (no real DSH, no real journal).
 *
 * Boots index.js against a throw-away HOME with a hand-written journal fixture and
 * calls the registered prefix route directly, so the paths that used to 500 or
 * silently corrupt state (trash empty, export, hard delete, consistency fix,
 * branch delete, config) are exercised end to end.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HOME = mkdtempSync(join(tmpdir(), 'pj-routes-'))

const now = new Date().toISOString()
const journal = {
  version: 3,
  updatedAt: now,
  config: { provider: '', model: '', auto: false, idleDelayMs: 25000, minNewEvents: 3, maxInputChars: 60000, maxPhaseContext: 12, throttleMs: 1500 },
  projects: {
    p1: {
      id: 'p1',
      title: 'P1',
      path: '/tmp/pj-p1',
      order: 0,
      createdAt: now,
      updatedAt: now,
      locked: false,
      activeBranchId: 'main',
      branches: [
        { id: 'main', title: '主线', fromPhaseId: null, fromSeq: null, status: 'active', createdAt: now, note: '', seedSessionId: null },
        { id: 'b1', title: '实验', fromPhaseId: 'ph1', fromSeq: 1, status: 'abandoned', createdAt: now, note: '', seedSessionId: null },
      ],
      phases: [
        { id: 'ph1', seq: 1, title: 'live', summary: 'live summary', status: 'done', branchId: 'main', sessions: ['s2'], problems: [], nextSteps: [], artifacts: [], createdAt: now, updatedAt: now },
        { id: 'ph2', seq: 2, title: 'deleted', summary: 'deleted summary', status: 'done', branchId: 'main', sessions: ['s1'], problems: [], nextSteps: [], artifacts: [], deletedAt: now, deletedBy: 'user', trashedArtifacts: [{ name: 'artifact.bin' }] },
        { id: 'ph3', seq: 1, title: 'empty branch phase', summary: '', status: 'planned', branchId: 'b1', sessions: [], problems: [], nextSteps: [], artifacts: [], createdAt: now },
        { id: 'ph4', seq: 2, title: 'busy branch phase', summary: 'busy summary', status: 'done', branchId: 'b1', sessions: ['s2'], problems: [], nextSteps: [], artifacts: [], createdAt: now },
      ],
    },
    unassigned: {
      id: 'unassigned',
      title: '未归属会话',
      path: '',
      order: 999,
      createdAt: now,
      updatedAt: now,
      locked: true,
      activeBranchId: 'main',
      branches: [{ id: 'main', title: '主线', fromPhaseId: null, fromSeq: null, status: 'active', createdAt: now, note: '', seedSessionId: null }],
      phases: [{ id: 'uph1', seq: 1, title: 'unassigned phase', summary: 'u summary', status: 'done', branchId: 'main', sessions: ['su'], problems: [], nextSteps: [], artifacts: [], createdAt: now, updatedAt: now }],
    },
  },
  sessions: {
    s1: { sessionId: 's1', projectId: 'p1', branchId: 'main', phaseIds: ['ph1', 'ph_ghost'], hidden: true, hiddenBy: 'ph2', state: 'done', cursorSeq: 5, attempts: 0 },
    s2: { sessionId: 's2', projectId: 'p1', branchId: 'main', phaseIds: ['ph1'], hidden: false, state: 'done', cursorSeq: 3, attempts: 0 },
    su: { sessionId: 'su', projectId: 'unassigned', branchId: 'main', phaseIds: ['uph1'], hidden: false, state: 'done', cursorSeq: 2, attempts: 0 },
  },
  backfill: { state: 'done', projectId: null, processed: 0, total: 0, startedAt: null },
}

const DIR = join(process.env.HOME, '.dsh', 'project-journal')
mkdirSync(DIR, { recursive: true })
// p1 只有出现在 workspace 行里才进可见项目列表（面板与 /api/state 都按 workspace 组织）。
const STORAGE = join(process.env.HOME, '.dsh', 'storages')
mkdirSync(STORAGE, { recursive: true })
writeFileSync(join(STORAGE, 'workspace.json'), JSON.stringify({ tables: { workspaces: { p1: { id: 'p1', title: 'P1', path: '/tmp/pj-p1', sessionIds: ['s2'] } } }, global: { workspaceIds: ['p1'], archivedSessionIds: [] } }, null, 2))
mkdirSync(join(DIR, 'trash', 'p1'), { recursive: true })
writeFileSync(join(DIR, 'journal.json'), JSON.stringify(journal, null, 2))
writeFileSync(join(DIR, 'trash', 'p1', 'artifact.bin'), 'x'.repeat(32))
// F-08：模拟「上一次启动损坏另存过、随后宿主又写了空壳」的磁盘状态。启动后应重新提示，
// 而不是因为 journal.json 已经可解析就把事故静默掉。
const CORRUPT = join(DIR, 'journal.json.corrupt-fixture')
writeFileSync(CORRUPT, '{ leftover corrupt fixture')
mkdirSync(join(DIR, 'backups'), { recursive: true })
writeFileSync(join(DIR, 'backups', 'restore-me.json'), JSON.stringify(journal, null, 2))

const { apply } = await import('../index.js')

let route = null
const storage = { domain: null }
const ctx = {
  webServer: {
    register(options) {
      route = options.resource
      return () => {}
    },
  },
  effect(fn) {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  on() {
    return () => {}
  },
  get(name) {
    if (name === 'storageDomain' && storage.domain !== null) return storage.domain
    return undefined
  },
  sessionQuery: {
    async listSessions() {
      return []
    },
    async readTitle() {
      return null
    },
    async readSession() {
      return null
    },
  },
  llm: {
    async listProviders() {
      return []
    },
  },
}
apply(ctx)
assert.ok(typeof route === 'function', 'prefix route should be registered')

const call = async (path) => {
  const response = await route(new Request(`http://127.0.0.1:1/x-journal${path}`))
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: response.status, text, json }
}

test('trash/empty 清空非空回收站返回 ok 且不抛 ReferenceError', async () => {
  const result = await call('/api/trash/empty?confirm=1&projectId=p1')
  assert.equal(result.status, 200, result.text)
  assert.equal(result.json.ok, true)
  assert.equal(result.json.projects[0], 'p1')
  assert.equal(result.json.removed.files, 1)
  assert.equal(result.json.removed.bytes, 32)
  assert.equal(existsSync(join(DIR, 'trash', 'p1')), false, 'trash dir should be removed')
  // 记录仍在回收站：产物文件清空后打标记，不丢阶段本身。
  const after = JSON.parse(await (await import('node:fs/promises')).readFile(join(DIR, 'journal.json'), 'utf8'))
  assert.match(after.projects.p1.phases.find((phase) => phase.id === 'ph2').trashedArtifactsPurgedAt, /^\d{4}-/)
})

test('删除分支把空阶段也转进回收站，不再静默丢弃', async () => {
  const before = JSON.parse(await (await import('node:fs/promises')).readFile(join(DIR, 'journal.json'), 'utf8'))
  assert.equal(before.projects.p1.phases.find((phase) => phase.id === 'ph3').deletedAt, undefined)
  const result = await call('/api/branch/delete?projectId=p1&branchId=b1&force=1')
  assert.equal(result.status, 200, result.text)
  assert.equal(result.json.softDeleted, 2, 'both ph3 (empty) and ph4 (busy) should be soft-deleted')
  const after = JSON.parse(await (await import('node:fs/promises')).readFile(join(DIR, 'journal.json'), 'utf8'))
  for (const id of ['ph3', 'ph4']) {
    const phase = after.projects.p1.phases.find((item) => item.id === id)
    assert.ok(phase.deletedAt, `${id} should be soft-deleted`)
    assert.equal(phase.branchId, 'main', `${id} should land on main so it stays in the journal`)
  }
})

test('导出 Markdown 只含活阶段且序号不重复', async () => {
  const result = await call('/api/export?projectId=p1')
  assert.equal(result.status, 200)
  assert.match(result.text, /阶段 1（另有 3 个回收站阶段未导出）/)
  assert.match(result.text, /live summary/)
  assert.doesNotMatch(result.text, /deleted summary/)
  assert.doesNotMatch(result.text, /busy summary/)
  assert.equal(result.text.match(/^### 1\./gm)?.length, 1)
  assert.equal(result.text.match(/^### /gm)?.length, 1)
})

test('一致性检查与修复同一口径：报 1 条就能修 1 条', async () => {
  const state = await call('/api/state')
  assert.equal(state.json.projects.find((project) => project.id === 'p1').consistency.count, 1)
  const fixed = await call('/api/consistency/fix?projectId=p1')
  assert.equal(fixed.status, 200, fixed.text)
  assert.equal(fixed.json.changed, 1)
  assert.equal(fixed.json.removedFromRecord, 1)
  assert.equal(fixed.json.remaining, 0)
  assert.equal(fixed.json.noop, false)
  const again = await call('/api/consistency/fix?projectId=p1')
  assert.equal(again.json.noop, true, 'second pass must be a no-op instead of pretending to fix')
  assert.equal(again.json.remaining, 0)
})

test('永久删除阶段会解除只因它而隐藏的会话', async () => {
  const before = await call('/api/state')
  assert.equal(before.json.projects.find((project) => project.id === 'p1').phases.length, 1, 'only ph1 is live')
  const removed = await call('/api/phase?projectId=p1&phaseId=ph2&action=delete&hard=1')
  assert.equal(removed.status, 200, removed.text)
  assert.equal(removed.json.ok, true)
  const after = JSON.parse(await (await import('node:fs/promises')).readFile(join(DIR, 'journal.json'), 'utf8'))
  const s1 = after.sessions.s1
  assert.equal(s1.hidden, undefined, 'hidden must be cleared')
  assert.equal(s1.hiddenBy, undefined, 'hiddenBy must be cleared')
  assert.equal(s1.phaseIds.includes('ph2'), false)
  assert.equal(after.projects.p1.phases.some((phase) => phase.id === 'ph2'), false)
})

test('config 拒绝非法数值而不是写入 NaN', async () => {
  const bad = await call('/api/config?idleDelayMs=abc&minNewEvents=0&maxInputChars=1e9')
  assert.equal(bad.status, 200)
  assert.deepEqual([...bad.json.ignored].sort(), ['idleDelayMs', 'maxInputChars', 'minNewEvents'].sort())
  assert.equal(bad.json.config.idleDelayMs, 25000)
  const good = await call('/api/config?idleDelayMs=15000')
  assert.deepEqual(good.json.ignored, [])
  assert.equal(good.json.config.idleDelayMs, 15000)
})

test('导出不存在的项目返回可读错误码而不是 500', async () => {
  const result = await call('/api/export?projectId=nope')
  assert.equal(result.status, 404)
  assert.equal(result.json.error, 'project-missing')
})

test('未归属会话迁出时把它的阶段一起带走，不留悬空指针', async () => {
  const rows = new Map([
    ['p1', { id: 'p1', path: '/tmp/pj-p1', title: 'P1', sessionIds: ['s2'] }],
  ])
  storage.domain = {
    get(name) {
      return name === 'workspace' ? storage.domain : undefined
    },
    table() {
      return {
        get(id) {
          return rows.get(id)
        },
        update(id, fn) {
          const current = rows.get(id)
          if (current !== undefined) rows.set(id, fn(current))
        },
        entries() {
          return rows.entries()
        },
      }
    },
    global: { get: () => ({ workspaceIds: ['p1'], archivedSessionIds: [] }) },
  }
  const before = JSON.parse(await (await import('node:fs/promises')).readFile(join(DIR, 'journal.json'), 'utf8'))
  assert.ok(before.projects.unassigned.phases.some((phase) => phase.id === 'uph1'))
  const result = await call('/api/migrate?sessionId=su&targetProjectId=p1')
  assert.equal(result.status, 200, result.text)
  assert.equal(result.json.from, null)
  assert.equal(result.json.phases, 1, 'the unassigned phase should travel with the session')
  const after = JSON.parse(await (await import('node:fs/promises')).readFile(join(DIR, 'journal.json'), 'utf8'))
  assert.equal(after.sessions.su.projectId, 'p1')
  assert.equal(after.projects.unassigned.phases.some((phase) => phase.id === 'uph1'), false, 'phase must leave the unassigned bucket')
  const moved = after.projects.p1.phases.find((phase) => phase.id === 'uph1')
  assert.ok(moved, 'phase must land in the target project')
  assert.equal(moved.branchId, 'main')
  assert.ok(after.sessions.su.phaseIds.includes('uph1'))
  assert.ok(rows.get('p1').sessionIds.includes('su'), 'workspace row must claim the session')
  const consistency = await call('/api/consistency/fix?projectId=p1')
  assert.equal(consistency.json.remaining, 0)
})

test('残留 .corrupt-* 时启动即重新提示，diagnostics 暴露 corruptFiles', async () => {
  const state = await call('/api/state')
  const error = state.json.journalError
  assert.ok(error !== null, '重启后横幅应重新出现')
  assert.equal(error.reason, 'corrupt-backup-present')
  assert.equal(error.original, join(DIR, 'journal.json'))
  assert.match(error.file, /\.corrupt-fixture$/)

  const diag = await call('/api/diagnostics')
  const files = diag.json.corruptFiles
  assert.ok(Array.isArray(files) && files.length >= 1, 'diagnostics 应列出损坏另存')
  const entry = files.find((item) => item.path === CORRUPT)
  assert.ok(entry, 'diagnostics 条目应指向 .corrupt-* 文件')
  assert.ok(entry.bytes > 0)
  assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T/)
})

test('dismiss 按 .at 会话内忽略：同一次启动不再出现，重复点也无害', async () => {
  const first = await call('/api/journal/dismiss-error?confirm=1')
  assert.equal(first.status, 200, first.text)
  assert.equal(first.json.ok, true)
  assert.equal(first.json.journalError, null)

  const state = await call('/api/state')
  assert.equal(state.json.journalError, null, '同一 .at 不应再弹')

  const again = await call('/api/journal/dismiss-error?confirm=1')
  assert.equal(again.json.ok, true, '重复忽略不应报错')
})

test('从备份恢复后写恢复记录并清横幅；再启动也不反弹', async () => {
  const restored = await call('/api/backup/restore?file=restore-me.json')
  assert.equal(restored.status, 200, restored.text)
  assert.equal(restored.json.ok, true)

  const record = join(DIR, 'journal.last-restore.json')
  assert.equal(existsSync(record), true, '恢复成功后应写恢复记录')
  const state = await call('/api/state')
  assert.equal(state.json.journalError, null, '恢复后横幅应消失')

  // 模拟下一次启动：同一份 .corrupt-* 已被恢复记录覆盖，不应反弹。
  const store = await import('../journal-store.js')
  store.loadJournal()
  assert.equal(store.journalLoadError(), null, '恢复记录应覆盖更早的损坏另存')
})
