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
