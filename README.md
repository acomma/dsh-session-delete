# 删除会话（Session Delete）

一个 DSH 插件：在 Web GUI 会话列表每一行的「…」菜单末尾添加 **删除会话**，把该会话的存储日志从磁盘永久删除。

DSH 本身只提供「归档」，没有删除 API（`dsh-session-persistence-jsonl` 明确记录 *Nothing deletes session files*）。本插件补上这一项能力，并且把「不能删正在运行的会话」放在 Host 侧强制校验。

## 行为

- 菜单项位于 `sidebar.workspaces.session.menu.item`，排在内置的归档和复制 ID 之后。
- 行内图标与内置的「删除工作区」菜单项一致（`IconTrashOutlineRegular` 垃圾桶，14×14，错误色）；行的间距、内边距与悬停行为也对齐。
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

## 安装与配置

本插件按本地 bundle 安装（Plugin Manager：`install_bundle`，目标为这个目录）。它没有 Config 项。

会话根目录按 DSH 的默认布局解析：

```text
<DSH_HOME>/sessions/<normalized-cwd>/<sessionId>/
```

附件清理按 `<DSH_HOME>/attachments/v1` 定位对象。若某个 profile 把 `dsh-session-persistence-jsonl` 的 `root` 配到了别处，删除会话会返回 `directory-missing`；若把 `dsh-attachment-local` 的 `dshHome` 配到了别处，附件清理只会把对象记为 `missing`。两者都不会误删其他路径。

## 安全边界

- 路由注册在 `connection.fetch` 的 `/api` 通道上，只有通过 Host/Origin 校验和浏览器会话认证的请求才能到达。
- 会话 ID 必须匹配 `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`；删除前再次确认目标恰好是 `<root>/<项目>/<sessionId>` 两级目录，且不是符号链接。
- 附件对象路径只由 `sha256:<64 位小写十六进制>` 摘要拼出，限定在附件根目录的 `objects`、`file-objects`、`files` 三个子目录内；符号链接不删除。
- 附件清理是「宁可保留」策略：核对不完整（日志读不出来或超时）时保留全部附件并返回 `attachments.status = "unverified"`，但会话删除本身仍然成功。

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
