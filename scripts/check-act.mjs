#!/usr/bin/env node
// 客户端交互闸门：所有点击都必须经过 act()（错误收敛 + 信标），不得出现 window.prompt，
// 关键无障碍标记必须存在。设计：docs/superpowers/specs/2026-11-18-journal-optimization-design.md D 节。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = readFileSync(join(root, 'client.js'), 'utf8')
const failures = []
const fail = (message) => { failures.push(message); console.error(`FAIL ${message}`) }

// 1) onClick 一律包 act()。允许的例外：只做事件拦截、不发请求也不改状态的处理器。
const ALLOWLIST = new Set(['stopClickBubble'])
const handlers = [...source.matchAll(/onClick:\s*([A-Za-z_$][\w$]*)/g)].map((match) => match[1])
const wrapped = [...source.matchAll(/onClick:\s*act\(/g)].length
const bare = [...source.matchAll(/onClick:\s*([A-Za-z_$][\w$]*)/g)].map((match) => match[1]).filter((name) => name !== 'act')
const unwrapped = bare.filter((name) => !ALLOWLIST.has(name))
const allowlisted = bare.filter((name) => ALLOWLIST.has(name)).length
if (unwrapped.length > 0) fail(`有 ${unwrapped.length} 个 onClick 没包 act(): ${unwrapped.join(', ')}`)
if (wrapped + allowlisted !== handlers.length) fail(`onClick 计数对不上：act ${wrapped} + allowlist ${allowlisted} ≠ ${handlers.length}`)

// 2) 不许用 window.prompt（DSH 渲染层里是空操作）或 window.confirm（会绕开面板自己的确认框）。
const prompts = [...source.matchAll(/window\.(?:prompt|confirm)/g)].length
if (prompts !== 0) fail(`client.js 出现 ${prompts} 处 window.prompt/window.confirm`)

// 3) 无障碍标记：对话框语义、可访问名、状态播报、焦点可见。
const MARKS = [
  ['role=dialog', /role:\s*'dialog'/g, 2],
  ['aria-modal', /'aria-modal':\s*'true'/g, 2],
  ['aria-label', /'aria-label':/g, 3],
  ['aria-live', /'aria-live':/g, 1],
  ['aria-pressed', /'aria-pressed':/g, 1],
  ['aria-expanded', /'aria-expanded':/g, 1],
  ['tabIndex', /tabIndex:/g, 1],
]
for (const [name, pattern, min] of MARKS) {
  const count = [...source.matchAll(pattern)].length
  if (count < min) fail(`缺少 ${name}（期望 ≥${min}，实际 ${count}）`)
}
const promptText = prompts === 0 ? 'none' : String(prompts)

if (failures.length > 0) {
  console.error(`act: FAILED (${failures.length})`)
  process.exit(1)
}
console.log(`act: ${wrapped} wrapped, ${allowlisted} allowlisted, window.prompt/confirm=${promptText}, aria ok`)
