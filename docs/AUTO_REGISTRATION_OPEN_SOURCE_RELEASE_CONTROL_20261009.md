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

本入口当前只接纳首次不存在或为空的生产注册卷。
若卷已有 SQLite、日志或其他文件，返回 `API_ADMIN_WORKSPACE_SQLITE_BACKUP_REQUIRED`，
不得清空卷、覆盖资料或跳过门禁重试。
后续重发必须先补齐明确的 SQLite 在线一致性备份、备份完整性和恢复证明，
并在发布期间保护任务状态；现有 MySQL 备份不能替代该证明。
本范围暂不提供有数据卷的重发入口。
普通 `release`、`API_ADMIN` 和 `API_ADMIN_MIGRATION` 在当前配置包含注册卷、API 实际挂载该卷，
或回滚后同项目仍保留该卷时均拒绝执行；候选普通发布也不能引入注册卷来绕过本入口。
仅不重启 API 的 Admin 单独发布可继续走原入口。

成功后记录并独立回读卷名称、Docker 身份摘要和 API 的实际可写挂载；不读取或导出秘密值。
失败仅恢复实际已切换的 Admin/API/Caddy 和旧配置，始终保留新卷及其数据，不执行卷删除。
恢复 API 前须重新检查两类旧任务以及 SQLite `registration_tasks` 的受控状态：
`pending`/`running` 数量必须为 0，未知状态、损坏或不可读立即阻止 API 恢复。
新任务已开始或恢复不完整时报告 `API_ADMIN_WORKSPACE_PARTIAL_RECOVERY_REQUIRED`，保存现场，
不强制取消任务、不修改 SQLite 状态，也不声称已回滚。

## 回执位置

GitHub artifact：`api-workspace-evidence-<run>-<attempt>`，保存 runner 的
`.deploy/production-release/api-workspace-*.json`。

生产候选目录：`/opt/id-business-v2/releases/<timestamp>-<sha-prefix>/`，包括
`api-workspace-build-proof.json`、`api-workspace-preservation.json`、前后财务回执、
MySQL 备份证明及 `release-manifest.json`；失败时另存 `api-workspace-failure.json`。
独立 SSM 回读重新绑定本次 build proof、来源链、四个保留服务、卷身份和实际健康。
WORKSPACE 预检失败时可增加 `workspaceDiagnostic`，仅包含阶段、步骤、服务、范围和异常类型的
受控枚举。步骤区分当前 API/Admin 镜像与内容、原迁移镜像及内容、schema、任务、空闲及窗口。
原门禁错误码照常保留；未知异常原文、命令输出、文件内容、环境和凭证均不进入诊断。
离线 Caddy 配置验证仍使用原固定镜像、只读根文件系统、无网络及只读配置挂载。
仅 `/data`、`/config` 使用各 16 MiB、禁止执行及设备的临时内存目录，供验证期间生成本地 PKI；
容器退出即丢弃，不挂载生产证书卷。该调用失败返回 `API_ADMIN_WORKSPACE_CADDY_VALIDATION_FAILED`。
正式上线后还须登录后台进行页面验收；健康和镜像证明不代表真实注册、邮箱、付款已执行。
