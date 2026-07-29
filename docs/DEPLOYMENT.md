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

Cloudflare 单体构建：

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

当前生产使用 Cloudflare 单体 Worker，同时承载管理端和 API。确认当前分支、提交、远端和目标环境
后，执行一次：

```bash
npm run deploy:production
```

## 8. 回滚

- 前端回滚到上一份已验证静态构建。
- API 回滚到上一份已验证提交和镜像。
- migration 默认只向前，不直接回滚数据结构。
- 若发布包含数据库变更，先按该 migration 的专用回滚方案和备份执行。
