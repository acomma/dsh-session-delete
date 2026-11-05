# Changelog

## Unreleased

修复删除正确性、兼容性、路径边界与报告问题，并按 `deepseek-harness` 源码对齐 Host API：

- 不再对 Session id 做 `trim`/字符集限制：id 原样使用，通过 JSONL 的 `encodeSegment` 进入路径；支持空格、非 ASCII 与长 id。投影缓存只处理 storage-json 接受的 key。
- 删除目录前先从 snapshot 的 `location.path` 解析权威目录；同一 id 出现多个目录，或扫描目录与 catalog location 不一致时返回 `ambiguous` 并拒绝删除，不再挑第一个。
- 子会话先删、根会话最后删；子目录失败时根目录保留，重试仍可继续。已缺失的子目录按已删除处理。
- 根目录缺失仍返回 `directory-missing`；不再由非根目录的缺失误报 `partial`。
- 菜单从 `sidebar.workspaces.session.menu.item` 迁移到 `ctx.contextMenus`，使用 `order: 700` + `afterContent: true`，排在归档（order 600）之后。
- schedule 删除提前到日志删除之前，只支持 0.2.2-rc.1 起的 `target` + `edit({ action: 'delete' })`；`new_once` 目标也处理。删除失败返回 `schedule-failed`，日志不动。
- `engines.dsh` 下限提升到 `0.2.2-rc.1`，不再兼容旧的 `sessionId`/`delete` schedule 模型。
- reminder 删除使用 `expectedUpdatedAt`，冲突时重新读取；列表读不到或任务删不掉时 fail-closed，不再静默成功。
- live 检查支持异步作业查询；作业注册表查询失败返回 `live-check-failed`，不再当作「没有任务」。删除前、读取引用后、清除 reminder 后各检查一次。
- 会话/附件/spill 根必须由挂载服务暴露；没有 `root` 的非 JSONL/非本地后端返回 `unsupported` 或 `attachments.status = "unverified"`，不再回退到默认目录。
- 本地 spill 目录按 `session-<sha256(id)[0:12]>` 清理；存在仍从该树派生的 fork/subagent 时整体保留，catalog 不完整时也保留。
- `tmp`、projection cache 和 spill 目录增加 `realpath`/符号链接包含检查；`realpath` 的权限错误不再误报为「对象不存在」。
- 幸存的 live 会话日志仍未 materialize（pending）时，其内存中的附件引用无法读取，附件清理返回 `unverified` 并保留全部对象。
- 附件预算覆盖「读取待删会话」与「核对保留会话」两段，统一用 `reason = "timeout"` 报告超时。
- 后端返回不推进或跳过 offset 的批次时立即失败，不再死循环/漏读。
- 删除前把会话目录与 `sessionPersistence.list()` 对账：出现 catalog 之外的目录、或同一 id 落在两个项目目录下时，放弃附件清理（`reason = "catalog"`）。`list()` 会跳过读不了 header 的会话，这类目录正由此兜住。
- 删除对象前用 `realpath` 确认父目录仍在附件仓库内；符号链接、类型不符与非「不存在」的 `lstat` 错误计入 `failed`。
- 部分对象删除失败时报告 `attachments.status = "partial"`；客户端摘要在全部保留时不再输出「没有需要清理的附件」，并显示 spill 删除失败/未核对。
- 每次清理顺带删除 `attachments/v1/tmp` 中超过 7 天的暂存残留（通用文件没有大小上限，窗口放宽）。
- 客户端超时覆盖响应体读取；请求中止返回 `timeout` 而不是 `network`。
- 测试从 16 项扩展到 53 项，覆盖上述边界。

## 1.0.0

首个公开发布版本。

- 在 Web GUI 会话行的「…」菜单末尾新增「删除会话」。
- 删除冷会话的存储日志目录；有 subagent 子会话时递归删除，任一子会话 live 都会阻止删除。
- 默认清理仅被该会话引用的附件：删除前读取保留会话的附件引用，仍被引用的附件保留；核对不完整时保留全部附件。
- Host 侧拒绝删除已激活的会话、仍在内存中的会话，以及有运行中后台任务的会话。
- 删除绑定在该会话上的提醒和派生投影缓存。
- 删除成功后向已连接的页面广播 `api-session/removed`，侧边栏行立即消失。
- 声明 `engines.dsh` 兼容范围 `>=0.2.1-rc.5 <0.3.0-0`。
