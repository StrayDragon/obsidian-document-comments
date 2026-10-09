# 发布与迭代安装

本仓库通过 **GitHub Release + BRAT**（Obsidian 的 [Beta Reviewer's Auto-update Tool](https://github.com/TfTHacker/obsidian42-brat)）安装与更新，与 `.github/workflows/release.yml` 的现有自动化配合。

## 一次性：用 BRAT 首次安装

1. Obsidian 中先安装 BRAT 插件（社区插件搜索 "BRAT"）。
2. 命令面板执行：**BRAT: Add a beta plugin for testing**。
3. 仓库地址填：`StrayDragon/obsidian-document-comments`（或你本机的私仓对应 owner/repo）。
4. BRAT 会读取最新 Release 并安装。安装后插件出现在已安装社区插件列表里。

## 每次迭代（改代码 → 发布 → 更新）

1. **改代码**，并递增版本号（三处保持一致）：
   - `manifest.json` 的 `version`（如 `0.1.19`）
   - `versions.json` 增加 `"0.1.19": "1.7.2"`
   - `CHANGELOG.md` 增加 `## 0.1.19` 小节（发布时会自动作为 Release 说明）
2. **提交并推送**：
   ```bash
   git add -A
   git commit -m "xxx"
   git push origin main
   ```
3. **打标签并推送**（标签必须与 `manifest.json` 的 `version` **完全一致，无 `v` 前缀**；release.yml 会校验，不一致直接失败）：
   ```bash
   git tag 0.1.19
   git push origin 0.1.19
   ```
   GitHub Actions 会自动 `npm run build` 并创建 Release（资产含 `main.js` / `manifest.json` / `styles.css`）。
4. **在 Obsidian 里更新**：命令面板执行 **BRAT: Check for updates**（或重启 Obsidian 时 BRAT 自动检查）。BRAT 从 Release 资产下载，更新完成后按提示重启。

## 验证

- 发布后检查 <https://github.com/StrayDragon/obsidian-document-comments/releases> 是否有带 3 个资产的最新 Release。
- `gh release view 0.1.19 --repo <owner>/obsidian-document-comments` 可本地核验。

## 注意事项

- BRAT（≥ 1.1.0）直接从 **Release 资产**下载，依赖仓库根目录的 `manifest-beta.json`；无需创建它。
- `main.js` 是构建产物（已被 `.gitignore` 忽略），不要手工修改或提交。
- 如果 BRAT 频繁报 GitHub API 限流，可在 BRAT 主设置里填入一个 `public_repo` 权限的 personal access token。
- 若仓库是私有的，需要在 BRAT 里配置对应该仓库的 fine-grained token（Contents: Read-only）。
