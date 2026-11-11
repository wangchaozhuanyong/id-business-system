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

## 新版业务实时同步到 Google 表格

Google 表格是独立的查看和筛选入口。邮箱、账号、订单、客户分别使用固定页签。邮箱包含库存邮箱和托管邮箱池，账号包含库存账号和苹果 ID 余额，客户包含客户和租户，订单包含业务订单和代充核对状态。完整资料仍由加密归档保存。表格只同步审核过的业务字段。密码、验证码、查询码、恢复资料、付款凭据、完整银行卡号和自由备注保留在原系统。

后台独立进程监听 SQLite 文件变化，每 3 秒还会检查已提交版本。单条常规变更只更新对应行。Google 调用失败时退避重试，下一轮对照实际表格再补齐。多个字段一起变更时按一个批次写入，超过请求大小才拆分。资料删除后会清除同步列中对应的旧行，表外列和其他页签不参与写入。每 5 分钟还会重新核对一次。

正式站用 Node 24 独立运行，挂载业务库为只读。私有配置文件只允许服务用户读取，字段为 `dataDir`、`workbook`（工作簿编号）、`folder`（其直属私有文件夹编号）和 `oauth`（与 Drive 备份同格式）。工作簿需归授权账号所有、保持私有，并含四张已核对表头的页签。先在独立数据和验收工作簿运行，再启用正式进程。

```sh
node server/backup/sheets-cli.mjs once --config /absolute/private/sheets.json
node server/backup/sheets-cli.mjs run --config /absolute/private/sheets.json
```

新增网站字段后，在 `sheets-source.mjs` 审核并追加允许列。已有同步列和业务字段的更新会自动同步，新增数据库列不会自动公开到表格。报告从数据库单向生成，可在另建页签上建立自己的分析公式。
