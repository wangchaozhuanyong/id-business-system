# AWS ECR 与 SSM 发布通道

## 目标

发布运行时不再下载和上传约 2 GB 的 Docker 归档。GitHub 标签 CI 将六个不可变镜像推送到
Amazon ECR，仅保留当前 commit 源码小包和发布清单。生产 EC2 通过 instance role 按 digest 拉取镜像，
GitHub Actions 通过 OIDC 和受限 SSM Document 启动部署。

## 一次性配置

1. 在 AWS IAM 中建立 GitHub Actions OIDC provider，Audience 为 `sts.amazonaws.com`。
2. 确认生产 EC2 已关联包含 `AmazonSSMManagedInstanceCore` 的 instance role，且 SSM Managed Node 在线。
3. 用 [`id-business-v2-ecr-release.yaml`](../deploy/aws/id-business-v2-ecr-release.yaml) 创建 CloudFormation stack。参数只填：
   GitHub `owner/repository`、OIDC provider ARN、生产 EC2 instance ID、现有 EC2 role 名称。
4. 将 stack outputs 配置为 GitHub Actions Variables：

| GitHub Variable                  | CloudFormation output / 值 |
| -------------------------------- | -------------------------- |
| `AWS_REGION`                     | `AwsRegion`                |
| `AWS_ECR_REPOSITORY_PREFIX`      | `EcrRepositoryPrefix`      |
| `AWS_RELEASE_BUILD_ROLE_ARN`     | `ReleaseBuildRoleArn`      |
| `AWS_PRODUCTION_DEPLOY_ROLE_ARN` | `ProductionDeployRoleArn`  |
| `AWS_PRODUCTION_RELEASE_BUCKET`  | `ReleaseBucketName`        |
| `AWS_PRODUCTION_READ_DOCUMENT`   | `ProductionReadDocument`   |
| `AWS_PRODUCTION_DEPLOY_DOCUMENT` | `ProductionDeployDocument` |
| `AWS_PRODUCTION_INSTANCE_ID`     | 生产 EC2 instance ID       |
| `PRODUCTION_BASE_URL`            | 生产 HTTPS 入口            |
| `PRODUCTION_COMPOSE_PROJECT`     | 现有 Compose 项目名        |

5. 给 GitHub `production` Environment 配置必需审批人。不配置 AWS access key、SSH private key、Cookie 或生产数据库凭据。

## 日常发布

1. 修复通过 PR 和 `main` Quality Gate。
2. 为当前 `origin/main` 完整 SHA 创建不可移动带说明 `v2-production-<UTC>` 标签。
3. 标签 Quality Gate 构建/复用 Buildx 缓存，测试镜像，推送 ECR commit 标签，记录六个 registry digest。
4. 在 `Deploy Production` 工作流输入该标签并完成 Environment 审批。
5. SSM 内部仍执行：部署锁 → 8 GiB 余量与保留预检 → S3 制品校验 → ECR digest 拉取
   → S3 备份校验 → 向前 migration → 38 项财务门禁 → 容器更新 → 切换前后冒烟 →
   `current` 原子切换 → 定时器验证。

## 故障边界

- ECR 六个 commit 标签不完整时不会混合构建，需先调查失败的标签 CI。
- SSM 只允许调用仓库内定义的只读和部署文档，不使用通用 `AWS-RunShellScript`。
- 应用异常仍只回切上一份已验证不可变镜像；数据库 migration 不自动回滚。
- 此文档和模板不会自动创建或修改 AWS 资源，必须单独评审并执行 stack 变更。
