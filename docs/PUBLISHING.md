# 通过 GitHub Actions 发布到 npm

本仓库的 Gateway 和 Web Admin 是两个独立 npm 包：

- [dsh-plugin-feishu-gateway](https://www.npmjs.com/package/dsh-plugin-feishu-gateway)（`feishu-channel` Profile）
- [dsh-plugin-feishu-admin](https://www.npmjs.com/package/dsh-plugin-feishu-admin)（`web` Profile）

[自动发布工作流](../.github/workflows/npm-publish.yml)使用 npm Trusted Publishing（OIDC），**不需要 GitHub Secrets 中的 `NPM_TOKEN`**。只有发布一个 GitHub Release（`published` 事件）才会执行；`git push`、PR 和仅推送 Tag 都不会触发 npm 发布。

> `v0.1.0-beta.1` 已通过手动方式发布。新工作流不会重新发布它；首次验证自动发布时，应使用一个新版本，例如 `v0.1.0-beta.2`。

## 首次配置：npm Trusted Publishing

这是 npm 包所有者需要在 npm 网站完成的**一次性授权**，不是 GitHub 代码能代替的操作。分别打开两个包的 npm 页面 → **Settings → Trusted publishing → Add trusted publisher → GitHub Actions**。

**两个包都填写完全相同的配置：**

| 字段 | 内容 |
| --- | --- |
| Organization / user | `WeipengMO` |
| Repository | `dsh-plugin-feishu-gateway` |
| Workflow filename | `npm-publish.yml` |
| Environment | `npm-release` |
| Allowed actions | **允许 `npm publish`** |

工作流文件名只填 `npm-publish.yml`，**不要**填完整的 `.github/workflows/npm-publish.yml`。从 2026 年 9 月起，npm 新增的 Trusted Publisher 默认可能只允许 staged publishing；本工作流使用直接发布，因此必须勾选 **Allow npm publish**。无需授权 `npm dist-tag`，工作流不执行独立的 `npm dist-tag` 修改。

按 [npm 官方 Trusted Publishing 文档](https://docs.npmjs.com/trusted-publishers/) 的要求，**首次成功的 Trusted Publisher 发布需在配置后 2 天内完成**。建议准备好下一个版本以后再配置。

## GitHub 环境保护

进入仓库 **Settings → Environments → New environment**，创建精确命名为 `npm-release` 的环境：

1. 推荐启用 Required reviewers（如你的 GitHub 套餐和仓库设置支持），发布前需要人工批准。
2. 在 Deployment branches and tags 中限制发布来源为受控的 Release Tag（例如 `v*`），并通过 Repository rulesets 保护 Release Tag 创建权限。
3. 不需要添加 npm Token / npm 密钥。环境名称必须与 npm Trusted Publisher 的 Environment 完全匹配。

工作流的 `build` job 只有代码读取权限，负责测试和打包；`publish` job 才申请 `id-token: write`，且进入 `npm-release` 环境。工作流完成 npm 发布后，由单独的 `attach` job 将**同一份通过校验的安装包**上传到 GitHub Release。

## 每次发布新版本

### 1. 更新两个 package.json 的版本

在仓库根目录执行（以 `0.1.0-beta.2` 为例）：

```bash
git switch main
git pull --ff-only

npm pkg set version=0.1.0-beta.2
npm pkg set version=0.1.0-beta.2 --prefix web-admin

git add package.json web-admin/package.json
git commit -m "chore(release): v0.1.0-beta.2"
git push origin main
```

确保 Gateway 和 Admin 的 `version` **相同**，并且将要创建的 Git Tag 恰好等于 `v` 加版本号。等待 main 分支上的 CI 和 Security 通过再发布。

### 2. 在 GitHub 创建 Release

进入 [Releases → Draft a new release](https://github.com/WeipengMO/dsh-plugin-feishu-gateway/releases/new)：

- **Tag**：`v0.1.0-beta.2`（从最新 `main` 创建）
- **Release title**：`v0.1.0-beta.2`
- 勾选 **Set as a pre-release**
- 填写变更说明，点击 **Publish release**

创建 Draft 但未 Publish 不触发自动发布。**仅 `git push origin v0.1.0-beta.2` 不触发**。Release 标签必须指向当时最新的 `main` 提交，且两个 package.json 都是 `0.1.0-beta.2`。

### 3. 查看发布状态

打开 [GitHub Actions](https://github.com/WeipengMO/dsh-plugin-feishu-gateway/actions/workflows/npm-publish.yml)，查看 `Publish npm packages`：

1. `build`：校验版本与 main、运行代码测试、两包打包及 SHA256 检查
2. `publish`：通过 `npm-release` 环境审批，使用 OIDC 分别发布两个 npm 包
3. `attach`：把发布包、SHA256SUMS 和 manifest 上传到 GitHub Release

执行成功后可查询：

```bash
npm view dsh-plugin-feishu-gateway@0.1.0-beta.2 version
npm view dsh-plugin-feishu-admin@0.1.0-beta.2 version
npm view dsh-plugin-feishu-gateway dist-tags --json
npm view dsh-plugin-feishu-admin dist-tags --json
```

## 版本和 dist-tag 规则

| GitHub Release Tag | GitHub 类型 | npm dist-tag |
| --- | --- | --- |
| `v0.1.0-beta.2` | Pre-release | `beta` |
| `v0.1.0-rc.1` | Pre-release | `next` |
| `v0.1.0-alpha.1` | Pre-release | `alpha` |
| `v0.1.0` | 普通 Release | `latest` |

这避免把预发布版本误推到 `latest`。正式版 `latest` 只有在两个包都使用稳定 SemVer，且 GitHub Release 未勾选 pre-release 时才允许发布。

## 发布失败、重试和回滚

- `ENEEDAUTH`、`E403`：检查**两个** npm 包是否都绑定了 Trusted Publisher，workflow filename、环境名称、仓库拥有者和 Allow npm publish 是否正确；确保发布 Job 使用 GitHub-hosted runner，Node 24 和 npm ≥11.5.1。
- Tag 与版本不一致：修复代码、提交到 main，并**创建新的**版本 Tag/Release；不要强行修改已经发布的 npm 包。
- 两包不是原子发布。如果 Gateway 成功而 Admin 失败，可在同一 GitHub Action 中重新运行失败 Job。工作流会比较 npm 上已有版本的包 SHA1：文件完全相同则跳过，内容不同则停止，避免覆盖已发布的版本。
- 已发布到 npm 的 `name@version` 不能覆盖：修复后需发布新版本（如 `beta.3`），不要重写已发布版本。
- 回滚通常是让用户安装上一版；需要时可手动调整 npm dist-tag（本工作流**不授权** dist-tag 管理），但不能因此改变已经发布的 tarball。

推荐同时启用 npm 账户 2FA、GitHub branch/tag protection，并将 GitHub Actions 的 npm 发布权限限制在专用 `npm-release` 环境。更多安全要求见 [SECURITY.md](../SECURITY.md)。
