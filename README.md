# 删除会话（Session Delete）

一个 DSH 插件，提供两个互补的永久删除入口：

1. **删除会话**：在 Web GUI 会话列表每一行的「…」菜单末尾添加一项，把该会话的存储日志从磁盘永久删除。
2. **删除工作区时一并删除会话**：在内置「删除工作区」确认框里追加选项，勾选后先清掉该工作区的会话日志，再让内置动作删除工作区注册。

DSH 本身只提供「归档」，没有删除 API（`dsh-session-persistence-jsonl` 明确记录 *Nothing deletes session files*）；内置的「删除工作区」也只删除注册记录，保留目录与会话日志（会话会散到「未分组」）。本插件补上这两项能力，并把「不能删正在运行的会话」放在 Host 侧强制校验。

## 行为

### 删除会话

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

### 删除工作区时一并删除会话

- 内置「删除工作区」确认框里会多出两项：**同时删除会话**（默认不勾选，提示里给出该工作区的会话数）和 **同时删除附件**（默认勾选，只有在上一项勾选时才可用）。不勾选时行为与内置完全一致。
- 勾选后，客户端先调用 `POST api/workspace.purge-sessions`（请求体 `{ workspaceId, deleteSessions: true, deleteAttachments }`）清理会话，成功后再调用内置的 `workspaces.delete` 删除工作区注册。**注册表的写入、行更新与弹窗关闭仍然由内置实现完成**，本插件不改 `storages/workspace.json`。
- 「该工作区的会话」取自注册记录里的 `sessionIds`（与侧边栏分组的同一份账户），每个会话再展开它自己拥有的 `origin: 'subagent'` 子会话；不在任何工作区里的会话不受影响。
- **运行中/已打开的会话会被跳过并保留**：Agent、内存 Session、运行中的后台任务任一命中，就整棵树跳过（不会出现「父会话没了、子会话还在跑」），其余会话照删。被跳过的会话留在「未分组」下，重启 Harness 后可以用「删除会话」单独清理。
- 附件清理沿用会话删除的同一套「只删无引用」规则；被跳过的 live 会话仍算作引用来源，因此它们引用的对象不会被删。任何核对不完整（日志读不出来或超时）都保留全部附件。
- 只要有一个会话目录删除失败，就返回 `code: "partial"` 并**不删除工作区**，弹窗里显示错误、可重试；目录本来就不存在（已被外部删除）只记为 `missing`，不算失败。
- 极端情况下（会话已清理成功、随后内置删除工作区自身失败），会话已删而工作区仍在；再点一次「删除工作区」即可，不会重复清理。
- 工作区里没有会话时，勾选后只是照常删除工作区。

## 有意保留

- **共享附件**：附件按内容寻址且不可变，续聊、fork 和子会话可能共享同一个对象，因此不能按会话目录判断归属。
- **附件请求缓存**：`<DSH_HOME>/cache/attachments/request-images/`（部分版本写在 `<DSH_HOME>/attachments/v1/request-images/`）是按附件 ID 与目标尺寸派生的缓存，文件名是变体摘要，无法从附件 ID 反推，因此不随附件清理。
- **工作区注册与成员记录**：`storages/workspace.json` 由 Workspace registry 维护；删除工作区仍走内置动作，删会话也不会去改 `sessionIds`。registry 会在下次启动/下一次工作区变更时按「会话头是否存在」自行清理，本插件不直接改这个存储文件，避免与内存态不一致。
- **`storages/session_projcache.json` 中的旧记录**：派生缓存，不是会话数据源；本插件不清理这里的旧记录。

## 安装与配置

本插件按本地 bundle 安装（Plugin Manager：`install_bundle`，目标为这个目录）。它没有 Config 项。

会话根目录按 DSH 的默认布局解析：

```text
<DSH_HOME>/sessions/<normalized-cwd>/<sessionId>/
```

附件清理按 `<DSH_HOME>/attachments/v1` 定位对象。若某个 profile 把 `dsh-session-persistence-jsonl` 的 `root` 配到了别处，删除会话会返回 `directory-missing`；若把 `dsh-attachment-local` 的 `dshHome` 配到了别处，附件清理只会把对象记为 `missing`。两者都不会误删其他路径。

工作区选项依赖 Workspace UI 与客户端 `workspaces` 服务；profile 里没有它们时本插件仍然提供「删除会话」，只是不出现工作区选项。

## 安全边界

- 两条路由都注册在 `connection.fetch` 的 `/api` 通道上，只有通过 Host/Origin 校验和浏览器会话认证的请求才能到达。
- 会话 ID 必须匹配 `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`；删除前再次确认目标恰好是 `<root>/<项目>/<sessionId>` 两级目录，且不是符号链接。
- 工作区 ID 必须是 registry 铸造的 UUID 形状；工作区选项的请求必须显式带 `deleteSessions: true`，否则路由拒绝（避免「少写一个字段就顺手删日志」）。
- 工作区清理只按注册记录里的 `sessionIds` 展开，不会按目录/路径前缀扫描，因此不会误删同一 cwd 下不在该工作区账户里的会话。
- 附件对象路径只由 `sha256:<64 位小写十六进制>` 摘要拼出，限定在附件根目录的 `objects`、`file-objects`、`files` 三个子目录内；符号链接不删除。
- 附件清理是「宁可保留」策略：核对不完整（日志读不出来或超时）时保留全部附件并返回 `attachments.status = "unverified"`，但会话删除本身仍然成功。
- 客户端通过内置弹窗的 `role="dialog"` 无障碍框架与 `workspace` 命名空间的 `delete.workspace` 文案定位该弹窗（不复制内置文本、不依赖 CSS 类名）；文案解析不出来或页面结构变化时选项不出现，删除工作区退化为内置行为。
- 两条路由之间互不牵连：工作区路由注册失败只会在日志里留一条 warning，单会话删除路由照常注册（客户端同理，级联安装与扫描异常只关闭级联本身）。

## 测试

```powershell
npm test
```

四个套件共 44 个用例：

- `test/session-delete.test.mjs`：会话删除的附件引用计数与 fail-closed、live 拒绝、子会话连带删除、分页读取、行移除广播。
- `test/workspace-purge.test.mjs`：工作区批量清理（子会话、live 跳过、`missing` 不算失败、未知/非法工作区、目录级兜底、附件共用与 unverified）。
- `test/workspace-option.test.mjs`：客户端选项的挂载/计数/关闭清理，以及「未勾选走内置、勾选先清理再走内置、清理失败不删工作区」。
- `test/routes.test.mjs`：两条路由的注册与 HTTP 契约（`deleteSessions: true` 强制、400/404/200、工作区路由注册失败时单会话路由仍在）。

`test/all.test.mjs` 在单进程里跑完所有套件（避免 `node --test` 逐文件起子进程在受限环境里失败）。

## 已知限制

- 安装或更新后，若界面仍是旧版本：在 Plugin Manager 里关闭再开启本 bundle（会热替换 Client 模块），或重启 DSH。
- 打开过的会话会被 Host 预热一个 Agent 并持有日志写句柄；DSH 没有释放单个 Agent 的 API，只能重启 Harness 后再删除，刷新页面无效。工作区选项同样受此限制，这正是它「跳过 live 会话」的原因。
- 清理附件（默认勾选）且会话较多时，Host 需要顺序读取每个保留会话的完整事件流来核对引用，删除耗时明显增加；客户端超时相应放宽到 180 秒（不清理附件时 60 秒）。
- 引用核对以 `sessionPersistence.list()` 的会话目录为准；当前 Build 无法读取的会话（例如更新的日志格式）不会出现在目录里，也就不参与核对。
- 引用核对基于删除时刻的日志快照：如果另一个会话同时上传了**相同字节**（内容寻址会去重成同一个对象）并写入引用，极小概率下该对象会被删除。
- 工作区选项依赖内置弹窗的 DOM 结构（`role="dialog"`、`aria-modal`、`aria-label`、正文容器）与 `workspace` 命名空间文案；DSH 升级若改动这些，选项会**安全消失**而不是误删（此时勾选框不存在，删除工作区保持内置行为）。这是本插件唯一依赖内置 UI 内部结构的点，已在测试里用最小 DOM 桩覆盖。
- 被跳过的 live 会话只在控制台留下一条 `session-delete: live sessions kept with the workspace`，界面上通过「会话仍在未分组」体现；没有额外的完成提示条。
- 终端 / CLI 等非 Web 组合没有 `connection` 服务，本插件在这些 profile 中保持不激活。
