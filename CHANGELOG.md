# Changelog

本插件的所有重要变更记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

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
- **J-13** 安装说明补充已发布包的 `plugin_manager action=install_bundle target="@pawsey0319/dsh-project-journal@0.2.1"`；并说明 `~/.dsh-plugins/dsh-project-journal` 只是 clone 暂存目录，真正安装位置在 `~/.dsh/profiles/<profile>/node_modules/@pawsey0319/dsh-project-journal`。
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
