# AWS 生产部署

## 1. 部署边界

生产环境只使用 AWS：

- EC2 运行 Caddy、Vue 管理端、NestJS API、内网媒体解析器和 MySQL 8.4。
- Docker Compose 负责服务编排和健康检查。
- EBS Docker volume 保存 MySQL 数据。
- 私有 S3 存储桶保存服务端加密的异地备份。
- IAM Role 只授予 EC2 上传和核验指定备份前缀的最小权限。

不再使用外部认证、Edge Function、外部数据库或第三方静态托管。

## 2. 生产文件

- 编排：`docker-compose.aws-mysql.yml`
- API 镜像：`apps/api/Dockerfile.mysql`
- 前端镜像：`apps/admin/Dockerfile`
- 媒体解析镜像：`apps/api/src/id-business-v2/workspace/media-resolver/Dockerfile`
- HTTPS 入口：`deploy/caddy/Caddyfile.aws`

API Dockerfile 提供两个独立目标：`runtime` 只保留生产依赖、Prisma Client 和编译产物，`migration`
保留 Prisma CLI 与 MySQL migration。生产 Compose 必须显式选择对应目标；两个容器均以非 root、
只读根文件系统、无额外 capabilities 的方式运行。生产基础镜像与 CI Actions 均固定到不可变 SHA，
升级时需同步更新版本标签、digest 和相关门禁测试。

- 环境变量模板：`.env.aws.production.example`
- 备份脚本：`scripts/backup-aws-mysql.sh`
- 备份定时器：`deploy/systemd/id-business-v2-mysql-backup.*`
- 发布制品与镜像保留脚本：`scripts/cleanup-aws-production-retention.sh`
- 生产保留定时器：`deploy/systemd/id-business-v2-production-retention.*`
- MySQL 性能巡检脚本：`scripts/audit-aws-mysql-performance.sh`
- MySQL 性能巡检定时器：`deploy/systemd/id-business-v2-mysql-performance.*`

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

3. 推送发布分支并创建以 `main` 为目标的 PR；禁止直接推送或强制推送 `main`。发布分支 push
   本身不重复触发质量门禁，PR 只保留一组 required checks；同一 PR 的旧提交由 concurrency 自动取消。
4. GitHub CI 全部通过并完成审查后合并 PR。普通业务改动不重复构建生产镜像；只有 Dockerfile、
   Compose、依赖锁文件等容器边界变化时才在 PR 构建镜像，`production-images` required check 仍必须成功。
   CI 和生产镜像的依赖安装统一关闭 npm 隐式审计，只由下述显式门禁执行一次，避免每个安装层重复等待
   advisory 接口。
   依赖审计遇到 registry 网络故障时最多尝试两次，每次 15 秒并间隔 5 秒。PR 在两次已识别的审计
   服务故障后记录警告并继续，但真实 high/critical 漏洞仍立即阻断；每日定时审计、`main` 质量门禁
   和正式生产标签保持失败即阻断。
5. 重新拉取 `origin/main`，确认工作区干净，且本地 `HEAD`、`origin/main` 和待部署 SHA 完全一致。
6. 确认该 SHA 的 `main` Quality Gate 已成功，且尚无成功生产制品，再创建不可移动的带说明正式标签
   `v2-production-<UTC>` 并推送。标签必须指向当前 `origin/main` 完整 SHA，且不得重用、强制移动，
   同一个 SHA 也不得通过第二个正式标签重复构建制品。
7. 标签 CI 复用同 SHA 已成功的 `main` 质量结论，只在构建前执行一次生产依赖审计，然后构建一次 API、
   管理端、migration、媒体解析和发布门禁镜像，导出单一不可变制品，上传
   `release-manifest.json` 和 `SHA256SUMS`。清单必须包含完整 commit、CI 运行号、制品 SHA-256
   及五个镜像 digest；标签阶段不再重复执行整套 lint、unit test、浏览器验收和本地数据库验收。
8. 只使用成功标签 CI 中的该制品执行生产部署；禁止从本地文件、历史目录或生产服务器重新构建。

正式顺序固定为：

```text
origin/main → 发布分支 → 本地完整检查 → commit → push → PR/CI → 合并 main
→ 锁定正式标签与完整 SHA → CI 单次构建不可变制品 → 备份/迁移/门禁
→ 加载同一制品 → 原子切换 → 发布后复核 → 删除已合并远程分支
```

紧急修复不得绕过该流程。生产部署过程必须持有 `/opt/id-business-v2/.deploy.lock`，发现其他部署、
Compose、迁移或同步进程时立即停止，避免两个版本同时操作生产环境。

## 4. 服务器发布流程

1. 本机读取 Git 忽略且权限为 `0600` 的 `.deploy/aws-production.local.env`，执行：

```bash
bash scripts/deploy-aws-production-artifact.sh v2-production-YYYYMMDDTHHMMSSZ
```

入口脚本会拒绝脏工作区、非 `main` 分支、移动标签、不属于 `origin/main` 的 SHA、
失败的 CI 或缺少 digest 的制品。检查 GitHub 制品和下载大文件前会先读取生产 `current` 的完整清单；
若同一 commit 已经上线，则只执行公共页面、静态资源 MIME 和 live/ready 语义健康检查，返回
`deployment_status=already_deployed`，不重复下载、上传、备份、migration、容器重启或回切。

2. 制品在本机与 EC2 各校验一次 SHA-256；源码归档禁止包含 `.git`、`.deploy` 和真实环境文件。

3. 上传制品前先在 EC2 使用同一个部署锁执行生产保留预检：发布目录保留最近 5 份，不可变制品
   保留最近 3 份，并始终额外保护 `current` 和发布清单中的上一生产 commit。Docker 只移除
   `id-business-v2-*` 受控旧标签及没有容器引用的悬空层，禁止运行 `docker image prune -a`、
   `docker volume prune` 或 `docker system prune`。预检后少于 8 GiB 可用空间时禁止上传和安装。

4. EC2 在整个安装期间持有 `/opt/id-business-v2/.deploy.lock`，并拒绝并发备份、恢复验证、
   Compose、migration 或同步进程。新源码进入 `/opt/id-business-v2/releases/<UTC>-<short-sha>`，
   CI 制品与清单进入 `/opt/id-business-v2/artifacts/<tag>-<full-sha>`。

5. 安装器复制上一版 `.env.aws.production`，校验 Compose 配置与镜像 digest，只通过
   `docker load` 加载 CI 镜像。生产脚本不包含 `docker build`、`docker compose build` 或 `--build`。

6. 更新容器前先触发一次生产备份，确认 S3 大小和 SHA-256 校验成功：

```bash
sudo systemctl start id-business-v2-mysql-backup.service
sudo systemctl show id-business-v2-mysql-backup.service --property=Result --value
```

`Result` 必须返回 `success`。备份失败时不得继续 migration。

7. 数据库固定使用四个独立身份：`id_business_migrator` 只执行 migration，`id_business_app`
   只运行 API，`id_business_audit` 只执行完整性巡检，`id_business_backup` 只生成备份。首次切换到
   独立账号或迁移账号密码轮换后，先用本机 root 连接可重复供应账号，再执行向前 migration；migration
   后必须再次供应权限，使新表得到精确的运行权限。这些步骤均由不可变制品中的安装器执行：

```bash
docker compose --env-file .env.aws.production -f docker-compose.aws-mysql.yml up -d mysql
# 在 CI 门禁镜像中供应四身份
docker compose --env-file .env.aws.production -f docker-compose.aws-mysql.yml run --rm migrate
# 在同一 CI 门禁镜像中重新供应并校验权限
```

`id_business_app` 不得拥有 DDL、GRANT OPTION、全库 DELETE、Prisma migration 写入或审计日志更新
权限。供应命令不得输出 root 密码、业务数据库 URL 或账号密码。

8. 首次部署或审计密码轮换后，安装器会在同一 CI 门禁镜像内供应只读审计账号，
   然后在更新应用容器前执行数据库身份及财务完整性阻断门禁。

必须得到数据库四身份 `ok: true`、38 项检查和 0 条违规。门禁只能使用 `.env.aws.production` 中的
本机门禁连接；脚本检测到运行账号 DDL、越界 DELETE、审计写权限或账号复用时会主动拒绝运行。

9. 门禁通过后使用已加载镜像更新应用容器，等待 `mysql`、`media-resolver`、`api`、`admin`、
   `caddy` 健康，并执行整站巡检：

```bash
docker compose --env-file .env.aws.production -f docker-compose.aws-mysql.yml up -d --no-build
docker compose --env-file .env.aws.production -f docker-compose.aws-mysql.yml ps -a
```

```bash
BASE_URL=https://your-domain.example bash scripts/deploy-smoke.sh
```

巡检至少包括首页、静态资源 MIME、live/ready、登录、`auth/me`、核心业务只读接口、越权写入 403 和登出。

10. 健康检查和巡检均通过后，原子更新 `/opt/id-business-v2/current` 软链接。每次发布目录保存
    完整发布清单，记录来源分支、完整 SHA、正式标签、CI 与部署运行号、
    制品名称与 SHA-256、五个镜像 digest、环境、UTC 时间、操作人和上一生产 SHA。
11. 原子切换后重复执行整站巡检和 38 项财务完整性门禁，执行一次发布后保留清理，并安装、启用
    `id-business-v2-production-retention.timer` 和每 5 分钟执行的
    `id-business-v2-mysql-performance.timer`。同时核验备份服务、自动备份、每周恢复验证、每日
    保留策略与首次性能巡检均处于预期状态。任一检查失败，立即回切并重启上一已验证不可变制品。
12. 生产验证成功后删除已合并且不再使用的远程发布分支。

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

## 7. 发布制品与镜像保留

生产服务器每天 UTC 03:15 后在 15 分钟随机窗口内执行：

```bash
sudo systemctl start id-business-v2-production-retention.service
sudo systemctl show id-business-v2-production-retention.service --property=Result --value
sudo journalctl -u id-business-v2-production-retention.service -n 100 --no-pager
```

任务与发布共用 `/opt/id-business-v2/.deploy.lock`；发布、备份或恢复验证正在执行时安全跳过或阻断。
固定保留最近 5 个受控发布目录和 3 份不可变制品，同时无条件保护当前与上一已验证提交。

## 8. MySQL 连接池与慢查询观测

生产服务器每 5 分钟执行一次只读 `performance_schema` 摘要。发布安装器会先建立一次维护窗口基线，
避免容器切换产生的预期断连被误判为日常 5 分钟异常增量；随后立即执行一次正常阈值巡检：

```bash
sudo systemctl start id-business-v2-mysql-performance.service
sudo systemctl show id-business-v2-mysql-performance.service --property=Result --value
sudo journalctl -u id-business-v2-mysql-performance.service -n 100 --no-pager
```

巡检记录当前连接数、历史连接峰值、运行线程、异常客户端增量，以及最近 10 分钟最慢在线业务 SQL
的 digest、次数、平均/最大耗时、扫描行数和未使用索引次数。输出禁止包含 SQL 正文、业务参数、密码
或数据库连接串；备份使用的 `SELECT SQL_NO_CACHE` 和 migration/系统查询不计入在线慢查询告警。

默认停止阈值为连接使用率 70%、最近业务 SQL 最大 500 ms、5 分钟 `Aborted_clients` 增量 25。
阈值可通过 `.env.aws.production` 中的以下可选变量收紧，但不得超过脚本的安全边界：

```text
MYSQL_PERFORMANCE_MAX_CONNECTION_USAGE_PCT=70
MYSQL_PERFORMANCE_MAX_QUERY_MS=500
MYSQL_PERFORMANCE_MAX_ABORTED_CLIENTS_DELTA=25
```

数据库 Docker volume、MySQL 备份、非本项目镜像及运行容器镜像不在清理范围。清理后可用空间低于
8 GiB 时任务返回失败，下一次生产发布也会在上传前被阻断。

## 8. 回滚

- 应用回滚：将 `current` 重新指向上一个已验证发布目录，然后启动该版 Compose。
- 数据库 migration 默认不逆向回滚。如果新应用不兼容旧结构，必须在发布前准备专用方案。
- 任何数据恢复先在隔离 MySQL 实例验证，不直接覆盖生产数据。
