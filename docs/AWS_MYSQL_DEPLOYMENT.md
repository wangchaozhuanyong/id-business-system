# AWS 东京 MySQL 部署

当前部署使用单台东京区 EC2，Docker Compose 同机运行 Caddy、管理端、NestJS API 和 MySQL 8.4。
MySQL 只绑定宿主机 `127.0.0.1`，安全组不得开放 3306；公网仅开放 80/443，SSH 仅允许管理员
当前公网 IP。

## 部署结构

- `docker-compose.aws-mysql.yml`：生产服务编排。
- `apps/api/Dockerfile.mysql`：使用 `prisma-mysql/schema.prisma` 构建 API。
- `deploy/caddy/Caddyfile.aws`：HTTPS 证书和同源反向代理。
- `.env.aws.production`：服务器私有配置，权限必须为 `600`，不得提交。
- `apps/api/prisma-mysql/migrations`：MySQL 独立迁移基线；原 PostgreSQL 迁移保持不变以便回退。

`COMPOSE_PROJECT_NAME` 上线后不得随发布目录变化，否则 Docker 会创建新的空数据库卷。现有环境升级时
必须继续使用首次部署时的项目名。

## 数据迁移

1. 先生成并验证最新加密 PostgreSQL 备份。
2. 将备份恢复到临时 PostgreSQL 17 容器，避免生产连接池中断长事务。
3. 通过 SSH 隧道连接 EC2 本机 MySQL：
   `ssh -N -L 13306:127.0.0.1:3306 ec2-user@服务器地址`。
4. 执行 `scripts/migrate-postgres-to-mysql.mjs`，只复制当前系统 schema 中存在的表。
5. 必须确认目标为空，并核对每张表和总行数后再启动 API。

## 启停和检查

```bash
docker compose --env-file .env.aws.production -f docker-compose.aws-mysql.yml up -d --build
docker compose --env-file .env.aws.production -f docker-compose.aws-mysql.yml ps
docker compose --env-file .env.aws.production -f docker-compose.aws-mysql.yml logs --tail=200 api
```

没有真实 `CURRENCY_API_KEY` 时，生产配置必须将自动采集和联网采集设为 `false`。现有收购价、
手工维护和计算逻辑仍可使用，配置真实 Key 后再单独开启自动采集。

服务器启用 `id-business-v2-mysql-backup.timer`，每天将事务一致的逻辑备份写到
`/opt/id-business-v2/backups/mysql`。EC2 磁盘已加密，但这些备份仍与服务器同盘；正式长期使用前应再增加
一个加密的跨机器备份目标。
