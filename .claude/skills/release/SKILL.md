---
name: release
description: 一键发布 SGI 新版本：更新版本号与 CHANGELOG、运行本地验证、提交、打 tag、推送并跟踪 GitHub Actions 直到 Release 产出。当用户要求发版、发布新版本、打 release tag 时使用。
argument-hint: "<version> [说明]"
---

# 一键发布

把用户参数原样传给发布脚本，不要手动改版本号或 CHANGELOG：

```bash
npm run release -- $ARGUMENTS
```

## 脚本会自动完成

1. 预检：main 分支、工作区干净、与 origin/main 同步、tag 不冲突
2. 更新 `package.json`、`package-lock.json`、`CHANGELOG.md`
3. 运行 `type-check` / `test` / `build`
4. 提交 `chore: vX.Y.Z`、打 annotated tag
5. 推送 main 和 tag
6. 用 `gh` 跟踪 tag 对应的 CI 运行
7. 等待并核对 GitHub Release 产物

## 执行约定

- 预检失败立即停止，把具体原因转告用户。
- 本地验证与 CI 耗时较长，保持等待，不要重复启动发布。
- CI 失败时不要自动删 tag、不要 force push；向用户报告失败任务和脚本给出的回滚命令。
- 成功后汇报 Release URL 与产物清单。
- 用户只给版本号时，更新日志由上次 tag 以来的提交自动生成；额外文字作为发布说明。
- 只预览不发布：`npm run release -- 1.2.3 --dry-run`
- 网络不可用时仅可用 `--offline --dry-run` 预览；不要把 `--offline` 用于正式发布。
- 用户明确要求跳过本地验证时才加 `--skip-checks`。

## 前置条件

- 工作区干净、当前在 main、与 `origin/main` 同步
- `gh` 已登录（用于跟踪 CI 和校验 Release）
- 已安装依赖（存在 `node_modules`）
