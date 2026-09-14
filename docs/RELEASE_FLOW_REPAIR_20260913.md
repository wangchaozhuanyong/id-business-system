# 代充管理系统发布流程整改

状态：代码、本地验证完成；未提交、推送、创建 PR、合并或部署。

基线：origin/main `27ef09783f373b384cafef5b4b24d46c37d4c9e6`。分支：`fix/release-dedup-20260913`。

现有 PR→main 证据复用有效：读取的 main 运行 34756278051 用时 17 秒，另两次分别 14、20 秒。本次保留这条机制。

修复文档和普通 V2 后台页面修改误选 full-quality 的问题。文档/CI 修改只执行控制检查；普通 V2 前端修改执行后台静态检查、后台测试、共享包和后台构建。后台构建包含 vue-tsc，不再额外重复类型检查。仅涉及代充界面时追加其浏览器验收。后端、共享依赖、数据库等不在白名单的修改保留原必要检查。

修改文件：`.github/workflows/quality.yml`、`scripts/ci-recharge-scope.mjs`、`scripts/ci-recharge-check.mjs`、`scripts/ci-recharge-scope.test.mjs`、`AGENTS.md`、`docs/V2_TASKS.md`、本文。

已执行：三个 CI 测试文件共 16/16 通过；修改文件 Prettier、ESLint、diff 检查通过；工作流 YAML、job 依赖及 38 个 shell 步骤语法通过。未启动业务全套、数据库验收或生产部署。

待完成：授权提交并推送后通过 PR 生效。当前 main 已移除旧生产发布脚本；本次没有恢复历史发布体系，不能把 CI 修复等同于生产发布验证。原工作区的 Python 缓存保留。
