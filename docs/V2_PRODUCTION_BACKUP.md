# AWS MySQL 生产备份

## 目标

- 每 30 分钟生成一份事务一致的 MySQL 逻辑备份，正常调度目标 RPO 为 35 分钟内；任务失败或 EC2 停机会扩大实际 RPO。
- EC2 本地默认最多保留 48 份，同时受 1 GiB 总容量上限保护。
- 每份备份必须上传到跨服务器的私有 S3 存储桶，不允许只留在 EC2。
- 备份使用 S3 服务端 AES-256 加密。
- 上传后核对远端对象大小和 SHA-256，失败时 systemd 任务返回非零状态。
- 每周从 S3 下载最新备份，恢复到无网络端口的临时 MySQL 8.4 容器进行验证。

## 配置

`.env.aws.production` 中设置：

```text
MYSQL_BACKUP_S3_BUCKET=<private-bucket>
MYSQL_BACKUP_S3_PREFIX=mysql/daily
MYSQL_BACKUP_S3_REGION=ap-northeast-1
MYSQL_BACKUP_LOCAL_RETENTION_COUNT=48
MYSQL_BACKUP_LOCAL_MAX_BYTES=1073741824
MYSQL_BACKUP_MIN_FREE_BYTES=2147483648
```

`MYSQL_BACKUP_S3_BUCKET` 是强制项。S3 存储桶当前使用生命周期策略保留 90 天，过期对象会自动清理，
不占用 EC2 磁盘。EC2 IAM Role 只授予该 bucket/prefix 需要的
`PutObject`、`GetObject` 和必要列表权限，不在环境文件保存 AWS Access Key。

服务器必须安装 Docker、AWS CLI、gzip、OpenSSL 和 util-linux（提供 `flock`）。

## 执行

```bash
sudo systemctl start id-business-v2-mysql-backup.service
sudo journalctl -u id-business-v2-mysql-backup.service -n 100 --no-pager
```

脚本会：

1. 从当前发布的 `.env.aws.production` 读取 MySQL 和 S3 配置。
2. 使用 `mysqldump --single-transaction --quick --hex-blob --triggers` 导出当前库。
3. 先写入 `.partial`，通过 `gzip -t` 且确认非空后再原子改名。
4. 上传到 S3 并校验远端大小和 SHA-256。
5. 只有 S3 验证成功后才轮换本机旧备份，并始终保留最新一份。

systemd 配置位于：

- `deploy/systemd/id-business-v2-mysql-backup.service`
- `deploy/systemd/id-business-v2-mysql-backup.timer`
- `deploy/systemd/id-business-v2-mysql-backup-verify.service`
- `deploy/systemd/id-business-v2-mysql-backup-verify.timer`

安装或更新后执行：

```bash
sudo install -d -o root -g root -m 0700 /opt/id-business-v2/backups/mysql
sudo install -m 0644 deploy/systemd/id-business-v2-mysql-backup.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/id-business-v2-mysql-backup.timer /etc/systemd/system/
sudo install -m 0644 deploy/systemd/id-business-v2-mysql-backup-verify.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/id-business-v2-mysql-backup-verify.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now id-business-v2-mysql-backup.timer
sudo systemctl enable --now id-business-v2-mysql-backup-verify.timer
sudo systemctl list-timers 'id-business-v2-mysql-backup*'
```

## 恢复演练

手工验证 S3 最新备份：

```bash
sudo systemctl start id-business-v2-mysql-backup-verify.service
sudo journalctl -u id-business-v2-mysql-backup-verify.service -n 100 --no-pager
```

验证指定的本地备份：

```bash
sudo /opt/id-business-v2/current/scripts/verify-aws-mysql-backup.sh \
  --archive=/opt/id-business-v2/backups/mysql/id-business-v2-YYYYMMDDTHHMMSSZ.sql.gz
```

脚本会下载并校验 S3 SHA-256，在不发布任何宿主机端口的临时 MySQL 8.4
容器中完成导入，检查核心表、Prisma migration 和 `mysqlcheck`，结束后自动删除临时容器及下载文件。

真实事故恢复仍必须：

1. 创建独立的隔离恢复环境，禁止直接指向生产库。
2. 对比备份时点与生产的所有业务表行数。
3. 运行账务平衡、数据完整性、登录、权限和核心只读接口检查。
4. 记录 RPO、RTO、备份对象键和验证结果。

未完成隔离恢复验证前，不得覆盖生产数据。
