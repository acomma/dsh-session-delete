# 删除会话（Session Delete）

一个 DSH 插件：在 Web GUI 会话列表每一行的「…」菜单末尾添加 **删除会话**，把该会话的存储日志从磁盘永久删除。

> **不可撤销。** 删除会移除会话日志；默认还会清理仅被该会话引用的附件。被其他会话引用的附件会保留。安装或使用前请阅读[行为](#行为)与[安全边界](#安全边界)。

DSH 本身只提供「归档」，没有删除 API（`dsh-session-persistence-jsonl` 明确记录 *Nothing deletes session files*）。本插件补上这一项能力，并且把「不能删正在运行的会话」放在 Host 侧强制校验。

## 安装

要求：

- DSH `>=0.2.1-rc.5 <0.3.0-0`。包内 `engines.dsh` 声明了这个范围，安装和启动时会检查；不匹配时 DSH 会拒绝安装或禁用插件行。
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

- 菜单项位于 `sidebar.workspaces.session.menu.item`，排在内置的归档和复制 ID 之后。
- 菜单行与确认框直接复用内置 ui-primitives（`MenuItemButton`、`Modal`、`Button`、`IconTrashOutlineRegular`），图标、间距、悬停、焦点圈与内置归档/删除对话框一致。
- 点击后弹出确认框，显示会话标题；确认后向 `POST api/session.delete` 发送请求。
- 确认框里有一个**默认勾选**的「同时删除附件」选项。取消勾选则一律保留附件；保持勾选时，Host 先读取待删除会话日志中的附件引用（`attachmentId`），再逐个核对所有**保留下来**的会话日志：只有不再被任何保留会话引用的附件对象才会被删除，仍被引用的保留。
- 引用核对通过 `sessionPersistence` 的逻辑事件流读取（只有这条读取路径能正确解码压缩日志）；核对有 30 秒预算，超时或任何一个保留会话读不出来时一律不删。
- Host 侧先检查会话是否仍然存活：Agent 注册表、Session 内存存储、运行中的后台任务任一命中都会拒绝删除。拒绝结果带 `reason`：`agent`（会话已被 Host 激活）、`session`（会话仍在内存中）、`job`（有运行中的后台任务）。被拒绝的删除不会改动任何文件。
- 只删除**冷会话**：删除 `<DSH_HOME>/sessions/<项目>/<sessionId>/` 整个日志目录；如果该会话有 `origin: 'subagent'` 的子会话，一并递归删除，其中任何一个仍然 live 都会阻止删除；fork 出来的会话是独立谱系，不会被连带删除。
- 删除绑定在该会话上的提醒（schedule），避免删除后再次投递。
- 删除该会话的 `session_projcache/sessions/<id>.json` 派生缓存（以及 `.json.bak.*` 备份）。
- 成功后向已连接的页面发出 `api-session/removed`，侧边栏行立刻消失（不依赖刷新页面）。

## 有意保留

- **共享附件**：附件按内容寻址且不可变，续聊、fork 和子会话可能共享同一个对象，因此不能按会话目录判断归属。
- **附件请求缓存**：`<DSH_HOME>/cache/attachments/request-images/`（部分版本写在 `<DSH_HOME>/attachments/v1/request-images/`）是按附件 ID 与目标尺寸派生的缓存，文件名是变体摘要，无法从附件 ID 反推，因此不随附件清理。
- **工作区成员记录**：`storages/workspace.json` 里的 `sessionIds` 由 Workspace registry 维护，它会在下次启动/下一次工作区变更时按「会话头是否存在」自行清理；本插件不直接改这个存储文件，避免与内存态不一致。
- **`storages/session_projcache.json` 中的旧记录**：派生缓存，不是会话数据源；本插件不清理这里的旧记录。

## 安全边界

- 路由注册在 `connection.fetch` 的 `/api` 通道上，只有通过 Host/Origin 校验和浏览器会话认证的请求才能到达。
- 会话 ID 必须匹配 `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`；删除前再次确认目标恰好是 `<root>/<项目>/<sessionId>` 两级目录，且不是符号链接。
- 附件对象路径只由 `sha256:<64 位小写十六进制>` 摘要拼出，限定在附件根目录的 `objects`、`file-objects`、`files` 三个子目录内；符号链接不删除。
- 附件清理是「宁可保留」策略：核对不完整（日志读不出来或超时）时保留全部附件并返回 `attachments.status = "unverified"`，但会话删除本身仍然成功。
- 插件运行时不发起网络请求，没有运行时依赖，也没有 `install`/`postinstall` 脚本。删除逻辑完全在本机文件系统上执行。

## 兼容性

`engines.dsh` 声明为 `>=0.2.1-rc.5 <0.3.0-0`。上界特意写成 `<0.3.0-0`：DSH 检查版本时会包含预发布版本，这样 0.3 的 rc 也不会被误放进来。

如果 DSH 升级后插件被禁用，先查看是否超出了这个范围。不要在公开分发中建议用户用版本豁免绕过检查；那会让插件在未验证的 Host API 上运行，而这是一个会删除文件的插件。

## 测试

```powershell
node --test test/session-delete.test.mjs
```

覆盖：附件引用计数与 fail-closed、live 拒绝、子会话连带删除、分页读取、行移除广播。

## 已知限制

- 安装或更新后，若界面仍是旧版本：在 Plugin Manager 里关闭再开启本 bundle（会热替换 Client 模块），或重启 DSH。
- 打开过的会话会被 Host 预热一个 Agent 并持有日志写句柄；DSH 没有释放单个 Agent 的 API，只能重启 Harness 后再删除，刷新页面无效。
- 清理附件（默认勾选）且会话较多时，Host 需要顺序读取每个保留会话的完整事件流来核对引用，删除耗时明显增加；客户端超时相应放宽到 180 秒。
- 引用核对以 `sessionPersistence.list()` 的会话目录为准；当前 Build 无法读取的会话（例如更新的日志格式）不会出现在目录里，也就不参与核对。
- 引用核对基于删除时刻的日志快照：如果另一个会话同时上传了**相同字节**（内容寻址会去重成同一个对象）并写入引用，极小概率下该对象会被删除。
- 终端 / CLI 等非 Web 组合没有 `connection` 服务，本插件在这些 profile 中保持不激活。

## 许可证

[MIT](LICENSE)
