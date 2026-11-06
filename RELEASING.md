# 发布说明

面向维护者。最终用户请看 [README.md](README.md#安装)。

## 发布前检查

1. 确认 DSH 版本与 `package.json` 的 `engines.dsh` 一致：

   ```powershell
   dsh --version
   ```

   当前声明范围是 `>=0.2.2-rc.1 <0.2.3-0`。如果在新 DSH 上验证通过，再扩范围；不要未经测试就放宽。

2. 跑测试：

   ```powershell
   npm test
   ```

3. 检查打包内容：

   ```powershell
   npm pack --dry-run
   ```

   应包含 `index.js`、`client.js`、`cordis.patch.yml`、`locale/*.json`、`icon.svg`、`README.md`、`LICENSE`、`package.json`，不应包含 `test/`。

4. 在一次性 profile 中装打包产物并确认组合成功：

   ```powershell
   npm pack
   dsh plugin --profile release-smoke add (Resolve-Path .\acomma-dsh-session-delete-1.0.0.tgz)
   dsh --profile release-smoke --dump-config | Select-String 'session-delete'
   ```

   `--dump-config` 中应出现 `id: session-delete` 和 `name: '@acomma/dsh-session-delete'`。

5. 人工验证 Web UI：

   - 中英文下菜单项、确认框、图标、标题/描述都正常。
   - 在一个可丢弃的 profile 里删除一个带附件的冷会话，确认附件引用计数和 fail-closed 行为。
   - 确认删除 live 会话会被拒绝，且文件没有变化。

## 版本号

遵循 SemVer：

- **patch**：只改文案、样式或内部修复，行为兼容。
- **minor**：新增能力，兼容旧配置。
- **major**：删除/重命名配置项、改变删除语义、或需要新的 DSH API。

`engines.dsh` 变化通常至少是 minor；如果旧 DSH 上会加载失败，按 major 处理。

不要复用已经发布过的版本号。

## 发布到 npm

### 首次发布

```powershell
npm login
npm whoami        # 应为 acomma
npm publish --access public
```

`@acomma/dsh-session-delete` 是 scoped 包，需要 public access；`package.json` 已声明 `publishConfig.access: "public"`，命令里再加 `--access public` 只是显式确认。

确认 npm 页面和版本：

```powershell
npm view @acomma/dsh-session-delete version
npm view @acomma/dsh-session-delete dist.tarball
```

### 后续发布（推荐走 CI）

CI 使用 GitHub Actions 的 OIDC provenance，不需要在本机保存 npm token。仓库需要配置：

- Secret `NPM_TOKEN`：npm granular access token，拥有 `@acomma` scope 的写权限；不需要 2FA bypass。
- 仓库是公开的（provenance 需要）。
- workflow 已有 `id-token: write` 和 `contents: write` 权限。

流程：

```powershell
git tag v1.0.1
git push origin v1.0.1
```

`.github/workflows/release.yml` 会在 tag 上跑测试并执行：

```text
npm stage publish --provenance --access public
```

这会把版本放进 npm 的 staged 区，同时创建 GitHub Release 并附上 tarball。**npm 不会立即公开**，需要维护者在本机批准（会要求 2FA）：

```powershell
npm login
npm stage list @acomma/dsh-session-delete
npm stage view <stage-id>          # 可选，先检查版本和内容
npm stage approve <stage-id>
```

批准后验证：

```powershell
npm view @acomma/dsh-session-delete version
npm audit signatures
```

不想发布时用 `npm stage reject <stage-id>` 丢弃这次 stage。

> 账号或包启用 staged publishing 时，CI 里的 `npm publish` 也可能把版本 stage 住，但命令本身不会明确说明。直接使用 `npm stage publish` 更清楚，也符合 npm 推荐的新包发布流程。

### 预发布

先用 `next` tag 试：

```powershell
npm version 1.1.0-rc.1 --no-git-tag-version
npm publish --tag next --access public
```

用户安装 `@acomma/dsh-session-delete@next` 验证后再发正式版。正式版发布后把 `latest` 指过去。

## GitHub Release

1. 打 tag 并推送：

   ```powershell
   git tag v1.0.0
   git push origin v1.0.0
   ```

2. 在 GitHub Release 中附上 `npm pack` 生成的 `.tgz`，并写 SHA256：

   ```powershell
   Get-FileHash .\acomma-dsh-session-delete-1.0.0.tgz -Algorithm SHA256
   ```

3. Release notes 至少包含：支持的 DSH 版本、删除行为、是否默认清理附件、升级方式。

## 出错时

- **发错版本但还没人用**：72 小时内可以 `npm unpublish @acomma/dsh-session-delete@x.y.z`；超过 72 小时优先 `npm deprecate`。
- **行为有严重问题**：立即 `npm deprecate @acomma/dsh-session-delete@x.y.z "原因，请升级到 x.y.z+1"`，再发修复版。
- **不要**删除旧版本后复用同一个版本号；pnpm 缓存和 lockfile 会混乱。

## 安全

- npm 账号开启 2FA。
- 只给 CI 最小权限的 granular token；能用 trusted publishing 时优先用 OIDC。
- 保持零运行时依赖、零 install script。这既是供应链优势，也是 git/tgz 安装能直接工作的原因。
- 不要在插件里加入联网上报；删除类插件一旦有网络行为，用户很难审计。
