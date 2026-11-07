# 删除会话（Session Delete）

一个 DSH 插件：在 Web GUI 会话列表每一行的「…」菜单中添加 **删除会话**，把该会话的存储日志从磁盘永久删除。

> **不可撤销。** 删除会移除会话日志；默认还会清理仅被该会话引用的附件。被其他会话引用的附件会保留。安装或使用前请阅读[行为](#行为)与[安全边界](#安全边界)。

DSH 本身只提供「归档」，没有删除 API（`dsh-session-persistence-jsonl` 明确记录 *Nothing deletes session files*）。本插件补上这一项能力，并且把「不能删正在运行的会话」放在 Host 侧强制校验。

## 安装

要求：

- DSH `>=0.2.2-rc.1 <0.2.3-0`。包内 `engines.dsh` 声明了这个范围，安装和启动时会检查；不匹配时 DSH 会拒绝安装或禁用插件行。
- 一个带 Web 界面的 profile。插件通过 `connection` 服务注册删除路由；终端、CLI 等没有 `connection` 的 profile 中保持不激活。
- 安装器可调用 pnpm。DSH 的 Plugin Manager 自带 pnpm 调用方式，通常不需要单独配置。

### 从 npm 安装（推荐）

在 Web 侧栏打开 **插件** → **添加插件**，输入：

```text
@acomma/dsh-session-delete@1.0.1
```

也可以在完全退出 DSH Desktop 后使用命令行：

```powershell
dsh plugin --profile desktop add @acomma/dsh-session-delete@1.0.1
```

Web profile 把 `--profile desktop` 换成 `--profile web`。Desktop 的 profile 由应用持有，应用运行期间请优先使用插件页。

### 从 GitHub 安装

在 **添加插件** 中输入：

```text
github:acomma/dsh-session-delete#v1.0.1
```

请保留 `#v1.0.1`（或具体的 commit）。不带 ref 会跟踪仓库 HEAD，同一份配置在不同时间可能装到不同代码。GitHub 直连在部分网络下较慢，必要时优先使用 npm 或压缩包。

### 从压缩包安装

从 GitHub Release 下载 `acomma-dsh-session-delete-1.0.1.tgz`，在 **添加插件** 中输入它的绝对路径，或输入以 `.tgz` 结尾的 HTTPS 地址：

```text
<压缩包所在目录>/acomma-dsh-session-delete-1.0.1.tgz
```

把 `<压缩包所在目录>` 换成你实际保存压缩包的目录；Windows 用 `\`，其他系统用 `/`。

### 本地开发安装

在 **添加插件** 中输入这个包的绝对目录：

```text
<你克隆仓库的绝对路径>
```

把占位符换成实际目录；Windows 用 `\`，其他系统用 `/`。Plugin Manager 会把它记成 `link:`，所以该目录之后不能删除或移动。这条路径适合本地开发，不适合最终用户。

安装完成后如果界面仍是旧版本：在插件页把本 bundle 关闭再开启（会热替换 Client 模块），或重启 DSH。

## 升级与卸载

第三方插件目前没有原地升级。升级时先移除旧 bundle，再按新版本 spec 重新安装：

1. 插件页打开本 bundle，选择 **移除**。
2. 用 **添加插件** 安装 `@acomma/dsh-session-delete@<新版本>`。

命令行等价操作：

```powershell
dsh plugin --profile desktop remove @acomma/dsh-session-delete
dsh plugin --profile desktop add @acomma/dsh-session-delete@1.0.1
```

卸载只移除插件和它的依赖，**不会恢复**已经删除的会话或附件。

### 从旧的 `@local` 版本迁移

早期本地版本使用 `@local/dsh-session-delete`。改名后包名变了，旧 profile 里的 `link:` 记录不会自动跟着改，因此必须先移除旧 bundle，再按上面的方式安装新包。不要同时保留两个名字，否则会在菜单里出现重复项。

## 行为

- 菜单项通过 `ctx.contextMenus` 注册为 `target: 'session'`、`order: 700`、`afterContent: true` 的 action；内置「归档」是 order 600 的 footer action，因此「删除会话」紧排在归档之后。
- 菜单 action 由 `ctx.contextMenus` 统一渲染，确认框复用内置 ui-primitives（`Modal`、`Button`、`IconTrashOutlineRegular`），图标、间距、悬停、焦点圈与内置归档/删除对话框一致。
- 点击后弹出确认框，显示会话标题；确认后向 `POST api/session.delete` 发送请求。
- 会话 ID 按存储值**原样使用**，不 `trim`、不改大小写；文件系统目录通过与 JSONL 后端相同的 `encodeSegment` 规则构造，所以空格、中文、分隔符等合法 ID 都能定位。投影缓存只清理 storage-json 接受的 `[A-Za-z0-9_-]+` key。
- 确认框里有一个**默认勾选**的「同时删除附件」选项。取消勾选则一律保留附件；保持勾选时，Host 先读取待删除会话日志中的附件引用（`attachmentId`），再逐个核对所有**保留下来**的会话日志：只有不再被任何保留会话引用的附件对象才会被删除，仍被引用的保留。
- 删除前先做一次**树完整性预检**：在根会话所在 project 下，如果存在 catalog 无法命名的会话目录，存在 `origin: 'subagent'` 但 `parentSession` 不在 catalog 中、为空或父链成环的会话，或某个 subagent 的父链落在目标树内却没有被纳入删除树（例如中间会话缺少 `origin`），返回 `tree-incomplete` 并拒绝删除。否则 `list()` 跳过读不了 header 的子会话时，删除根会留下一个不能再单独删除（`subagent-session`）的孤儿子会话。
- 核对前还会把会话根目录下的会话目录与删除后的 `sessionPersistence.list()` 对一遍：出现 catalog 无法命名的会话目录（包括只有子目录、没有文件的目录），或同一个 id 落在两个项目目录下时，一律不做附件清理（`attachments.status = "unverified"`，`reason = "catalog"`），因为无法证明这些会话不引用目标对象。目录匹配会按平台规则折叠 Windows 大小写并在 macOS 上做 Unicode 归一化，避免把 DSH 后端可读的同一目录误判为未知目录。`list()` 会跳过当前 Build 读不了 header 的会话，这类目录正是靠这一步兜住。
- 删除目录前会为每个 id 解析目标目录：优先使用 snapshot 的 `location.path` 父目录（这是后端的权威路径）；没有 location 时才扫描项目目录。目录名必须等于 JSONL 的 `encodeSegment(id)`；每个目录真正 `rm` 前还会用 `sessionPersistence.stat(id)` 复核 materialized location 仍指向计划目录，防止 plan→rm 之间被替换。同一 id 出现多个目录，或扫描目录与 catalog location 不一致时，返回 `ambiguous` 并拒绝删除，不会只挑第一个。多个 location 造成的目标树重复 id 由上面的预检发现。
- 引用核对通过 `sessionPersistence` 的逻辑事件流读取（只有这条读取路径能正确解码压缩日志）；「读取待删会话 + 核对保留会话」共享 30 秒预算，超时或任何一个会话读不出来时一律不删。核对到某个幸存会话快照没有 `location` 且后端报告 pending（尚未 materialize）时，附件清理同样保留全部对象；backend 没有 JSONL 实现的 `hasPendingSession()` 时，会退回公开的 `stat()` 快照（没有 `location` 即 pending），探测失败或两者都不存在时同样按未知 pending 处理。对仍存活的幸存会话，持久化日志之外还会合并其 `snapshotEvents()` 内存快照，因此普通空白草稿不会单独阻止附件清理。附件根不可用时不再扫描待删日志，直接返回 `attachments.status = "unverified"`。
- 对**仍存活**的保留会话，除了持久化日志，还会合并其 `snapshotEvents()` 内存快照，避免漏掉 write-behind 缓冲中刚发布、尚未落盘的附件引用。对不在本进程 live、但已 materialize 的 current 幸存会话，读取日志前先做一次 write-lease 探测；另一个进程仍在写时保留全部附件（`reason = "writer"`）。
- 附件对象按 `objects`、`file-objects`、`files` 三个位置删除；每次清理还会移除 `attachments/v1/tmp` 中超过 7 天的暂存残留（窗口刻意放宽，因为通用文件没有大小上限，慢速大文件上传可能持续很久），数量记在 `attachments.staging` 并在成功摘要中显示。部分对象删不掉时返回 `attachments.status = "partial"` 与 `failed` 计数，对象留在磁盘上。`tmp` 和 projection-cache 目录同样做 `realpath`/符号链接检查。
- Host 侧先检查会话是否仍然存活：Agent 注册表、Session 内存存储、运行中的后台任务任一命中都会拒绝删除；此外会扫描所有 live Agent/Session 的 subagent 祖先链，覆盖未进入 catalog 的 pending 子会话（空/环父链按未知祖先处理），对已 materialize 的 tree 会话做一次 `open(id, 'write')` 短探测，并在清除 reminder 后询问 DSH 的 `workspace/session-activity` waterfall 以覆盖自定义 activity provider。同一 id 的并发删除会在 Host 进程内返回 `busy`；不同 id 的派生清理在进程内串行执行，避免共享附件被双方同时判定为“对方仍引用”而永久保留。根目录在删除前已被另一个进程删掉时返回 `not-found`，而不是误报 `partial`。后台任务只按 `owner === sessionId` 计入（与 DSH 归档准入一致，未归属任务不阻止删除）。拒绝结果带 `reason`：`agent`、`session`、`job`、`writer`，以及 waterfall 报告的 activity kind；客户端保留该 `reason`，因此 job 场景显示“先停止后台任务”而不是“重启 Harness”。查询失败会返回 `live-check-failed`，不会当作「没有任务」继续。
- 删除前会先移除目标树上的 schedule 提醒，再检查一次 live，然后才动日志。这样 reminder 不会在删除过程中激活会话；reminder 删除失败时返回 `schedule-failed`，日志保持不动。如果提醒已经删了一部分、后续 live 检查或目录删除才失败，结果会带 `schedules` 计数，客户端会明确提示“提醒已移除、不会恢复”；成功时摘要也会显示已移除提醒数。目录删除部分成功（例如子目录已删、根目录失败）时，`deleted` 中已删除的子会话仍会继续完成投影缓存、spill、附件和 workspace 状态清理，再返回 `partial`；客户端错误视图会显示这批已删子会话的附件/spill 清理摘要，同时提示根会话未删除。
- 只删除**冷会话**：删除会话根目录下的 `<项目>/<encodedSessionId>/` 整个日志目录；如果该会话有 `origin: 'subagent'` 的子会话，一并删除，其中任何一个仍然 live 都会阻止删除；fork 出来的会话是独立谱系，不会被连带删除。直接把一个 `origin: 'subagent'` 的子会话作为根 id 调用 API 会被拒绝（`subagent-session`），避免父 Session 的 subagent catalog 留下不可修复的悬空引用。子目录按深度优先删除、根目录最后删；**任一子目录删除失败后立即停止**，不会继续删除它的祖先，因此重试仍能沿父链到达失败节点。已经缺失的子目录按已删除处理。
- 删除绑定在该会话上的提醒（schedule）：只支持 0.2.2-rc.1 起的 `target` + `edit({ action: 'delete' })` API；`new_once` 预留目标也会处理，`new` 目标保留。无关的旧模型记录会被忽略；只有旧记录确实指向待删会话时才拒绝。
- 删除该会话的 `session_projcache/sessions/<safeId>.json` 派生缓存（以及 `.json.bak.*` 备份）。根目录优先取已挂载 `storage` hub 的 JSON backend `root`；无法确认根目录时跳过这项清理，不猜 `<DSH_HOME>/storages`。
- 删除该会话的本地 spill 目录 `<spillRoot>/session-<sha256(id)[0:12]>/`。默认 spill root 是进程级临时目录，因此还会检查同一个临时目录下其他**严格匹配 `dsh-spill-` 加 6 位字母数字**的 root 中的同名会话目录，并在 POSIX 上检查 root/祖先的所有权和权限；配置了稳定 root 时只清理该 root，但该 root 同样要通过所有权/权限检查，不信任时保留并报告 `unverified`。存在仍可能从该树派生的 fork/subagent，或幸存 subagent 的父链无法解析（含空链/环）时保留，避免破坏继承的 locator。远程 spill 后端不暴露 root 时交给其自身保留策略。
- 菜单 action 会通过 `ctx.remoteAccess.source('session', id, 'session/delete')` 门控；由于 exact route 只允许 owner，`session/delete` 也不是可授予的 Remote endpoint，非 owner 实际上始终看不到这一项。
- Client 字典覆盖 DSH 内置的 `zh` / `en`；如果 profile 额外安装了其他语言包，未覆盖的语言回退英文。
- 成功后向已连接的页面发出 `api-session/removed`，侧边栏行立刻消失（不依赖刷新页面）。

## 有意保留

- **共享附件**：附件按内容寻址且不可变，续聊、fork 和子会话可能共享同一个对象，因此不能按会话目录判断归属。
- **附件请求缓存**：`<DSH_HOME>/cache/attachments/request-images/`（部分版本写在 `<DSH_HOME>/attachments/v1/request-images/`）是按附件 ID 与目标尺寸派生的缓存，文件名是变体摘要，无法从附件 ID 反推，因此不随附件清理。
- **删除失败的对象**：已经删掉的会话无法再提供它的引用，插件也没有第二次核对的入口；`failed` 计数里的对象会留在磁盘上，需要时按上面的路径规则手动清理。
- **写失败的暂存文件**：`attachments/v1/tmp` 里 7 天内的文件保留，只有在执行清理时才会顺带删除更早的残留。
- **有幸存后代的 spill**：如果删除的树仍有 subagent 后代，或任何仍存活的会话带 `isSeeded`（当前 DSH 普通 fork 只写 `isSeeded`、不写 `parentSession`），spill 目录整体保留，避免破坏后代继承的 locator；没有可疑幸存者时才删除。非本地 spill 后端、或日志快照之外被外部引用的 locator 不在核对范围内。
- **工作区成员记录**：删除成功后，插件通过公开的 `Workspace.detachSession` 从每个包含该 id 的 workspace 移除成员记录；`archivedSessionIds` / `pinnedSessionIds` 则通过公开的 `unarchiveSession` / `unpinSession` 清除。任一步失败只留下派生状态，不影响已完成的会话删除。插件不直接改 `storages/workspace.json`。
- **Workspace 内存 header 索引**：`WorkspaceRegistry.sessionPaths` 仍是 registry 持有的内存索引，外部删除日志后不会立即刷新；`detachSession` 只清 durable account，没有公开 API 清该 map。同 ID 在 registry 重新索引前重建的极端场景仍可能读到旧 cwd。
- **`snapshotEvents` 弃用 API**：存活会话的内存 write-behind 引用仍通过 DSH 已标记 deprecated 的 `Session.snapshotEvents()` 读取；当前没有等价的公开替代。
- **activity waterfall 的范围**：`workspace/session-activity` 只按目标树中的 id 查询；未进入 tree 的孤儿后代如果只由自定义 provider 报告活动，插件无法枚举该 id。本地 live Agent/Session 已由祖先链覆盖。
- **`storages/session_projcache.json` 中的旧记录**：legacy whole-unit 文件中的旧记录不会清理；当前 per-record `sessions/` 目录存在时 DSH 也不会重新 bootstrap 它。派生缓存，不是会话数据源。
- **自定义 storage 根**：projection cache 的根取自已挂载 `storage` hub 的 JSON backend；如果该 backend 不暴露可确认的 root，插件跳过 cache 清理，而不是按 `<DSH_HOME>/storages` 猜测。

## 安全边界

- 路由注册在 `connection.fetch` 的 `/api` 通道上，只有通过 Host/Origin 校验和浏览器会话认证的请求才能到达；exact route 只允许 owner peer。
- 会话 ID 必须是字符串，但不再限制字符集；它只通过 `encodeSegment` 进入路径。删除前再次确认目标恰好是 `<root>/<项目>/<encodedId>` 两级目录，且不是符号链接；同一 id 多目录或与 catalog location 不符时拒绝。删除目标必须是 root 的严格后代，且 realpath 后 basename 仍等于计划目录名，防止 mount/reparse 目标把一次删除重定向到容器根或另一个会话目录。
- 附件对象路径只由 `sha256:<64 位小写十六进制>` 摘要拼出；删除前用 `realpath` 确认父目录和 leaf 本身仍在附件根目录内，并限定在 `objects`、`file-objects`、`files` 三个子目录的精确 digest 路径；符号链接和类型不符的条目拒绝删除并计入 `failed`。`tmp`、projection cache 和 spill 目录也做精确父目录/符号链接/包含检查，并在删除时使用已解析路径。
- 只有服务暴露已解析的文件系统根目录时才执行删除；没有 `root` 的非 JSONL/非本地后端返回 `unsupported`，不会退回默认目录误删。
- 附件清理是「宁可保留」策略：核对不完整（日志读不出来、超时、会话目录与 catalog 对不上、附件根不可用、存在待确认的 pending/存活快照）时保留全部附件并返回 `attachments.status = "unverified"`，但会话删除本身仍然成功。
- 本地单用户环境下仍有 `realpath` 校验与 `rm` 之间的父目录交换窗口；插件已改为尽量删除解析后的路径，并拒绝链接/类型不符的条目，但无法在 Node 的路径 API 上做到完全 fd-relative 的原子性。能写 DSH_HOME 的本地攻击者本身已具备直接删除能力。
- Host 半侧不发起网络请求，没有运行时依赖，也没有 `install`/`postinstall` 脚本；Client 半侧只向本机已认证的 `/api/session.delete` 发请求，并在显示菜单项前用 remoteAccess 资源快照做门控。

## 存储位置

会话根目录优先取 JSONL backend 构造时已解析的 `root`，没有时才退回公开的 `sessionPersistence.config.root`；profile 重定位后端时它仍是准确的，两者都没有时插件返回 `unsupported`，不退回到某个默认目录。附件仓库取已挂载的 `attachments` 服务暴露的 `root`，因此 profile 给 attachment-local 配的 `dshHome` 也会自动生效；没有 `root` 时不做附件清理并返回 `unverified`，同样不会退回默认目录。spill 取本地 `spillStore.root`；默认进程级 root 会额外扫描同一父目录下严格匹配 `dsh-spill-` 加 6 位字母数字的兄弟目录，配置了 `config.root` 时只清理配置 root。派生投影缓存按已挂载 `storage` hub 的 JSON backend root 放在 `<storageRoot>/session_projcache/sessions`；没有 storage 服务或根不可确认时不做删除。

插件不再自行解析 `DSH_HOME` 或猜测默认存储目录；会话、附件、spill 和 projection-cache 根都来自已挂载服务暴露的已解析 root，无法确认时对应清理直接跳过。

## 兼容性

`engines.dsh` 声明为 `>=0.2.2-rc.1 <0.2.3-0`。从 0.2.2-rc.1 起 schedule 使用 `target` + `edit` 模型；旧的 `sessionId`/`delete` 模型不再支持。上界特意收窄到 `<0.2.3-0`：插件依赖 JSONL 的会话目录编码、附件对象布局、spill 目录命名和 projection-cache 路径，这些都是当前 0.2.2 的实现细节，不能假设整个 0.2.x 都不变。DSH 检查版本时会包含预发布版本，所以 0.2.3 的 rc 也不会被误放进来。

如果 DSH 升级后插件被禁用，先查看是否超出了这个范围。不要在公开分发中建议用户用版本豁免绕过检查；那会让插件在未验证的 Host API 上运行，而这是一个会删除文件的插件。

## 测试

```powershell
npm test
```

共 104 项（Host 92 + Client 12；Windows 上 2 项 POSIX 用例跳过），覆盖：附件引用计数与 fail-closed（不可读、超时、catalog 缺项、重复目录、编码目录、pending 幸存会话（含无 pending 探测 backend）、存活会话内存事件、幸存 migration-required 写租约不可探测、目录型 artifact、附件根不可用）、分页读取、非推进/跳读读取、深度优先删除与失败祖先保留、子树已删后根失败的部分清理、中间子会话失败时更深子会话的清理、超深 subagent 链、缺失中间父会话、无父链/成环 subagent、无 `origin` 的中间 subagent、树完整性预检、migration-required tree 写租约探测、链接目录与拒绝删除、目录名与编码 id 不符、materialized location 复核、暂存清理、只读对象删除、projection cache（默认根、storage backend 根、链接目录、无 storage 服务）、存储根解析（backend `root`/`config.root`/`attachments.root`/缺失根）、二次/三次 live 检查、activity waterfall、跨进程写租约探测、pending 子会话祖先检查、并发 `busy`、根目录已被其他进程删除时的 `not-found`、schedule API（含旧模型拒绝、部分删除副作用、无 `total` 分页）、提醒删除失败、spill 清理（普通 fork、旧私有 root、精确 root 形状、POSIX 信任检查、配置 root 信任、未知父链、空父链、配置 root）、workspace 成员/归档/置顶清理、subagent 根拒绝、非 ASCII/带空格/分隔符/~ ID、Windows 大小写目录、行移除广播，以及客户端的 job/writer/busy/list-failed 错误映射、fork 文案、提醒副作用提示（成功与失败）、partial 附件/spill 摘要、响应体超时和 remoteAccess 门控。

## 已知限制

- 安装或更新后，若界面仍是旧版本：在 Plugin Manager 里关闭再开启本 bundle（会热替换 Client 模块），或重启 DSH。
- 打开过的会话会被 Host 预热一个 Agent 并持有日志写句柄；DSH 没有释放单个 Agent 的 API，只能重启 Harness 后再删除，刷新页面无效。
- 清理附件（默认勾选）且会话较多时，Host 需要顺序读取每个保留会话的完整事件流来核对引用；对仍存活的保留会话还要合并内存快照，删除耗时明显增加，客户端超时相应放宽到 180 秒。
- 当前 Build 无法读取的会话不会出现在 `sessionPersistence.list()` 里。根会话所在 project 下出现这种目录时，删除会以 `tree-incomplete` 拒绝，避免留下孤儿子会话；其他 project 的未知目录只让附件/spill 清理返回 `unverified`，不影响根删除。
- **未发送的草稿附件**不写入任何会话日志：如果它的字节恰好与待删会话引用的对象相同（内容寻址会去重），该对象会被当成无人引用而删除，草稿里的图片随之失效。概率极低，但无法在 Host 侧核对。
- 引用核对基于删除时刻的日志快照：如果另一个会话同时上传了**相同字节**（内容寻址会去重成同一个对象）并写入引用，极小概率下该对象会被删除。
- **跨进程写者/冷写句柄**：DSH 的 JSONL 写租约是跨进程的。插件会对已 materialize 的 tree 会话做一次 `open(id, 'write')` 短探测：另一个进程持有写句柄时返回 `live` / `reason = "writer"`。`migration-required` 的 tree 日志也允许探测；写打开会先发布 migration，随后目录被删除，若删除失败则留下已迁移但完整的会话。成功探测只缩小竞争窗口，不能在探测与 `rm` 之间提供原子互斥；最稳妥的长期方案仍是上游提供 `sessionPersistence` 删除 API。
- **另一个进程中的幸存 live 会话**：附件核对会先对非本进程 live、已 materialize 的幸存会话做 write-lease 探测；`current` 探测忙时保留全部附件（`reason = "writer"`）。幸存会话的 `migration-required`/未知格式不做写打开（避免为一次核对发布 migration），直接保留全部附件（同样 `reason = "writer"`）；pending（本进程不可见）也无法探测，仍需上游提供跨进程删除/引用核对 API。
- **客户端超时/断开不会回滚**：删除一旦开始在 Host 上执行就会继续到结束；页面超时后应刷新确认，而不是立即重试。
- spill 的幸存判断对 subagent 走 `parentSession` 链；当前普通 fork 只写 `isSeeded`，所以插件保守地对任何存活 `isSeeded` 会话保留 spill，可能留下本可清理的文件。父链无法解析（缺失、为空或成环）时也按“未知祖先”保留。如果某个 locator 被外部复制到无关会话，插件仍无法追踪。
- 默认 spill root 的旧兄弟目录只在同一个父目录下发现，要求目录名严格匹配 `dsh-spill-` 加 6 位字母数字，并在 POSIX 上检查 root 归当前用户所有、group/other 不可写，祖先目录必须不可被 group/other 写或带有 sticky 位；如果进程间改过 `TMPDIR`/`TEMP`，更早的 root 不在扫描范围内，交给 DSH 自己的保留策略。
- 终端 / CLI 等非 Web 组合没有 `connection` 服务，本插件在这些 profile 中保持不激活。

## 许可证

[MIT](LICENSE)
