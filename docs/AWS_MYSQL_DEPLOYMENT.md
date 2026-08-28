# AWS 东京 MySQL 部署

目标部署使用单台东京区 EC2，Docker Compose 同机运行 Caddy、管理端、NestJS API 和 MySQL 8.4。
MySQL 只绑定宿主机 `127.0.0.1`，安全组不得开放 3306；公网仅开放 80/443，SSH 仅允许管理员
当前公网 IP。

## 部署结构

- `docker-compose.aws-mysql.yml`：生产服务编排。
- `apps/api/Dockerfile.mysql`：分别构建只含生产依赖与编译产物的 `runtime` 镜像，以及保留 Prisma CLI
  和迁移文件的 `migration` 镜像。
- `deploy/caddy/Caddyfile.aws`：HTTPS 证书和同源反向代理。
- `.env.aws.production`：服务器私有配置，权限必须为 `600`，不得提交。
- `apps/api/prisma-mysql/migrations`：MySQL 独立迁移基线；原 PostgreSQL 迁移保持不变以便回退。

`COMPOSE_PROJECT_NAME` 上线后不得随发布目录变化，否则 Docker 会创建新的空数据库卷。现有环境升级时
必须继续使用首次部署时的项目名。

公网请求固定经过 Caddy 和管理端 Nginx 后进入 API。Caddy 必须覆盖外部传入的
`X-Forwarded-For`，Nginx 只转发该单一值，禁止追加容器地址；API 只信任紧邻的 Nginx 一跳。
`api` 和 `admin` 服务不得映射公网端口，否则客户端可绕过可信代理边界并伪造来源 IP。

生产编排中的 Node、MySQL、Nginx 和 Caddy 基础镜像必须同时保留可读版本标签和不可变 digest；更新
版本时必须通过 PR、CI 和镜像验收同步更新 digest，禁止只改回浮动标签。API 和 migration 容器固定
使用非 root 用户、只读根文件系统、受限 `/tmp`、`no-new-privileges` 并删除全部 Linux capabilities。
API 运行镜像不得包含 TypeScript、Prisma CLI、业务源码或 migration；只有一次性 migration 镜像可保留
Prisma CLI 和 MySQL migration。

`.env.aws.production` 中还必须配置独立的只读审计连接：

```dotenv
V2_DATA_INTEGRITY_DATABASE_URL=mysql://id_business_audit:URL编码后的随机密码@127.0.0.1:3306/id_business_v2
```

该连接只供 EC2 本机发布门禁使用，不得改成业务账号，也不得授予写权限。

生产数据库另外固定区分迁移、运行和备份身份：

```dotenv
MYSQL_USER=id_business_migrator
MYSQL_BACKUP_USER=id_business_backup
MIGRATION_DATABASE_URL=mysql://id_business_migrator:URL编码后的随机密码@mysql:3306/id_business_v2
DATABASE_URL=mysql://id_business_app:URL编码后的随机密码@mysql:3306/id_business_v2
V2_RUNTIME_DATABASE_URL=mysql://id_business_app:URL编码后的相同随机密码@127.0.0.1:3306/id_business_v2
```

四个数据库身份和 root 必须使用互不相同的随机密码。API 不得接收 `MIGRATION_DATABASE_URL`、root、
审计或备份凭据。

## 数据迁移

1. 先生成并验证最新加密 PostgreSQL 备份。
2. 将备份恢复到临时 PostgreSQL 17 容器，避免生产连接池中断长事务。
3. 通过 SSH 隧道连接 EC2 本机 MySQL：
   `ssh -N -L 13306:127.0.0.1:3306 ec2-user@服务器地址`。
4. 执行 `scripts/migrate-postgres-to-mysql.mjs`，只复制当前系统 schema 中存在的表。
5. 必须确认目标为空，并核对每张表和总行数后再启动 API。

迁移脚本只在同一事务连接内设置 `@idv2_data_migration`，临时跳过会改写展示快照或校验业务流程的
`BEFORE/AFTER INSERT` 触发器；事务结束前会恢复会话状态。不可将该变量写入服务器全局配置。

## 启停和检查

```bash
docker compose --env-file .env.aws.production -f docker-compose.aws-mysql.yml up -d mysql
npm run provision:v2-production-database-access:production
docker compose --env-file .env.aws.production -f docker-compose.aws-mysql.yml run --rm migrate
npm run provision:v2-production-database-access:production
npm run provision:v2-data-integrity-auditor:production
npm run gate:v2-financial-integrity:production
docker compose --env-file .env.aws.production -f docker-compose.aws-mysql.yml up -d --build
docker compose --env-file .env.aws.production -f docker-compose.aws-mysql.yml ps
docker compose --env-file .env.aws.production -f docker-compose.aws-mysql.yml logs --tail=200 api
```

首次部署以及审计密码轮换后，在 migration 成功后执行：

```bash
npm run provision:v2-data-integrity-auditor:production
```

该命令只允许维护固定账号 `id_business_audit`，会先撤销其全部旧权限，再仅授予当前数据库的
`SELECT`、`SHOW VIEW`，以及安全触发器存在性函数的 `EXECUTE`。随后每次发布切换流量前执行：

```bash
npm run gate:v2-financial-integrity:production
```

门禁会先检查 AWS 单一云边界，再以只读账号在同一个可重复读快照中全量执行 38 项数据不变量检查。
任一检查非零、审计账号存在写权限、连接目标不是 MySQL 或检查执行失败，都必须阻断发布；禁止通过
修改审计 SQL、删除异常记录或改用 root 账号绕过。

`gate:v2-financial-integrity:production` 会先检查四个固定身份的实际 `SHOW GRANTS`。运行账号按现有表
逐表获得读取、业务写入权限，仅对代码中受控清理表授予 `DELETE`；`_prisma_migrations`、操作审计和
敏感访问日志不能由运行账号更新。新增 migration 创建表后必须重新运行账号供应命令，再执行门禁。

收购汇率使用 ExchangeRate-API 的免 Key 开放接口，每天北京时间 09:05 自动采集一次；生产配置使用
`CURRENCY_RATE_PROVIDER=exchange_rate_api`，无需申请或保存 `CURRENCY_API_KEY`。若供应商异常，可通过
`ID_BUSINESS_V2_EXCHANGE_RATE_NETWORK_ENABLED=false` 立即停用联网采集，现有收购价、手工维护和计算逻辑
仍可继续使用。

服务器启用 `id-business-v2-mysql-backup.timer`，固定使用 `id_business_backup` 每 30 分钟将事务一致的逻辑备份写到
`/opt/id-business-v2/backups/mysql`。`MYSQL_BACKUP_S3_BUCKET` 为强制配置，同一份备份必须通过实例 IAM
角色上传到私有 S3，强制 TLS 和 AES-256 服务端加密，并在上传后核对对象大小和 SHA-256。
本机默认最多保留 48 份且总量不超过 1 GiB；S3 当前保留 90 天并由生命周期自动过期。
`id-business-v2-mysql-backup-verify.timer` 每周从 S3 下载最新备份并恢复到临时 MySQL 8.4 容器。
详细配置和安装命令见 `docs/V2_PRODUCTION_BACKUP.md`。
