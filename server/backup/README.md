# 独立新版 SQLite 本机备份与旁路恢复

Node 24 自带的 SQLite Backup API 从只读源连接取得一致快照。它读取已提交数据，包括 WAL 中还未写回主文件的记录。快照使用单个 SQLite 文件保存，另附记录字节数、SHA-256、文档和审计数量的清单。校验会核对清单、运行 SQLite 完整性检查，并检查独立新版的业务表结构。恢复再次校验目标副本，然后用现有业务存储逐个打开加密文档和审计记录。

快照目录只包含 `local-business.sqlite` 和 `manifest.json`，均为 0600。密钥保存在快照包外。恢复命令从单独保管的 32 字节文件读取密钥，在新的恢复目录写入仅当前用户可访问的 `local-business.sqlite.key`。目录权限为 0700。命令输出只有状态、校验值和计数。数据库中的业务文档保持加密，现有审计元数据仍按源库格式保留。SHA-256 可发现文件与清单不符，两者一并被替换时仍需可信保管记录确认来源。

## 重复运行合成演练

从独立新版 Git 根运行。下面的生成命令只创建独立的合成目录。

```sh
mkdir -p backups
drill_dir="$(mktemp -d ./backups/sqlite-drill.XXXXXX)"
mkdir -m 700 "$drill_dir/synthetic"

node --input-type=module - "$drill_dir/synthetic/fixture.sqlite" <<'JS'
import { createLocalBusinessStore } from './server/local-business.mjs';
const store = createLocalBusinessStore(process.argv[2]);
try {
  store.saveBatch([{
    domain: 'commerce', version: 0, action: '新增独立订单',
    data: {
      customers: [{ id: 'fixture-customer', name: '合成客户' }],
      tenants: [], operating: [], rentBatches: [], logs: [],
      orders: [{
        id: 'fixture-order', orderNo: 'FIXTURE-1', customerId: 'fixture-customer',
        payment: '银行卡', cardId: 'fixture-card', paidConfirmed: true,
        paidAmount: '1000', paidCurrency: 'PHP', saleAmount: '250', saleCurrency: 'CNY',
        receiptConfirmed: true,
        refunds: [{ id: 'fixture-refund', amount: '70', currency: 'CNY', payment: '银行卡' }],
        bankReturns: [{ id: 'fixture-return', cardId: 'fixture-card', amount: '200', currency: 'PHP' }]
      }]
    }
  }]);
} finally {
  store.close();
}
JS

node server/backup/cli.mjs snapshot \
  --source "$drill_dir/synthetic/fixture.sqlite" --output "$drill_dir/snapshot"
node server/backup/cli.mjs verify --input "$drill_dir/snapshot"
node server/backup/cli.mjs restore \
  --input "$drill_dir/snapshot" --key "$drill_dir/synthetic/fixture.sqlite.key" \
  --output "$drill_dir/restored"
```

所有路径须位于本项目内，目标的父目录须已存在。快照和恢复目标均须为新目录，失败返回退出码 1。已有目标会拒绝覆盖。发现 SQLite 附属文件、密钥混入快照包、清单不匹配或业务回读失败时停止。空业务快照可以生成并校验，但无法证明密钥匹配，恢复命令会提示并停止。恢复目录在命令成功后才可作为独立读回位置。

`node --test test/backup-local-sqlite.test.mjs` 会自动使用合成资料执行 CLI，覆盖 WAL 已提交／未提交数据的边界、原样读回订单及客户退款和银行卡回款、库存、工具箱与审计，以及错误密钥、损坏快照和已存在目标。测试使用的临时文件都归本项目 `backups/`，演练结束后清理。

范围是本机业务 SQLite。账号配置文件、其他运行库、密钥的长期独立保管和 Google Drive 上传需要分别处理。本次仅对合成库执行备份与恢复。

## 独立进程的 Google Drive 备份候选

现行新版把邮箱、账号、订单和客户存到同一套独立业务库。后台进程用只读连接每 5 秒检查提交变化，复用 SQLite 在线备份 API，在独立私有磁盘制作一致快照。每个归档是独立可恢复的全量快照，包含实际保存的列和密文文档。备份和 Drive 上传都不在网站请求内执行。使用 AES-256-GCM 加密压缩后的快照和清单，用离线 RSA 公钥封装随机密钥。

进程在源库持续可用、Drive 授权有效且磁盘有空间时采集。Drive 中断期间先保留待传密文，再继续采集最新提交。每个批次的 Drive 文件编号先持久化，重启后先核对远端文件，避免丢失成功响应时重复建文件。上传分块受带宽限制，校验目录、来源、字节数和 SHA-256。既有云端归档不自动删除。

在隔离 Linux 中使用单独的服务账号或同一应用账号的独立进程，提供 Node 24 和 `flock`。私有配置文件权限为 0600。配置字段为 `dataDir`（新版持久数据目录）、`outbox`（独立的 0700 持久目录）、`source`（安装专用 UUID）、`recipientFile`（恢复公钥）、`root` 和 `folder`（备份根目录与其直属全量子目录），以及独立的 `oauth.clientId`、`oauth.clientSecret`、`oauth.refreshToken`。OAuth 凭据通过服务私有配置提供。使用文件范围授权的应用必须能访问指定子目录。

```sh
node server/backup/cloud-cli.mjs preflight --config /absolute/private/config.json
node server/backup/cloud-cli.mjs run --config /absolute/private/config.json
node server/backup/cloud-cli.mjs unpack --input /absolute/opaque.idbackup \
  --output ./backups/new-verified-snapshot --key /absolute/private/recovery.pem
```

下载解密后的快照复用本页的 `restore` 命令和原新版 SQLite 字段加密密钥。业务库密钥和归档私钥分别在受管环境保管。员工登录文件、外部邮件服务器原件、独立的支付执行库和仅在其他目录中的附件，需要单独核对来源。可读 Google 表格属于另外的投影输出，当前候选只有可恢复的加密归档。

上线前先用新建隔离环境和虚构记录验证源库、应用 OAuth、断线重试、下载及隔离恢复。用相同数据和并发记录启用前后库存和商务接口的 p95，同时测量提交到云端可读的时间。正式环境首次备份在独立进程中验证，线上检查使用读取操作。
