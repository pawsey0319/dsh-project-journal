# Changelog

本插件的所有重要变更记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

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
