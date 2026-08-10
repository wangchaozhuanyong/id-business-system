# V2 生产数据库免费备份与恢复

## 目标与边界

- Supabase 保持免费方案，不启用 PITR；R2 未配置凭据前不创建外部资源或产生费用。
- GitHub Actions 每小时第 17 分钟生成一次加密逻辑备份；小时备份只保留最新 2 份，北京时间
  03:17 的备份额外保留 30 天。
- 一台保持开机和联网的 macOS 运维机每小时 05、20、35、50 分钟生成独立加密备份，目标 RPO 为
  15 分钟；GitHub 异地备份仍是运维机离线时的后备。两种免费定时任务都不是严格 SLA，延迟或设备
  休眠会增加实际 RPO。
- 目标 RTO 为 30 分钟以内。实际恢复前仍必须先做隔离恢复验证。
- PostgreSQL dump 只包含数据库及 Supabase Storage 元数据，不包含 Storage 对象本身。

## 安全模型

- `id_v2_backup` 是唯一日常备份角色，使用 `BACKUP_DATABASE_URL`。它可以读取全部数据并绕过 RLS，
  但没有业务表写入、DDL、TRUNCATE、创建数据库、创建角色或复制权限。
- Supabase 的 `pg_net`/`pg_cron` 扩展对 3 张内部表和 1 个序列持续授予 `PUBLIC` 写权限，免费托管
  项目的管理员不能可靠撤销。脚本固定校验这些对象是唯一例外，并强制角色默认只读事务；因此这是
  “业务数据只读”，不是 PostgreSQL 全局绝对零写。例外集合漂移时角色创建必须失败。
- `MIGRATION_DATABASE_URL` 只用于离线创建或轮换备份角色，不进入定时工作流。
- dump 先写入 `.partial`，必须通过非零检查、`pg_restore --list`、核心表计数和 SHA-256 后才成立。
- 高频备份使用本机原生 PostgreSQL 17 客户端、一个只读连接和单进程 `pg_dump`；数据库不新增备份
  表，不把备份文件写入数据库，也不要求 Docker Desktop 常驻。原生进程以低优先级运行，命令
  15 分钟超时，临时文件达到 16 MiB 时终止；明文 dump 超过 12 MiB 会在读入加密进程前失败并
  告警，不能自动扩大上限。
- GitHub 异地备份继续使用受限 Docker 容器：1 CPU、256 MiB 内存、64 个进程和 16 MiB 单文件。
- 上传前使用随机 AES-256-GCM 内容密钥加密；内容密钥使用 RSA-4096/OAEP-SHA256 公钥封装。
- GitHub Artifact 中只有 `.backup.enc` 和不含业务数据的 receipt。明文 dump 在工作流退出前删除。
- 加密私钥不进入 Git、GitHub Secret 或 Artifact；私钥使用口令加密，口令保存在 macOS Keychain。

## 15 分钟本机第二执行器

- 高频文件使用 `backups/postgres/local-15m-*` 专用前缀；轮换程序不接触手工备份、发布保护备份或
  恢复报告。
- 本机只保留最新 1 份有效加密备份，同时设置 16 MiB 总容量硬上限；生成前还要求磁盘至少有
  2 GiB 可用空间。新备份必须先完成校验，成功后才删除上一份；新备份失败时保留原有备份。
- 明文 `.partial`、不成对密文或无效 receipt 超过 1 小时后自动清理；正常成功时明文立即删除。
- 监控每 5 分钟检查一次。最新成功备份超过 20 分钟、任务失败、文件无效或超过容量上限时显示
  macOS 通知；相同告警 1 小时内不重复弹出。
- launchd 的标准输出和错误输出都写入 `/dev/null`，状态仅保存在几个大小固定、每次覆盖的 JSON
  文件中，避免日志长期增长。
- 原生客户端固定为 Postgres.app PostgreSQL 17.10 Universal 中经过签名和 SHA-256 校验的
  `pg_dump`、`pg_restore`、`psql` 及最小动态库集合，安装在
  `~/.local/share/id-business-v2/postgresql-17.10`，约 16 MiB；不安装或启动本地数据库服务。
  来源资产是 Postgres.app v2.9.5 的 `Postgres-2.9.5-17.dmg`，发布资产 SHA-256 为
  `9189567e943edfa2441c4bc72751bcfb9b417fb3f7cc32d2252991e92b22d2d0`；每次执行前还会校验所用
  命令和动态库的固定摘要与版本。

首次安装必须先手动生成并检查一份真实只读备份：

```bash
npm run backup:frequent
npm run backup:frequent:check
npm run backup:frequent:install -- --checkout=/absolute/path/to/ID业务管理系统
```

安装后用 `launchctl print gui/$UID/com.id-business-v2.frequent-production-backup` 和对应的
`frequent-production-backup-monitor` 服务确认任务已加载。运维机长期关机时，15 分钟目标不成立，
仍由 GitHub 小时备份兜底。

日常15分钟备份不依赖 Docker Desktop。隔离恢复演练仍使用临时 PostgreSQL 容器，只有执行恢复演练
时才需要启动 Docker；演练结束会删除临时容器。

## 运维命令

初始化密钥仅执行一次。私钥目录必须是本机受保护的 `.deploy` 目录：

```bash
npm run backup:key:generate -- \
  --private-key=/absolute/path/.deploy/backup-recovery-private.pem \
  --public-key=/tmp/backup-recovery-public.pem \
  --allowed-private-root=/absolute/path/.deploy
```

创建或轮换生产只读角色前，必须提供最新有效生产备份：

```bash
npm run backup:role:provision -- \
  --apply \
  --backup=/absolute/path/latest.dump \
  --backup-sha256=<64位SHA-256> \
  --confirmation=PROVISION_BACKUP_ROLE_fjquufgbnxyocmuzltxi_<SHA前12位> \
  --secrets-file=/absolute/path/.deploy/cloudflare-free.secrets.json
```

本机手动备份：

```bash
npm run backup:production -- \
  --label=manual-protection \
  --confirmation=BACKUP_fjquufgbnxyocmuzltxi_manual-protection \
  --public-key=deploy/backup-recovery-public.pem
```

验证明文备份：

```bash
npm run backup:verify -- --backup=/absolute/path/file.dump
```

验证加密备份时，先从 Keychain 读取口令到当前进程环境，不得回显或写入 shell 历史：

```bash
BACKUP_PRIVATE_KEY_PASSPHRASE="$(security find-generic-password \
  -s id-business-v2-production-backup -a "$USER" -w)" \
npm run backup:verify -- \
  --archive=/absolute/path/file.backup.enc \
  --private-key=/absolute/path/.deploy/backup-recovery-private.pem
```

隔离恢复演练：

```bash
RESTORE_TARGET=isolated \
BACKUP_PRIVATE_KEY_FILE=/absolute/path/.deploy/backup-recovery-private.pem \
BACKUP_PRIVATE_KEY_PASSPHRASE="$(security find-generic-password \
  -s id-business-v2-production-backup -a "$USER" -w)" \
bash scripts/restore-postgres.sh /absolute/path/file.backup.enc
```

恢复演练只会创建名称带 `id-v2-restore-drill-` 的临时 PostgreSQL 17.6 容器；无论成功或失败都会
删除容器和解密后的临时文件。禁止把该脚本改为直接连接生产库。

## GitHub 配置与免费额度

1. 创建 GitHub Environment `production-backup`，只允许 `main` 分支部署。
2. 在该 Environment 写入 `BACKUP_DATABASE_URL`，不要配置 migration 或运行时管理员凭据。
3. Actions/Packages 支出预算保持 0 美元。
4. 工作流单份密文硬限制为 12 MiB，备份 Artifact 总量预警线为 400 MiB。
5. 超过限制时工作流必须失败并通知管理员，不得通过提高付费额度继续执行。

2026-08-10 首次本机高频加密归档约 3.6 MiB。数据库增长导致单份备份接近 12 MiB 时，应先缩短
每日保留或选择新的免费存储方案，再修改上限。

R2 只能在已有 Cloudflare 账号、已确认免费额度并提供最小权限的 R2 专用凭据后启用。不得复用
Cloudflare 部署管理员凭据，也不得为了自动化自行开通付费；未满足这些条件时，本机第二执行器加
GitHub Artifact 是当前的双执行器方案。

## 验收和月度演练

- 首次启用后人工触发一次 `Production Database Backup`，确认工作流中没有数据库地址、密码、卡号、
  用户资料或明文 dump。
- 下载密文，用离线私钥执行一次完整恢复演练，核对 migrations、外键有效性、核心表计数和财务借贷
  平衡。
- 每月重复一次恢复演练并保留只读 JSON 结果；只看到工作流成功或 Artifact 存在不能算恢复成功。
- 合并后的稳定运维 checkout 可执行 `npm run backup:drill:install -- --checkout=<绝对路径>
--private-key=<绝对路径>` 安装 launchd；每月 1 日本机时间 04:17 自动下载最新每日备份并演练。
- 私钥至少保存两份：本机加密私钥和用户控制的密码管理器或离线介质。第二份完成前，灾备状态只能
  标记为“部分完成”。

## 事故恢复

1. 先停止业务写入并生成新的保护性备份，不删除任何现有归档。
2. 选择事故前最近的小时或每日密文，核对 receipt 的 SHA-256。
3. 始终先恢复到隔离环境，生成表计数和内容差异清单。
4. 生产恢复使用事故专用、参数化、可回滚脚本；不得使用 `pg_restore --clean` 直接覆盖生产库。
5. 免费方案没有 PITR，备份时点后的数据必须根据审计和业务凭据人工复核，不能猜测敏感字段。
