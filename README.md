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
@acomma/dsh-session-delete@1.0.0
```

也可以在完全退出 DSH Desktop 后使用命令行：

```powershell
dsh plugin --profile desktop add @acomma/dsh-session-delete@1.0.0
```

Web profile 把 `--profile desktop` 换成 `--profile web`。Desktop 的 profile 由应用持有，应用运行期间请优先使用插件页。

### 从 GitHub 安装

在 **添加插件** 中输入：

```text
github:acomma/dsh-session-delete#v1.0.0
```

请保留 `#v1.0.0`（或具体的 commit）。不带 ref 会跟踪仓库 HEAD，同一份配置在不同时间可能装到不同代码。GitHub 直连在部分网络下较慢，必要时优先使用 npm 或压缩包。

### 从压缩包安装

从 GitHub Release 下载 `acomma-dsh-session-delete-1.0.0.tgz`，在 **添加插件** 中输入它的绝对路径，或输入以 `.tgz` 结尾的 HTTPS 地址：

```text
<压缩包所在目录>/acomma-dsh-session-delete-1.0.0.tgz
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
- 核对前还会把会话根目录下的会话目录与删除后的 `sessionPersistence.list()` 对一遍：出现 catalog 无法命名的会话目录（包括只有子目录、没有文件的目录），或同一个 id 落在两个项目目录下时，一律不做附件清理（`attachments.status = "unverified"`，`reason = "catalog"`），因为无法证明这些会话不引用目标对象。`list()` 会跳过当前 Build 读不了 header 的会话，这类目录正是靠这一步兜住。
- 删除目录前会为每个 id 解析目标目录：优先使用 snapshot 的 `location.path` 父目录（这是后端的权威路径）；没有 location 时才扫描项目目录。同一 id 出现多个目录，或扫描目录与 catalog location 不一致时，返回 `ambiguous` 并拒绝删除，不会只挑第一个。
- 引用核对通过 `sessionPersistence` 的逻辑事件流读取（只有这条读取路径能正确解码压缩日志）；「读取待删会话 + 核对保留会话」共享 30 秒预算，超时或任何一个会话读不出来时一律不删。如果某个幸存的 live 会话日志仍处于 pending（尚未 materialize），其内存引用无法读取，附件清理同样保留全部对象；backend 没有 JSONL 实现的 `hasPendingSession()` 时，会退回公开的 `stat()` 快照（没有 `location` 即 pending），探测失败也按未知处理。
- 对**仍存活**的保留会话，除了持久化日志，还会合并其 `snapshotEvents()` 内存快照，避免漏掉 write-behind 缓冲中刚发布、尚未落盘的附件引用。
- 附件对象按 `objects`、`file-objects`、`files` 三个位置删除；每次清理还会移除 `attachments/v1/tmp` 中超过 7 天的暂存残留（窗口刻意放宽，因为通用文件没有大小上限，慢速大文件上传可能持续很久），数量记在 `attachments.staging` 并在成功摘要中显示。部分对象删不掉时返回 `attachments.status = "partial"` 与 `failed` 计数，对象留在磁盘上。`tmp` 和 projection-cache 目录同样做 `realpath`/符号链接检查。
- Host 侧先检查会话是否仍然存活：Agent 注册表、Session 内存存储、运行中的后台任务任一命中都会拒绝删除。后台任务只按 `owner === sessionId` 计入（与 DSH 归档准入一致，未归属任务不阻止删除）。拒绝结果带 `reason`：`agent`（会话已被 Host 激活）、`session`（会话仍在内存中）、`job`（有运行中的后台任务）；客户端保留该 `reason`，因此 job 场景显示“先停止后台任务”而不是“重启 Harness”。查询失败会返回 `live-check-failed`，不会当作「没有任务」继续。
- 删除前会先移除目标树上的 schedule 提醒，再检查一次 live，然后才动日志。这样 reminder 不会在删除过程中激活会话；reminder 删除失败时返回 `schedule-failed`，日志保持不动。如果提醒已经删了一部分、后续 live 检查或目录删除才失败，结果会带 `schedules` 计数，客户端会明确提示“提醒已移除、不会恢复”。
- 只删除**冷会话**：删除会话根目录下的 `<项目>/<encodedSessionId>/` 整个日志目录；如果该会话有 `origin: 'subagent'` 的子会话，一并删除，其中任何一个仍然 live 都会阻止删除；fork 出来的会话是独立谱系，不会被连带删除。直接把一个 `origin: 'subagent'` 的子会话作为根 id 调用 API 会被拒绝（`subagent-session`），避免父 Session 的 subagent catalog 留下不可修复的悬空引用。子目录先删、根目录最后删：子目录失败时根目录保留，重试仍可继续；已经缺失的子目录按已删除处理。
- 删除绑定在该会话上的提醒（schedule）：只支持 0.2.2-rc.1 起的 `target` + `edit({ action: 'delete' })` API；`new_once` 预留目标也会处理，`new` 目标保留。无关的旧模型记录会被忽略；只有旧记录确实指向待删会话时才拒绝。
- 删除该会话的 `session_projcache/sessions/<safeId>.json` 派生缓存（以及 `.json.bak.*` 备份）；无法确认 storage 根目录布局时不做删除。
- 删除该会话的本地 spill 目录 `<spillRoot>/session-<sha256(id)[0:12]>/`。默认 spill root 是进程级临时目录，因此还会检查同一个临时目录下其他 `dsh-spill-*` root 中的同名会话目录；配置了稳定 root 时只清理该 root。存在仍可能从该树派生的 fork/subagent 时保留，避免破坏继承的 locator。远程 spill 后端不暴露 root 时交给其自身保留策略。
- 菜单 action 会通过 `ctx.remoteAccess.source('session', id, 'session/delete')` 门控；owner 总是可见，非 owner 没有对应 grant 时不显示，避免点击后才收到 403。
- Client 字典覆盖 DSH 内置的 `zh` / `en`；如果 profile 额外安装了其他语言包，未覆盖的语言回退英文。
- 成功后向已连接的页面发出 `api-session/removed`，侧边栏行立刻消失（不依赖刷新页面）。

## 有意保留

- **共享附件**：附件按内容寻址且不可变，续聊、fork 和子会话可能共享同一个对象，因此不能按会话目录判断归属。
- **附件请求缓存**：`<DSH_HOME>/cache/attachments/request-images/`（部分版本写在 `<DSH_HOME>/attachments/v1/request-images/`）是按附件 ID 与目标尺寸派生的缓存，文件名是变体摘要，无法从附件 ID 反推，因此不随附件清理。
- **删除失败的对象**：已经删掉的会话无法再提供它的引用，插件也没有第二次核对的入口；`failed` 计数里的对象会留在磁盘上，需要时按上面的路径规则手动清理。
- **写失败的暂存文件**：`attachments/v1/tmp` 里 7 天内的文件保留，只有在执行清理时才会顺带删除更早的残留。
- **有幸存后代的 spill**：如果删除的树仍有 subagent 后代，或任何仍存活的会话带 `isSeeded`（当前 DSH 普通 fork 只写 `isSeeded`、不写 `parentSession`），spill 目录整体保留，避免破坏后代继承的 locator；没有可疑幸存者时才删除。非本地 spill 后端、或日志快照之外被外部引用的 locator 不在核对范围内。
- **工作区成员记录**：`storages/workspace.json` 里的 `sessionIds` 由 Workspace registry 维护，它会在下次启动/下一次工作区变更时按「会话头是否存在」自行清理；本插件不直接改这个存储文件，避免与内存态不一致。`archivedSessionIds` / `pinnedSessionIds` 不会随 header 刷新自动清理，插件在删除成功后会通过公开的 `unarchiveSession` / `unpinSession` 尽力清除；失败只留下派生状态。
- **`storages/session_projcache.json` 中的旧记录**：派生缓存，不是会话数据源；本插件不清理这里的旧记录。
- **自定义 storage 根**：projection cache 固定按随附组合的 `<DSH_HOME>/storages/session_projcache/sessions` 清理；如果 profile 把 storage-json 根改到别处，缓存会保留。

## 安全边界

- 路由注册在 `connection.fetch` 的 `/api` 通道上，只有通过 Host/Origin 校验和浏览器会话认证的请求才能到达；exact route 只允许 owner peer。
- 会话 ID 必须是字符串，但不再限制字符集；它只通过 `encodeSegment` 进入路径。删除前再次确认目标恰好是 `<root>/<项目>/<encodedId>` 两级目录，且不是符号链接；同一 id 多目录或与 catalog location 不符时拒绝。
- 附件对象路径只由 `sha256:<64 位小写十六进制>` 摘要拼出；删除前用 `realpath` 确认父目录和 leaf 本身仍在附件根目录内，并限定在 `objects`、`file-objects`、`files` 三个子目录；符号链接和类型不符的条目拒绝删除并计入 `failed`。`tmp`、projection cache 和 spill 目录也做符号链接/包含检查，并在删除时使用已解析路径。
- 只有服务暴露已解析的文件系统根目录时才执行删除；没有 `root` 的非 JSONL/非本地后端返回 `unsupported`，不会退回默认目录误删。
- 附件清理是「宁可保留」策略：核对不完整（日志读不出来、超时、会话目录与 catalog 对不上、附件根不可用、存在待确认的 pending/存活快照）时保留全部附件并返回 `attachments.status = "unverified"`，但会话删除本身仍然成功。
- 本地单用户环境下仍有 `realpath` 校验与 `rm` 之间的父目录交换窗口；插件已改为尽量删除解析后的路径，并拒绝链接/类型不符的条目，但无法在 Node 的路径 API 上做到完全 fd-relative 的原子性。能写 DSH_HOME 的本地攻击者本身已具备直接删除能力。
- Host 半侧不发起网络请求，没有运行时依赖，也没有 `install`/`postinstall` 脚本；Client 半侧只向本机已认证的 `/api/session.delete` 发请求，并在显示菜单项前用 remoteAccess 资源快照做门控。

## 存储位置

会话根目录取 `sessionPersistence` 的解析结果：JSONL 后端暴露已解析的 `root`（profile 重定位后端时它仍是准确的），没有 `root` 时再取它的 `config.root`；两者都没有时插件返回 `unsupported`，不退回到某个默认目录。附件仓库取已挂载的 `attachments` 服务暴露的 `root`，因此 profile 给 attachment-local 配的 `dshHome` 也会自动生效；没有 `root` 时不做附件清理并返回 `unverified`，同样不会退回默认目录。spill 取本地 `spillStore.root`；默认进程级 root 会额外扫描 `tmpdir()/dsh-spill-*` 兄弟目录，配置了 `config.root` 时只清理配置 root。派生投影缓存按随附组合的 storage-domain 布局放在 `<DSH_HOME>/storages/session_projcache/sessions`。

`DSH_HOME` 的解析与 `dsh-home-paths` 一致：空或仅含空白视为未设置，支持 `~` 展开，并规范化为绝对路径；未设置时用 `~/.dsh`。

## 兼容性

`engines.dsh` 声明为 `>=0.2.2-rc.1 <0.2.3-0`。从 0.2.2-rc.1 起 schedule 使用 `target` + `edit` 模型；旧的 `sessionId`/`delete` 模型不再支持。上界特意收窄到 `<0.2.3-0`：插件依赖 JSONL 的会话目录编码、附件对象布局、spill 目录命名和 projection-cache 路径，这些都是当前 0.2.2 的实现细节，不能假设整个 0.2.x 都不变。DSH 检查版本时会包含预发布版本，所以 0.2.3 的 rc 也不会被误放进来。

如果 DSH 升级后插件被禁用，先查看是否超出了这个范围。不要在公开分发中建议用户用版本豁免绕过检查；那会让插件在未验证的 Host API 上运行，而这是一个会删除文件的插件。

## 测试

```powershell
npm test
```

共 71 项（Host 64 + Client 7），覆盖：附件引用计数与 fail-closed（不可读、超时、catalog 缺项、重复目录、编码目录、pending 幸存会话、存活会话内存事件、目录型 artifact）、分页读取、非推进/跳读读取、叶子优先删除顺序、链接目录与拒绝删除、暂存清理、只读对象删除、projection cache 与链接目录、存储根解析（backend `root`/`config.root`/`attachments.root`/缺失根）、二次/三次 live 检查、schedule API（含旧模型拒绝、部分删除副作用）、提醒删除失败、spill 清理（普通 fork、旧私有 root、配置 root）、workspace 归档/置顶清理、subagent 根拒绝、非 ASCII/带空格/分隔符/~ ID、行移除广播，以及客户端的 job/list-failed 错误映射、fork 文案、提醒副作用提示和 remoteAccess 门控。

## 已知限制

- 安装或更新后，若界面仍是旧版本：在 Plugin Manager 里关闭再开启本 bundle（会热替换 Client 模块），或重启 DSH。
- 打开过的会话会被 Host 预热一个 Agent 并持有日志写句柄；DSH 没有释放单个 Agent 的 API，只能重启 Harness 后再删除，刷新页面无效。
- 清理附件（默认勾选）且会话较多时，Host 需要顺序读取每个保留会话的完整事件流来核对引用；对仍存活的保留会话还要合并内存快照，删除耗时明显增加，客户端超时相应放宽到 180 秒。
- 当前 Build 无法读取的会话不会出现在 `sessionPersistence.list()` 里；现在这类目录会让附件清理直接放弃（`reason = "catalog"`），不再冒险删除。
- **未发送的草稿附件**不写入任何会话日志：如果它的字节恰好与待删会话引用的对象相同（内容寻址会去重），该对象会被当成无人引用而删除，草稿里的图片随之失效。概率极低，但无法在 Host 侧核对。
- 引用核对基于删除时刻的日志快照：如果另一个会话同时上传了**相同字节**（内容寻址会去重成同一个对象）并写入引用，极小概率下该对象会被删除。
- **跨进程写者/冷写句柄**：DSH 的 JSONL 写租约是跨进程的，但本插件只能检查本进程的 Agent/Session/job；另一个进程持有的写句柄，或当前进程内直接打开日志写句柄的服务，插件无法通过公共 API 检测。最稳妥的长期方案是上游提供 `sessionPersistence` 删除 API。
- **客户端超时/断开不会回滚**：删除一旦开始在 Host 上执行就会继续到结束；页面超时后应刷新确认，而不是立即重试。
- spill 的幸存判断对 subagent 走 `parentSession` 链；当前普通 fork 只写 `isSeeded`，所以插件保守地对任何存活 `isSeeded` 会话保留 spill，可能留下本可清理的文件。如果某个 locator 被外部复制到无关会话，插件仍无法追踪。
- 默认 spill root 的旧兄弟目录只在同一个父目录下发现；如果进程间改过 `TMPDIR`/`TEMP`，更早的 root 不在扫描范围内，交给 DSH 自己的保留策略。
- 终端 / CLI 等非 Web 组合没有 `connection` 服务，本插件在这些 profile 中保持不激活。

## 许可证

[MIT](LICENSE)
