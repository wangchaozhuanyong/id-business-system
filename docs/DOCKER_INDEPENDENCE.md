# ID 业务管理系统脱离 Docker 方案

日期：2026-10-08。状态：**本机空业务库、API、管理端及原生财务检查联调通过；Linux 原生配置和备份入口已实现，线上尚未切换**。

用户已批准本机原生化并要求继续未完成的实现。本轮补齐原生运行、七服务配置生成、备份恢复和只读财务检查入口，并执行本机隔离验证。生产安装、数据库迁移、服务切换和旧 Docker 退役尚未执行；此前批准的一台临时 Linux 测试机已运行并按时清理；线上执行须按实际现场、制品和维护窗口审阅，真实充值在扣款前停止。

2026-10-08 用户最新安排：发布已经完成的修复源码，暂停自动充值业务测试；不再创建或使用临时测试机，不使用移动代理。此前唯一测试机及其磁盘和附属资源已回查清理，第二次测试方案取消。Docker 暂时保留，其他本地项目仍只读盘点。原生七服务、生产数据恢复及切换门禁未取得完整证明，保持待完成状态。

## 1. 已核实的能力与当前边界

本次改造基于 `8c14f41923a1806a701ba1dc53fdc1892274454d`；这是工作树基线，不代表当前生产版本。源码交付按当前 main 的精确增量集成，发布状态以实际 Git／CI 回执为准；线上七服务尚未切换。

本机已直接启动两个 Mac 浏览器 Worker，验证健康、授权拒绝、角色隔离及停止充值后注册仍可用。后续隔离副本使用 MySQL 8.4.11 执行全部 45 条现有 migration，业务用户为 0；API live/ready、管理端入口和静态资源、8 个安全头及 API 代理均实际通过。原生财务检查在同一空库前后各执行 49 条原规则，违规为 0，身份与检查指纹一致。原回滚 31 项、财务 78 项及 24 组反例通过；原生备份在自有合成库完成 13 项备份／恢复保护探针。测试进程已退出，空库已回收，原有业务库、配置和 ROOT Prisma 客户端没有被修改。

最终修订回执位于候选工作区 `.runtime/docker-independence-20261008/native-python-fixtures/final-summary.json`，数据治理最终回执另见 `native-data-governance/native-data-governance-final-validation-pipe-v3.json`。最终包输入变化后重新封存，并在新空库执行 49 条前后核验；未变化的 API／管理端构建和健康证据复用。较早财务封存回执保留为旧输入证明，不能代替最终版本。这是本机隔离空库验收，不代表生产数据迁移、真实业务开通或 Linux systemd 运行通过。

| 范围           | 已核实事实                                                        | 尚未完成                                     |
| -------------- | ----------------------------------------------------------------- | -------------------------------------------- |
| 本机前后端     | 原生构建、45 条空库迁移、API／管理端及同库 49 条前后检查实际通过  | 使用生产副本的迁移验收                       |
| 浏览器执行器   | Mac 原生两个角色的启动、独立端口、授权拒绝和退出隔离已实际通过    | Linux 七服务安全隔离验证（依赖及构建已实测） |
| 当前生产       | Compose 定义七个常驻服务及一个迁移入口                            | 原生运行、发布、备份、恢复和独立读回均未实施 |
| 旧“native”采证 | Python 控制器运行在宿主机，但仍调用 `docker inspect/exec/compose` | 不得用该名称或旧回执声称业务已脱离 Docker    |

`scripts/lib/native-postgres-client.mjs` 是历史 PostgreSQL 客户端支持；当前权威数据库是 MySQL 8.4，不能据此恢复 PostgreSQL 运行方案。业务界面、金额计算、支付确认和数据库结构沿用当前系统。

## 2. 目标服务及替换范围

| 当前服务            | 目标运行方式                                           | 必须保留的行为                                                    |
| ------------------- | ------------------------------------------------------ | ----------------------------------------------------------------- |
| `mysql`             | 同版本原生 MySQL 8.4，独立服务账号和数据目录           | 原数据库、字符集/排序规则、时区、SQL mode、账号权限、触发器和例程 |
| `api`               | Node 24 的构建产物，由 systemd 管理                    | Prisma MySQL 客户端、认证/加密配置、回调和健康接口                |
| `admin`             | 原生 Nginx 提供前端静态产物                            | SPA 路由、API/实时连接代理、超时、真实客户端地址和缓存规则        |
| `caddy`             | 原生 Caddy                                             | 原域名、证书/账户存储、安全响应头和 HTTPS                         |
| `auto-recharge`     | Python 3.12、锁定依赖和浏览器，由独立 systemd 单元管理 | 单次付款、人工确认、代理及任务窗口所有权                          |
| `auto-registration` | 独立 Python 3.12 进程和临时目录                        | 注册任务、原窗口、角色隔离和续接规则                              |
| `media-resolver`    | Python 3.11，独立 yt-dlp/F2 环境及 ffmpeg              | 当前媒体功能、出站限制、临时文件和超时                            |
| `migrate`（单次）   | 独立受控 Prisma 迁移入口                               | 仅执行已经批准的当前系统新增 migration；本次脱 Docker 不要求改表  |

现行生产 Compose 中两个浏览器执行器的默认入口仍为 `0.0.0.0:8051`，彼此有独立容器网络。本轮新增 CLI 地址／端口／内核路径参数，旧无参数启动兼容；本机包装入口固定环回监听，默认充值 8051、注册 8052。上线替换还须调整已有 API Worker URL 与 Worker callback URL，不能把两者合成同一进程。媒体端口已有配置入口。API 新增显式 `--host`；媒体新增 `--host`、`--port`、`--f2-bridge` 和仅预检的 `--check`，无参数保留原容器行为。本轮没有新增环境变量；后续新增环境配置时同步更新 `.env.example`，只提供占位值。内部服务仅绑定环回或明确的私有接口，只有网关公开 80/443。

## 3. 阶段一：冻结现场与准备可恢复副本

### 本轮新增原生工具

- `scripts/native-services.mjs`：默认只读取公开模板，生成七个独立服务账号、状态目录、私有环境文件路径和候选配置。只有 `--write --output-dir=本项目新目录` 才写出配置；`--installed-check` 与 `--health` 不安装或启动服务。MySQL 健康检查用私有客户端文件执行 `SELECT 1`，不把 `mysqladmin ping` 视为认证成功。
- API、两个浏览器执行器和媒体服务使用各自文件系统命名空间内的有界 `/tmp`：分别沿用 64／512／512／640 MiB，共享内存 `/dev/shm` 各限 256 MiB；`/var/tmp` 只读。四个角色的 `HOME`／`TMPDIR` 指向 `/tmp`，宿主 `0700` 运行目录在服务内只读，避免绕过限额写入另一条临时路径。按 [systemd 252 官方配置](https://github.com/systemd/systemd/blob/v252/man/systemd.exec.xml)及[挂载优先级实现](https://github.com/systemd/systemd/blob/v252/src/core/namespace.c)，有界角色使用 `TemporaryFileSystem` 而关闭会覆盖同路径 tmpfs 的 `PrivateTmp`；MySQL、Nginx 和 Caddy 保留原宿主可见 socket／PID 目录。配置回执仍标 `NOT_MEASURED`，现场须测量真实 `/tmp`／`/dev/shm` 的容量、不可执行／只读属性和跨角色隔离；持久状态、浏览器缓存及日志容量另需核验，不能把 tmpfs 限额当作总磁盘上限。
- Caddy 管理 API 使用本服务 `0700` 运行目录内的 `admin.sock`，不监听宿主环回 `2019`；公开网站的 80/443 和 HTTPS 规则保持原模板。健康检查由 Caddy 服务账号运行 `--health=caddy --runtime-dir=/run/独立运行根目录`，仅访问固定 socket 的 `GET /config/`，核对规范路径、属主和私有权限，丢弃配置响应，失败不回退 TCP。语法及默认 socket 权限遵循 [Caddy 官方管理入口文档](https://caddyserver.com/docs/caddyfile/options#admin)和[网络地址文档](https://caddyserver.com/docs/conventions#network-addresses)。Linux 上其他六个服务账号是否均无法访问该入口仍为 `NOT_MEASURED`，须现场验证。
- `scripts/native-mysql-backup.mjs`：默认 `check` 不连接数据库。`backup` 使用明确的原生程序目录、既有私有客户端文件和加密密钥文件；单次一致性备份保留例程、事件和触发器。`verify` 只初始化自己创建的新实例，禁止接受已有数据库或客户端文件作为恢复目标。归档认证、摘要及原恢复保护失败即停止；S3 上传和保留策略仅准备参数，未执行。
- `scripts/native-finance-artifact.mjs`：按源码、原 49 规则和 Prisma 运行文件的实际字节封存并校验制品，不调用 Docker，不复制配置或凭据。
- `scripts/native-finance-audit.mjs`：默认只校验制品，不连接数据库；显式 `--run` 使用既有只读数据库配置。固定单连接，验证只读权限、会话和 RepeatableRead；规范化 MySQL bigint 身份字段后计算摘要；连接前及出具回执前将实际执行模块绑定封存字节。不可执行规则不得生成绿色回执，前后回执以 SHA-256 绑定。
- 现有财务／回滚验收新增 `--runtime=native --mysql-bin=/已安装MySQL/bin`，仍执行原 fixture、反例与断言。隔离实例固定环回监听，密码仅在内存，生成前和清理前复核项目、祖先与自有目录的真实路径，拒绝软链接重定向；结束只清理该次新进程和空测试库；兼容的 Docker 默认分支保持原行为。

原生财务回执明确 `historicalClearanceEquivalent=false`、`productionCutoverAllowed=false`。空库 strict-zero 验收不能替代原生产历史清理政策、数据指纹和固定发布合同。原生备份当前 SQL 与压缩载荷各有 64 MiB 上限，超限停止；实际生产备份大小、生产 Definer／触发器恢复、S3 独立读回及原定时策略尚未验收。

无需 Docker 的本机检查：

```sh
npm run test:native-runtime
npm run acceptance:v2-rollback-integrity:native -- --mysql-bin=/已安装MySQL/bin
npm run acceptance:v2-financial-integrity:native -- --mysql-bin=/已安装MySQL/bin
npm run native:backup -- check --bin-dir=/已安装MySQL/bin
```

财务／回滚验收会生成测试客户端和构建产物，须在自己的隔离工作区执行，不能覆盖并行开发的依赖或 Prisma 客户端。完整执行的有限回执保留在本工作区运行目录；源码/配置生成通过不代表生产已切换。

### 五类数据库检查的原生入口

正式工作流涉及的数据治理、财务、回滚、充值迁移与审计保留均已增加显式原生模式，保留原 SQL、fixture、权限和删除保护断言。新实例只能使用本项目新建的测试目录；原生子进程输出被捕获，只回传有限计数和固定错误，不将临时数据库凭据或原始 SQL 写入日志。Python 测试通过受限桥接操作私有 socket，非 root 权限测试使用原受限身份；异常、EOF 和信号退出只清理自己的实例，启动未返回实例时不会虚报清理成功。

本机实际通过：数据治理 3 项及 12 步工作流、回滚 31 项、财务 78 项及 24 组反例、充值迁移原断言、审计保留 12 项。原生脚本现有 59 项验证覆盖：私有 Caddy 管理入口、七服务配置及临时容量的 15 项本地通过，其余 44 项复用输入未变化的既有通过证明；两个 Python 原生别名也实际执行通过。所有检查使用新建空库或合成数据，不连接已有业务库。

```sh
npm run acceptance:v2-data-governance:native -- --mysql-bin=/已安装MySQL/bin
npm run check:recharge-migration:native -- --mysql-bin=/已安装MySQL/bin
npm run check:audit-retention:native -- --mysql-bin=/已安装MySQL/bin
```

正式 `.github/workflows/quality.yml` 仍采用原 Docker 默认入口。Linux 的锁定工具和 API／前端构建已在此前隔离机实测；七服务实际隔离尚未验收，不能把本机原生通过记作远端 CI 或生产切换通过。

1. 执行时重新取得生产 commit/tree、清单摘要、配置摘要、各服务身份、数据库版本和注册窗口状态；本机源码与历史回执不能代替现场证据。
2. 登记原 MySQL、Caddy 数据卷及密钥配置的归属、权限和备份恢复路径。秘密只进入受控配置或加密备份，报告只保留摘要。
3. 保留当前 Compose、运行容器和回滚镜像。原生候选使用独立端口及数据目录，不与原 MySQL 同时打开同一数据目录。
4. 检查安装、恢复副本和回滚所需实际磁盘/内存余量；不足时停止准备，不自动扩容或删除旧数据。

通过条件：源码和现场身份闭合、备份方案可恢复、没有未识别的活动任务。原注册窗口仍被保留时，只能进行隔离准备；最终退役原注册进程必须等任务自然结束或取得针对该窗口的明确授权。

### 2026-10-08 Linux 验收续做

此前唯一临时 Linux 测试机完成依赖身份和 API／管理端构建；完整七服务验证停在空库初始化的临时目录权限，单点修正已实测通过。该机于 52 分 57 秒内终止，新根卷、安全组、专属角色及到期任务均已回查清理，不能继续复用，也没有另建机器。

本轮把上述四角色临时目录限额补进原生服务生成器，15 项定向测试、语法、格式及配置摘要读回通过，并仅将这三份容量修复文件的精确增量接入主目录。Linux 配置实际生效、七服务、五套数据库检查及 49 条前后核验仍待实机完成；本机通过不替代该门禁。测试控制器已补齐自有测试账号和生成目录的失败清理、实际 MainPID 命名空间容量及跨角色标记探测；空白浏览器已接入同一有界文件系统内的自有私有子目录，保留原探针全部断言；控制器 22 项、启动存储探针 16 项、空白浏览器运输包装器 17 项本地检查通过。未经过现场运行不标成功。

Docker 按用户最新要求暂时保留。本机初始快照 16 个、结束前复核 15 个运行容器均属装修网站，其他项目的依赖见本项目 `.runtime/docker-independence-20261008/docker-project-dependency-report.md`；这份跨项目清单没有授权改动其他网站或删除数据。

## 4. 阶段二：构建原生制品和运行保障

1. 将 Dockerfile 中锁定的 Node/Python 依赖及系统依赖提取为受控原生安装/构建输入，保留 Prisma 生成、Python 依赖审计及浏览器下载摘要验证；不顺带升级版本。
2. 为每个服务准备并测试 systemd 单元：独立非 root 账号、只读源码、最小可写状态/临时目录、受保护的环境文件、自动恢复和健康检查。采用当前内存/进程/临时空间限额作为基线；浏览器的共享内存、Xvfb、沙箱和系统调用需求单独验证。
3. 用本机端口、进程身份与网络规则替代 Compose DNS/网络。验证 Worker 控制端口不对外开放，媒体与浏览器出站范围保持受控，API callback 授权保持有效。
4. 构建带 SHA-256 的制品清单，记录 commit/tree、依赖锁文件、工具版本、实际文件映射、构建运行编号与批准身份。相同输入复用已经通过的 CI 证据；变动部分补相应检查。

通过条件：在隔离环境实际启动七服务的替代入口，健康检查、角色/端口隔离、源码身份、权限和故障恢复通过。此阶段不生成未经验证的生产单元并直接启用。

## 5. 阶段三：数据库、备份和证书恢复演练

1. 沿用原备份保护：一致性逻辑备份、触发器/例程、加密、S3 大小和 SHA-256 校验。改造备份和恢复演练的 Docker 运输方式，保留原核验项目和受限账号。
2. 在隔离原生 MySQL 实例恢复；比较 schema/migration、表数/行数、金额与余额摘要、字符集/排序规则、时区、SQL mode、例程定义及触发器保护，执行原恢复保护探针。演练不得写生产数据库。
3. 最终切换安排写入冻结和最终一致性备份；停止业务写入后再恢复或完成同步，避免首次演练后新增数据遗漏。原卷保留，禁止直接移动、覆盖或删除。
4. Caddy 的证书、ACME 账户及配置存储制作受保护副本，在正确权限下恢复验证。候选不抢占原 80/443，不在演练时反复申请生产证书。

通过条件：原生恢复完整可用、备份可独立解密校验、TLS 证书有效且回滚存储完好。数据库主写入口始终只有一个。

## 6. 阶段四：替换发布和财务检查运输方式

1. 正式构建/推送由 Docker/ECR 镜像改为受控不可变制品；发布器验证摘要、权限和批准后落盘、启动候选并切换。版本记录继续保留一次发布的源码、检查、制品、迁移和验收证据。
2. 新建有限原生发布合同，使用进程启动身份、systemd 单元/配置摘要、实际运行源码及 HTTP 内容证明替代容器/镜像身份。保留原固定合同与历史私有回执，不改旧 pin、伪造容器字段或用旧绿色结果代替现场验证。
3. 财务 **49 条原规则、只读账号权限检查、只读会话、RepeatableRead、一致性指纹和切换前后比较全部保留**。现有执行器依赖 `/app` 路径、封存编译产物和审计镜像，需准备可核验的原生审计制品与路径适配；新运输合同单独审阅，不能仅删掉镜像校验后宣称等价。
4. 将财务/恢复验收的临时 Docker MySQL 改为一次性隔离原生实例，保留 fixture、检查和清理归属保护。若要求 CI 也完全脱 Docker，正式 CI 的这些入口必须完成替换。

通过条件：制品身份、原生读回、49 条前后检查及失败回滚在隔离演练中实际通过；受影响 CI 有准确源树证据。未通过时沿用线上原运行方式。

## 7. 阶段五：批准后切换、验证和回滚

切换前逐项确认：

- 精确源码/制品清单及现场基线已批准；生产没有其他发布在改变基线。
- 注册原任务和窗口已得到保留或单独退役安排；充值处于未付款的可停止状态。
- 备份/恢复演练、最终数据一致性、证书、资源余量、依赖审计和原生隔离检查通过。
- 新鲜的切换前 49 项全部执行、无不可用项、符合原财务门禁；配置和业务数据没有未经批准的改变。
- 切换顺序、唯一数据库主写入口、服务依赖、回滚触发条件及操作人明确，回滚点已验证。

切换依次处理数据库连接、API/媒体/Worker、管理端与网关，按依赖逐项读回。验证 API liveness/readiness、静态 build ID、进程及实际源码身份、数据库连接、内部回调、HTTPS 和切换后 49 项；业务验收独立记录，充值仍在扣款前等待确认。

任何身份/数据/健康门禁失败即停止开放流量。开放业务写入前可以回切原服务和原数据库；开放后已有新数据时必须先冻结写入，完成经审阅的数据回同步或前向修复，禁止直接接回旧数据副本。单纯改回 `current` 指针不算数据库回滚证明。

## 8. 退役 Docker 与控制持续增长

七个服务、迁移、备份、恢复演练、发布及 CI 验收均通过原生入口且不再调用 Docker，才达到完整脱离。稳定观察及回滚保留期结束后，另行审阅 Docker 镜像/容器/卷的精确退役清单；本方案不授权删除生产卷、备份、证书或旧任务数据。

原生运行仍会产生浏览器安装、依赖、发布包、日志和备份。依赖与浏览器按锁文件摘要复用，避免每次发布重新复制安装；发布包保留当前和必要回滚版本，封存审计所需制品单独登记。给日志、临时文件和备份设置容量/期限上限，失败候选和缓存另有可恢复清单；原历史证明链仍被合同引用时保留，先设计独立封存证明再评估回收。

最终交付分别报告：本机无 Docker 实际验收、线上原生部署、财务门禁、真实业务结果和 Docker 退役结果。本轮已完成本机空库联调，并补齐下述原生工具。生产数据、副本恢复、Linux 服务、发布和 Docker 退役仍需完成。

## 源码依据与后续实施路径

- `docker-compose.aws-mysql.yml`：七常驻服务、迁移、数据卷、内部地址、隔离与资源基线。
- `.nvmrc`、`apps/api/package.json`、`apps/admin/package.json`、`apps/api/Dockerfile.mysql`、`apps/admin/Dockerfile`：原生 Node 入口、构建产物与 Prisma。
- `apps/api/src/id-business-v2/auto-recharge/worker/{Dockerfile,requirements.lock.txt,install_fingerprint_browser.py,server.py}`：Python/浏览器依赖、角色、callback 和固定 8051；`apps/api/src/id-business-v2/workspace/media-resolver/{Dockerfile,server.py,prepare_f2.py}`：媒体依赖与端口。
- `deploy/caddy/Caddyfile.aws`、`deploy/nginx/admin.conf`：网关、证书存储关联、代理及安全规则；`deploy/systemd/`：现有备份/演练/性能定时服务仍要求 `docker.service`。
- `scripts/production-release/{build-images.sh,push-images.sh,dispatch.sh,remote-deploy.py}`、`.github/workflows/production-release.yml`：当前镜像构建、发布、健康/身份与回滚；`remote-deploy.py` 的 `compose`、`service_state`、`registration_recovery_finance_audit` 是硬绑定入口。
- `scripts/v2-registration-finance-audit.mjs`、`scripts/acceptance-v2-financial-integrity.mjs`、`scripts/acceptance-v2-rollback-integrity.mjs`、`.github/workflows/quality.yml`：原 49 规则、固定审计运行路径和一次性数据库验收。
- `scripts/{backup-aws-mysql.sh,verify-aws-mysql-backup.sh,audit-aws-mysql-performance.sh}`：备份、恢复保护及性能检查运输方式。

原生产发布脚本、Compose、备份定时器和正式 CI 的 Docker 分支保留；原生入口单独执行，不用旧镜像身份冒充原生证明。本轮生成了候选 systemd 配置，但没有安装或启用。
