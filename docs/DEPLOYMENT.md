# AWS 生产部署

## 1. 部署边界

生产环境只使用 AWS：

- EC2 运行 Caddy、Vue 管理端、NestJS API 和 MySQL 8.4。
- Docker Compose 负责服务编排和健康检查。
- EBS Docker volume 保存 MySQL 数据。
- 私有 S3 存储桶保存服务端加密的异地备份。
- IAM Role 只授予 EC2 上传和核验指定备份前缀的最小权限。

不再使用外部认证、Edge Function、外部数据库或第三方静态托管。

## 2. 生产文件

- 编排：`docker-compose.aws-mysql.yml`
- API 镜像：`apps/api/Dockerfile.mysql`
- 前端镜像：`apps/admin/Dockerfile`
- HTTPS 入口：`deploy/caddy/Caddyfile.aws`

API Dockerfile 提供两个独立目标：`runtime` 只保留生产依赖、Prisma Client 和编译产物，`migration`
保留 Prisma CLI 与 MySQL migration。生产 Compose 必须显式选择对应目标；两个容器均以非 root、
只读根文件系统、无额外 capabilities 的方式运行。生产基础镜像与 CI Actions 均固定到不可变 SHA，
升级时需同步更新版本标签、digest 和相关门禁测试。

- 环境变量模板：`.env.aws.production.example`
- 备份脚本：`scripts/backup-aws-mysql.sh`
- 备份定时器：`deploy/systemd/id-business-v2-mysql-backup.*`

真实 `.env.aws.production` 只能存放在服务器发布目录，禁止提交密码、Token、加密密钥或数据库 URL。

## 3. Git 发布流程

生产环境只认 `origin/main` 中已经合并的精确 commit，不设“线上最新分支”。固定流程如下：

1. 拉取远端并从最新 `origin/main` 创建 `codex/<scope>-release-<date>` 发布分支。
2. 在发布分支完成改动，提交前至少运行：

```bash
npm run check
npm run acceptance:v2-financial-integrity
npm run git:readiness
```

3. 推送发布分支并创建以 `main` 为目标的 PR；禁止直接推送或强制推送 `main`。
4. GitHub CI 全部通过并完成审查后合并 PR。
5. 重新拉取 `origin/main`，确认工作区干净，且本地 `HEAD`、`origin/main` 和待部署 SHA 完全一致。
6. 从该 SHA 导出代码并创建不可变发布目录；禁止把 `.git`、`.deploy`、本机环境文件或未跟踪文件上传到服务器。

正式顺序固定为：

```text
origin/main → 发布分支 → 本地完整检查 → commit → push → PR/CI → 合并 main
→ 部署合并后的精确 SHA → 备份/迁移/门禁 → 原子切换 → 发布后复核
```

紧急修复不得绕过该流程。生产部署过程必须持有 `/opt/id-business-v2/.deploy.lock`，发现其他部署、
Compose、迁移或同步进程时立即停止，避免两个版本同时操作生产环境。

## 4. 服务器发布流程

1. 确认待发布 commit 等于最新 `origin/main`，不把未审核的工作区改动混入发布目录。
2. 在 `/opt/id-business-v2/releases/<UTC>-<short-sha>` 创建新发布目录，并在整个部署期间持有部署锁。
3. 复制上一版 `.env.aws.production`，不修改旧发布目录。
4. 检查编排并构建镜像：

```bash
docker compose --env-file .env.aws.production -f docker-compose.aws-mysql.yml config
docker compose --env-file .env.aws.production -f docker-compose.aws-mysql.yml build
```

5. 更新容器前先触发一次生产备份，确认 S3 大小和 SHA-256 校验成功：

```bash
sudo systemctl start id-business-v2-mysql-backup.service
sudo systemctl show id-business-v2-mysql-backup.service --property=Result --value
```

`Result` 必须返回 `success`。备份失败时不得继续 migration。

6. 数据库固定使用四个独立身份：`id_business_migrator` 只执行 migration，`id_business_app`
   只运行 API，`id_business_audit` 只执行完整性巡检，`id_business_backup` 只生成备份。首次切换到
   独立账号或迁移账号密码轮换后，先用本机 root 连接可重复供应账号，再执行向前 migration；migration
   后必须再次供应权限，使新表得到精确的运行权限：

```bash
docker compose --env-file .env.aws.production -f docker-compose.aws-mysql.yml up -d mysql
npm run provision:v2-production-database-access:production
docker compose --env-file .env.aws.production -f docker-compose.aws-mysql.yml run --rm migrate
npm run provision:v2-production-database-access:production
```

`id_business_app` 不得拥有 DDL、GRANT OPTION、全库 DELETE、Prisma migration 写入或审计日志更新
权限。供应命令不得输出 root 密码、业务数据库 URL 或账号密码。

7. 首次部署或审计密码轮换后执行 `npm run provision:v2-data-integrity-auditor:production`，然后在
   更新应用容器前执行数据库身份及财务完整性阻断门禁：

```bash
npm run gate:v2-financial-integrity:production
```

必须得到数据库四身份 `ok: true`、38 项检查和 0 条违规。门禁只能使用 `.env.aws.production` 中的
本机门禁连接；脚本检测到运行账号 DDL、越界 DELETE、审计写权限或账号复用时会主动拒绝运行。

8. 门禁通过后更新应用容器，等待 `mysql`、`api`、`admin` 健康，并执行整站巡检：

```bash
docker compose --env-file .env.aws.production -f docker-compose.aws-mysql.yml up -d --no-build
docker compose --env-file .env.aws.production -f docker-compose.aws-mysql.yml ps -a
```

```bash
BASE_URL=https://your-domain.example bash scripts/deploy-smoke.sh
```

巡检至少包括首页、静态资源 MIME、live/ready、登录、`auth/me`、核心业务只读接口、越权写入 403 和登出。

9. 健康检查和巡检均通过后，原子更新 `/opt/id-business-v2/current` 软链接。
10. 原子切换后重复执行整站巡检和 38 项财务完整性门禁，并核验备份服务、自动备份定时器和
    每周恢复验证定时器均处于预期状态。任一检查失败，立即回切并重启上一已验证应用版本，同时保留现场日志。

## 5. 数据库规则

- 生产 `DATABASE_URL` 必须使用 `id_business_app` 且目标为 Compose `mysql` 服务；本机门禁使用同一
  账号的 `V2_RUNTIME_DATABASE_URL`。
- `MIGRATION_DATABASE_URL` 只能使用 `id_business_migrator`；API 容器不得接收该变量。
- 备份只能使用 `id_business_backup`，完整性巡检只能使用 `id_business_audit`。
- 只允许通过 `apps/api/prisma-mysql/migrations` 向前变更结构。
- 禁止修改已应用 migration；新变更必须新增 migration。
- 不得使用旧数据库覆盖当前生产库。数据迁移必须先备份，导入全新空库，完成行数和外键校验后才切换。

## 6. 备份

EC2 通过 systemd timer 调用：

```bash
sudo systemctl start id-business-v2-mysql-backup.service
sudo journalctl -u id-business-v2-mysql-backup.service -n 100 --no-pager
```

脚本使用 `mysqldump --single-transaction`，先在本机生成 gzip 文件并校验，再强制上传
S3，最后对比远端对象大小和 SHA-256。定时器每 30 分钟执行，本机默认最多保留 48 份且
总量不超过 1 GiB；S3 保留 90 天后自动过期。

每周恢复验证由 `id-business-v2-mysql-backup-verify.timer` 执行：

```bash
sudo systemctl start id-business-v2-mysql-backup-verify.service
sudo journalctl -u id-business-v2-mysql-backup-verify.service -n 100 --no-pager
```

该脚本从 S3 下载最新备份，在无宿主机端口的临时 MySQL 8.4 容器内完成恢复和核心表检查。
完整安装和验收流程见 `docs/V2_PRODUCTION_BACKUP.md`。

## 7. 回滚

- 应用回滚：将 `current` 重新指向上一个已验证发布目录，然后启动该版 Compose。
- 数据库 migration 默认不逆向回滚。如果新应用不兼容旧结构，必须在发布前准备专用方案。
- 任何数据恢复先在隔离 MySQL 实例验证，不直接覆盖生产数据。
