# ID 业务管理系统部署

## 1. 部署边界

生产运行只包含：

- `apps/admin` 管理端
- `apps/api` API
- PostgreSQL / Supabase PostgreSQL
- 汇率公开报价采集

部署配置不包含外部消息推送、旧业务 Worker、OCR、Redis 队列或对象存储服务。

## 2. 环境变量

从模板创建私密文件：

```bash
cp .env.production.example .env.production
```

填写真实值后检查：

```bash
PROD_ENV_FILE=.env.production npm run prod:env:check
```

不得提交 `.env`、`.env.production`、数据库凭据、Supabase 密钥或管理员密码。

## 3. 数据库

```bash
npm run prisma:generate
npm run prisma:migrate:deploy
npm run prisma:seed
```

全新数据库直接执行当前系统基线。已经承载当前系统的生产数据库不得重复执行基线；必须先完成结构
比对，再将基线标记为已应用。生产数据库中的无关历史表不属于代码发布范围，不得在发布脚本中自动
删除。

```bash
npx prisma migrate resolve \
  --schema apps/api/prisma/schema.prisma \
  --applied 20260729000000_current_system_baseline
```

标记基线前必须备份生产数据库，并确认当前 schema 所需表、字段、索引和约束均存在。

## 4. 本地 Docker

本地 `docker-compose.yml` 只启动 PostgreSQL：

```bash
docker compose up -d
```

应用分别启动：

```bash
npm run dev:api
npm run dev:admin
```

## 5. Docker Compose 生产参考

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.prod.yml \
  config

docker compose \
  --env-file .env.production \
  -f docker-compose.prod.yml \
  up -d --build
```

健康检查：

```bash
curl --fail https://your-api-domain.com/api/health/live
curl --fail https://your-api-domain.com/api/health/ready
```

## 6. Cloudflare / Supabase

Cloudflare 静态管理端与轻量 API 转发构建：

```bash
npm run build:cloudflare-free
npm run cloudflare:free:dry-run
```

Supabase Edge Function 构建：

```bash
npm run build:supabase-v2-api
```

发布前确认 Cloudflare、Supabase 项目和数据库都属于当前系统，且域名与
`CORS_ORIGIN`、`APP_PUBLIC_URL`、`VITE_API_BASE_URL` 一致。

## 7. 发布检查

```bash
npm run check:v2-isolation
npm run typecheck
npm run test
npm run build
npm run prisma:validate
npm run git:readiness
```

当前生产使用 Cloudflare 承载静态管理端，`/api/*` 仅做轻量同源转发；NestJS、
Prisma、认证和业务事务运行在 Supabase Edge Function。确认当前分支、提交、远端和目标
环境后，执行一次：

```bash
npm run deploy:production
```

Cloudflare 发布命令包含以下硬门禁：

- 当前分支必须为干净的 `main`，且 `HEAD` 与 `origin/main` 完全一致。
- GitHub `quality`、`production-images` 必须成功，`main` 必须启用 PR、管理员约束、线性历史、
  对话解决和禁止强推/删除的保护规则。
- Supabase project/function、Cloudflare account/Worker 和公开域名必须与仓库固定生产配置一致。
- 发布顺序固定为：构建并发布 Supabase API、完成 API 独立巡检、发布 Cloudflare 静态端与转发层、完成整站巡检。
- Cloudflare Worker 不得绑定 Hyperdrive，不得打包 NestJS/Prisma；前端固定使用同源 `/api`。
- `.deploy/cloudflare-free.secrets.json` 必须将数据库凭据拆分为
  `V2_RUNTIME_DATABASE_URL`、`AUDIT_DATABASE_URL`、`MIGRATION_DATABASE_URL`、
  `BACKUP_DATABASE_URL`，并包含
  `JWT_SECRET`、`FIELD_ENCRYPTION_KEY`、`HASH_SECRET`、`SMOKE_TEST_USERNAME`、
  `SMOKE_TEST_PASSWORD`。免费收购汇率接口不需要 API Key；该文件必须保持 Git 忽略且权限为 `0600`。
- `V2_RUNTIME_DATABASE_URL` 只允许当前业务表 DML，不拥有表、不具备 `ALTER`、`TRUNCATE`、
  禁用触发器或修改 `_prisma_migrations` 的权限；`AUDIT_DATABASE_URL` 只读；
  `MIGRATION_DATABASE_URL` 仅供离线迁移管理员使用，不会注入发布、巡检或应用运行时。
- `BACKUP_DATABASE_URL` 只属于 `id_v2_backup`，允许读取完整备份所需数据并绕过 RLS，但禁止任何
  写入和 DDL；只注入 GitHub `production-backup` Environment。免费备份与恢复流程详见
  `docs/V2_PRODUCTION_BACKUP.md`。
- 生产凭据启动器只接受 `closure-audit`、`release-check`、`smoke-user-provision`、`deploy`
  四个固定操作，不接受 `-- node -e` 或任意命令。
- Wrangler 版本消息和标签写入完整/短 Git commit；部署成功后自动检查首页、健康端点、只读账号
  登录、最小权限集合和核心只读接口。

首次创建或轮换生产巡检账号时，在受控本机执行：

```bash
npm run prod:smoke-user:provision
```

该命令只同步所需的七项查看权限并创建/刷新 `production_smoke_readonly` 角色和专用账号，不修改
数据库结构，也不授予新增、修改、删除、密文查看或业务选项管理权限。巡检账号凭据只保存在被 Git
忽略的本机部署凭据文件中，不上传为 Worker 运行时密钥。

首次拆分或轮换数据库角色时，先预览，再绑定最新生产备份指纹显式执行：

```bash
node scripts/provision-production-database-roles.mjs
node scripts/provision-production-database-roles.mjs --apply \
  --backup=/absolute/path/to/backups/postgres/pre-migration.dump \
  --backup-sha256=<最新备份 SHA-256> \
  --confirmation=<脚本预期的固定确认口令>
```

生产 migration 只能在干净且与 `origin/main` 完全一致的 `main` 上执行，并必须绑定当前项目内最新
生产备份的绝对路径、SHA-256 和派生确认口令：

```bash
npm run prisma:migrate:production -- \
  --backup=/absolute/path/to/backups/postgres/pre-migration.dump \
  --backup-sha256=<最新备份 SHA-256> \
  --confirmation=MIGRATE_fjquufgbnxyocmuzltxi_<SHA-256 前 12 位>
```

该固定命令在 `prisma migrate deploy` 成功后，会使用同一迁移数据库连接和部署凭据中的
`FIELD_ENCRYPTION_KEY` 自动执行员工账号手机号历史回填：写入 `phone_encrypted`、校验脱敏值、清空
历史 `phone` 明文并验证 `users_phone_plaintext_forbidden` 约束。任一步失败都会令命令失败，禁止在回填
未完成时继续发布；日志只输出处理数量，不输出手机号或密文。

敏感资料盲索引 migration 完成后，使用运行时最小权限角色执行可重复的历史数据回填。该命令只会注入
运行时数据库凭据、`FIELD_ENCRYPTION_KEY` 和 `HASH_SECRET`，不会获得 migration 或审计凭据：

```bash
npm run backfill:v2-sensitive-search-indexes:production
```

该固定脚本只会执行 `prisma migrate deploy` 和已审查的员工手机号加密回填，不会把
`MIGRATION_DATABASE_URL` 注入通用命令、应用运行时或发布流程。执行 Prisma 前还会检查专用备份角色
事务：存在任何备份事务时最多等待 3 分钟，
等待超时会立即停止并报告，不会自动终止连接，也不会写入失败的 migration 记录。超过 16 分钟的
`idle in transaction` 遗留事务还会由高频备份监控单独告警。

若 `20260809090000_user_table_preferences_runtime_access` 曾因创建策略等待表锁而超时，必须先确认
PostgreSQL 已回滚整段 migration，再在同一备份与确认门后追加固定参数：

```bash
npm run prisma:migrate:production -- \
  --backup=/absolute/path/to/backups/postgres/pre-migration.dump \
  --backup-sha256=<最新备份 SHA-256> \
  --confirmation=MIGRATE_fjquufgbnxyocmuzltxi_<SHA-256 前 12 位> \
  --resolve-rolled-back=20260809090000_user_table_preferences_runtime_access
```

若 `20260812180000_beijing_business_timezone` 因只读备份事务持有表锁而超时，先确认备份进程已经
完成，并终止仍处于 `idle in transaction` 且持有
`id_business_v2_finance_settings` 读锁的 `id_v2_backup` 遗留连接。恢复脚本只会在失败记录的
`applied_steps_count` 为 0、时区列默认值仍为 `Asia/Kuala_Lumpur` 且没有记录已变为
`Asia/Shanghai` 时允许标记回滚并重试：

```bash
npm run prisma:migrate:production -- \
  --backup=/absolute/path/to/backups/postgres/pre-migration.dump \
  --backup-sha256=<最新备份 SHA-256> \
  --confirmation=MIGRATE_fjquufgbnxyocmuzltxi_<SHA-256 前 12 位> \
  --resolve-rolled-back=20260812180000_beijing_business_timezone
```

脚本只接受这一条已审查 migration，并在标记回滚前核验失败记录唯一存在、运行角色权限和策略均未
部分生效；任何状态不一致都会拒绝继续。

仓库不提供通用生产清理入口。所有验收脚本继续同时校验 API 与数据库均为 loopback；若未来确需
生产清理，必须新增专用固定脚本、只读预览清单、二次确认和最新备份指纹，禁止临时命令直接执行。

## 8. 回滚

- 前端回滚到上一份已验证静态构建。
- API 回滚到 Supabase Edge Function 的上一个已验证版本。
- migration 默认只向前，不直接回滚数据结构。
- 若发布包含数据库变更，先按该 migration 的专用回滚方案和备份执行。
