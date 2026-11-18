import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// journal-store 在 import 时用 homedir() 定目录，所以先改 HOME 再动态 import。
process.env.HOME = mkdtempSync(join(tmpdir(), 'pj-test-'))
const store = await import('../journal-store.js')

const event = (seq, type, data) => ({ type, seq, time: 1760000000000 + seq * 1000, data })

function project() {
  const state = store.emptyJournal()
  const item = store.ensureProject(state, { id: 'p1', title: '测试项目', path: '/tmp/pj-test-project' }, 0)
  return { state, project: item }
}

test('buildDigest 从游标之后取增量，seq 是 0 基', () => {
  const events = [
    event(0, 'user/message', { content: [{ type: 'text', text: '第一问' }] }),
    event(1, 'assistant/message', { message: { content: [{ type: 'text', text: '第一答' }] } }),
    event(2, 'user/message', { content: [{ type: 'text', text: '第二问' }] }),
  ]
  const digest = store.buildDigest(events, -1, {})
  assert.equal(digest.maxSeq, 2)
  assert.equal(digest.newCount, 3)
  const partial = store.buildDigest(events, 0, {})
  assert.equal(partial.newCount, 2)
  assert.equal(store.buildDigest(events, 2, {}).newCount, 0)
})

test('applySummary 新建阶段并保留合法 quote，丢弃编造 quote', () => {
  const { state, project: item } = project()
  const userText = '都投过了，你似乎关注领域太少了，给我至少30家'
  const parsed = {
    phases: [{
      title: '秋招企业梳理',
      summary: '覆盖互联网与央国企',
      artifacts: ['a.csv'],
      nextSteps: ['补岗位表'],
      problems: [
        { statement: '范围过窄', quote: '你似乎关注领域太少了', resolution: '扩展到央国企', status: 'solved' },
        { statement: '编造', quote: '这句话不在原文里', status: 'open' },
      ],
    }],
  }
  store.applySummary(state, { project: item, sessionId: 's1', sessionStart: 1760000000000, parsed, userText, source: { sessionId: 's1', seq: 9 } })
  assert.equal(item.phases.length, 1)
  const phase = item.phases[0]
  assert.equal(phase.status, 'active')
  assert.equal(phase.sourceSeq, 9)
  assert.equal(phase.nextSteps[0], '补岗位表')
  assert.equal(phase.problems.length, 2)
  assert.equal(phase.problems[0].quote, '你似乎关注领域太少了')
  assert.equal(phase.problems[1].quote, '')
})

test('applySummary 对同一标题更新而不是重复新建，并关闭上一个 active', () => {
  const { state, project: item } = project()
  const mk = (title) => ({ phases: [{ title, summary: title, problems: [] }] })
  store.applySummary(state, { project: item, sessionId: 's1', sessionStart: 1760000000000, parsed: mk('阶段一'), userText: '' })
  store.applySummary(state, { project: item, sessionId: 's1', sessionStart: 1760000000000, parsed: mk('阶段二'), userText: '' })
  store.applySummary(state, { project: item, sessionId: 's1', sessionStart: 1760000000000, parsed: mk('阶段一'), userText: '' })
  assert.equal(item.phases.length, 2)
  // 再次总结到旧阶段时只更新内容，不改变已有状态（避免把已完成阶段反复「复活」）。
  assert.equal(item.phases.find((phase) => phase.title === '阶段二').status, 'active')
  assert.equal(item.phases.find((phase) => phase.title === '阶段一').status, 'done')
})

test('manual 阶段不被自动总结覆盖', () => {
  const { state, project: item } = project()
  store.applySummary(state, { project: item, sessionId: 's1', sessionStart: 1760000000000, parsed: { phases: [{ title: '手改', summary: '原值' }] }, userText: '' })
  item.phases[0].manual = true
  store.applySummary(state, { project: item, sessionId: 's1', sessionStart: 1760000000000, parsed: { phases: [{ title: '手改', summary: '新值' }] }, userText: '' })
  assert.equal(item.phases[0].summary, '原值')
})

test('active 阶段没有 nextSteps 时用未解决问题兜底', () => {
  const { state, project: item } = project()
  store.applySummary(state, { project: item, sessionId: 's1', sessionStart: 1760000000000, parsed: { phases: [{ title: '兜底', summary: 's', nextSteps: [], problems: [{ statement: '部署脚本总是超时', status: 'open' }] }] }, userText: '' })
  assert.equal(item.phases[0].nextSteps.length, 1)
  assert.match(item.phases[0].nextSteps[0], /部署脚本总是超时/)
})

test('resequence 跳过软删除阶段但不丢弃它们', () => {
  const { project: item } = project()
  item.phases = [
    { id: 'a', branchId: 'main', seq: 2, title: 'A', problems: [], sessions: [] },
    { id: 'b', branchId: 'main', seq: 1, title: 'B', deletedAt: '2026-01-01T00:00:00.000Z', problems: [], sessions: [] },
    { id: 'c', branchId: 'main', seq: 3, title: 'C', problems: [], sessions: [] },
  ]
  store.resequence(item)
  const kept = item.phases.filter((phase) => phase.deletedAt !== undefined)
  assert.equal(kept.length, 1)
  const live = store.branchPhases(item, 'main')
  assert.deepEqual(live.map((phase) => phase.title), ['A', 'C'])
})

test('migrateJournal 幂等补分支字段', () => {
  const state = store.emptyJournal()
  state.version = 2
  state.projects.p1 = { id: 'p1', title: '老项目', path: '/tmp/old', phases: [{ id: 'x', seq: 1, title: '旧阶段', problems: [], sessions: [] }], sessions: [] }
  store.migrateJournal(state)
  store.migrateJournal(state)
  const item = state.projects.p1
  assert.equal(state.version, 3)
  assert.equal(item.branches.length, 1)
  assert.equal(item.branches[0].id, 'main')
  assert.equal(item.phases[0].branchId, 'main')
  assert.equal(item.activeBranchId, 'main')
})

test('saveJournal/loadJournal 往返一致', () => {
  const { state, project: item } = project()
  store.applySummary(state, { project: item, sessionId: 's1', sessionStart: 1760000000000, parsed: { phases: [{ title: '往返', summary: 'x' }] }, userText: '' })
  store.saveJournal(state)
  const loaded = store.loadJournal()
  assert.equal(loaded.projects.p1.phases.length, 1)
  assert.equal(loaded.projects.p1.phases[0].title, '往返')
  assert.equal(loaded.version, 3)
})

test('purgeTrash 只清指定项目的回收站，清全部后可重复调用', () => {
  mkdirSync(join(store.TRASH_DIR, 'p1'), { recursive: true })
  mkdirSync(join(store.TRASH_DIR, 'p2'), { recursive: true })
  writeFileSync(join(store.TRASH_DIR, 'p1', 'a.bin'), Buffer.alloc(10))
  writeFileSync(join(store.TRASH_DIR, 'p2', 'b.bin'), Buffer.alloc(4))
  const one = store.purgeTrash('p1')
  assert.deepEqual(one.projects, ['p1'])
  assert.equal(one.removed.files, 1)
  assert.equal(one.removed.bytes, 10)
  assert.equal(existsSync(join(store.TRASH_DIR, 'p1')), false)
  assert.equal(existsSync(join(store.TRASH_DIR, 'p2', 'b.bin')), true)
  const rest = store.purgeTrash()
  assert.deepEqual(rest.projects, ['p2'])
  assert.equal(rest.removed.files, 1)
  assert.deepEqual(store.purgeTrash(), { removed: { bytes: 0, files: 0 }, projects: [] })
})

test('journal.json 损坏时另存为 .corrupt-* 并暴露错误，不静默清空', () => {
  store.saveJournal(store.emptyJournal())
  writeFileSync(store.FILE, '{ this is not json')
  const loaded = store.loadJournal()
  assert.deepEqual(loaded.projects, {})
  assert.equal(existsSync(store.FILE), false)
  const error = store.journalLoadError()
  assert.ok(error !== null)
  assert.match(error.file, /\.corrupt-/)
  assert.equal(existsSync(error.file), true)
})

test('自动归纳式 saveJournal 写回不清 corrupt 横幅，只有显式 clear 才清', () => {
  // 先制造一次损坏读取，让 loadError 处于已置位状态。
  store.saveJournal(store.emptyJournal())
  writeFileSync(store.FILE, '{ broken again')
  store.loadJournal()
  assert.ok(store.journalLoadError() !== null, '损坏读取后应有错误状态')

  // 自动归纳 / reconcile 空壳写回走的是通用 saveJournal，不能顺手清横幅，
  // 否则用户在面板上永远看不到「原文件已另存为」的提示。
  const shell = store.emptyJournal()
  store.ensureProject(shell, { id: 'p9', title: '自动归纳后的项目', path: '/tmp/pj-restore' }, 0)
  store.saveJournal(shell)
  assert.ok(store.journalLoadError() !== null, '通用 saveJournal 写回不应清掉警告')

  // 即便写回含阶段的数据也一样：只有显式 clear 才是恢复信号。
  const at = new Date().toISOString()
  shell.projects.p9.phases.push({
    id: 'ph9', seq: 1, title: '阶段', summary: '', status: 'done', branchId: 'main',
    sessions: [], problems: [], nextSteps: [], artifacts: [], createdAt: at, updatedAt: at,
  })
  store.saveJournal(shell)
  assert.ok(store.journalLoadError() !== null, '含阶段的自动写回同样不应清掉警告')

  // 显式清除（dismiss 走的路径）只清内存：下次启动仍会因残留 .corrupt-* 重新提示，
  // 这正是 F-08 要求的「重启后仍会提示」。真正的持久清除是 recordRestore()。
  store.clearJournalLoadError()
  assert.equal(store.journalLoadError(), null)
  const reloaded = store.loadJournal()
  assert.ok(store.journalLoadError() !== null, '仅 clear 后重启：残留 .corrupt-* 应重新提示')
  assert.equal(store.journalLoadError().reason, 'corrupt-backup-present')
  assert.equal(reloaded.projects.p9.phases.length, 1)
  store.recordRestore()
  store.loadJournal()
  assert.equal(store.journalLoadError(), null, '恢复记录之后重新加载不应再提示')
})

test('clearJournalLoadError 可显式清除 corrupt 横幅状态', () => {
  store.saveJournal(store.emptyJournal())
  writeFileSync(store.FILE, '{ broken once more')
  store.loadJournal()
  assert.ok(store.journalLoadError() !== null)
  store.clearJournalLoadError()
  assert.equal(store.journalLoadError(), null)
})

/** 清掉历史用例留下的 .corrupt-* 与恢复记录，让「重启」场景从干净状态开始。 */
function resetCorruptState() {
  for (const name of readdirSync(store.DIR)) {
    if (name.startsWith('journal.json.corrupt-')) rmSync(join(store.DIR, name), { force: true })
  }
  rmSync(store.RESTORE_RECORD, { force: true })
  store.clearJournalLoadError()
}

/** 造一份 .corrupt-* 残留，并把 mtime 固定到指定毫秒，避免同毫秒写入导致断言抖动。 */
function leftoverCorrupt(name, mtimeMs) {
  const path = join(store.DIR, `journal.json.corrupt-${name}`)
  writeFileSync(path, '{ leftover corrupt')
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000)
  return path
}

test('重启场景：残留 .corrupt-* 且未恢复 → loadJournal 重新置错（corrupt-backup-present）', () => {
  resetCorruptState()
  store.saveJournal(store.emptyJournal())
  const path = leftoverCorrupt('boot1', Date.now() + 60_000)
  const loaded = store.loadJournal()
  assert.equal(loaded.version, 3, '健康 journal.json 仍能读到')
  const error = store.journalLoadError()
  assert.ok(error !== null, '重启后应重新提示损坏另存')
  assert.equal(error.reason, 'corrupt-backup-present')
  assert.equal(error.original, store.FILE)
  assert.equal(error.file, path)
  assert.equal(error.bytes, statSync(path).size)
  assert.ok(store.corruptBackups().some((entry) => entry.path === path), 'corruptFiles 清单应包含该文件')
})

test('恢复记录之后不反弹；比恢复记录更新的新损坏会再次提示', () => {
  resetCorruptState()
  const stale = leftoverCorrupt('resolved', Date.now() - 120_000)
  store.saveJournal(store.emptyJournal())
  store.recordRestore()
  store.loadJournal()
  assert.equal(store.journalLoadError(), null, '恢复记录已覆盖更早的损坏另存')
  assert.ok(store.corruptBackups().some((entry) => entry.path === stale), '文件仍保留在磁盘上，只是不再提示')

  // 恢复之后又坏了一次：新损坏应重新置错。
  const fresh = leftoverCorrupt('after-restore', Date.now() + 5_000)
  store.loadJournal()
  const error = store.journalLoadError()
  assert.ok(error !== null, '新的损坏另存应重新提示')
  assert.equal(error.file, fresh)
})
