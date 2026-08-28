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
- 环境变量模板：`.env.aws.production.example`
- 备份脚本：`scripts/backup-aws-mysql.sh`
- 备份定时器：`deploy/systemd/id-business-v2-mysql-backup.*`

真实 `.env.aws.production` 只能存放在服务器发布目录，禁止提交密码、Token、加密密钥或数据库 URL。

## 3. 发布流程

1. 确认待发布 commit，不把未审核的工作区改动混入发布目录。
2. 在 `/opt/id-business-v2/releases/<release-id>` 创建新发布目录。
3. 复制上一版 `.env.aws.production`，不修改旧发布目录。
4. 检查编排并构建镜像：

```bash
docker compose --env-file .env.aws.production -f docker-compose.aws-mysql.yml config
docker compose --env-file .env.aws.production -f docker-compose.aws-mysql.yml build
```

5. 使用 Prisma MySQL migration 容器先进行向前迁移，再启动应用：

```bash
docker compose --env-file .env.aws.production -f docker-compose.aws-mysql.yml up -d --no-build
docker compose --env-file .env.aws.production -f docker-compose.aws-mysql.yml ps -a
```

6. 确认 `mysql`、`api`、`admin` 健康，`migrate` 退出码为 0，再原子更新
   `/opt/id-business-v2/current` 软链接。
7. 执行整站巡检：

```bash
BASE_URL=https://your-domain.example bash scripts/deploy-smoke.sh
```

巡检至少包括首页、静态资源 MIME、live/ready、登录、`auth/me`、核心业务只读接口、越权写入 403 和登出。

## 4. 数据库规则

- 生产 `DATABASE_URL` 必须是 `mysql://` 且目标为 Compose `mysql` 服务。
- 只允许通过 `apps/api/prisma-mysql/migrations` 向前变更结构。
- 禁止修改已应用 migration；新变更必须新增 migration。
- 不得使用旧数据库覆盖当前生产库。数据迁移必须先备份，导入全新空库，完成行数和外键校验后才切换。

## 5. 备份

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

## 6. 回滚

- 应用回滚：将 `current` 重新指向上一个已验证发布目录，然后启动该版 Compose。
- 数据库 migration 默认不逆向回滚。如果新应用不兼容旧结构，必须在发布前准备专用方案。
- 任何数据恢复先在隔离 MySQL 实例验证，不直接覆盖生产数据。
