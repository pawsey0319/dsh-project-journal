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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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
        { id: 'ph3', seq: 1, title: 'empty branch phase', summary: '', status: 'planned', branchId: 'b1', sessions: [], problems: [], nextSteps: [], artifacts: [], createdAt: now, updatedAt: now, summaryMeta: { v: 1, by: 'model', at: '2026-11-18T02:03:04.000Z', model: 'deepseek-chat', provider: 'deepseek', sessionId: 's2', seq: 3, restoredFrom: null } },
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
    // v0.4.0 E：幽灵项目 —— 不在 workspace 表里，面板看不见，但仍占着 journal。
    'pj-ghost': {
      id: 'pj-ghost', title: '幽灵项目', path: '/tmp/pj-ghost', order: 7, createdAt: now, updatedAt: now, locked: false,
      activeBranchId: 'main',
      branches: [{ id: 'main', title: '主线', fromPhaseId: null, fromSeq: null, status: 'active', createdAt: now, note: '', seedSessionId: null }],
      phases: [{ id: 'gph1', seq: 1, title: 'ghost phase', summary: 'g', status: 'done', branchId: 'main', sessions: [], problems: [{ id: 'gpr1', statement: 'p', status: 'open', confidence: 'evidenced', quote: 'q' }], nextSteps: [], artifacts: [], createdAt: now, updatedAt: now }],
    },
    // 还有会话的幽灵项目：只能先处理会话，不许直接删记录。
    'pj-busy': {
      id: 'pj-busy', title: '还有会话的幽灵', path: '/tmp/pj-busy', order: 8, createdAt: now, updatedAt: now, locked: false,
      activeBranchId: 'main', branches: [], phases: [],
    },
    // 路径与 workspace 行相同的幽灵项目：删它等于跟真实项目抢地盘。
    'pj-dup': {
      id: 'pj-dup', title: '路径撞车的幽灵', path: '/tmp/pj-p1', order: 9, createdAt: now, updatedAt: now, locked: false,
      activeBranchId: 'main', branches: [], phases: [],
    },
  },
  sessions: {
    s1: { sessionId: 's1', projectId: 'p1', branchId: 'main', phaseIds: ['ph1', 'ph_ghost'], hidden: true, hiddenBy: 'ph2', state: 'done', cursorSeq: 5, attempts: 0 },
    s2: { sessionId: 's2', projectId: 'p1', branchId: 'main', phaseIds: ['ph1'], hidden: false, state: 'done', cursorSeq: 3, attempts: 0 },
    su: { sessionId: 'su', projectId: 'unassigned', branchId: 'main', phaseIds: ['uph1'], hidden: false, state: 'done', cursorSeq: 2, attempts: 0 },
    sb: { sessionId: 'sb', projectId: 'pj-busy', branchId: 'main', phaseIds: [], hidden: false, state: 'done', cursorSeq: 0, attempts: 0 },
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

const callWith = async (path, headers) => {
  const response = await route(new Request(`http://127.0.0.1:1/x-journal${path}`, { headers }))
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: response.status, text, json, headers: response.headers }
}

const call = (path) => callWith(path, undefined)

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

// ---------------------------------------------------------------------------
// v0.4.0：/api/state 条件请求、阶段修订按需拉取、幽灵项目只读清单与删除
// ---------------------------------------------------------------------------

test('/api/state 带 ETag；内容没变时回 304 且没有 body', async () => {
  const first = await call('/api/state?probe=1')
  assert.equal(first.status, 200, first.text)
  const etag = first.headers.get('etag')
  assert.ok(etag, '响应必须带 etag 头')
  assert.match(etag, /^"[A-Za-z0-9_-]{27}"$/)
  assert.equal(first.headers.get('cache-control'), 'no-store')

  const second = await callWith('/api/state', { 'if-none-match': etag })
  assert.equal(second.status, 304, second.text)
  assert.equal(second.text, '', '304 不得带 body（客户端据此跳过重渲染）')

  // 弱校验前缀与逗号列表也要认。
  const weak = await callWith('/api/state', { 'if-none-match': `"nope", W/${etag}` })
  assert.equal(weak.status, 304, weak.text)

  // 心跳/信标不算内容变化：只写 beacons（诊断环形缓冲）之后仍必须 304，
  // 否则每 5 s 轮询都会「看起来变了」，304 永远命中不了。
  await call('/api/beacon?e=etag-probe')
  const afterBeacon = await callWith('/api/state', { 'if-none-match': etag })
  assert.equal(afterBeacon.status, 304, 'beacons 变化不得改变 ETag')

  // 内容真变了（改配置）就必须回 200，不能拿旧 ETag 骗客户端。
  await call('/api/config?idleDelayMs=26000')
  const changed = await callWith('/api/state', { 'if-none-match': etag })
  assert.equal(changed.status, 200, '内容变化时不得回 304')
  assert.notEqual(changed.headers.get('etag'), etag)
})

test('阶段修订可单独拉取；缺参/缺项目/缺阶段都有可读错误码', async () => {
  const edited = await call('/api/phase?projectId=p1&phaseId=ph1&title=live-renamed')
  assert.equal(edited.status, 200, edited.text)

  const rev = await call('/api/phase/revisions?projectId=p1&phaseId=ph1')
  assert.equal(rev.status, 200, rev.text)
  assert.equal(rev.json.ok, true)
  assert.equal(rev.json.projectId, 'p1')
  assert.equal(rev.json.phaseId, 'ph1')
  assert.equal(rev.json.revisionLimit, 20)
  assert.ok(rev.json.revisionCount >= 1)
  assert.equal(rev.json.revisions[0].by, 'user', '人改的修订 by=user')
  assert.equal(rev.json.revisions[0].before.title, 'live')
  assert.equal(rev.json.revisions[0].after.title, 'live-renamed')
  assert.equal(rev.json.summaryMeta.by, 'user', '手改后作者标成 user')
  assert.match(rev.json.summaryMeta.at, /^\d{4}-\d{2}-\d{2}T/)

  const missing = await call('/api/phase/revisions?projectId=p1')
  assert.equal(missing.status, 400)
  assert.equal(missing.json.error, 'bad-request')
  const noPhase = await call('/api/phase/revisions?projectId=p1&phaseId=nope')
  assert.equal(noPhase.status, 404)
  assert.equal(noPhase.json.error, 'phase-missing')
  const noProject = await call('/api/phase/revisions?projectId=nope&phaseId=ph1')
  assert.equal(noProject.status, 404)
  assert.equal(noProject.json.error, 'project-missing')
})

test('/api/project/orphans 列出不在 workspace 的项目，但永不列出未归属', async () => {
  const result = await call('/api/project/orphans')
  assert.equal(result.status, 200, result.text)
  assert.equal(result.json.ok, true)
  const ids = result.json.orphans.map((item) => item.projectId).sort()
  assert.deepEqual(ids, ['pj-busy', 'pj-dup', 'pj-ghost'])
  assert.equal(result.json.total, 3)
  assert.equal(ids.includes('unassigned'), false, '未归属桶不是幽灵项目')

  const ghost = result.json.orphans.find((item) => item.projectId === 'pj-ghost')
  assert.equal(ghost.title, '幽灵项目')
  assert.equal(ghost.phases, 1)
  assert.equal(ghost.problems, 1)
  assert.equal(ghost.branches, 1)
  assert.equal(ghost.deletable, true)
  assert.equal(ghost.frozen, null)
  const busy = result.json.orphans.find((item) => item.projectId === 'pj-busy')
  assert.equal(busy.deletable, false, '还有会话的项目不能一键删')
})

test('删除幽灵项目记录：五类拒绝 + 成功时先备份、只动 journal', async () => {
  const noConfirm = await call('/api/project/delete?projectId=pj-ghost')
  assert.equal(noConfirm.status, 400)
  assert.equal(noConfirm.json.error, 'confirm-required')

  const noId = await call('/api/project/delete?confirm=1')
  assert.equal(noId.status, 400)
  assert.equal(noId.json.error, 'bad-request')

  const reserved = await call('/api/project/delete?confirm=1&projectId=unassigned')
  assert.equal(reserved.status, 400)
  assert.equal(reserved.json.error, 'reserved-project')

  const inWorkspace = await call('/api/project/delete?confirm=1&projectId=p1')
  assert.equal(inWorkspace.status, 400)
  assert.equal(inWorkspace.json.error, 'project-in-workspace')

  const busy = await call('/api/project/delete?confirm=1&projectId=pj-busy')
  assert.equal(busy.status, 400)
  assert.equal(busy.json.error, 'project-has-sessions')

  const dup = await call('/api/project/delete?confirm=1&projectId=pj-dup')
  assert.equal(dup.status, 400)
  assert.equal(dup.json.error, 'project-path-in-workspace')

  const missing = await call('/api/project/delete?confirm=1&projectId=nope')
  assert.equal(missing.status, 404)
  assert.equal(missing.json.error, 'project-missing')

  const { createHash } = await import('node:crypto')
  const { readFileSync } = await import('node:fs')
  const workspaceFile = join(STORAGE, 'workspace.json')
  const workspaceBefore = createHash('sha256').update(readFileSync(workspaceFile)).digest('hex')

  const deleted = await call('/api/project/delete?confirm=1&projectId=pj-ghost')
  assert.equal(deleted.status, 200, deleted.text)
  assert.equal(deleted.json.ok, true)
  assert.equal(deleted.json.deleted.projectId, 'pj-ghost')
  assert.equal(deleted.json.deleted.phases, 1)
  assert.equal(deleted.json.deleted.problems, 1)
  assert.equal(deleted.json.deleted.branches, 1)
  assert.match(deleted.json.backup, /^manual-.*\.json$/, '删记录前必须先备份')
  assert.equal(existsSync(join(DIR, 'backups', deleted.json.backup)), true)

  const workspaceAfter = createHash('sha256').update(readFileSync(workspaceFile)).digest('hex')
  assert.equal(workspaceAfter, workspaceBefore, 'workspace.json 不得被改动（只删 journal 记录）')

  const journalAfter = JSON.parse(readFileSync(join(DIR, 'journal.json'), 'utf8'))
  assert.equal(journalAfter.projects['pj-ghost'], undefined)
  assert.ok(journalAfter.projects.p1, '其它项目不受影响')

  const orphans = await call('/api/project/orphans')
  assert.deepEqual(orphans.json.orphans.map((item) => item.projectId).sort(), ['pj-busy', 'pj-dup'])
})

test('导出 Markdown 每个阶段带作者行（与面板同口径，t6 F8）', async () => {
  const res = await call('/api/export?projectId=p1')
  assert.equal(res.status, 200, res.text)
  const authorLines = res.text.match(/^作者：.*$/gm) ?? []
  assert.equal(authorLines.length, 3, 'p1 有 3 个非回收站阶段，每个阶段一行作者')
  // 手写了 summaryMeta 的阶段按四态显示；旧阶段没有字段，读期推断为 unknown。
  assert.ok(authorLines.includes('作者：模型（deepseek-chat） · 2026-11-18T02:03:04.000Z'), authorLines.join(' / '))
  assert.ok(authorLines.some((line) => line.startsWith('作者：未知') && line.endsWith('· 旧数据推断')), authorLines.join(' / '))
  // 作者行必须紧跟阶段标题，别飘到别处（标题可能被前面的用例改过名，这里不锁标题文本）。
  assert.match(res.text, /### 1\. [^\n]+\n\n作者：/m)
  assert.equal((res.text.match(/### \d+\. [^\n]+\n\n作者：/g) ?? []).length, 3)
})

test('/api/project/delete 拒绝原型链键：404、不返回 ok、不写备份（t6 F4）', async () => {
  const backups = join(DIR, 'backups')
  const before = readdirSync(backups).length
  for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const res = await call(`/api/project/delete?confirm=1&projectId=${encodeURIComponent(id)}`)
    assert.equal(res.status, 404, `${id} 不能顺着原型链被当成项目`)
    assert.equal(res.json.error, 'project-missing')
    assert.equal(res.json.ok, undefined)
  }
  assert.equal(readdirSync(backups).length, before, '拒绝路径不得产生备份文件')
  // 只读接口同样不能认原型链键。
  const revisions = await call('/api/phase/revisions?projectId=__proto__&phaseId=ph1')
  assert.equal(revisions.status, 404)
  assert.equal(revisions.json.error, 'project-missing')
})

test('/api/project/orphans 是只读实现：处理块里不出现 reconcile()（t6 F9）', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const start = source.indexOf("if (pathname.endsWith('/api/project/orphans'))")
  const end = source.indexOf("if (pathname.endsWith('/api/project/delete'))")
  assert.ok(start > 0 && end > start, '找不到 /api/project/orphans 处理块')
  // 注释里会提到 reconcile()（说明为什么不用），所以先去掉行注释再断言调用。
  const block = source.slice(start, end).split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
  assert.equal(/reconcile\s*\(/.test(block), false, '只读接口不得调用 reconcile()（它会就地补项目、写内存）')
  assert.match(block, /workspaceRows\s*\(/, '应该只读 workspace 表本身')
})

// ---------------------------------------------------------------- 客户端纯函数
// 面板逻辑跑在浏览器里，本仓库没有 jsdom 环境；但 C5（条件请求头）、C8（300 ms 合并窗口）、
// D4（Esc 分层）本身是纯函数。这里**直接从 client.js 抽源码**来跑，而不是另抄一份实现——
// 抄一份只能证明「测试自洽」，抽源码才能在函数被删/改跑偏时真正失败（t6 F3）。

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function sliceFrom(marker, stopMarker) {
  const start = source.indexOf(marker)
  assert.ok(start >= 0, `client.js 里找不到标记：${marker}`)
  const end = stopMarker === null ? source.length : source.indexOf(stopMarker, start)
  assert.ok(end > start, `client.js 里找不到结束标记：${stopMarker}`)
  return source.slice(start, end)
}

// 纯函数区：从「C5：条件请求头」到 api() 之前，包含 REFRESH_WINDOW_MS / ESC_LAYERS。
const region = sliceFrom('// C5：条件请求头', 'async function api(')
const { conditionalHeaders, shouldCoalesceRefresh, decideEscAction, REFRESH_WINDOW_MS, ESC_LAYERS } = new Function(
  `${region}\nreturn { conditionalHeaders, shouldCoalesceRefresh, decideEscAction, REFRESH_WINDOW_MS, ESC_LAYERS }`,
)()

test('C5 conditionalHeaders：有 ETag 才发 If-None-Match', () => {
  assert.deepEqual(conditionalHeaders('"abc123"'), { 'If-None-Match': '"abc123"' })
  assert.deepEqual(conditionalHeaders(null), {}, '第一次请求没有 ETag，不能发空头')
  assert.deepEqual(conditionalHeaders(undefined), {})
  assert.deepEqual(conditionalHeaders(''), {}, '空串 ETag 视为没有')
})

test('C8 shouldCoalesceRefresh：300 ms 内的连点合并成一次，force 永远放行', () => {
  assert.equal(REFRESH_WINDOW_MS, 300)
  const now = 1_700_000_000_000
  assert.equal(shouldCoalesceRefresh(0, now, false), false, '还没发过请求时不合并')
  assert.equal(shouldCoalesceRefresh(now - 11, now, false), true, '11 ms 后的真实双击要被合并')
  assert.equal(shouldCoalesceRefresh(now - 100, now, false), true)
  assert.equal(shouldCoalesceRefresh(now - 299, now, false), true, '窗口左边界内合并')
  assert.equal(shouldCoalesceRefresh(now - 300, now, false), false, '到窗口边界就放行')
  assert.equal(shouldCoalesceRefresh(now - 400, now, false), false)
  assert.equal(shouldCoalesceRefresh(now - 11, now, true), false, '动作后的强制刷新不能被吞')
})

test('D4 decideEscAction：搜索框里的 Esc 永远不关面板', () => {
  assert.deepEqual(decideEscAction({ query: '阶段' }, true), { clearSearch: true })
  assert.deepEqual(decideEscAction({ query: '' }, true), { blurSearch: true })
  // 即使同时开着设置/弹层，搜索框里的 Esc 也只作用在搜索框上。
  assert.deepEqual(decideEscAction({ query: 'x', settings: true }, true), { clearSearch: true })
})

test('D4 decideEscAction：层级顺序固定（设置 → 弹层 → 确认 → 编辑 → 其它 → 面板）', () => {
  // 0.5.0：右栏翻到设置/回收站/数据卫生页时，Esc 先回「阶段检视」，再一下才关面板。
  assert.deepEqual(decideEscAction({ panePage: 'settings' }, false), { patch: { panePage: 'phase' } }, 'Esc 在设置页先回检视器')
  assert.deepEqual(decideEscAction({ panePage: 'trash' }, false), { patch: { panePage: 'phase' } })
  assert.deepEqual(decideEscAction({ panePage: 'phase' }, false), { closePanel: true }, '已经在检视器，Esc 直接关面板')
  assert.deepEqual(decideEscAction({ settings: true }, false), { patch: { settings: false } })
  assert.deepEqual(decideEscAction({ forkDraft: { title: 'x' } }, false), { patch: { forkDraft: null } })
  assert.deepEqual(decideEscAction({ confirm: { text: '删？' } }, false), { patch: { confirm: null } })
  assert.deepEqual(
    decideEscAction({ editingPhaseId: 'ph1' }, false),
    { patch: { editingPhaseId: null, editingPhaseProjectId: null } },
    '关阶段编辑时要一起清项目 id，否则下次打开会串项目',
  )
  assert.deepEqual(decideEscAction({ editingProblemId: 'pr1' }, false), { patch: { editingProblemId: null } })
  assert.deepEqual(decideEscAction({ attachFor: { sessionId: 's1' } }, false), { patch: { attachFor: null } })
  assert.deepEqual(decideEscAction({ phaseDraft: { title: '' } }, false), { patch: { phaseDraft: null } })
  assert.deepEqual(decideEscAction({ stepDraft: { index: 0 } }, false), { patch: { stepDraft: null } })
  assert.deepEqual(decideEscAction({ renameDraft: { id: 'b1' } }, false), { patch: { renameDraft: null } })
  assert.deepEqual(decideEscAction({ moveSessionId: 's1' }, false), { patch: { moveSessionId: null } })
  assert.deepEqual(decideEscAction({ gapsOpen: true }, false), { patch: { gapsOpen: false } })
  // 全都关着才关面板。
  assert.deepEqual(decideEscAction({ settings: false, confirm: null, gapsOpen: false }, false), { closePanel: true })
  assert.deepEqual(decideEscAction({}, false), { closePanel: true })
})

test('D4 Esc 层顺序表本身不许乱序（面板关闭必须是最后一层）', () => {
  assert.deepEqual(ESC_LAYERS.map(([key]) => key), [
    'panePage',
    'settings',
    'forkDraft',
    'confirm',
    'editingPhaseId',
    'editingProblemId',
    'attachFor',
    'phaseDraft',
    'stepDraft',
    'renameDraft',
    'moveSessionId',
    'gapsOpen',
  ])
})

test('client.js 里这三处逻辑确实接到了纯函数（不是留着一份死代码）', () => {
  assert.match(source, /const headers = conditionalHeaders\(store\.lastEtag\)/, 'fetchState 必须用 conditionalHeaders')
  assert.match(source, /shouldCoalesceRefresh\(lastRequestAt, Date\.now\(\), force\)/, 'refresh 必须用 shouldCoalesceRefresh')
  assert.match(source, /const decision = decideEscAction\(store, inSearch\)/, 'Esc 处理必须用 decideEscAction')
})
