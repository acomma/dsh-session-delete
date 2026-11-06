# Changelog

## Unreleased

修复删除正确性、兼容性、路径边界与报告问题，并按 `deepseek-harness` 源码对齐 Host API：

- 不再对 Session id 做 `trim`/字符集限制：id 原样使用，通过 JSONL 的 `encodeSegment` 进入路径；支持空格、非 ASCII 与长 id。投影缓存只处理 storage-json 接受的 key。
- 删除前先从 snapshot 的 `location.path` 直接解析权威目录（没有 location 才扫描项目目录）；同一 id 出现多个目录，或扫描目录与 catalog location 不一致时返回 `ambiguous` 并拒绝删除。
- 删除前增加树完整性预检：根会话所在 project 出现 catalog 无法命名的会话目录、出现 `parentSession` 不在 catalog 中的 subagent 会话，或某个 subagent 的父链落在目标树内却未被纳入删除树（例如中间会话缺少 `origin`）时返回 `tree-incomplete` 并拒绝删除，避免 `list()` 跳过不可读子会话后留下孤儿子会话。
- 子会话按深度优先删除、根会话最后删；任一子目录失败后立即停止，不再删除失败节点的祖先，重试仍可沿父链继续。已缺失的子目录按已删除处理。
- 移除 64 层 lineage 截断：subagent 链可以超过旧上限，删除与 spill 幸存判断不再静默截断。
- 根目录缺失仍返回 `directory-missing`；不再由非根目录的缺失误报 `partial`。
- 菜单从 `sidebar.workspaces.session.menu.item` 迁移到 `ctx.contextMenus`，使用 `order: 700` + `afterContent: true`，排在归档（order 600）之后。
- schedule 删除提前到日志删除之前，只支持 0.2.2-rc.1 起的 `target` + `edit({ action: 'delete' })`；`new_once` 目标也处理。删除失败返回 `schedule-failed`，日志不动。
- `engines.dsh` 下限提升到 `0.2.2-rc.1`，不再兼容旧的 `sessionId`/`delete` schedule 模型。
- reminder 删除使用 `expectedUpdatedAt`，冲突时重新读取；列表读不到或任务删不掉时 fail-closed，不再静默成功。
- live 检查支持异步作业查询；作业注册表查询失败返回 `live-check-failed`，不再当作「没有任务」。删除前、读取引用后、清除 reminder 后各检查一次；并扫描所有 live Agent/Session 的 subagent 祖先链，覆盖未进入 catalog 的 pending 子会话。清除 reminder 后还会询问 `workspace/session-activity` waterfall，覆盖自定义 activity provider。
- 对已 materialize 的 tree 会话做 `open(id, 'write')` 短探测；另一个进程持有写租约时返回 `live` / `reason = "writer"`。tree 的 `migration-required` 日志允许探测（可能先发布 migration，随后删除；删除失败则留下已迁移但完整的会话）。附件核对时对非本进程 live 的 current 幸存会话也做同样探测，忙时保留全部附件；幸存会话的 migration-required/未知格式不做写打开，直接保留全部附件（`reason = "writer"`）；幸存会话 pending 仍无法探测。
- 会话根优先取公开的 `config.root`；附件根取 `attachments.root`；spill 根取 `spillStore.root`，没有根的 backend 不会被猜成默认目录。
- 本地 spill 目录按 `session-<sha256(id)[0:12]>` 清理；兄弟 root 只匹配 `dsh-spill-` 加 6 位字母数字的精确形状，并在 POSIX 上检查 root/祖先的所有权与权限。存在仍从该树派生的 fork/subagent、父链无法解析的幸存 subagent，或存活 `isSeeded` 会话时整体保留，catalog 不完整时也保留。
- `tmp`、projection cache、session 目录和 spill 目录增加 strict-descendant/精确父目录/符号链接检查；`realpath` 的权限错误不再误报为「对象不存在」。
- 幸存的 live 会话日志仍未 materialize（pending）时，其内存中的附件引用无法读取，附件清理返回 `unverified` 并保留全部对象。
- 附件预算覆盖「读取待删会话」与「核对保留会话」两段，统一用 `reason = "timeout"` 报告超时；附件根不可用时跳过待删日志读取，直接返回 unavailable。
- 后端返回不推进或跳过 offset 的批次时立即失败，不再死循环/漏读。
- 删除前做树完整性预检（同 project 的未知会话目录、未解析父链的 subagent 会话）；删除后仍把会话目录与 `sessionPersistence.list()` 对账，出现 catalog 之外的目录、或同一 id 落在两个项目目录下时，放弃附件清理（`reason = "catalog"`）。
- 删除对象前用 `realpath` 确认父目录和 digest leaf 的精确位置；符号链接、类型不符与非「不存在」的 `lstat` 错误计入 `failed`。
- 部分对象删除失败时报告 `attachments.status = "partial"`；客户端摘要在全部保留时不再输出「没有需要清理的附件」，并显示 spill 删除失败/未核对。
- 每次清理顺带删除 `attachments/v1/tmp` 中超过 7 天的暂存残留（通用文件没有大小上限，窗口放宽）。
- 客户端超时覆盖响应体读取；body 读取期间 abort 返回 `timeout` 而不是 `http`/`network`。
- 客户端错误结果保留 Host 的 `reason`，运行中 job 显示“先停止后台任务”，write lease 被占用显示对应提示；补齐 `tree-incomplete`、`list-failed`、`subagent-session` 文案和 `dialog.remindersRemoved` 提示。
- 客户端在显示删除菜单项前用 `ctx.remoteAccess.source('session', id, 'session/delete')` 门控；由于 exact route 只允许 owner，该门控实际是 owner-only。
- 确认框文案改为“subagent 子会话”，明确普通 fork 不会被删除；成功摘要显示 `attachments.staging`。
- 删除后重新 `list()`/扫描 catalog，覆盖删除期间新建的 fork 或未知目录；普通 fork 只写 `isSeeded`，spill 清理对任何存活 `isSeeded` 会话保守保留。
- 默认 spill root 是进程级 `dsh-spill-*` 临时目录；清理时同时检查同一父目录下的历史 root，配置了 `config.root` 时只清理该 root。
- pending 探测在 backend 没有 `hasPendingSession()` 时退回公开的 `stat()` snapshot；存活会话的附件引用同时扫描其内存 `snapshotEvents()`，覆盖 write-behind 缓冲。
- catalog 在删除后检查，且把“只有子目录”的未知会话目录也视为 artifact；目录/附件/spill 删除尽量使用 `realpath` 后的路径。
- 拒绝把 `origin: 'subagent'` 的子会话作为删除根，避免父 Session 的 subagent catalog 悬空；无关的旧 schedule 记录不再阻止删除。
- 成功删除后通过 `Workspace.detachSession` 清除 workspace 成员记录，并尽力清除 `archivedSessionIds` / `pinnedSessionIds`。
- projection cache 根取已挂载 storage hub 的 JSON backend root；根不可确认时跳过 cache 清理。
- `engines.dsh` 收紧到 `>=0.2.2-rc.1 <0.2.3-0`，避免在未验证的 0.2.3 布局上删除文件。
- 测试从 53 项扩展到 87 项（Windows 上 1 项 POSIX 权限用例跳过），新增 Host 边界用例和独立 Client harness。

## 1.0.0

首个公开发布版本。

- 在 Web GUI 会话行的「…」菜单末尾新增「删除会话」。
- 删除冷会话的存储日志目录；有 subagent 子会话时递归删除，任一子会话 live 都会阻止删除。
- 默认清理仅被该会话引用的附件：删除前读取保留会话的附件引用，仍被引用的附件保留；核对不完整时保留全部附件。
- Host 侧拒绝删除已激活的会话、仍在内存中的会话，以及有运行中后台任务的会话。
- 删除绑定在该会话上的提醒和派生投影缓存。
- 删除成功后向已连接的页面广播 `api-session/removed`，侧边栏行立即消失。
- 声明 `engines.dsh` 兼容范围 `>=0.2.1-rc.5 <0.3.0-0`。
