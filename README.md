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
- 汇率记录、Binance / OKX 公开报价采集，以及 ExchangeRate-API 多币种人民币收购价自动计算、异常审核与报价文本复制
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

当前运行时 Prisma 以 `apps/api/prisma-mysql/schema.prisma` 和其 migration 为唯一权威，
不包含其他系统的历史表、枚举或任务。`apps/api/prisma` 仅保留 PostgreSQL 历史迁移源和兼容验收文件，
不参与当前 API 或管理端运行。

## 本地开发

本机默认直接运行 Node、MySQL 和 Python，不要求 Docker Desktop。先启动本项目独立的
MySQL 8.4 实例，在 `.env` 中配置本机数据库地址，再按下述入口运行。已有数据库和其他项目
的数据目录不能共用；不要把生产数据库地址用于本机开发。

```bash
nvm use
npm ci
npm run setup:env
npm run doctor -- --mysql-client=/已安装MySQL目录/bin/mysql --mysql-server=/已安装MySQL目录/bin/mysqld
npm run prisma:mysql:generate
npm run prisma:mysql:migrate:deploy
npm run prisma:seed
npm run dev:api
npm run dev:admin
```

以上迁移和初始化仅用于已确认的独立开发库。`doctor` 默认只检查原生程序和配置，
不会启动 MySQL、连接数据库或执行迁移；程序存在不代表数据库已就绪。
MySQL 已在 PATH 时可省略两个路径参数。已有依赖按锁文件复用，不必每次安装；
普通脚本测试可执行 `npm run test:native-runtime`。

五类数据库检查都提供显式原生入口，追加已安装 MySQL 的 `--mysql-bin=/绝对目录`：

- `npm run acceptance:v2-data-governance:native`
- `npm run acceptance:v2-financial-integrity:native`
- `npm run acceptance:v2-rollback-integrity:native`
- `npm run check:recharge-migration:native`
- `npm run check:audit-retention:native`

这些检查仅创建自己的测试库；前三类会生成客户端与构建产物，须在隔离工作区执行。
它们已在本机真实 MySQL 验证；正式 Linux CI 尚未切换，生产运行方式也未改变。
`npm run native:backup -- check --bin-dir=/绝对目录` 默认仅预检，不连接数据库。
七服务配置、备份恢复、财务制品封存和线上切换边界见 [脱离 Docker 说明](docs/DOCKER_INDEPENDENCE.md)。

- 管理端：http://localhost:5374
- API：http://localhost:3000/api
- 健康检查：http://localhost:3000/api/health/ready

### 本机注册与充值执行器

复用已安装的 Python 3.11+ 虚拟环境与经过锁定校验的 Camoufox 内核，不自动安装软件或
下载浏览器。通过已有环境变量 `AUTO_RECHARGE_WORKER_TOKEN` 提供独立随机凭据，
不要把凭据写到命令参数、报告或聊天中。启动入口不会读取 `.env`；应由本机运行环境加载配置。

```bash
# 只检查前置条件，不启动服务
npm run auto-recharge:native -- --python=/已安装虚拟环境/bin/python --engine-path=/已安装Camoufox/Camoufox.app/Contents/MacOS/camoufox --check

# 分别在两个终端或独立进程中启动
npm run auto-recharge:native -- --role=recharge --python=/已安装虚拟环境/bin/python --engine-path=/已安装Camoufox/Camoufox.app/Contents/MacOS/camoufox
npm run auto-recharge:native -- --role=registration --python=/已安装虚拟环境/bin/python --engine-path=/已安装Camoufox/Camoufox.app/Contents/MacOS/camoufox
```

两个角色默认只监听本机 `127.0.0.1`，充值端口 8051，注册端口 8052，可显式传入 `--port`。
各自使用项目内 `.runtime/native-workers/角色/` 运行目录；共用已经安装的依赖和浏览器程序，
进程、任务和端口独立。端口被占用时先停止启动，不再创建第二套浏览器；Ctrl+C 或正常终止
会清理本进程的浏览器及监听端口。

本机 API 配置沿用 `AUTO_RECHARGE_WORKER_URL=http://127.0.0.1:8051`、
`AUTO_REGISTRATION_WORKER_URL=http://127.0.0.1:8052`，保持 API 与相应执行器的授权配置一致。
Worker 默认回调本机 API 的 `/api/id-business-v2/auto-recharge/internal`，
可用已有 `AUTO_RECHARGE_CALLBACK_URL` 指定其他本机端口；本机入口拒绝远程回调和公开监听。
启动及健康检查不会自动执行注册或付款。

Docker 开发方式仍可显式选择：`npm run doctor:docker`。已有 Docker 数据不会自动删除。
线上替换、数据库保护和回滚安排见 [Docker 脱离方案](docs/DOCKER_INDEPENDENCE.md)；
线上尚未改为原生运行，不应直接卸载生产 Docker。

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
