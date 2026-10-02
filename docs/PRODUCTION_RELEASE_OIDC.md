# AWS 生产发布临时授权

生产发布使用 GitHub Actions OIDC 换取最长一小时的 AWS 角色凭证。仓库和本机不保存长期 AWS Access Key；本机的交互式 `aws login` 过期不影响此工作流。

## 资源边界

- CloudFormation：`deploy/aws/id-business-v2-github-release-oidc.yaml`，栈名 `id-business-v2-github-release-access`。
- 信任来源：仅 `wangchaozhuanyong/id-business-system` 的 `main` 分支工作流；使用 GitHub OIDC 中不可变的所有者 ID 和仓库 ID 匹配 `sub`。
- 权限：向专用 ECR 仓库推送不可变镜像、向指定 EC2 实例发送 SSM 命令、读取命令结果；实例角色只增加该仓库镜像的拉取权限。
- 不授予工作流 IAM 管理、数据库直接访问或其他 EC2 实例权限。

## 使用

先核实 `main` 的 Quality Gate 已通过、生产 `current/release-manifest.json` 中的 `commit`，并审查待应用的 migration。下列值必须是完整的 40 位 SHA：

```bash
gh workflow run production-release.yml --ref main \
  -f operation=verify_access \
  -f commit=<已通过-main-Quality-Gate-的-SHA> \
  -f expected_current=<当前生产-SHA>
```

权限验证成功后，同一工作流的 `operation=release` 才会构建镜像并发布。工作流要求目标 SHA 恰好等于当时的 `main` HEAD、对应的 push Quality Gate 成功，并且生产基线等于 `expected_current`。发布会先验证只读财务巡检、运行中的自动充值任务、镜像来源和 S3 备份，再应用只包含非破坏性 SQL 的新增 migration，按服务切换并复核健康和财务数据。失败时尝试恢复原有服务镜像；已应用的向前 migration 不自动逆转。

`operation=verify_access` 同时输出生产当前 SHA、磁盘余量、容器健康和镜像来源诊断。诊断仅读取发布清单及 Docker 的指定元数据，不读取环境变量、数据库内容或凭证，不清理镜像、不重启服务。发布基础设施及 CI 范围修复运行控制检查；若同批包含业务代码，仍按相应业务范围检查。

诊断也仅读取本机 MySQL 备份的名称、数量、大小，以及 backups、releases、.staging、logs 的文件总大小，便于区分备份与构建缓存占用；不读取备份内容。备份轮换沿用 `docs/V2_PRODUCTION_BACKUP.md` 的既有策略，正式发布创建并验证 S3 备份时执行本机轮换，不清空恢复点或缩短 S3 保留期。

用户于 2026-10-02 明确要求清理备份后，可使用 `operation=verify_backups` 核验旧本机副本，再使用 `cleanup_backups` 执行本次手动清理。脚本固定保留最新 24 份及当前/上一版发布的恢复备份，持有发布锁和备份锁；最新及必要恢复点和全部候选的大小、SHA-256、S3 AES-256 均匹配后才删除旧本机副本。禁止删除 S3 对象，不改自动保留策略；任何基线或文件身份变化均阻止执行。具体记录见 `.runtime/fx-subscription-release-20261001/`。

`operation=verify_cache` 只读核验 `deploy/aws/cache-cleanup-20261001.json` 中已审核的十个历史本机镜像缓存，不执行删除。方案覆盖 `6a674279...-36845230653-1` 与 `cef5c05d...-36814755308-1` 两批各五个服务；生产基线为 `ddbcc8b5...`，上一版本为 `848d2c6c...`。用户在审核这份清单后于 2026-10-01 要求继续完成剩余发布，授权本清单清理及发布恢复。

只读核验通过后，`operation=cleanup_cache` 才应用这份清单。脚本绑定清单摘要及显式批准摘要、生产与上一版本 SHA，保护所有容器、当前与上一版发布及回滚镜像，核验 ECR 可重新拉取相同镜像 ID 后才按引用删除；不使用 force 或 prune，不删除远端镜像、发布目录、容器、数据卷、数据库或备份。其他清理范围必须重新生成方案并单独授权。执行后先读取实际磁盘余量，再决定是否可以发布。原五个缓存方案已完成，不得再次执行。

`cleanup_plan` 默认选择原 `initial_20261001` 计划，已有记录和摘要保留。换汇发布容量恢复使用 `fx_subscription_20261002`，对应 `deploy/aws/cache-cleanup-fx-subscription-20261002.json` 中两个未上线候选版本的十个引用，具体保护和恢复边界见 `docs/FX_RELEASE_CACHE_RECOVERY_20261002.md`。这份新计划先运行 `verify_cache`；只有取得用户对其清单的单独批准后才能运行 `cleanup_cache`。业务发布授权本身不替代这份新清单的批准。

姓名库发布容量恢复使用 `recharge_names_20261002`，精确清单和保护边界见 `docs/RECHARGE_NAMES_CACHE_RECOVERY_20261002.md`。这份计划仍须先只读核验，再取得用户单独批准；未批准不得执行删除。

发布控制修复后，可设置可选的 `reuse_image_run` 复用一次已完成的构建。仅当该次 main 发布的源码验证、构建和不可变镜像推送步骤全部成功，且镜像源码至当前发布源码仅有明确列出的发布控制文件变化时允许复用。服务器再次比较两份源码中所有其他文件的内容和执行权限，并核验镜像架构、原始提交标签；依赖、业务代码、数据库迁移或运行配置有任何变化都会阻止复用。发布清单分别记录当前 main SHA、真实部署运行和原镜像构建运行；备份、磁盘阈值、迁移、财务巡检、健康和回滚检查均保留。

```bash
gh workflow run production-release.yml --ref main \
  -f operation=release \
  -f commit=<已通过-main-Quality-Gate-的-SHA> \
  -f expected_current=<当前生产-SHA>
```

迁移后按现有数据库权限规则为新增表同步应用账号权限，并核验运行、迁移和备份账号权限。同步只覆盖本次新增 migration 创建的表，不重置账号或密码；权限验证失败时不切换业务服务。

发布后仍要核对 GitHub Actions 运行结果、服务器 `release-manifest.json` 的 SHA、公开健康接口和实际登录后的页面操作。工作流的健康检查不能替代人工浏览器验收。

生产基线到目标 main 的差异满足现有管理端范围规则时，仅构建、推送和更新 admin，沿用当前其他服务的镜像及来源记录；服务器仍验证备份、财务只读巡检和公共健康，且核验未更新服务完全保持原状态。此范围不得包含 migration、API、共享包、依赖或认证改动；否则使用原完整发布流程。纯管理端发布不启动迁移容器。

服务器充值执行链容量恢复使用 `cleanup_plan=recharge_execution_20261002`，精确清单和恢复记录见 `docs/RECHARGE_EXECUTION_CACHE_RECOVERY_20261002.md`。先执行只读 `verify_cache`；只有用户单独批准该清单后才能执行 `cleanup_cache`。绑定生产 `63e7c3b9...`、上一版 `a9530728...` 和五个 `c59861de...-36965061061-1` 历史本机引用，保留当前／上一版、候选和全部远端镜像。恢复发布指定 `reuse_image_run=36993584579`，不重复构建已验证且应用源码未改变的镜像。

生产网关 `deploy/caddy/Caddyfile.aws` 变化时，完整发布先校验新配置，再切换 Caddy 并核对公网响应的安全策略；失败时和业务服务一起恢复旧配置。仅管理端发布禁止携带网关配置变更。比特网页直连仅放行本机 HTTP 与 WebSocket，仍禁止任意远程连接和不可信脚本。

发布命令失败时回传受控错误类型、脚本行号及固定失败原因，不输出任意原始错误或业务内容。需要补查某次发布失败时，`verify_access` 可填写该次工作流已显示的 `diagnostic_command_id`；只读取指定实例和命令的执行结果，不重新发布。
