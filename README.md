# 删除会话（Session Delete）

一个 DSH 插件：在 Web GUI 会话列表每一行的「…」菜单末尾添加 **删除会话**，把该会话的存储日志从磁盘永久删除。

DSH 本身只提供「归档」，没有删除 API（`dsh-session-persistence-jsonl` 明确记录 *Nothing deletes session files*）。本插件补上这一项能力，并且把「不能删正在运行的会话」放在 Host 侧强制校验。

## 行为

- 菜单项位于 `sidebar.workspaces.session.menu.item`，排在内置的归档（400）和复制 ID（450）之后。
- 行内图标与内置的「删除工作区」菜单项相同：ui-primitives 的 `IconTrashOutlineRegular` 垃圾桶（16 单位画布、5 段 1px 描边），渲染为 14×14 并随行使用错误色；行的间距、内边距与悬停行为也按内置菜单项对齐。
- 点击后弹出确认框，显示会话标题；确认后向 `POST api/session.delete` 发送请求。
- 确认框里有一个**默认勾选**的「同时删除附件」选项。取消勾选则一律保留附件；保持勾选时，Host 先读取待删除会话日志中的附件引用（`attachmentId`），再逐个核对所有**保留下来**的会话日志：只有不再被任何保留会话引用的附件对象才会被删除，仍被引用的保留。
- 引用核对通过 `sessionPersistence` 的逻辑事件流读取（日志默认是 zstd 多帧压缩，只有这条读取路径能正确解码，也能看到尚未落盘的追加）；核对有 30 秒预算，超时或任何一个保留会话读不出来时一律不删。
- Host 侧先检查会话是否仍然存活：Agent 注册表、Session 内存存储、运行中的后台任务任一命中都会拒绝删除。拒绝结果带 `reason`：`agent`（会话已被 Host 激活）、`session`（会话仍在内存中）、`job`（有运行中的后台任务）。
- 只删除**冷会话**：删除 `<DSH_HOME>/sessions/<项目>/<sessionId>/` 整个日志目录；如果该会话有 `origin: 'subagent'` 的子会话，一并递归删除；fork 出来的会话是独立谱系，不会被连带删除。
- 删除绑定在该会话上的提醒（schedule），避免删除后再次投递。
- 删除该会话的 `session_projcache/sessions/<id>.json` 派生缓存。
- 成功后向已连接的页面发出 `api-session/removed`，侧边栏行立刻消失（不依赖刷新页面）。

## 删除后为什么会自动打开相邻会话

这是「行立刻消失」的代价，来自 DSH 客户端的行为：

- 客户端在自己维护的行消失时，会顺势打开列表里的下一个会话；
- 打开任意会话（`session/follow`）会让 Host 的 `SessionController.promote()` 在后台 `agents.resume()` 一个 Agent 并持有日志写句柄，于是那个相邻会话立刻变成 live、同样删不掉；
- 该 Agent 在 Host 进程内没有释放入口，只能等进程退出。

所以连续删除时会发现「删掉一个，下一个被打开也删不掉了」。处理办法：先删完想删的，再重启 Harness；重启后再打开任何会话之前删除剩下的目标。插件选择即时的行移除，是因为 Desktop 没有「刷新页面」入口，保留行会变成永远不消失的幽灵行。

## 无法删除时

DSH 没有「关闭会话」按钮，也没有释放单个 Agent 的 API。**一次点击就会让会话进入 live 状态**：

- `session/follow` 返回历史快照后，`SessionController.promote()` 会在后台对该会话执行 `agents.resume()`，预热一个 Agent。这个 Agent 持有会话日志的写入句柄，句柄的所有权属于 Session Controller 的 fiber；切换会话、关闭标签页、刷新页面都不会释放它，只有 Host 进程退出才会。
- 所以「历史会话只要点开过一次、没做任何操作」也会被判为 live。工作区的「新会话」草稿同理（`session.create` 直接创建 Agent）。
- 日志正被写入时不能删：删除后 Agent 的后续 append 会写到已删除的文件，或在下次写入时把目录重新建出来。
- 会话若还有运行中的后台任务（`reason: "job"`），需要先停止任务。
- 若该会话有 `origin: 'subagent'` 的子会话，其中任何一个还活着也会阻止删除。

唯一可靠的做法：**重启 Harness**（Desktop 退出重开；Web 端重启 `dsh web` 进程），重启后在打开任何会话之前删除它。刷新页面释放不了这类 Agent，因为它属于 Host 进程而不是页面。

被拒绝的删除不会改动任何文件。

## 有意保留

- **默认清理附件**：取消勾选时行为与之前完全一致，`<DSH_HOME>/attachments/v1` 下的对象一律不动。
- **共享附件**：附件按内容寻址且不可变，续聊、fork 和子会话可能共享同一个对象；因此勾选后也按「是否还有保留会话引用」决定，而不是按会话目录决定。
- **附件请求缓存**：`<DSH_HOME>/cache/attachments/request-images/`（部分版本写在 `<DSH_HOME>/attachments/v1/request-images/`）是按附件 ID 与目标尺寸派生的缓存，文件名是变体摘要，无法从附件 ID 反推，因此不随附件清理。
- **工作区成员记录**：`storages/workspace.json` 里的 `sessionIds` 由 Workspace registry 维护，它会在下次启动/下一次工作区变更时按「会话头是否存在」自行清理；本插件不直接改这个存储文件，避免与内存态不一致。
- **`storages/session_projcache.json` 中的旧记录**：这是派生缓存，不是会话数据源；本插件只删每会话的缓存文件。

## 安装与配置

本插件按本地 bundle 安装（Plugin Manager：`install_bundle`，目标为这个目录）。它没有 Config 项。

会话根目录按 DSH 的默认布局解析：

```text
<DSH_HOME>/sessions/<normalized-cwd>/<sessionId>/session.jsonl[.zstd]
```

若某个 profile 把 `dsh-session-persistence-jsonl` 的 `root` 配置到了别处，删除会明确返回 `directory-missing`，而不会误删其他路径。

附件清理按 `<DSH_HOME>/attachments/v1` 定位对象；如果 profile 把 `dsh-attachment-local` 的 `dshHome` 配到了别处，清理只会把这些对象记为 `missing`，不会误删别处文件。

## 安全边界

- 路由注册在 `connection.fetch` 的 `/api` 通道上，只有通过 Host/Origin 校验和浏览器会话认证的请求才能到达。
- 会话 ID 必须匹配 `[A-Za-z0-9][A-Za-z0-9._-]*`；删除前再次确认目标恰好是 `<root>/<项目>/<sessionId>` 两级目录，且不是符号链接。
- 附件对象路径只由 `sha256:<64 位小写十六进制>` 摘要拼出，限定在 `<DSH_HOME>/attachments/v1/{objects,file-objects,files}` 内；符号链接不删除。
- 附件清理是「宁可保留」策略：待删会话日志读不出来、任一保留会话日志读不出来、或核对超时，都会返回 `attachments.status = "unverified"` 并保留全部附件——会话删除本身仍然成功。
- 拒绝删除任何仍被 Agent 持有、仍在 Session 内存存储中、或仍有运行中后台任务的会话。

## 测试

```powershell
node --test test/session-delete.test.mjs
```

覆盖：未请求清理时不动附件、独占图片删除、跨会话共享保留、文件对象与别名目录、同摘要不同文件名、保留会话读取失败（fail-closed）、树内会话删除失败仍算引用、子会话连带删除、非布尔参数被忽略、对象缺失、分页读取到日志末尾、行移除广播与「未删成功的会话不广播」。

## 已知限制

- 安装或更新后，若界面仍是旧版本：在 Plugin Manager 里关闭再开启本 bundle（会热替换 Client 模块），或重启 DSH。Desktop 没有内置的「刷新页面」入口。
- 清理附件（默认勾选）且会话较多时，Host 需要顺序读取每个保留会话的完整事件流来核对引用，删除耗时明显增加；客户端超时相应放宽到 180 秒，Host 核对预算为 30 秒，超出则保留全部附件并报告 `unverified`。
- 引用核对以 `sessionPersistence.list()` 的会话目录为准；当前 Build 无法读取的会话（例如更新的日志格式）不会出现在目录里，也就不参与核对。
- 引用核对基于删除时刻的日志快照：如果另一个会话同时上传了**相同字节**（内容寻址会去重成同一个对象）并写入引用，极小概率下该对象会被删除。
- 行会立刻消失，但客户端随即可能打开相邻会话并把它预热成 live；那个会话要重启 Harness 后才能删除。工作区成员记录同样在下次启动/工作区变更时清理。
- 终端 / CLI 等非 Web 组合没有 `connection` 服务，本插件在这些 profile 中保持不激活。
