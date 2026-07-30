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
```

`npm run prisma:seed` 只允许在已确认没有业务数据的全新空库中手工执行，不得作为生产发布步骤。
Supabase 等托管生产库发布前必须先完成可恢复备份、现有结构比对和 Prisma migration 状态核对，
确认迁移只向前且不会覆盖新数据后，才允许执行 `prisma:migrate:deploy`。

`npm run backup:postgres` 和 `npm run restore:verify` 只适用于 Compose 中确实存在 `postgres`
服务的自托管环境。当前 `docker-compose.prod.yml` 只有 API 和管理端，不得把这两个命令当作
Supabase 生产备份证明。托管生产库必须使用供应商认可的备份/时间点恢复能力，并把备份引用、
生成时间、数据库项目、migration 水位和隔离库恢复演练结果记录到发布单。

旧 dump 不允许直接恢复到仍在写入的生产库。恢复只能进入新建隔离库，先对比备份后新增记录、
业务主键、不可变流水和 migration，再做增量重放或受控切换。仓库中的 `restore-postgres.sh`
已固定只接受 `restore_drill_*` 隔离目标，不能在线覆盖 `POSTGRES_DB`。

全新空库可直接执行当前系统基线。已经承载当前系统的生产数据库不得重复执行基线或 seed；必须先
完成结构比对，再将基线标记为已应用。生产数据库中的无关历史表不属于代码发布范围，不得在发布
脚本中自动删除。

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

使用 Supabase Auth 时还必须同时满足：

- 后端 `AUTH_PROVIDER=supabase`，前端 `VITE_SUPABASE_URL` 和 publishable/anon key 完整配置，且
  前后端指向同一个 Supabase 项目；生产管理端构建会自动拒绝缺失、错配或 local/supabase 混用。
- `SUPABASE_SERVICE_ROLE_KEY` 或 `SUPABASE_SECRET_KEY` 只能进入 API 运行时密钥，不得进入
  `VITE_*`、前端构建参数或静态产物。
- API 与管理端必须作为同一发布批次交付。稳定会话门禁上线后，历史未登记的 Supabase 会话会被
  拒绝，用户需要重新登录一次；不得通过请求阶段自动补建会话来绕过该门禁。
- 首次强制改密账号只允许访问当前身份、修改密码和退出接口；发布验收必须验证手动输入业务 URL
  仍会被后端拒绝。

首次切换稳定会话和强制改密前，先运行只读审计：

```bash
npm run audit:supabase-auth-readiness
```

返回码 `2` 表示存在未绑定身份、历史改密标记或停用账号身份问题，需要逐个业务账号复核。历史版本
曾在登录时直接清除强制改密标记，因此只允许按明确的 `userId` 定向恢复标记并撤销该账号会话，
禁止全表更新。`cleanupEligibleSessions` 只是保留期规划数据，不是删除授权。

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

Cloudflare 发布命令包含以下硬门禁：

- 当前分支必须为干净的 `main`，且 `HEAD` 与 `origin/main` 完全一致。
- GitHub `quality`、`production-images` 必须成功，`main` 必须启用 PR、管理员约束、线性历史、
  对话解决和禁止强推/删除的保护规则。
- Cloudflare account、Worker、Hyperdrive、公开域名和 CORS 必须与仓库固定生产配置一致。
- `.deploy/cloudflare-free.secrets.json` 必须包含数据库与字段安全密钥、固定的
  `AUTH_PROVIDER=supabase`、前后端同项目 Supabase URL、前后端 publishable/anon key、仅后端使用
  的 service/secret key、首发 Realtime 关闭开关及 `SMOKE_TEST_USERNAME`、
  `SMOKE_TEST_PASSWORD`；该文件必须保持 Git 忽略且权限为 `0600`。
- Wrangler 版本消息和标签写入完整/短 Git commit；部署成功后自动检查首页、健康端点、只读账号
  登录、最小权限集合和核心只读接口。
- 发布前读取当前唯一承载 100% 流量的 Worker 版本；新版本部署或线上巡检失败时自动回滚该版本并
  再跑一次巡检。流量正在分批发布或无法确定唯一回滚目标时，发布会在变更前直接拒绝。

首次创建或轮换生产巡检账号时，在受控本机执行：

```bash
npm run prod:smoke-user:provision
```

该命令只同步所需的七项查看权限并创建/刷新 `production_smoke_readonly` 角色和专用账号，不修改
数据库结构，也不授予新增、修改、删除、密文查看或业务选项管理权限。巡检账号凭据只保存在被 Git
忽略的本机部署凭据文件中，不上传为 Worker 运行时密钥。

Provisioning 使用固定业务用户名 `production_release_smoke` 和固定专用 Auth 邮箱
`production-release-smoke@daichongxitong-v2-free-20260727.ppfzj1314.workers.dev`，不接受环境
变量指定其他员工账号。既有业务用户必须已经且仅绑定 `production_smoke_readonly`，既有角色也
只能分配给该专用用户；任一标识命中非专用用户、非专用角色或其他 `V2AuthIdentity` 时立即失败，
不会轮换密码或清空原角色。

当 `AUTH_PROVIDER=supabase` 时，该命令只通过服务端 Supabase Admin API 创建或校验带受保护
`app_metadata` 标记的专用 Auth 用户，并同步 `V2AuthIdentity`。跨 Supabase 与数据库的后半程
失败会给出可重试状态；若新建 Auth 用户后数据库事务失败，会先尝试补偿删除。出现“结果不确定”时
必须使用同一份新密码重试，禁止改用员工邮箱，也不要手工删除业务用户。

## 8. 回滚

- Cloudflare 单体发布失败时由发布脚本回滚到发布前记录的 100% 流量版本，并再次执行线上巡检。
- 前端与 API 必须作为同一个 Worker 版本回滚，不能只回滚一侧。
- migration 默认只向前，不直接回滚数据结构。
- 应用版本回滚不会回滚数据库。若发布包含数据库变更，必须先验证新旧代码兼容窗口，并按该
  migration 的前向修复方案和备份执行。
- 灾难恢复不得把旧备份 `--clean` 覆盖在线库；固定采用“冻结写入 → 隔离恢复 → 对比并补齐备份后
  新数据 → 对账 → 切换 → 原库只读观察”的流程。
