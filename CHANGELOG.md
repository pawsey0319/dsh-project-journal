# Changelog

本插件的所有重要变更记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.5.0] - 2026-11-18

界面与信息架构重做（用户：「ui 排版以及逻辑性太差，重新设计 ui」）。三栏：左项目 / 中阶段时间线 / 右阶段检视器；顶栏只留标题、分支页签、搜索、状态、迁移、新建阶段、⋯ 与关闭。设计见 `docs/superpowers/specs/2026-11-18-journal-ui-redesign-design.md`，对照稿见 `docs/mockups/journal-ui-redesign.html`。

### 新增

- **三栏布局**：`224px / 1fr / 360px`，面板 1360×880（小屏按 96vw/92vh 收）。左栏项目名 + 「未解决/下一步」计数，底部固定「回收站 / 数据卫生 / 设置」入口；中栏阶段时间线，节点只留序号、标题、一行摘要与角标（问题 / 下一步 / 产物 / 会话），主线已走过部分折叠成一行；右栏检视器按「详情 / 问题 / 下一步 / 产物 / 会话 / 修订」分页。
- **打开即定位**：打开面板自动选中当前阶段；阶段消失时回退到当前阶段。
- **顶栏搜索**：过滤当前项目的阶段（命中问题或总结时显示片段）；左栏搜索只过滤项目名。
- **横幅一次一条**：优先级 `error > journalError > 失败会话 > 一致性 > 错位建议 > 迁移中 > 未汇总`，其余折叠为「另有 N 条」；`notice` 改成右下角 toast。
- **Esc 分层**：右栏在设置/回收站/数据卫生页时，Esc 先回阶段检视，再按一次才关面板（`ESC_LAYERS` 新增 `panePage` 一层，单测同步）。
- **迁移流程**：顶栏「迁移」先选会话（当前项目 + 未归属，可搜），左栏出现「迁到这里」，底部确认条，只有点确认才执行。
- **主题 token**：新增 `--pj-bg/--pj-surface/--pj-border/--pj-accent/--pj-warn/--pj-danger`，`check-theme` 覆盖 190 处 `var(--pj-*)`。

### 变更

- 删除旧的单面板 `ProjectDetail` / `PhaseCard` / `MigratePicker` 组件（约 500 行），阶段操作改由检视器承担；`act()` 计数 85 → 79。

### 修复

- **布局返工**（用户首轮「排版全乱了」）：设置页不再复用菜单浮层类，改用 `.pj-settings-page`（回到文档流）；三栏从固定网格改为 flex + `1100/850/650px` 三档断点；列统一 `min-width:0` 与独立滚动；全局 `box-sizing:border-box`；顶栏与 tab 可换行；迁移确认条回文档流；长文本安全换行；弹窗限宽高并内部滚动。800×600 下中栏由 184px 提升到 342px。
- **样式热更失效**（第二轮「按钮挤成一堆、颜色分不清」）：HMR 只重载 JS，已注入的 `<style id="pj-style">` 不会更新，导致 0.5.0 结构套着 0.4.0 样式。`ensureStyle()` 改为内容不一致时原地重写。

### 未做（下一轮）

- 两层面板弹窗的 scoped 焦点陷阱（当前仍是面板级平铺）；浅色主题只保证 token 正确，未做完整浅色视觉。

## [0.4.0] - 2026-11-18

并入此前未单独发布的 0.3.0–0.3.2 改动（0.3.3 只存在于未提交的工作树，没有单独发过版），并落地「回来能看懂 / 打开不卡 / 键盘与浅色 / 库要干净」四个方向。
设计见 `docs/superpowers/specs/2026-11-18-journal-optimization-design.md`，验收逐条对照见 `docs/DEV.md`。

### 新增

- **阶段作者可追溯（B）**：`phase.summaryMeta` 记录这段进展是谁写的、什么时候写的。四态 `by: model|user|restore|unknown`，模型侧还记 `model`/`provider`/`sessionId`/`seq`，回退记 `restoredFrom`。写入点三处：自动归纳（`applySummary`，`manual` 阶段不覆盖）、手改（`/api/phase`，内容真变才写）、回退（`/api/phase/restore-revision`）。旧 journal **不补字段**：读时只计算 `inferred: true` 的兜底（`phaseBrief`），磁盘上不会出现 `summaryMeta`（因此也不升 version）；缺字段时面板与导出都标「旧数据推断」。
- **阶段卡片作者行**：`SummaryMetaLine` 显示「作者：模型（provider/model） · 时间」或「作者：你」「作者：回退 · 回到 xx 那一版」。
- **修订历史按需拉取**：面板首屏仍显示 `state` 带来的最近 5 条，「查看全部 N 条」走新增的只读 `GET /api/phase/revisions`（最近 20 条，新→旧）；`state` 体积不因此变大。
- **失败横幅与重试**：只统计 `state==='error'` 的会话，逐条给「重试」；`skipped` 单独列出原因、不给按钮。`/api/summarize?retry=1` 只对 `error` 生效（清失败计数、不动事件游标），其它状态回 `400 not-retryable`。
- **孤儿项目记录治理（E）**：只读 `GET /api/project/orphans`（永不列出「未归属」）；`GET /api/project/delete?projectId&confirm=1` 只删 journal 里的项目记录与分支索引，不动项目目录、不碰 workspace 表，删前 `backupJournal('manual')`；七类拒绝（`confirm-required` / `bad-request` / `reserved-project` / `project-in-workspace` / `project-has-sessions` / `project-path-in-workspace` / `project-missing`）。设置抽屉新增「数据卫生」小节。
- **迁移入口常显（D7）**：项目页头部新增「迁移会话…」，选中会话后再点左侧目标项目，不再依赖会话行 hover。
- **`npm run check` 三道文档/交互/主题闸门**：`scripts/check-docs.mjs`（README 版本、路由表、act 计数与代码同步；发布包内无 `docs/` 时降级为只校验 README 并 exit 0）、`scripts/check-act.mjs`（onClick 必须包 `act()`、`window.prompt` 为 0、7 类 aria 标记齐全）、`scripts/check-theme.mjs`（规则体直连 `--dsw-alias-*` 为 0、别名后不跟写死 hex fallback）。`npm run check` 串行跑三道，已加入发布前检查；`files[]` 增加 `scripts/*`（发布包 15 个文件）。

### 变更

- **`/api/state` 支持 ETag/304（C）**：响应头带 `ETag`（按顶层 key 增量算 sha1，跳过 `generatedAt`/`beacons`，不做整树深拷贝）；`If-None-Match` 命中回 `304` 且无 body。客户端把上次的 ETag 作为 `If-None-Match` 回传，5 秒轮询先看状态码，304 时零解析、不 setState 数据，只在 `window.__pjDebug.stats` 累加 `notModified`。
- **轮询改为条件刷新**：页面 `visibilitychange` 到 hidden 暂停、回到 visible 立刻补一次；编辑态（阶段/问题/下一步/分支改名/开分支/确认框/挂载会话/迁移会话）暂停；`refresh()` 做 in-flight 去重 **+ 300 ms 合并窗口**（窗口内重复刷新只记 `stats.coalesced`），后台静默刷新不再置 `loading`（不会每次闪「加载中」），连点「刷新」也只发一次请求。
- **主题 token 层（D）**：`.pj-root` 定义 19 个 `--pj-*` 语义 token（`text`/`border`/`surface`/`accent`/`warn`/`success`/`danger`/`hover`/`on-accent`…），它们的 fallback 改成系统色关键字（`Canvas`/`CanvasText`/`GrayText`/`ButtonFace`/`LinkText`），规则体 122 处改用 `var(--pj-*)`；硬编码深色 rgba 换成 `color-mix(in srgb, var(--pj-*) N%, transparent)`，内联 `#3f6f5a`/`#4c6ef5`/`#7a5a2e` 等也全部收进 token。
- **键盘与无障碍（D）**：面板 `role="dialog" aria-modal`，Esc 分层关闭（设置 → 弹层 → 确认 → 阶段编辑 → 问题编辑 → 挂载 → 新建阶段 → 下一步 → 改名 → 迁移 → 面板），搜索框内的 Esc 在 capture 阶段被拦下（有词清词、无词失焦），**不会关掉面板**；Tab 焦点限制在面板内，关闭后焦点回到打开前的元素；通知/错误区加 `aria-live`/`role=alert`，设置与迁移按钮加 `aria-pressed`/`aria-expanded`。
- **`journal.json` 仍是 version 3**：`summaryMeta` 是可选字段，旧文件读时迁移即可，不升 v4（旧版本读到多出来的字段会自动忽略，降级安全）。

### 修复（独立验收后）

- **真实浏览器拿不到 304**：`fetchState()` 之前只计算 ETag、从不回传 `If-None-Match`，304 分支在真机上是死代码。现在记住 `store.lastEtag` 并在下一次请求带上（`cache: 'no-store'`）；实测面板打开后 30 s 内 6 次请求全部 304、`stats.notModified=6`。
- **搜索框里按 Esc 会关掉整个面板**：document capture 阶段的 Esc 处理没有识别搜索框，面板级 `stopPropagation` 来不及执行。现在先判 `closest('[data-pj-search]')`：有词只清词、无词只失焦，两种情况都不关面板。
- **100 ms 双击「刷新」仍发两次请求**：in-flight 去重只能挡住「上一次没回来」。新增 300 ms 合并窗口（`REFRESH_WINDOW_MS`），窗口内只累加 `stats.coalesced`。
- **`/api/state` p50 6.012 ms 超阈值**（复验 6.15 ms / 450 KB；阈值按设计 §14 Q7 放宽为 p50 ≤ 8 ms，作为已接受偏差）：`stateEtag` 对 400 KiB body 做 `structuredClone` 太贵，改成按顶层 key 增量喂 sha1。采样口径写清楚：t8 真机 40 次采样 p50 5.18 ms，t9 复验 20 次采样 p50 6.152 ms（450 KB body），设计 §14 Q7 因此把阈值放宽到 p50 ≤ 8 ms；304 侧 p50 2.876 ms / body 0 B。
- **`summaryMeta` 兜底被写进磁盘**：`migrateJournal` 曾在加载时补字段，把加载时刻写成推断时间。现在兜底只在 `phaseBrief` 读期给出，磁盘上不出现该字段（用例断言两次 `loadJournal` 后文件内容不变）。
- **文档与实现口径再次漂移**：README 备份口径（每类 tag 各 8 份）、未归属会话「是否新增阶段由模型判断」都已对齐实现，并加进 `check-docs` 断言（反向自测：写回旧口径会 FAIL）；`docs/DEV.md` §4.6 硬约束补齐第 15/16 条。
- **Release 资产名对不上**（已定方案）：`npm pack` 对 `@pawsey0319/…` 产出 `pawsey0319-dsh-project-journal-<版本>.tgz`，而发布资产统一用**去 scope** 的 `dsh-project-journal-<版本>.tgz`——上传前先改名（`gh release upload` 用 basename 作资产名）。README 下载链接用去 scope 名，`check-docs` 第 7 条断言「发布资产名 = pack 名去掉 `pawsey0319-` 前缀」并保留 15 文件断言。
- **古法皮肤场景记为环境限制**：隔离实例里 gufa bundle 能加载但 DOM 里没有 gufa 节点、插件自报 `gufa-none`，覆盖层无法复现，因此没有写「已验证」；常显迁移入口 + 迁移成功路径已实测（`docs/DEV.md` §4.17.5）。

### 修复（发布前评审 findings 清账，t10）

t6 代码评审 PASS（无 blocker/high）后留下的 9 条 findings 已在发布前清完：

- **F1/D2 文档自相矛盾**：`summaryMeta` 的「读时补齐」表述删掉，统一为「读时只算 `inferred`、磁盘不写字段」——与 `migrateJournal`/`phaseBrief` 的实现一致。
- **F2 304 收益说法夸大**：304 仍会写一次 `stats` 触发一次轻量重渲，文档与代码注释都改成「省的是序列化 + 网络 + 解析与随之而来的整树重渲」。
- **F3 客户端行为没有仓库内测试**：抽出 `conditionalHeaders` / `shouldCoalesceRefresh` / `decideEscAction` 三个纯函数，用例并入 `test/routes.test.mjs` 尾部（直接抽 `client.js` 源码执行，并断言三处调用点确实接了纯函数；不另开文件是为了不破坏「发布包 15 个文件」的断言）。
- **F4 原型链键**：`/api/project/delete` 与 `/api/phase/revisions` 增加 `Object.hasOwn` 校验，`projectId=__proto__`/`constructor` 返回 404 `project-missing`，不返回 `ok`、不写备份。
- **F5 无作者信息也写 `summaryMeta`**：`applySummary` 只在拿到非空模型名时写字段，否则留空由 `phaseBrief` 读期推断。
- **F6 采样数字**：p50 同时标注 t8（5.18 ms）与 t9（6.152 ms）两次采样与 8 ms 阈值来源。
- **F7 测试条数**：`docs/DEV.md` 两处 27/27 改成当前 44/44。
- **F8 导出没有作者行**：`/api/export` 每个阶段标题下加「作者：模型（model） · ISO 时间 / 作者：你 / 作者：回退 · 回到 … 那一版 / 作者：未知 · 旧数据推断」，与面板 `SummaryMetaLine` 同口径。
- **F9 只读接口有内存副作用**：`/api/project/orphans` 不再调 `reconcile()`（它会就地 `ensureProject`），改为只读 `workspaceRows()`；并加回归用例锁住「处理块里不出现 `reconcile(`」。
- **发布资产名（D1）**：README 下载链接、`check-docs` 第 7 条、本文件、`docs/DEV.md` 统一到「pack 用实际名、上传前改名为去 scope 的 `dsh-project-journal-0.4.0.tgz`、README 用去 scope 名」。
- **`files[]`（D4）**：`docs/DEV.md` 里「12 个文件」改成 15 个并列清单（含 `scripts/*`、两个测试文件）。

### 测试

- `node --test test/*.test.mjs` 44/44（journal-store 20 + routes 24）。新增用例：`phaseBrief` 兜底 `inferred` 且不回写、`migrateJournal` 幂等、`applySummary` 写 `summaryMeta` 且不覆盖 `manual` 阶段；`/api/state` ETag/304、`/api/phase/revisions`（含 400/404）、`/api/project/orphans`、`/api/project/delete`（六类拒绝 + 成功时先备份、只动 journal、workspace.json sha256 不变）；发布前补：导出作者行、`__proto__`/`constructor` 拒绝且不写备份、`orphans` 处理块不调 `reconcile()`、`applySummary` 缺模型名时不写 `summaryMeta`。C5 条件请求头 / C8 300 ms 合并窗口 / D4 Esc 分层三个纯函数做成了可直接单测的纯函数，用例**从 `client.js` 直接抽源码执行**（不是另抄一份实现），并断言三处调用点确实接了纯函数；为守住「发布包 15 个文件」这组用例放在 `test/routes.test.mjs` 尾部，没有另开文件。
- `node scripts/check-{docs,act,theme}.mjs` 全绿（`docs: ok (44 routes, act 85, version 0.4.0)` / `act: 85 wrapped, 1 allowlisted` / `theme: ok (122 var(--pj-*), 19 tokens)`）。
- 版本 0.3.2（工作树）→ 0.4.0。

## [0.3.2] - 2026-11-18

修 O-1：导出里的推测条目要能按「未解决/已解决」对账。

### 修复

- **导出正文推测两态**：此前正文对所有无原话的问题统一打 `[推测]`（含已解决的），而头部只数 `status==='open'` 的推测，读者会以为一堆已处理的推断还挂着。现在正文按状态分 `[推测·未解决]` / `[推测·已解决]`，有原话的仍是 `[未解决]` / `[已解决]`。
- **头部与正文自洽**：头部改为「推测 N 条未解决 / 共 M 条（无原话，不计入未解决；其中已解决 M-N 条）」；导出末尾新增一行「统计」，把头部数字与正文三种标签的计数并排写出（`[未解决]×a / [推测·未解决]×N / [推测·已解决]×M-N`），同一文件即可对账。
- **面板同步**：PhaseCard 的推测折叠区标题补「未解决 x / 已解决 y」，与导出同一口径。

### 兼容

- 只改呈现与统计口径，不改任何 journal 记录；`open`（evidenced）、`openAll`、`openInferred` 与 `open + openInferred == openAll` 均不变，徽标/tooltip/版本对照数值不动。

## [0.3.1] - 2026-11-18

J-01 + J-02：把「未解决」收敛成单一口径，并让面板头部直接点名待汇总会话。

### 修复

- **J-01 未解决口径分叉**：面板徽标 151（只有原话的）与 tooltip/导出/版本对照 240（含模型推测）同屏并存。`evidenceReport().problems` 现在给 `{ total, open, openAll, openEvidenced, openInferred, evidenced, inferred }`，`open` 收敛为 evidenced 口径，恒有 `open + openInferred == openAll`；侧栏徽标与 tooltip、项目头/项目行、导出、`/api/branch/diff` 四处消费方都读 `open`，推测一律单独计数（tooltip「另有推测 N 条，无原话，不计入未解决」、宽栏徽标「含推测 N」、项目行「含推测 M」、版本对照单独「推测 分支 x / 主线 y」chip）。
- **J-01 导出侧**：`/api/export` 头部「未解决问题 <evidenced> · 推测 N 条（无原话，未计入未解决）」，正文无原话条目不再写 `[未解决]`；`/api/branch/diff` 的 `openProblems` 改 evidenced 口径，新增 `openProblemsAll` 与 `inferredProblems`。
- **J-02 缺口不点名**：面板头部原来只有一个「待汇总 N」。新增 `gapSummaryText()`：标题优先、无标题回落 `未命名会话·<sessionId 末 8 位>`，只列前 3 个，其余折叠为「另有 N 个」；仍是按钮，点击展开每条的游标与最近汇总时间。

## [0.3.0] - 2026-11-18

可信度整修：面板不再「看起来完成了其实没做」。对应 `docs/verify/journal-panel-review.md` 的六条问题。

### 修复

- **回填诚实化**：`/api/state` 新增 `summary{total,summarized,never,stale,skipped,pending,coverage,gaps}` 与逐会话 `summaryState`（`summarized|never|stale|skipped`，附 `cursorSeq`、`lastSummarizedAt`、`dirtyAt`）；面板头部显示「已汇总 X/Y」，点开列出 never/stale 缺口，`state:'done'` 不再作为「已汇总」的等价物；`backfill` 增 `done/candidates/complete`，历史会话（cursor 为 -1 或停在旧游标）会被重新列为候选，不再因 `backfill.state==='done'` 被永久跳过。
- **引文强制与 inferred 口径**：prompt 明确「problems 每一项都必须带 quote（用户原话片段），没有原话就不要输出这一项——推测内容不允许写进 problems」；存储层新增 `problemConfidence()`（有原话 evidenced、无原话 inferred），`/api/state` 给 `evidence{problems{...}, quoteCoverage}`；面板把无原话条目移出主列表、收进「推测 N 条（无原话，不计入未解决）」折叠区，不再计入未解决。
- **产物失效可见可清**：`phaseBrief()` 增 `artifactStatus:[{name,path,exists}]`，面板把不存在的产物置灰加删除线，并给「清理失效 N」按钮（`/api/artifact/prune`，支持 `dry=1` 只统计）；导出仍列记录，但不再假装文件都在。
- **真探活取代假 ready**：`model.ready` 不再是「进程内有没有缓存」，而是真调一次 provider（`/api/model-probe`，`maxTokens:8`，8s 超时，成功缓存 60s）；`providerState` 区分 `ok|unreachable|unverified|unknown`，超时与不可达分别给出原因，面板如实显示「模型不可达（provider:unreachable）」而不是「未就绪」。
- **软删收口**：删除阶段在存储层写 `status:'deleted'` + `deletedAt` + `statusBeforeDelete`（恢复时还原原状态），不再只靠 `deletedAt` 过滤；旧 journal.json 读入时自动归一（有 `deletedAt` 没 `status` 的补 `deleted`，反之回滚），迁移幂等且保留原始字段。
- **CSRF 同源校验**：写路径（config/backfill/summarize/branch/phase/problem/artifact/trash/backup/migrate 等）在资源入口校验来源——`sec-fetch-site: cross-site|same-site` 直接拒，`Origin`/`Referer` 的 host:port 必须等于 `Host`（`localhost` 与 `127.0.0.1` 互认），缺头放行（curl 本机脚本不受影响）；拒绝时 403 `{ok:false,error:'cross_origin_rejected'}` 并记 note「写操作被拒」。

### 测试

- `node --test test/*.test.mjs` 27/27（store 16 + routes 11）；隔离 harness 覆盖 health/state/export/prune/CSRF 与旧 journal.json 读时归一。
- 版本 0.2.5 → 0.3.0。

## [0.2.5] - 2026-11-18

补掉 R1，并把分发方式从 npm 改为 GitHub Release（npm 侧有 2FA / 组织策略限制，本项目不为此开例外）。

### 修复

- **R1：journal.json 不存在但仍有 `.corrupt-*` 时不再静默**。此前 `loadJournal()` 走 ENOENT 分支直接返回空 journal，不扫残留损坏副本，面板显示 0 个项目而可恢复数据就在旁边。现在该分支同样查 `pendingCorruptBackups()`，未恢复的残留会置 `journalError.reason = 'corrupt-backup-present'`；已被恢复记录覆盖的旧副本仍不误报。
- 新增两条单测：「`journal.json` 完全不存在、只剩 `.corrupt-*` → 仍提示」「`journal.json` 不存在但恢复记录已覆盖 → 不误报」。

### 变更

- **分发路线**：不再通过 npm 发布。安装改为 ① git clone + 本地路径 `install_bundle`；② `link:` 到 profile；③ 下载 GitHub Release 的 `dsh-project-journal-0.2.5.tgz` 解包后本地安装。README 顶部与安装章节已按此重写，并明确「按版本号 install_bundle 会 404」。

## [0.2.4] - 2026-11-18

修复 F-08：v0.2.3 的「重启后仍会告警」并不成立——损坏启动时 `.corrupt-*` 确实写了，但宿主紧接着把空壳写回 `journal.json`；下次启动文件可解析，`loadError` 归零，横幅消失、阶段静默丢失。J-06 的「不静默清空」此前只覆盖单次会话。

### 修复

- **F-08 损坏后重启仍提示**：`loadJournal()` 启动时扫描 `DIR` 下的 `journal.json.corrupt-*`（只读文件名/大小/mtime，不读内容），只要存在未被恢复记录覆盖的条目，就重新置 `journalLoadError({ original, file, at, reason: 'corrupt-backup-present' })`，`/api/state` 横幅随重启恢复。判定不看 `journal.json` 的 mtime——它会被启动时的空壳写回刷新得比损坏文件更新，正是 F-08 的成因；改为与恢复记录比较。
- **恢复记录**：`restoreBackup()` 成功后除 `clearJournalLoadError()` 外再写 `journal.last-restore.json`（`recordRestore()`）；此后 mtime 不晚于该记录的 `.corrupt-*` 视为已覆盖，重启不反弹；恢复之后的新损坏（mtime 更新）仍会提示。
- **dismiss 语义不变**：`GET /api/journal/dismiss-error?confirm=1` 仍只在会话内按 `journalError.at` 隐藏，不落盘；重启后重新提示，直到恢复或再次忽略。
- **诊断可见**：`/api/diagnostics` 新增 `corruptFiles: [{ path, bytes, at }]`，面板横幅之外的排查入口。
- **文案如实**：`client.js` 横幅改为「重启后仍会提示，直到用备份恢复或再次忽略」；README 限制第 12 条、CHANGELOG 同步。

### 测试

- `journal-store.test.mjs`：新增「残留 `.corrupt-*` 且未恢复 → 重新置错（`corrupt-backup-present`，含 original/bytes）」「恢复记录之后不反弹；比恢复记录更新的新损坏会再次提示」，并把「显式 clear 后重新加载」改成断言会重新置错（只有恢复记录才持久）。
- `routes.test.mjs`：新增「残留 `.corrupt-*` 时启动即重新提示 + diagnostics `corruptFiles`」「dismiss 按 `.at` 会话内忽略、重复点无害」「从备份恢复后写恢复记录、清横幅且再次 load 不反弹」，共 25 条用例（14 store + 11 route）。

## [0.2.3] - 2026-11-17

把 0.2.2 之后的 corrupt-journal 横幅维修（F-04/F-05）正式发版，并补上客户端「知道了」按钮（F-06）——此前 CHANGELOG 已描述该交互，但 `client.js` 与 v0.2.2 完全相同、并没有按钮，属文档先行的失实，本次补齐。

### 修复

- **J-06 后续**：`journal-store.js` 保留导出 `clearJournalLoadError()`，但 `saveJournal()` 不再把它当恢复信号（此前按「写回含真实内容」清除，仍会把自动归纳、reconcile 空壳写回误判为恢复）。现在只有显式路径清警告：① `index.js` 的 `restoreBackup()` 成功 `saveJournal(state)` 后清空底层 loadError——恢复一份**合法但 0 阶段**的备份同样清零，因为坏文件已被覆盖，这条是持久的；② 新增 `GET /api/journal/dismiss-error?confirm=1`：把「用户点了知道了」记为**会话内**状态（内存里的 `loadErrorDismissedAt`，不落盘、不用 localStorage），`/api/state` 与 `/api/diagnostics` 的 `journalError` 在已 dismiss 时返回 `null`，但底层 `.corrupt-*` 文件、日志与 loadError 原样保留；下次启动重新 load 出错误时（新的 `.at`）会重新告警。单测覆盖「自动归纳式写回不清 + 显式 clear 才清」，另用临时 HOME 端到端验证损坏启动 → dismiss → 恢复 0 阶段备份的完整链路。

### 新增

- **F-06 横幅补「知道了」按钮**：`client.js` 的 `journalError` 横幅现在渲染「知道了」按钮，`onClick` 走 `act('dismiss-error', …)` → `GET /api/journal/dismiss-error?confirm=1` → 成功后 `refresh()`；请求失败落入面板错误条（`操作失败：…`）。语义与服务端一致：只清会话内的面板视图，`.corrupt-*` 文件、日志和底层 loadError 保留，重启后仍会告警。

### 文档

- README 安装说明中「那里没有 `test/`」的失实理由改为限定表述：按**方式 A**（本地路径 `install_bundle`）装出来的是拷贝副本、不是开发副本（没有 git 历史），**方式 B** 的 `link:` 直接指向 clone、二者是同一份；两种安装都没有开发依赖，测试请在 clone 目录跑（`files[]` 含 `test/*`，安装副本确实带测试）。
- CHANGELOG 中 J-13 条目改为与 0.2.2 README 一致：补充本地路径 / `link:` 安装说明；包未上架 npm 前按版本号 `install_bundle` 会 404。

## [0.2.2] - 2026-11-17

docs only：更正 npm 上架状态说明（`npm publish` 需要 2FA，当前未上架任何版本），无代码变更。

### 文档

- README「安装」：删除「已发布到 npm 时…」条件句与不存在的 `install_bundle target="@pawsey0319/dsh-project-journal@版本号"` 命令，改为明确说明「npm 尚未上架 npm（发布需要 2FA）」，并给出当前可用路径——先 clone 仓库，再按本地路径安装或 `link:` 到 profile；英文 quick start 同步。

## [0.2.1] - 2026-11-17

可用级维修：按 `docs/research/journal-final-audit.md` 的审查结论逐条修复（J-01…J-18），数据格式保持 journal **version 3** 兼容，无需手动迁移。

### 修复

- **J-01（blocker）清空回收站必然 500**：`index.js` 调用 `rmSync` 却没有从 `node:fs` 导入，回收站非空时返回 `{"error":"internal","detail":"rmSync is not defined"}`（回收站为空反而 200，导致「一按就错」）。清理逻辑抽到 `journal-store.js` 的 `purgeTrash()` 并补齐导入，路由只负责标记与保存；新增路由回归用例覆盖「回收站非空时清空返回 ok」。
- **J-02（high）导出 Markdown 混入回收站阶段**：`/api/export` 先过滤 `deletedAt` 再按分支排序，标题编号按活阶段重排（不再出现「阶段 4」而正文只有 3 段、`### 1.` 重复），头部注明「另有 N 个回收站阶段未导出」。
- **J-03（high）永久删除阶段后会话永久消失**：hard delete 遍历全部会话清 `phaseIds`，并清除 `hiddenBy` 指向该阶段的 `hidden/hiddenBy`；`syncSessions()` 额外自愈历史数据里悬空的 `hiddenBy`，会话回到项目与「未归属」并重新参与自动归纳。
- **J-04（medium）一致性横幅常驻误报、一键修复恒 0 条**：检查与修复共用 `consistencyIssues()`（软删除阶段仍算「存在」），修复返回 `changed/remaining/noop`，面板据此提示「已修正 / 没有可自动修正的项 / 还剩 N 处」。
- **J-05（medium）未归属会话迁移丢阶段**：会话不在任何 workspace 行时把「未归属」当作隐式来源项目，阶段随会话一起迁移，不再留下指向不存在阶段的悬空指针。
- **J-06（medium）journal.json 损坏被静默清空**：解析失败（含顶层非对象）先把原文件另存为 `journal.json.corrupt-<时间戳>`，`journalLoadError()` 暴露给 `/api/state`、`/api/diagnostics` 与面板横幅，提示可从备份恢复。
- **J-07（medium）错误面直接抛内部异常串 / config 无数值校验**：客户端新增「错误码 → 中文文案」映射并挂 `error.code`（`internal` 等不再原样显示，原始 detail 只进诊断）；`/api/config` 数值参数改为 `Number.isFinite` + 区间校验，越界或非数字保留原值并返回 `ignored`。
- **J-08（low）删除分支静默丢弃空阶段**：分支内所有阶段统一软删除进回收站（有内容的阶段仍隐藏相关会话），不再有阶段「既看不见也恢复不了」。
- **J-09（low）分支会话计数含隐藏会话**：`sessionCount` 过滤 `hidden`。
- **J-10（low）旧备份恢复后结构滞后**：`/api/backup/restore` 在保存前执行 `migrateJournal()`，恢复 v1/v2 备份后立即是当前结构。
- **J-11（low）`exports` 缺 `./package.json`**：补上映射，便于工具读取包元数据。
- **J-14（info）幽灵项目不可见**：`/api/diagnostics` 增加 `projectsTotal` / `projectsVisible`。
- **J-18（low）诊断看不到路由异常**：`/api/diagnostics` 增加 `routeErrors`（最近 5 条「路由异常」信标）。

### 文档

- **J-12** README 删除不存在的 `docs/images/*.png` 截图占位表，改为说明「本包不附带截图」及原因（`docs/` 不在 `files[]` 里）。
- **J-13** 安装说明补充本地路径 / `link:` 安装方式；包未上架 npm 前按版本号 `install_bundle` 会 404，0.2.2 已从 README 移除该命令。
- **J-15** 限制清单写明：自动归纳会改写阶段标题/摘要/下一步，只有 `manual: true` 的阶段不被覆盖。
- **J-17** `act()` 调用点计数修正为 72（中英文 README 两处）。
- 其余审查项（如 J-16 轮询去重）与完整复现步骤、验证记录见 `docs/research/journal-final-audit.md`。

### 测试

- `npm test` 18/18：新增 `test/routes.test.mjs` 8 条 Host 路由回归（临时 `HOME` + 手写夹具，不读写真实 `~/.dsh/project-journal`），并在存储层单测补充 `purgeTrash()` 与「损坏 journal 另存」两条。
- `node --check index.js client.js journal-store.js` 全部通过。

## [0.2.0] - 2026-11-17

首个公开发布版本：包名改为 `@pawsey0319/dsh-project-journal`，独立仓库发布（不再随 `@local/*` 内部包分发）。

### 新增

- **进展分支与阶段重做（R10）**：任意阶段可「从此阶段开分支」，分支首节点标记 `↺ 重做`，阶段在分支内独立编号；主线永不被覆盖。分支可标注 `active` / `merged` / `abandoned`，已合并可「撤销合并」（阶段按 `mergedPhases` 退回原分支）。
- **承接上下文开分支**：默认调用 `sessionController.fork({ sessionId, atSeq })` 把该阶段所在会话分叉到阶段结束的 turn 边界（`snapToTurnEnd` 兜底），新会话继承此前的全部对话历史；`fork` 不可用时降级为「空白会话 + 可编辑文字种子」，并把 `warning: fork-failed` 写进分支记录与面板错误条。
- **回收站**：删除阶段改为软删除——记录进回收站可恢复，该阶段的产物文件移到 `~/.dsh/project-journal/trash/<projectId>/<phaseId>/`，相关会话标记 `hidden`；恢复时文件原路移回、会话恢复可见；永久清除需 `confirm=1` 二次确认。
- **备份与恢复**：迁移、删除阶段、撤销合并前自动备份 `journal.json`（必要时连同 `workspace.json`）到 `~/.dsh/project-journal/backups/`，滚动保留 8 份；设置抽屉与 `/api/backups`、`/api/backup`、`/api/backup/restore` 可查看/立即备份/恢复。
- **阶段修订历史**：手改阶段记录改前/改后快照（最多 20 条，卡片显示「手改 N」），可「回到这一版」（`/api/phase/restore-revision`）。
- **「接下来」一等字段**：每阶段带 `nextSteps`（≤6 条、每条 ≤120 字），项目顶部汇总当前阶段的下一步；`active` 阶段为空时用未解决问题兜底生成；手改后整组保护，不被自动总结覆盖。
- **检索与导出**：面板顶部搜索框对「阶段标题/摘要/下一步/问题陈述与处理/分支名」即时过滤并直达项目与分支；项目页「导出 MD」导出含分支、阶段、问题与处理、下一步、产物的 Markdown。
- **产物 chip 可点开**：`GET /api/artifact/open?projectId=&name=` 在项目目录内解析文件名/相对路径并 `open`，拒绝目录穿越与跨项目路径，找不到时给明确提示；`/api/phase/rescan` 可补扫阶段时间窗内的产物。
- **一致性体检与修复**：面板显式列出「会话指向不存在阶段」「阶段列着不存在/跨项目会话」，`/api/consistency/fix` 一键清理。
- **会话归属体检**：会话 `cwd` 指向另一个已登记项目时，项目顶部给出提示与一键「迁到「X」」（复用迁移事务）。
- **手工补问题记录**：`/api/problem` 支持问题/处理/状态的增改删，写入即 `manual=true`，进入面板、导出与未解决统计。
- **未归属会话也有阶段**：`unassigned` 桶按会话自身目标归纳 1–3 个阶段；`/api/reproject?rebuild=1` 先重置游标再重读，避免「已总结过 → 增量 0 → 永远没有阶段」。
- **英文 locale**：新增 `locale/en.json`，插件名与描述随 DSH 界面语言切换（面板内文案目前仍为中文，属已知限制）。

### 修复

- **面板点击被「古法编程」覆盖层劫持**：面板改为 portal 到 `body` 自己的宿主并置顶（shell.overlay 容器 z-index 较低，子元素抬 z-index 压不住古法挂在 body 上的浮层），portal 宿主幂等归位；古法 `mode=1` 时给出非侵入提示 `.pj-notice`；不跨插件调用 `window.__GUFA_CODE__`。独立验证覆盖 10 类控件（会话 chip、关闭、改阶段、删除、开分支、下一步、筛选、设置、回收站、迁移）全部命中本插件处理器，无古法跳转。
- **`act()` 覆盖**：面板内的交互动作统一经 `act()` 包装，产出 `ui:<action>` 诊断信标并把异常收敛为面板错误条，使「点了没反应」可被定位；纯 UI 状态切换保持轻量不打点。
- **空分支导致面板「看起来点不动」**：`activeBranchId` 指向已放弃/零阶段分支时自动归 `main`（`setBranchStatus`、`migrateJournal` 加载、客户端 `branchSelected` 三处），避免 0 张阶段卡时连「改阶段/重做」按钮都没有。
- **分支会话计数虚高**：`sessionCount` 按「项目 + 分支」双过滤，主线不再显示项目全部会话数。
- **`window.prompt` 空操作**：所有需要输入的交互改为内嵌 input/textarea（`StepForm`、`BranchRename`），不再出现「点了既不弹窗也不报错」。
- **fork 拒绝 `atSeq must be a completed-turn boundary`**：`snapToTurnEnd` 找 `turn/end` 边界，按 `[snapped, atSeq, undefined]` 依次重试 `fork`。
- **会话列表与游标**：`listSessions()` 正确 `await`；会话 seq 0 基 → 游标初值 `-1`；`sessionController.prompt` 第二参传 `AbortSignal`。
- **迁移重复阶段**：阶段随会话一起迁移（源项目释放、共享阶段在目标项目克隆并换 id），不再新建「迁入 · 会话名」占位阶段。
- **旧 journal 迁移**：读取 v1/v2 数据时自动补 `main` 分支与 `branchId`，并修正非 active 的 `activeBranchId`。
- **会话记录虚高**：`syncSessions()` 在拿到非空会话列表时 prune 掉 DSH 已不存在（删除/归档）且未被阶段引用的记录。

### 变更

- 包名：`@local/dsh-project-journal` → **`@pawsey0319/dsh-project-journal`**，仓库独立为 `pawsey0319/dsh-project-journal`（MIT）。插件本身与 `dsh-agent-suite` 无关，不并入该套件。
- 数据文件 `~/.dsh/project-journal/journal.json` 升到 **version 3**（`projects.branches[]`、`phases.branchId`、`sessions.branchId`、`projects.activeBranchId`、`phases.sourceSessionId/sourceSeq`），旧数据读时自动迁移。
- 面板入口与槽位稳定为：`shell.overlay`（面板）、`sidebar.footer.action`（按钮）、`sidebar.workspaces.session.row.action`（会话行「移入项目」）。
- 写接口统一为 **GET + query**（DSH `webServer` prefix 路由只服务 `GET`/`HEAD`），文档见 README §6。

### 文档

- 修正重载说明：本插件由 bundle 自带 patch 插入，`plugin_manager action=set_plugin target="include:dsh-project-journal"` 会返回 `unaddressable`；改为 `action=set_bundle target="@pawsey0319/dsh-project-journal" enabled=false/true` 或直接重启 DSH。
- 修正信标保留条数：内存环形 40 条、`/api/state` 返回末 12 条、诊断接口末 8 条，不落盘。
- 修正 pnpm 用法：DSH 用 corepack 管理 pnpm，命令写作 `corepack pnpm install`。
- 修正 README §5「数据与隐私」的信标口径（原写「最近 12 条」）：与限制 #4 统一为内存环形最多 40 条、`/api/state` 返回末 12 条、诊断接口返回末 8 条，均不落盘。
- 修正「开发与测试」的快速开始路径：原 `cd plugins/dsh-project-journal` 是 monorepo 视角，公开仓库根目录即插件包根，改为「在插件包根目录执行」（clone 后为 `cd dsh-project-journal`）。

## [0.1.0] - 2026-11-16

首个可用版本（R9「项目进展阶段链与会话迁移」）。

### 新增

- **项目阶段链**：按 DSH workspace 汇总项目下全部会话，由模型把会话归纳成「目标变化/交付节点」级别的阶段（标题 ≤16 字、摘要 ≤180 字、状态、时间范围、来源会话、产物线索），不按会话轮次切分。
- **问题档案**：每阶段记录「问题陈述 + 用户原话引用 + 处理方式 + 已解决/未解决」；`quote` 必须是该会话用户原话的连续子串，否则丢弃（防模型编造）。
- **增量总结**：会话 idle 25s（可调）且新增可总结事件 ≥3 时触发，只把游标之后的新增内容 + 已有阶段摘要发给小模型；无新增不写库。模型返回非法 JSON 时会话标失败、队列继续、可重试。
- **历史一次性回填**：按项目串行推进，进度可见、可暂停、重启后续跑；只读本项目会话、只写本项目。
- **一键迁移**：会话行「移入项目」→ 选目标项目 → 确认；同时改 live `workspace` domain 的 `sessionIds`、journal 的 `projectId`、以及该会话名下的阶段；写前自动备份。
- **手动修正优先**：阶段标题/摘要与问题条目可手改，`manual` 字段保护，自动总结不覆盖。
- **设置抽屉**：模型 provider/model、自动总结开关、回填进度与开始/暂停、立即总结。
- **存储**：`~/.dsh/project-journal/journal.json`（原子写 + 滚动备份），`/api/health`、`/api/state`、`/api/export` 等 HTTP 面。
