# AWS MySQL 生产备份

## 目标

- EC2 本地保留可快速恢复的 gzip SQL 备份。
- 每份备份上传到跨服务器的私有 S3 存储桶。
- 备份使用 S3 服务端 AES-256 加密。
- 上传后核对远端对象大小，失败时 systemd 任务返回非零状态。

## 配置

`.env.aws.production` 中设置：

```text
MYSQL_BACKUP_S3_BUCKET=<private-bucket>
MYSQL_BACKUP_S3_PREFIX=mysql/daily
MYSQL_BACKUP_S3_REGION=ap-northeast-1
```

EC2 IAM Role 只授予该 bucket/prefix 需要的 `PutObject`、`HeadObject` 和必要列表权限，不在环境文件保存 AWS Access Key。

## 执行

```bash
sudo /opt/id-business-v2/current/scripts/backup-aws-mysql.sh
```

脚本会：

1. 从当前发布的 `.env.aws.production` 读取 MySQL 和 S3 配置。
2. 使用 `mysqldump --single-transaction --quick --hex-blob --triggers` 导出当前库。
3. 先写入 `.partial`，通过 `gzip -t` 且确认非空后再原子改名。
4. 上传到 S3 并校验远端大小。

systemd 配置位于：

- `deploy/systemd/id-business-v2-mysql-backup.service`
- `deploy/systemd/id-business-v2-mysql-backup.timer`

## 恢复演练

恢复必须先在隔离 MySQL 8.4 实例完成：

1. 校验 gzip 文件和 S3 对象信息。
2. 导入全新空库，禁止指向生产库。
3. 对比所有业务表精确行数。
4. 校验外键、账务平衡、登录、权限和核心只读接口。
5. 记录 RPO、RTO、备份对象键和验证结果。

未完成隔离恢复验证前，不得覆盖生产数据。
