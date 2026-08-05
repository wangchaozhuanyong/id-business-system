# V2 生产数据库免费备份与恢复

## 目标与边界

- Supabase 保持免费方案，不启用 PITR，不使用 R2 或其他可产生固定费用的存储。
- GitHub Actions 每小时第 17 分钟生成一次加密逻辑备份；小时备份只保留最新 2 份，北京时间
  03:17 的备份额外保留 30 天。
- 目标 RPO 为 1 小时以内、目标 RTO 为 30 分钟以内。GitHub 定时任务不是严格 SLA，工作流延迟会
  增加实际 RPO。
- PostgreSQL dump 只包含数据库及 Supabase Storage 元数据，不包含 Storage 对象本身。

## 安全模型

- `id_v2_backup` 是唯一日常备份角色，使用 `BACKUP_DATABASE_URL`。它可以读取全部数据并绕过 RLS，
  但没有业务表写入、DDL、TRUNCATE、创建数据库、创建角色或复制权限。
- Supabase 的 `pg_net`/`pg_cron` 扩展对 3 张内部表和 1 个序列持续授予 `PUBLIC` 写权限，免费托管
  项目的管理员不能可靠撤销。脚本固定校验这些对象是唯一例外，并强制角色默认只读事务；因此这是
  “业务数据只读”，不是 PostgreSQL 全局绝对零写。例外集合漂移时角色创建必须失败。
- `MIGRATION_DATABASE_URL` 只用于离线创建或轮换备份角色，不进入定时工作流。
- dump 先写入 `.partial`，必须通过非零检查、`pg_restore --list`、核心表计数和 SHA-256 后才成立。
- 上传前使用随机 AES-256-GCM 内容密钥加密；内容密钥使用 RSA-4096/OAEP-SHA256 公钥封装。
- GitHub Artifact 中只有 `.backup.enc` 和不含业务数据的 receipt。明文 dump 在工作流退出前删除。
- 加密私钥不进入 Git、GitHub Secret 或 Artifact；私钥使用口令加密，口令保存在 macOS Keychain。

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

当前 dump 约 2.4 MiB，2 个小时备份和 30 个每日备份预计约 80 MiB。数据库增长导致单份备份接近
12 MiB 时，应先缩短每日保留或选择新的免费存储方案，再修改上限。

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
