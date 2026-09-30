# AWS 生产发布临时授权

生产发布使用 GitHub Actions OIDC 换取最长一小时的 AWS 角色凭证。仓库和本机不保存长期 AWS Access Key；本机的交互式 `aws login` 过期不影响此工作流。

## 资源边界

- CloudFormation：`deploy/aws/id-business-v2-github-release-oidc.yaml`，栈名 `id-business-v2-github-release-access`。
- 信任来源：仅 `wangchaozhuanyong/id-business-system` 的 `main` 分支工作流；使用 GitHub OIDC 中不可变的所有者 ID 和仓库 ID 匹配 `sub`。
- 权限：向专用 ECR 仓库推送不可变镜像、向指定 EC2 实例发送 SSM 命令、读取命令结果；实例角色只增加该仓库镜像的拉取权限。
- 不授予工作流 IAM 管理、数据库直接访问或其他 EC2 实例权限。

## 使用

先核实 `main` 的 Quality Gate 已通过、生产 `current/release-manifest.json` 中的 `commit`，并审查待应用的 migration。下列值必须是完整的 40 位 SHA：

```bash
gh workflow run production-release.yml --ref main \
  -f operation=verify_access \
  -f commit=<已通过-main-Quality-Gate-的-SHA> \
  -f expected_current=<当前生产-SHA>
```

权限验证成功后，同一工作流的 `operation=release` 才会构建镜像并发布。工作流要求目标 SHA 恰好等于当时的 `main` HEAD、对应的 push Quality Gate 成功，并且生产基线等于 `expected_current`。发布会先验证只读财务巡检、运行中的自动充值任务、镜像来源和 S3 备份，再应用只包含非破坏性 SQL 的新增 migration，按服务切换并复核健康和财务数据。失败时尝试恢复原有服务镜像；已应用的向前 migration 不自动逆转。

```bash
gh workflow run production-release.yml --ref main \
  -f operation=release \
  -f commit=<已通过-main-Quality-Gate-的-SHA> \
  -f expected_current=<当前生产-SHA>
```

发布后仍要核对 GitHub Actions 运行结果、服务器 `release-manifest.json` 的 SHA、公开健康接口和实际登录后的页面操作。工作流的健康检查不能替代人工浏览器验收。
