#!/usr/bin/env node
// 主题闸门：颜色只能在 .pj-root 的 --pj-* token 层里跟 --dsw-alias-* 对接；
// 规则体只许用 var(--pj-*)，且不许再出现「别名 + 写死深色 hex」的 fallback。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = readFileSync(join(root, 'client.js'), 'utf8')
const failures = []
const fail = (message) => { failures.push(message); console.error(`FAIL ${message}`) }

const start = source.indexOf('const CSS = `')
const end = source.indexOf('`\n\n    function ensureStyle()', start)
if (start === -1 || end === -1) {
  fail('没找到 CSS 模板串（client.js 结构变了？）')
  process.exit(1)
}
const css = source.slice(start, end)
const tokenStart = css.indexOf('.pj-root{')
const tokenEnd = css.indexOf('--pj-on-warn:')
if (tokenStart === -1 || tokenEnd === -1) {
  fail('没找到 .pj-root 的 --pj-* token 层')
  process.exit(1)
}
const tokenBlock = css.slice(tokenStart, css.indexOf('}', tokenEnd) + 1)
const rules = css.slice(0, tokenStart) + css.slice(tokenStart + tokenBlock.length)

// 1) 规则体里不许直接碰 --dsw-alias-*
const direct = [...rules.matchAll(/--dsw-alias-[a-z0-9-]+/g)].length
if (direct !== 0) fail(`规则体直连 --dsw-alias-* ${direct} 处（应只用 var(--pj-*)）`)

// 2) 不许「别名 + hex fallback」（浅色主题下会被写死成深色块）
const hexFallback = [...css.matchAll(/var\(--dsw-alias-[a-z0-9-]+,\s*#[0-9a-fA-F]{3,8}\)/g)].length
if (hexFallback !== 0) fail(`var(--dsw-alias-*, #hex) ${hexFallback} 处`)

// 3) token 必须齐全
const REQUIRED = ['text', 'text-secondary', 'text-tertiary', 'border', 'border-l1', 'border-strong', 'surface', 'surface-raise', 'surface-sunken', 'surface-sunken-2', 'surface-platform', 'hover', 'accent', 'warn', 'success', 'danger', 'label-warning', 'on-accent', 'on-warn']
for (const token of REQUIRED) {
  if (!tokenBlock.includes(`--pj-${token}:`)) fail(`token 层缺 --pj-${token}`)
}

// 4) 规则体必须真的走 token（防止有人回退成写死颜色）
const uses = [...rules.matchAll(/var\(--pj-[a-z0-9-]+\)/g)].length
if (uses < 80) fail(`规则体只用 var(--pj-*) 的地方只有 ${uses} 处，疑似回退`)

if (failures.length > 0) {
  console.error(`theme: FAILED (${failures.length})`)
  process.exit(1)
}
console.log(`theme: ok (${uses} var(--pj-*), 0 direct alias, ${REQUIRED.length} tokens)`)
