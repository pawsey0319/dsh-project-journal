import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
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
