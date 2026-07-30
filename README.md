# ID 业务管理系统

本仓库只包含当前 ID 业务管理系统。管理端、API、构建命令和部署入口均已统一为单一运行链路。

## 当前功能

- 续费操作
- 订单录入
- 加卡
- ID 录入
- 订单管理
- 客户记录
- 加卡记录与余额流水
- 开通记录
- 汇率记录与 Binance / OKX 公开报价采集
- 业务选项设置
- 登录、权限与操作审计

当前没有外部消息推送、兑换码商城、平台 OAuth、旧版通知中心或 Apple 官网自动操作。

## 技术栈

- 管理端：Vue 3、Vite、TypeScript、Element Plus、Pinia
- API：NestJS、TypeScript、Prisma
- 数据库：PostgreSQL / Supabase PostgreSQL
- 包管理：npm workspaces
- 部署：Docker Compose、Cloudflare Pages/Workers、Supabase Edge Function

## 目录

- `apps/admin`：唯一管理端
- `apps/api`：唯一 API
- `apps/api/src/id-business-v2`：业务领域模块
- `packages/shared`：前后端共享类型
- `docs/V2_PRODUCT_SCOPE.md`：产品边界
- `docs/V2_ARCHITECTURE.md`：模块边界
- `docs/UI_DESIGN.md`：界面强制规则
- `docs/V2_LOADING_STANDARD.md`：加载与路由规则
- `docs/V2_TASKS.md`：当前任务清单
- `docs/DEPLOYMENT.md`：部署说明

Prisma migration 从当前系统纯净基线开始，不包含其他系统的历史表、枚举或任务。

## 本地开发

```bash
nvm use
npm install
npm run setup:env
docker compose up -d
npm run prisma:generate
npm run prisma:migrate:deploy
npm run prisma:seed
npm run dev:api
npm run dev:admin
```

- 管理端：http://localhost:5374
- API：http://localhost:3000/api
- 健康检查：http://localhost:3000/api/health/ready

## 常用检查

```bash
npm run check:v2-isolation
npm run check:v2-loading-standard
npm run check:v2-table-standard
npm run check:v2-module-architecture
npm run check:v2-color-contrast
npm run acceptance:v2-color-contrast
npm run typecheck
npm run test
npm run build
npm run prisma:validate
```

全量检查：

```bash
npm run check
```

## 部署

生产环境变量从 `.env.production.example` 创建，并先执行：

```bash
PROD_ENV_FILE=.env.production npm run prod:env:check
```

部署命令：

```bash
npm run deploy:api
npm run deploy:admin
```

实际发布前必须确认当前分支、提交、远端、生产账号和目标环境。详细说明见
`docs/DEPLOYMENT.md`。

当前 Cloudflare 单体生产发布：

```bash
npm run deploy:production
```

该命令会强制检查干净且已同步的 `main`、GitHub 必需检查、主分支保护、固定 Cloudflare
账号/Worker/域名和生产凭据。部署版本写入 Git commit，成功后自动使用独立只读账号执行线上巡检。
首次配置或轮换巡检账号时执行：

```bash
npm run prod:smoke-user:provision
```
