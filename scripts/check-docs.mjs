#!/usr/bin/env node
// 文档一致性闸门：README 的版本号、路由表、act() 计数必须和代码同步。
// 发布包里没有 docs/（files[] 不含 docs），此时只校验 README 并正常退出。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (name) => readFileSync(join(root, name), 'utf8')
const failures = []
const fail = (message) => { failures.push(message); console.error(`FAIL ${message}`) }
const ok = (message) => console.log(`ok  ${message}`)

const pkg = JSON.parse(read('package.json'))
const readme = read('README.md')
const index = read('index.js')
const client = read('client.js')

// 1) README 必须写当前版本，且不再残留 0.x.y 旧版本号（journal 数据 version 3 之类不算）。
if (!readme.includes(pkg.version)) fail(`README 没写当前版本 ${pkg.version}`)
const stale = new Set([...readme.matchAll(/(?<![\d.])0\.\d+\.\d+(?![\d.])/g)].map((match) => match[0]).filter((value) => value !== pkg.version))
if (stale.size > 0) fail(`README 残留旧版本号：${[...stale].join(', ')}`)

// 2) index.js 注册的每条 /api/* 路由都要在 README 里出现。
const routes = [...new Set([...index.matchAll(/'(\/api\/[a-z0-9/-]+)'/g)].map((match) => match[1]))].sort()
const missing = routes.filter((route) => !readme.includes(route))
if (missing.length > 0) fail(`README 路由表缺 ${missing.length} 条：${missing.join(', ')}`)

// 3) README 里声明的 act() 处数必须等于 client.js 实际 wrapped 计数。
const wrapped = [...client.matchAll(/onClick:\s*act\(/g)].length
const declared = /共\s*(\d+)\s*处/.exec(readme)
if (declared === null) fail('README 没写 act() 处数（「共 N 处」）')
else if (Number(declared[1]) !== wrapped) fail(`README 写 act() 共 ${declared[1]} 处，实际 ${wrapped} 处`)

// 4) 实现记录：仓库里有 docs/DEV.md 时要求记到当前版本；发布包里没有 docs/ 就跳过。
let dev = null
const devPath = join(root, '..', '..', 'docs', 'DEV.md')
if (existsSync(devPath)) {
  dev = readFileSync(devPath, 'utf8')
  if (!new RegExp(`^#{2,4} .*${pkg.version.replace(/\./g, '\\.')}`, 'm').test(dev)) fail(`docs/DEV.md 还没有 ${pkg.version} 的章节（需要「##/### 0.4.0 …」这样的实现与验证记录）`)
  else ok(`docs/DEV.md 记录了 ${pkg.version}`)
} else {
  console.log(`ok  docs/DEV.md: skip (发布包内无 docs/)`)
}

// 5) 备份保留口径：实现是「每个 tag 分桶、各留最近 MAX_BACKUPS 份」，README 必须这么写。
const storeSource = read('journal-store.js')
const maxBackups = Number(/MAX_BACKUPS = (\d+)/.exec(storeSource)?.[1])
if (!Number.isFinite(maxBackups) || maxBackups <= 0) {
  fail('journal-store.js 里找不到 MAX_BACKUPS 常量')
} else {
  if (!storeSource.includes('name.startsWith(`${tag}-`)')) fail('pruneBackups 不再按 tag 分桶，README 的备份口径需要重写')
  const backupWord = `每类 tag 各保留最近 ${maxBackups} 份`
  if (!readme.includes(backupWord)) fail(`README 备份口径必须写「${backupWord}」`)
  if (/最多\s*8\s*份/.test(readme)) fail('README 仍残留旧备份口径「最多 8 份」')
}

// 6) 未归属桶口径：实现会给 unassigned 会话归纳并按模型判断建阶段，文档不能写成「不会自动建阶段」。
const unassignedWord = '是否新增阶段由模型判断'
if (!readme.includes(unassignedWord)) fail(`README 未归属口径必须写「${unassignedWord}」`)
for (const [name, text] of [['README.md', readme], ['docs/DEV.md', dev]]) {
  if (text !== null && text.includes('不会自动建阶段')) fail(`${name} 仍写「不会自动建阶段」，与实现相反（unassigned 照常归纳建阶段）`)
}

// 7) 发布产物：npm pack 产出带 scope 前缀的文件名，但 Release 资产统一用去 scope 名
//    （上传前改名，`gh release upload` 用 basename 作资产名）。README 必须用去 scope 名，
//    同时守住 files[] 的文件数（G4：15 个），避免文档与 tarball 再次漂移。
const packName = `${pkg.name.replace(/^@/, '').replace(/\//g, '-')}-${pkg.version}.tgz`
const assetName = packName.replace(/^pawsey0319-/, '')
if (assetName === packName) fail(`无法从 pack 名 ${packName} 推出发布资产名，请检查 package.json name 与发布换名规则`)
if (!readme.includes(assetName)) fail(`README 的 Release 下载链接必须用发布资产名 ${assetName}（去 scope 前缀，上传前改名）`)
if (readme.includes(packName)) fail(`README 里不要出现带 scope 前缀的 pack 名 ${packName}（那是本地产物名，不是资产名）`)
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
  const entry = Array.isArray(packed) ? packed[0] : null
  if (entry === null || typeof entry.filename !== 'string') fail('npm pack --dry-run --json 没返回文件名')
  else {
    if (entry.filename !== packName) fail(`npm pack 实际产物 ${entry.filename} 与推断 ${packName} 不一致`)
    if (!Array.isArray(entry.files) || entry.files.length !== 15) fail(`发布包应为 15 个文件，实际 ${entry.files?.length ?? '未知'}`)
    else ok(`npm pack: ${entry.filename} → asset ${assetName} (15 files)`)
  }
} catch (error) {
  console.log(`ok  npm pack: skip (${String(error?.code ?? error?.message ?? error)})`)
}

if (failures.length > 0) {
  console.error(`docs: FAILED (${failures.length})`)
  process.exit(1)
}
console.log(`docs: ok (${routes.length} routes, act ${wrapped}, version ${pkg.version})`)
