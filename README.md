# ID 业务管理系统

本仓库只包含当前 ID 业务管理系统。管理端、API、构建命令和部署入口均已统一为单一运行链路。

## 当前功能

- 续费操作
- 订单录入
- 加卡
- ID 管理
- 订单管理
- 客户记录
- 加卡记录与余额流水
- 开通记录
- 汇率记录、Binance / OKX 公开报价采集，以及 CurrencyAPI 多币种人民币收购价自动计算、异常审核与报价文本复制
- 业务选项设置
- 操作审计、敏感访问查询与导出留痕
- 员工账号、角色权限与操作审计
- 登录风险、在线会话强制下线、MFA 管理与 IP 白名单防锁死门禁
- 我的账户：脱敏个人资料、修改密码、MFA 和在线设备自助管理
- 经营仪表盘：权限感知的今日业务、风险待办、ID 库存成本和团队动态
- 业务监控：按源业务状态识别订单、余额、续费、汇率和财务基线异常
- 系统监控：API、数据库、版本补偿、汇率任务和认证状态只读探针

当前没有外部消息推送、兑换码商城、平台 OAuth、旧版通知中心或 Apple 官网自动操作。

## 技术栈

- 管理端：Vue 3、Vite、TypeScript、Element Plus、Pinia
- API：NestJS、TypeScript、Prisma
- 数据库：MySQL 8.4
- 包管理：npm workspaces
- 部署：AWS EC2、Docker Compose、Caddy、S3 备份

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
docker compose --env-file .env -f docker-compose.aws-mysql.yml up -d mysql
npm run prisma:mysql:generate
npm run prisma:mysql:migrate:deploy
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
npm run check:v2-prisma-runtime-boundary
npm run check:v2-color-contrast
npm run acceptance:v2-color-contrast
npm run acceptance:v2-table-layout
npm run acceptance:v2-session-reliability
npm run acceptance:v2-navigation-performance
npm run acceptance:v2-decimal-adapters
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

生产环境变量从 `.env.aws.production.example` 创建，仅保存在 AWS 服务器的
`/opt/id-business-v2/current/.env.aws.production`。先检查编排：

```bash
npm run aws:mysql:config
```

在 AWS 发布目录构建并启动：

```bash
docker compose --env-file .env.aws.production -f docker-compose.aws-mysql.yml build
docker compose --env-file .env.aws.production -f docker-compose.aws-mysql.yml up -d --no-build
npm run prod:smoke
```

实际发布前必须确认当前分支、提交、远端、生产账号和目标环境。详细说明见
`docs/DEPLOYMENT.md`。生产备份由 EC2 systemd timer 执行 `scripts/backup-aws-mysql.sh`，
并上传到私有 S3 存储桶。
