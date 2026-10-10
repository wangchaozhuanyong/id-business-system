# 开源自动注册模块生产发布控制

本次开源模块使用 `API_ADMIN_WORKSPACE` 独立范围。正式发布仅切换 API、管理端和 Caddy；
只构建 API、管理端两个本次运行的不可变镜像，Caddy 保留原固定镜像。
旧充值、旧注册、媒体与 MySQL 的容器 ID、启动时间、镜像、环境和配置必须保持。
不能使用普通 `release`、旧注册 Worker 发布入口或历史财务例外代替本范围。

## 正式入口

候选须先合入当时 `main` HEAD，取得同 SHA 的成功 push Quality Gate。
`commit` 与 `expected_current` 均填写完整 40 位 SHA；生产基线使用新鲜只读证明，不能猜测。

```bash
gh workflow run production-release.yml --ref main \
  -f operation=verify_api_workspace \
  -f commit=<通过-Quality-Gate-的-main-SHA> \
  -f expected_current=<实际生产-SHA> \
  -f historical_exception=none
```

预检成功后使用同一候选和已核实的实际基线：

```bash
gh workflow run production-release.yml --ref main \
  -f operation=release_api_workspace \
  -f commit=<同一-main-SHA> \
  -f expected_current=<同一实际生产-SHA> \
  -f historical_exception=none
```

其余输入沿用空值或默认值；不得填写镜像复用、旧 seal、缓存清理摘要或诊断命令。
预检和正式执行都重新核对原任务空闲与有效租约；保留的旧窗口不能被关闭或取消。

## 源码与运行证明

runner 构建回执绑定候选 Git tree、当前运行和 attempt、OCI revision、镜像 ID，
并对实际 API 编译产物、共享包、新模块 Python/上游源码、完整 venv、依赖审计回执及 `base.css`
生成内容摘要；管理端静态产物单独核验。运行数据、SQLite 内容和日志不进入源码证明。

镜像还须在只读、无外网的容器内通过六项离线验收：私有健康、打包资源、私有 SQLite、
加密、重启持久化和错误密钥拒绝。仅使用本次运行独有的临时卷，并在 finally 中删除该临时卷；
生产数据卷从不参与这一清理。

生产端下载完整源码归档并校验 Git tree、两份控制脚本原字节和本次镜像证明。
Compose 只允许 API 挂载 `auto_registration_data:/app/.runtime/auto-registration` 及同名顶层卷；
Caddy 只接受本次固定字节投影。环境、主 MySQL schema 和全部 migration 不变。
原 `20261008180000_quick_action_user_order` 迁移的三镜像来源、原始 manifest/证明、
当前 schema、任务和窗口仍按现有来源链复核，不重新运行迁移或授权同步。

切换前后各完整执行现有 49 项只读财务规则，49 项全部可用、违规数为 0，
且两次规则摘要相同。新鲜本地及 S3 备份、磁盘阈值和发布锁均保留。
先独立更新 Admin，再 API，最后 Caddy，各服务均使用 `--no-deps`。
API 的生产 `/api/health/ready` 必须通过真实 singleton 注册子服务的 SQLite/加密/资源健康检查。
还须核对公网首页 CSP 与候选 Caddy 配置一致。

## 数据卷与恢复边界

首次不存在或为空的生产注册卷仍沿用原受控入口。已有 SQLite 的非空卷必须经过专属保护，
不能清空卷、覆盖资料、删除历史任务或跳过门禁重试。只有日志等文件而没有数据库时仍拒绝。
预检只核验卷身份、任务和旧 API 容器本次启动以来的注册操作审计，不生成备份、围栏或改业务资料。

兼容尚无维护协议的旧 worker 时，要求本次 API 真实 `StartedAt` 以来所有注册、任务和注册
WebSocket 操作请求审计数为 0；审计缺失、容器/启动时间漂移、未知状态，以及任何旧 `cancelled`
记录均拒绝。取消或删除后的任务行不能证明原执行线程已结束，不能用空表或终态计数绕过。
新协议版本则要求没有待执行/执行中任务、加密邮箱占用或损坏资料。

旧协议正式切换还须持有 `audit_logs` 的短时 READ 屏障，并在同一连接中再次核对旧 API 本次
真实启动以来的注册修改审计数为 0。现有工作区代理在向 worker 转发修改请求或 WebSocket
操作前会等待该审计写入，屏障因此阻止新的代理修改转发；普通事后审计、GET 请求和其他
模块不作为这一保证。连接、超时或屏障失效时停止继续切换，不能用一次计数代替持锁。
已有任务与 SQLite 写屏障仍分别核验，不以审计屏障替代备份、恢复校验或线程空闲证明。

API 切换前取得 SQLite `BEGIN IMMEDIATE` 外部写锁，锁内再次扫描任务、核对逻辑指纹和旧运行期
审计，在卷根以独占创建方式写入本次 `.id-release-maintenance.json`（0600）。锁保护整个备份及
恢复证明，写锁预算为 150 秒；连接和命令另有超时，预算不足时不得停止旧 API。源数据库必须既存、0600，路径/数据库/侧车均拒绝
软链接。只用另一条 `mode=ro` 连接的 SQLite backup API 读取一致性快照，包含已提交 WAL 数据；
不能直接复制主库遗漏 WAL，也不修改源库业务状态。独立备份封存为无需 WAL 侧车的 DELETE 模式，
保存于本次 release 的 `backups/auto-registration/database.db`，目录 0700、文件 0600。

备份与源库的完整性、schema、全部业务行和密文逻辑指纹必须相同。将备份复制到仅本次使用的
带身份标签临时卷，用固定候选 API 镜像、只读根、无网络和只读副本挂载执行 `release_safety.py`：
既有密钥仅走内存/私有 stdin，验证原健康标记、全部受控密文字段、邮箱租约、任务状态及恢复
逻辑指纹。该 helper 不启动应用、不初始化数据库、不读取邮件、不执行注册。临时卷只在再次
验证本次标签后清理；生产卷和原始备份始终保留。MySQL 原有本地/S3备份继续执行，不能替代
这份 SQLite 证明。

旧 API 精确容器实际停止后才释放 SQLite 写锁，再启动候选 API。候选维护围栏阻止全部修改、
注册和 WebSocket 取消动作，保留读取和健康检查；成功完成生产回读且在围栏内确认数据仍与
备份一致后，才删除本次围栏。写锁期间原 worker 的写健康校验可能暂时不可 ready，该现象不
放宽容器 ID、镜像、启动来源或数据保护规则，也不以此强行取消或中断活动注册。
普通 `release`、`API_ADMIN` 和 `API_ADMIN_MIGRATION` 在当前配置包含注册卷、API 实际挂载该卷，
或回滚后同项目仍保留该卷时均拒绝执行；候选普通发布也不能引入注册卷来绕过本入口。
仅不重启 API 的 Admin 单独发布可继续走原入口。

成功后记录并独立回读卷名称、Docker 身份摘要和 API 的实际可写挂载；不读取或导出秘密值。
失败仅恢复实际已切换的 Admin/API/Caddy 和旧配置，始终保留新卷及其数据，不执行卷删除。
恢复 API 前须重新检查两类旧任务以及 SQLite `registration_tasks` 的受控状态：
`pending`/`running` 数量必须为 0，未知状态、损坏或不可读立即阻止 API 恢复。
新任务已开始或恢复不完整时报告 `API_ADMIN_WORKSPACE_PARTIAL_RECOVERY_REQUIRED`，保存现场，
不强制取消任务、不修改 SQLite 状态，也不声称已回滚。
准备阶段失败也必须交回本次围栏对象。仅在原/已恢复的原镜像 API 身份、空闲任务、旧运行期
审计及原逻辑数据重新核验后解除本次围栏；任何不确定保留围栏并报告 PARTIAL。不会把备份写回
生产数据库覆盖新资料；未知/外来围栏不得擅自删除，需按受控回执诊断。

## 已上线线上代充的继发兼容

只有 `ONLINE_RECHARGE` 正式发布并通过独立回读后，才能作为此入口的后继基线。
失败或只应用了部分迁移的状态不得作为发布来源。首次继发封存原代充 manifest、四镜像 proof、
保护回执、SQLite/MySQL 备份及财务检查摘要；后续 WORKSPACE 继续携带并核对同一来源封印。
旧 quick-action 来源只通过既有有限历史视图核验：先验证完整 ONLINE 迁移与九张表，再从旧
读视图中省略那一条已验证迁移，旧任务、窗口、HMAC、镜像和备份保护仍全部执行。
候选与当前主 schema、seed 和全部 migration 必须一致，`migration_plan=[]`，不执行 DDL。
Compose 的线上代充定义和共享卷按原字节保留，不接受任意新增配置。

该分支只在 WORKSPACE 内读取八个服务；历史七服务入口不变。API、Admin、Caddy 使用候选，
线上代充执行器保持原镜像、环境和卷，只重建容器以绑定 API 的新网络空间。
media-resolver、auto-recharge、auto-registration、MySQL 的容器 ID、启动身份、镜像、环境和
配置全部保持。回执将执行器列为 `servicesRebound`，不计入四个完全保留的容器。

切换前通过同一私有流式 MySQL CLI 连接对固定的 `online_recharge_tasks` 和
`online_recharge_cards` 取得短时 WRITE 锁；锁等待 5 秒，维护预算 120 秒。不修改业务行。
同连接确认 queued/running 及有效任务/卡租约数为 0，核对 MySQL 身份，再停止精确旧 API，
重核空闲并停止精确旧执行器，释放锁后启动候选 API 和原镜像执行器。失败回退也须重新取得
同一围栏并确认空闲，再恢复原 API、把原执行器绑定到恢复 API；不能用通用重建绕过代充门禁。
空闲检查拒绝前未触碰的 API/执行器不重建。围栏遗失、活动任务或恢复未证实均保留现场并报告
部分恢复；已发送的 Docker 停止请求无法撤回，不把失锁异常描述为业务线程已安全暂停。

重绑回执记录前后容器、启动及 API 网络绑定摘要，并证明镜像、环境和卷未变。
由 Docker/Compose 生成的 API 短主机名、网络目标、固定项目路径、服务 hash、重建及依赖标签
逐项验证后规范化；其余 Config、HostConfig、挂载和标签原样纳入指纹。
独立读回必须与本次预检的来源封印一致，不能省略八服务或重绑证明后退回七服务检查。
WORKSPACE 发布与独立读回入口从同一候选 SHA 下载四份固定资产：`remote-deploy.py`、
`api-admin-scope.py`、`online-recharge-scope.py` 和 `online-recharge-recovery.json`，
逐份校验本地源码对应的 SHA-256。恢复来源的固定策略随 ONLINE reader 一起传送，
其他 API scope 保持原两份控制脚本范围。该兼容不发布代充新镜像，不授权真实付款、注册、
邮件读取、业务清理或再次迁移。

## 回执位置

GitHub artifact：`api-workspace-evidence-<run>-<attempt>`，保存 runner 的
`.deploy/production-release/api-workspace-*.json`。

生产候选目录：`/opt/id-business-v2/releases/<timestamp>-<sha-prefix>/`，包括
`api-workspace-build-proof.json`、`api-workspace-preservation.json`、前后财务回执、
MySQL 备份证明及 `release-manifest.json`；非空卷另存 `api-workspace-sqlite-protection.json` 和私有
SQLite 原始备份。恢复证明摘要绑定卷、旧容器及启动时间、源数据库身份、旧/候选镜像、schema、
逻辑指纹和备份 SHA/大小，并绑定 manifest 与 preservation 回执。GitHub 仅接收受控摘要，不能
上传数据库文件、密钥、查询授权或原始业务数据。失败时另存 `api-workspace-failure.json`。
独立 SSM 回读重新绑定本次 build proof、来源链、四个保留服务、卷身份和实际健康。
WORKSPACE 预检失败时可增加 `workspaceDiagnostic`，仅包含阶段、步骤、服务、范围和异常类型的
受控枚举。步骤区分当前 API/Admin 镜像与内容、原迁移镜像及内容、schema、任务、空闲及窗口。
原门禁错误码照常保留；未知异常原文、命令输出、文件内容、环境和凭证均不进入诊断。
离线 Caddy 配置验证仍使用原固定镜像、只读根文件系统、无网络及只读配置挂载。
仅 `/data`、`/config` 使用各 16 MiB、禁止执行及设备的临时内存目录，供验证期间生成本地 PKI；
容器退出即丢弃，不挂载生产证书卷。该调用失败返回 `API_ADMIN_WORKSPACE_CADDY_VALIDATION_FAILED`。
正式上线后还须登录后台进行页面验收；健康和镜像证明不代表真实注册、邮箱、付款已执行。
