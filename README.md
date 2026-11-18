# 项目进展 · dsh-project-journal

> **中文优先（zh-first）**：本 README 以中文为主；English quick start is at the bottom.

把 DeepSeek Harness（DSH）里散落在各个会话中的「项目进展」整理成一条可回看的阶段链：每个项目一份进展记录，包含阶段、下一步和问题档案，并支持把会话一键迁回它真正所属的项目。

- npm 包名：`@pawsey0319/dsh-project-journal`
- 当前版本：`0.4.0`（见 [CHANGELOG.md](CHANGELOG.md)）
- 许可证：[MIT](LICENSE) © 2026 pawsey0319
- 宿主：DSH（`manifestVersion: 1`，需要 Web 客户端与 `slots` 服务）

这是一个 DSH 插件（Host 半 + Web client 半）：不改 DSH 本体（`app.asar`）、不接管会话，只读会话事件、只写自己的 `journal.json`。

## 它解决什么问题

DSH 的会话是按工作目录组织的，但真实工作往往跨目录：调研在 A 目录、实现落在 B 仓库、复盘又回到 A。同时开着四五个会话时，注意力只能跟住一个；两天后回来，你不记得另一个会话做到哪、为什么那么做、中间踩过什么坑；隔几个月，连「当初为什么这么设计」都说不清。重读几百条消息是最差的答案。

项目进展把这件事沉淀成结构化记录（阶段由**总结**产生，不按会话轮次切分）：

| 痛点 | 插件给的东西 |
| --- | --- |
| 多会话、多天后忘记进展 | 后台按会话增量归纳阶段链：标题 + 摘要（目标/做法/结论）+ 时间范围 + 来源会话；无新增事件不写库、不烧 token |
| 会话开错了项目 | 会话行一键「移入项目」：侧边栏归属、进展归属、阶段一起迁过去 |
| 项目之间互相污染 | **项目 = DSH workspace**，面板按项目隔离；不属于任何 workspace 的进「未归属」桶 |
| 只记得「做了什么」，不记得「为什么」 | 每个阶段带**问题档案**：问题陈述 + 用户原话引用 + 处理方式 + 已解决/未解决 |
| 不知道下一步做什么 | 阶段带「接下来」（`nextSteps`），项目顶部汇总当前阶段的下一步，可增删手改 |
| 路子走错了想重来 | **从阶段 K 重做**：开一条进展分支，新会话承接该阶段之前的对话上下文，主线原样保留 |
| 阶段记录写错了 | 手改优先（`manual` 不被自动总结覆盖），每次手改留修订快照，可回到某一版 |
| 删了怕丢东西 | 软删除进**回收站**：记录可恢复，产物文件移到回收站，会话对话历史一行不动 |
| 怕模型或手滑改坏数据 | 迁移/删除/撤销合并前自动备份 `journal.json`（必要时连同 `workspace.json`），可一键恢复 |
| 要交接、要存档 | 项目页一键「导出 MD」，含分支、阶段、问题与处理、下一步、产物 |

**明确不做**：不改会话内容、不代发消息、不调用审批、不重置其它插件的状态；分支只分「对话起点 + 进展链」，不动工作目录里的任何代码文件。

## 界面位置

插件注册三个槽位：

| 槽位 | 内容 |
| --- | --- |
| `sidebar.footer.action` | 侧边栏底部的「进展」入口，角标显示未解决问题 / 下一步数量 |
| `sidebar.workspaces.session.row.action` | 会话行右侧的「移入其他项目」按钮 |
| `shell.overlay` | 全屏的「项目进展」面板（搜索、阶段链、分支、回收站、设置） |

面板内的动作点击统一经过 `act()` 入口（共 85 处，另有一个 `stopClickBubble` 只做事件拦截）：打一条 `ui:<动作>` 诊断信标，并把同步/异步异常收敛到面板顶部的错误条，不会冒泡到宿主或其它插件的全局点击处理。

## 界面说明（暂无截图）

> 本包**不附带截图**：`docs/` 不在 npm 发布文件列表里，README 里指向 `docs/images/*.png` 的图片在 npm 页面必然加载失败，因此这里只做文字说明。需要配图时请在发布流程里单独上传，或把截图放进 `files[]` 覆盖的目录（例如 `images/`）后自行加链接。

| 位置 | 说明 |
| --- | --- |
| 面板总览 | 左侧项目列表（含「未归属」桶）+ 右侧阶段时间线 + 顶部「接下来」汇总条 |
| 阶段卡与问题档案 | 标题/摘要/状态/来源会话/产物 chip；问题区用「未解决」标记区分处理状态 |
| 分支视图 | 分支页签「主线 / 从阶段 K 分叉」、`↺ 重做` 首节点、只读前缀灰显 |

## 安装

### 前置条件

- DSH 桌面版或 Web 版，且当前 release 支持 Web client 插件（插件产物必须与宿主 boot release 一致，不一致时页面只会提示刷新）；
- Node.js >= 20；
- 插件会用宿主自带的 `webServer`、`storageDomain`、`sessionQuery`、`llm`、`sessionController`、`workspaceController`（按需）与客户端 `slots`，无需额外安装；
- 插件会调用宿主模型做会话归纳；模型未就绪时只有「手动记录 / 迁移 / 分支」可用，自动归纳会跳过。

### 方式 A：插件管理器安装（本地路径 / link，推荐）

> **本包暂不通过 npm 分发**（npm 侧有 2FA / 组织策略限制，本项目也不会为此开例外）。因此**不要**用 `plugin_manager action=install_bundle target="@pawsey0319/dsh-project-journal@版本号"` 这种 npm 版本号安装——那条路会 404。当前可用的安装路线：
>
> 1. **方式 C** `git clone` 本仓库，再按本节用本地绝对路径安装；
> 2. **方式 B** 把 clone 目录 `link:` 进 profile；
> 3. **方式 D** 下载 GitHub Release 里的 `dsh-project-journal-<版本>.tgz`，解包后按本节本地路径安装（不依赖 git、不依赖 npm）。
>
> 版本升级同样走 ①/②/③：换 tag 或换 tgz，再 disable → enable 一次。

本地路径安装（把路径换成 clone 后的仓库绝对路径）：

```text
plugin_manager action=install_bundle target="/绝对路径/dsh-project-journal"
# 返回 application:"applied" 才算真正生效；不是 applied 时按其 nextStep 处理
```

GUI 的 Plugins 页等价。插件包自带 bundle 配置补丁（`cordis.patch.yml`），装好后**启用该 bundle** 才会挂载三个槽位。

### 方式 B：手动 link 到 profile（开发用）

`~/.dsh/profiles/desktop/package.json` 里加依赖并追加到 `dsh.profile.bundles`：

```jsonc
{
  "dependencies": {
    "@pawsey0319/dsh-project-journal": "link:/绝对路径/dsh-project-journal"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ……已有条目保持原顺序……
        "@pawsey0319/dsh-project-journal"   // ← 追加
      ]
    }
  }
}
```

```bash
cd ~/.dsh/profiles/desktop && corepack pnpm install   # 也可 corepack pnpm add link:/绝对路径/dsh-project-journal
```

> DSH 用 corepack 管理 pnpm，PATH 里通常没有裸 `pnpm`（本机 `corepack pnpm --version` → 12.21.0）；照抄命令请带 `corepack` 前缀，或改用 `npx pnpm`。

进 `bundles` 后插件自带的 patch 会自行 `insert` 自己的条目（`id: dsh-project-journal`），一般**不需要**手写 patch 层；要显式指定时：

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- insert:
    - id: dsh-project-journal
      name: '@pawsey0319/dsh-project-journal'
```

### 方式 D：GitHub Release 压缩包（不装 git、不装 npm）

每个 tag 都附带一个 `npm pack` 产物：

```bash
mkdir -p ~/.dsh-plugins && cd ~/.dsh-plugins
curl -L -o pj.tgz https://github.com/pawsey0319/dsh-project-journal/releases/download/v0.4.0/dsh-project-journal-0.4.0.tgz
mkdir -p dsh-project-journal && tar -xzf pj.tgz -C dsh-project-journal --strip-components=1
```

然后按**方式 A** 用 `~/.dsh-plugins/dsh-project-journal` 的绝对路径安装，或按**方式 B** `link:` 进 profile。
压缩包是发布产物（`files[]` 内的 15 个文件：三个 JS、`locale/`、`scripts/` 三道文档/无障碍/主题闸门、`test/` 两个用例文件、README、CHANGELOG、LICENSE、`package.json`、`cordis.patch.yml`），不含 `node_modules` 与 `docs/`；不需要开发依赖，解包后可直接 `node --test test/*.test.mjs`。

> 资产名口径：`npm pack` 对 `@pawsey0319/dsh-project-journal` 产出的实际文件名是 `pawsey0319-dsh-project-journal-<版本>.tgz`（`@` 与 `/` 都换成 `-`），而 Release 资产统一用**去 scope** 的 `dsh-project-journal-<版本>.tgz`——上传前先改文件名（`gh release upload` 用文件 basename 作资产名）。本 README 的下载链接用的是去 scope 名；`npm run check` 会断言「资产名 = pack 名去掉 `pawsey0319-` 前缀」。

### 方式 C：从 GitHub clone 后安装

```bash
git clone https://github.com/pawsey0319/dsh-project-journal.git ~/.dsh-plugins/dsh-project-journal
cd ~/.dsh-plugins/dsh-project-journal && npm test    # 可选：先跑单测
```

然后按方式 A 或 B 安装 `~/.dsh-plugins/dsh-project-journal`。

> 注意：`~/.dsh-plugins/dsh-project-journal` 只是 clone 出来的**暂存源码目录**，不是插件管理器实际安装的位置。装好之后，面板用的插件在 `~/.dsh/profiles/<profile>/node_modules/@pawsey0319/dsh-project-journal`：按**方式 A**（本地路径 `install_bundle`）装出来的是拷贝副本，不是开发副本（没有 git 历史，不适合就地迭代改动）；**方式 B** 的 `link:` 直接指向 clone 目录，装出来的和 clone 是同一份。两种安装都没有开发依赖，测试都请在 clone 目录跑。

更新：`git pull` 后 **disable → enable**（Host 半代码改动必须走这一步；只改 `client.js` 时 HMR 会自动热替换）。

### 装载自检

```bash
B=http://127.0.0.1:<当前 GUI 端口>              # 端口每次重启会变，以 GUI URL 为准
curl -s $B/x-journal/api/health                 # 期望 {"ok":true,"version":3,...,"sessionController":true}
curl -s "$B/x-journal/api/state" | head -c 400  # 期望有 projects[] 与 beacons[]
```

- 路由前缀优先 `/x-journal`，被占用时依次退到 `/x-journal-b`、`/x-journal-c`、`/x-journal-d`（`/api/health` 的 `route` 字段即实际前缀）；
- 客户端半是否加载：`/api/state` 的 `beacons` 出现 `client-boot:*`、`slot-ok:shell.overlay`、`slot-ok:sidebar.footer.action`、`slot-ok:sidebar.workspaces.session.row.action` 即成功；出现 `slot-fail:*` 或 `render-error:*` 说明座位注册或组件渲染失败（有 guard 兜底，不会白屏）；
- **首次安装、或改了 `package.json` / `cordis.patch.yml` / `index.js` 之后，需要刷新窗口（必要时重启 DSH）才会加载新产物。**

### 卸载

```text
plugin_manager action=remove_bundle target="@pawsey0319/dsh-project-journal"
```

卸载后 `/x-journal/*` 路由消失、面板入口消失，**`~/.dsh/project-journal/journal.json` 保留**（不删用户历史）；想彻底清空请手动删除该目录。

## 配置

两个入口：面板右上「设置」抽屉，或 `/api/config`（GET + query，写操作同理，见下）。

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `provider` | 自动解析 | 归纳用的模型 provider；留空则从 `listProviders()` 解析 |
| `model` | 自动解析 | 归纳用的模型；默认取名字含 `chat` / `flash` 的模型 |
| `auto` | `true` | 自动归纳开关；关掉后只能手动「立即归纳」/「重新归纳本项目」 |
| `idleDelayMs` | `25000` | 会话 idle 多久后触发一次归纳（另有 1.5s 防抖） |
| `minNewEvents` | `3` | 新增可归纳事件少于该值时不调模型、不写库 |
| `maxInputChars` | `60000` | 单次喂给模型的输入上限（超出截断，不丢游标） |
| `maxPhaseContext` | `12` | 已有阶段摘要带进上下文的条数上限 |
| `throttleMs` | `1500` | 串行 worker 的节流间隔 |

```bash
curl -s "$B/x-journal/api/config?provider=deepseek&model=deepseek-chat&idleDelayMs=15000&minNewEvents=2"
curl -s "$B/x-journal/api/model-probe"     # 只读：模型是否可解析
```

**历史回填**：安装后不会自动重读全部历史，需要显式开始：

```bash
curl -s "$B/x-journal/api/backfill?action=start"   # 开始/续跑
curl -s "$B/x-journal/api/backfill?action=pause"   # 暂停（进度保留，重启后继续）
curl -s "$B/x-journal/api/backfill?action=reset"   # 游标重置为 -1 并重跑
```

回填是串行 worker、每会话一次模型调用，进度见 `/api/state` 的 `backfill` 或设置抽屉。

**未归属会话**：不在任何 workspace 里的会话进 `unassigned` 桶，不能作为迁移目标，但同样会被归纳（按会话自身目标归纳 1–3 个阶段；是否新增阶段由模型判断，与普通项目同一套规则）；桶里长期为空时用「重新归纳本项目」带 `rebuild=1` 重读。

## 使用

1. 点侧边栏底部的「进展」打开面板；
2. 左侧选项目，右侧看阶段链；顶部搜索框即时过滤「阶段标题/摘要/下一步/问题陈述与处理/分支名」，点结果直达项目与分支；
3. 阶段卡片上可以「改阶段」「+ 下一步」「从此阶段开分支」「重扫产物」「删除阶段」；
4. 问题记录可「修正」或删除，未解决数量累计到入口角标；
5. 会话行右侧按钮把会话迁到目标项目（项目顶部也会在 `cwd` 与项目不符时给一键迁移提示）；
6. 「设置」里配置自动归纳、回填历史、备份与恢复；「导出 MD」把项目进展带走。

补充几个关键语义：

- **阶段**：一个阶段 = 一个目标变化或一个交付节点（不是一轮对话），含标题、摘要、状态（已完成/进行中/计划）、时间范围、来源会话、产物、问题、下一步；
- **分支**：从阶段 K 开分支后，分叉点之前的阶段灰显只读，分支首节点标 `↺ 重做`；可标已合并/放弃/恢复/删除，已合并可「撤销合并」；
- **删除阶段**：软删除进回收站（记录可恢复、产物移到 `trash/<projectId>/<phaseId>/`），永久清除需二次确认；
- **修订**：手改阶段或回退都会记一条改前/改后快照（最多 20 条）；阶段卡片顶部标出这段进展「谁写的、什么时候写的」（模型 / 你 / 回退 / 旧数据推断），点「查看全部 N 条」按需拉完整修订，可「回到这一版」。

## 数据与隐私

- 进展数据保存在本机 `~/.dsh/project-journal/journal.json`（version 3，原子写 + 滚动备份），不上传第三方；
- 归纳时只把「游标之后的新增会话文本 + 已有阶段摘要」发给**你自己配置的**模型 provider；模型输入**不含文件内容、不含图片**；
- 插件无遥测：`/api/beacon` 只写本机内存里的环形诊断缓冲（最多保留 40 条；`/api/state` 返回末 12 条、诊断接口返回末 8 条），不落盘、不外发；
- 迁移会话只改 DSH 的 workspace 归属（经 `storageDomain` 的 `workspaces` 表），不移动磁盘上的项目文件；
- 删除阶段/问题先进回收站或保留修订历史，迁移/删除/撤销合并前自动备份：

```text
~/.dsh/project-journal/
├── journal.json                 # 唯一事实源：config / projects / sessions / backfill
├── backups/                     # 滚动备份（每类 tag 各保留最近 8 份：manual / restore / migrate / phase / branch / workspace / corrupt…）
└── trash/<projectId>/<phaseId>/ # 软删除阶段的产物文件（恢复时原路移回）
```

项目列表与会话归属以 live `workspace` domain（`workspaces.sessionIds`）为唯一真源，每次打开面板重新对账；旧版本 journal 读取时自动迁移（补 `main` 分支等）。

## HTTP 接口

宿主半边在 `/x-journal` 暴露接口（前缀被占用时自动退到 `/x-journal-b` 等）。

> **写操作也走 GET + query**：DSH 的 `webServer` prefix 路由只服务 `GET`/`HEAD`，`POST` 会在匹配前就 405。参数一律 query string，`1`/`true` 视为真。
> 这些接口是**本机 HTTP 面、没有鉴权**，不要把 DSH 端口暴露到公网。

### 只读

| 路由 | 说明 |
| --- | --- |
| `/api/health` | 存活与版本、实际路由前缀、`clientGraph`、`sessionController` 可用性 |
| `/api/diagnostics` | 维护用：会话状态分布、失败样本、`journal.json` 体积、备份数、队列/worker 状态 |
| `/api/state` | 面板主数据：`projects[]`（含 `branches[]`/`phases[]`/`sessions[]`）、`config`、`backfill`、`reproject`、`summarizing`、`beacons`、模型就绪状态。带 `ETag` 响应头（不含 `generatedAt`/`beacons`）；`If-None-Match` 命中时回 `304` 且无 body |
| `/api/export?projectId=` | 导出该项目 Markdown（分支、阶段、问题与处理、下一步、产物） |
| `/api/model-probe` | 清缓存后重新探测模型（只读） |
| `/api/branch/seed?projectId=&phaseId=` | 开分支前预演：分支名、`fromSeq`、种子 prompt、可承接上下文 `{sessionId, seq, total}` |
| `/api/branch/diff?projectId=&branchId=` | 分支与主线在分叉点之后的差异、各自未解决问题数 |
| `/api/backups` | 备份目录与备份文件列表 |
| `/api/trash` | 回收站占用、按项目统计、已软删阶段与产物清单 |
| `/api/session-debug?sessionId=` | 维护用：事件数、turn 数、首/末条用户消息摘要 |
| `/api/migrate?...&dryRun=1` | 迁移预演（不写库） |
| `/api/phase/revisions?projectId=&phaseId=` | 某个阶段的完整修订历史（最近 20 条，新→旧；含 `by`/`before`/`after`/`restoredFrom` 与 `summaryMeta`） |
| `/api/project/orphans` | 只读：已不在工作区、也不属于「未归属」的孤儿项目记录（含阶段/问题/会话/分支计数与 `deletable`） |

### 写操作

| 路由 | 关键参数 | 说明 |
| --- | --- | --- |
| `/api/beacon` | `e`（信标名）`d`（detail） | 客户端诊断打点（落内存环形缓冲） |
| `/api/config` | `provider` `model` `auto` `idleDelayMs` `minNewEvents` `maxInputChars` `maxPhaseContext` `throttleMs` | 改配置并落盘 |
| `/api/backfill` | `action=start\|pause\|reset` | 历史回填 |
| `/api/summarize` | `sessionId` `force=1` `retry=1` | 立即归纳某个会话（入队）；`retry=1` 只对 `state=error` 的会话生效（清掉失败计数重新排一次，不动事件游标），其它状态回 `400 not-retryable` |
| `/api/reproject` | `projectId` `action=stop` `rebuild=1` | 「重新归纳本项目」；`rebuild=1` 先重置游标再重读 |
| `/api/migrate` | `sessionId` `targetProjectId` | 会话迁移（workspace 归属 + journal 归属 + 阶段随会话迁移，写前备份） |
| `/api/branch` | `projectId` `phaseId` `title` `withSession=1` `mode=fork\|blank` `prompt` `sessionId` | 从阶段 K 开分支；默认 `fork` 承接上下文，失败降级为空白会话 + 种子 |
| `/api/branch/status` | `projectId` `branchId` `action=merged\|abandoned\|active\|rename` `title` | 分支标注/改名（`main` 不可改） |
| `/api/branch/merge` `/api/branch/unmerge` | `projectId` `branchId` | 并入主线 / 撤销合并 |
| `/api/branch/delete` | `projectId` `branchId` `force=1` | 只删未动过的分支，其会话改回 `main` |
| `/api/branch/attach` | `projectId` `branchId` `sessionId` `move=1` | 把会话挂到分支 |
| `/api/phase` | `projectId` `phaseId` `title` `summary` `nextSteps`（`\|` 分隔，≤6）`status` `action=delete\|restore` `hard=1` | 手改 / 软删除 / 恢复 / 永久删除阶段 |
| `/api/phase/create` | `projectId` `title` `summary` `branchId` | 手工新建阶段 |
| `/api/phase/rescan` | `projectId` `phaseId` | 重扫该阶段时间窗内的产物并补进 `artifacts` |
| `/api/phase/restore-revision` | `projectId` `phaseId` `at` | 回到某一修订版（本身也记一条修订） |
| `/api/problem` | `projectId` `phaseId` `statement` `resolution` `status=open\|solved` `problemId` `action=delete` | 补/改/删问题记录（写入即 `manual=true`） |
| `/api/artifact/prune` | `projectId` `phaseId` | 把已不存在的文件从该阶段产物记录里移除（只删记录，不动磁盘） |
| `/api/project/delete` | `projectId` `confirm=1` | 删除孤儿项目**记录**（阶段/问题/会话索引；不动项目目录，删前自动备份 journal）。拒绝：`confirm-required` / `bad-request` / `reserved-project` / `project-in-workspace` / `project-has-sessions` / `project-path-in-workspace` / `project-missing` |
| `/api/journal/dismiss-error` | `confirm=1` | 会话内忽略 `journal.json` 损坏横幅（只丢内存标记，`.corrupt-*` 与日志保留） |
| `/api/artifact/open` | `projectId` `name` `reveal=1` | 在项目目录内解析并打开产物，只允许项目路径内文件 |
| `/api/trash/empty` | `confirm=1` `projectId`（可选） | 永久清空回收站文件（记录保留，产物不可再恢复） |
| `/api/backup` | `action=create` | 立即备份 |
| `/api/backup/restore` | `file` | 从备份恢复 |
| `/api/consistency/fix` | `projectId`（可选） | 修掉「会话指向不存在阶段 / 阶段列着不存在或跨项目会话」 |

维护/调试接口（默认不用）：`/api/session-archive`、`/api/session-record`（`action=delete`，只删 journal 记录）、`/api/session-create`、`/api/session-prompt`、`/api/session-cancel`、`/api/workspace-create`（需 `confirm=1`）、`/api/workspace-delete`。

## 限制与已知问题

1. **首次安装/改元数据要刷新窗口**：改 `client.js` 可由 HMR 热替换；改 `package.json`、`cordis.patch.yml`、`index.js` 后需**重启 DSH**，或用 `plugin_manager action=set_bundle target="@pawsey0319/dsh-project-journal" enabled=false` → `true` 关开该 bundle（`set_plugin` 对本插件不可用，原因见「开发与测试」）。页面也可能需要刷新才加载新产物。
2. **「古法编程」覆盖层提示**：客户端用 DOM 探测古法覆盖层是否在（`.gufa-overlay-root` 存在即视为开启），命中时面板 portal 到 `body` 下自建的 `#pj-overlay-host` 并置顶，打开时给一条非侵入提示 `.pj-notice`（`gufaUnderlay`），面板内点击由本插件处理；期间还有 1.2s 一次的 portal 宿主守护（面板数据另有 5s 轮询），宿主被移出 `body` 会立刻纠正回来。**但**关掉面板后露出的是古法 IDE——那是古法自身的持久化状态，插件不跨插件调用 `window.__GUFA_CODE__`，无法单方面关闭；要「关面板同时退出古法」需产品拍板。
3. **不跨插件重置**：插件只改「会话归属」和自建的 `journal.json`，不重置任何其它插件状态、不代发消息、不调用审批；反过来，别人删了 workspace 或会话，本插件要等下一轮对账才反映。
4. **诊断看信标**：每个点击动作经 `act()` 包装产出 `ui:<动作>` 信标（`beacons` 在内存环形里保留最近 40 条，`/api/state` 只返回末 12 条、诊断接口末 8 条，均不落盘）；排查「点了没反应」先看信标是否到达。非点击动作（自动归纳、迁移、回填）只有摘要级信标。
5. **`window.prompt` 在 DSH 渲染层是空操作**，所以所有需要输入的交互都是内嵌 input/textarea，不存在系统弹窗。
6. **面板文案目前仅中文**；`locale/zh.json` / `locale/en.json` 只覆盖插件名与描述（随 DSH 界面语言切换）。
7. **分支不是代码回滚**：只分「对话起点 + 进展链」，工作目录文件一行不动；需要 git 级回滚请自行操作。
8. **产物打开依赖系统 `open`**，非 macOS 环境该动作无效，只会得到「找不到/可能已移动」提示。
9. **没有多用户概念**：单机单人插件，`journal.json` 不做并发写保护（两个 DSH 实例同时写会互相覆盖）；`journal.json` 体积随历史线性增长，建议定期清理彻底不用的分支与阶段。
10. **阶段是派生视图**：手改会进入后续归纳与开分支的上下文（`phaseContext` / `branchContext` / 种子），从而影响后续模型判断；修订记录就是为了让这件事可追溯。
11. **自动归纳会改写阶段标题/摘要/下一步**：同一阶段出现新进展时，模型会更新它（标题被重写是预期行为）；只有手改过的阶段（`manual: true`）才固定不被覆盖。想保留某版就点开阶段改一次，或从修订记录回退。

12. **journal.json 损坏后重启仍会提示**：解析失败时原文件先另存为 `journal.json.corrupt-<时间戳>`，面板横幅与 `/api/diagnostics.corruptFiles` 会一直提示，直到你从备份恢复（写恢复记录，较早的 `.corrupt-*` 不再提示）或在本次会话点「知道了」（仅隐藏当前会话，重启后仍提示，直到恢复）。`.corrupt-*` 文件不会被自动删除，确认数据已恢复后可手动清理。

## 开发与测试

下面所有命令都在**插件包根目录**执行（公开仓库 clone 后的 `dsh-project-journal/`；在 monorepo 里则是 `plugins/dsh-project-journal/`，不再是仓库根）：

```bash
cd dsh-project-journal        # 已在插件包根目录时省略
node --check index.js && node --check client.js && node --check journal-store.js
npm test          # node --test test/*.test.mjs
```

测试覆盖 `journal-store.js` 的摘要归并、问题 quote 校验、阶段状态迁移、分支上下文与 journal 迁移等纯逻辑（无需 DSH 在跑），以及 `index.js` 前缀路由的回归用例（回收站清空、导出过滤软删阶段、一致性检查/修复同口径、永久删除解隐藏、未归属会话迁移、config 数值校验、损坏另存的启动重提示 / dismiss / 恢复不反弹）。路由用例用临时 `HOME` + 手写 journal 夹具，不读写真实 `~/.dsh/project-journal`。装载回归需要真实 DSH：

```bash
B=http://127.0.0.1:<GUI 端口>
curl -s $B/x-journal/api/health
curl -s "$B/x-journal/api/state" | python3 -m json.tool | head -60
```

Host 半（`index.js` / `cordis.patch.yml` / `package.json`）改动后：**推荐直接重启 DSH**；不想重启时用 bundle 级开关：

```text
plugin_manager action=set_bundle target="@pawsey0319/dsh-project-journal" enabled=false
plugin_manager action=set_bundle target="@pawsey0319/dsh-project-journal" enabled=true
```

- 本插件是 bundle 自带 `cordis.patch.yml` 插入的条目，profile patch 里没有同名 row，所以 `plugin_manager action=set_plugin target="include:dsh-project-journal"` 会返回 `readOnlyReason="unaddressable"`（改名后依旧不可用），不要照抄这种写法；
- remap 之前 bundle 名仍是 `@local/dsh-project-journal`，上面的 `target` 要跟着换；
- 只改 `client.js` 时保存即 HMR，无需重启。

浏览器控制台可用 `window.__pjDebug = { open(), close(), store }`。

## 兼容性

- DSH bundle 清单版本 1；
- 客户端只 `require` 平台 seed 模块（`react`，可选 `react-dom`），不依赖额外构建产物；
- 三个槽位注册的 `name` 与槽位名一致，`inject` 含 `slots`，注册都放在 `ctx.effect`；
- 组件渲染异常由 `guard()` 兜底并上报 `render-error` 信标，不会白屏。

## 目录结构

```text
dsh-project-journal/
├── index.js                 # Host 半：路由、增量归纳队列、回填、迁移、分支、回收站、备份
├── client.js                # Web client 半：shell.overlay 面板 + 侧边栏两个入口（只用 react）
├── journal-store.js         # 无 Cordis 依赖的存储层：journal.json 读写、迁移、合并规则
├── cordis.patch.yml         # bundle patch：把插件 insert 进 profile
├── package.json             # dsh 元数据：manifestVersion / bundle.patch / client.platform=web
├── locale/{zh,en}.json      # 插件名与描述
├── test/journal-store.test.mjs  # 存储层单测
├── test/routes.test.mjs         # Host 路由回归（临时 HOME）
├── README.md
├── LICENSE
└── CHANGELOG.md
```

## English quick start

Project Journal keeps a durable, per-project chain of phases, next steps and problem records for every DSH session, and can migrate a session back to the project it really belongs to.

- Package: `@pawsey0319/dsh-project-journal` (v0.4.0, MIT; distributed via GitHub Releases, not npm)
- Install it from the DSH Plugin Manager using a local checkout (or the release tarball), then enable the bundle; it registers a sidebar entry, a per-session move button and a full-screen overlay panel. Local development can link the repo into `~/.dsh/profiles/<profile>/package.json` and add it to `dsh.profile.bundles`. There is intentionally no npm distribution path.
- Action clicks go through a single `act()` helper (85 call sites) that emits a `ui:<action>` beacon and routes failures to the panel error bar instead of throwing into the host.
- Data stays in `~/.dsh/project-journal/journal.json`; summaries are produced by the model configured in DSH, and the model never receives file contents or images.
- Writes use GET + query on purpose: DSH prefix routes only serve `GET`/`HEAD`. The surface is unauthenticated, so never expose the DSH port publicly.
- Verify with `npm test` and `node --check index.js client.js journal-store.js`, then `curl $B/x-journal/api/health`.

The UI strings are Chinese-first; `locale/zh.json` and `locale/en.json` describe the plugin in both languages with identical keys.

## License

MIT © 2026 pawsey0319 — 见 [LICENSE](LICENSE)。
