# 财务迁移前输入适配

适配器读取独立新版隔离 JSON，输出可以直接交给 `reconcile-cli.mjs` 的 `commerce`、`appleBalance` 和 `migration` 文档。运行命令只在标准输入和标准输出之间处理数据。

```sh
node server/finance/migration-input-cli.mjs --demo |
  node server/finance/reconcile-cli.mjs --as-of 2026-11-05T06:00:00.000Z
```

合成批次有 2 笔可核算订阅、1 笔待核算订阅和 1 笔单独列出的旧通用订单。改用实际整理后的隔离导出时，省略 `--demo`，把 JSON 从标准输入送入适配器。输入契约错误退出码为 1。字段证据缺口进入逐单报告，可由下游 `--strict` 返回退出码 2。已经是独立新版 `commerce.orders`、`appleBalance` 文档形状的订单，包括 Claude，直接交给原核对命令。

## 已核对来源

输入顶层是 `{ "schema": "id-finance-migration-v1", "orders": [...] }`。每项包含 `kind`、`order` 及 GPT 订阅需要的 `evidence`。补充凭据必须提供与原订单完全相同的 `evidence.orderId`。来源类型与订单编号共同确定身份。系统保留同一编号的不同来源记录，订单关联只使用已确认的稳定编号。

- `legacy-id-business-order` 对应旧仓库当前 Prisma 的 `IdBusinessV2Order`，已只读核对源码 `apps/api/prisma/schema.prisma`，参考提交 `b922b2d9`。输出 `excludedLegacy` 包含其订单编号和可读的 `receivedOriginalAmount`／`receivedCurrency`，供独立复核。这组字段只说明记录的收款原币。旧单的 `receivedAmount`、`refundCostAmount`、`profitAmount`、`receivedFxRateToCny` 和 `IdBusinessV2OrderBalanceReturn.returnedBalanceAmount` 属于其自身口径，均留在旧单。
- `gpt-subscription-v2` 使用独立新版 [订阅契约](../../modules/contracts/subscription-orders.ts) 的 `V2GptBankOrderRecord`、`V2GptBankFeeRule`、`V2SubscriptionAppleRefund` 和 `V2SubscriptionAppleWalletEntry` 财务字段。独立新版的 Claude 类型是录入契约，缺少对应的完整持久化订单投影。原始 Claude 导出应先核对来源并整理为已支持的独立新版订单文档。

## GPT 订阅字段映射

| 原始证据 | 送入对账的字段 | 核对条件与缺口 |
| --- | --- | --- |
| `id`、`orderNo`、`plan`、`paymentMethod` | 订单编号、GPT 产品、银行卡／Apple 内购 | 套餐和支付类型须在已核对订阅契约内 |
| `openedAt`、`dueAt`、`cancelledAt` | `start`、`expiry`、撤单状态 | 使用带 `Z` 的 UTC 时点，保留实际发生时间 |
| `paidAmount`／`paidCurrency`、`saleAmount`／`saleCurrency`、三项确认标志 | 原币代付、实收和确认状态 | 十进制字符串；币种与支付契约一致；明确为真的标志才视为确认 |
| `cardId`、`appleAccountId` | `cardId`、`appleIdId` | 使用稳定编号；尾号、邮箱和名称只作业务显示 |
| `feeRuleVersion`、`evidence.feeRule` | `costSettings.version`、比例手续费和美元固定／开卡费 | 证据版本须与订单指向的版本相同。未找到版本时留缺口 |
| `evidence.emailCost`、`evidence.issueFeeSnapshot` | 标准规则的邮箱成本和一次性开卡费 | 邮箱成本须明确金额和币种；开卡费须绑定原卡和版本。确认为零或未计入时需有明确记录 |
| `costBasis`、`evidence.actualCost` | 实际总成本原币，适用时含 Apple 可收回部分 | 使用退回前总成本。已换算的 `effectiveCost*`、`originalProfit*`、`profit*` 和 `appleRecoveredCostCny` 只用于额外人工比对 |
| `evidence.fxSnapshot` | `fxSnapshot` | 兼容的冻结对象原样复制，沿用核对引擎校验时点、来源与币种。只有旧单汇率或未知格式时留缺口 |
| `evidence.customerRefunds` 和订单 `customerRefundTotal` | 逐笔客户退款 | 校验退款 ID、订单 ID、原实收币种和总额。汇总为零仍需明确空数组 |
| `evidence.bankReturns` | 逐笔实际回款 | 校验回款 ID、订单 ID、原卡 ID 和原代付币种。空数组表示明确零笔 |
| `evidence.apple.allocation` | Apple 扣款分配 | 使用已核对的独立新版分配形状，按原订单和原 Apple ID 核对。钱包当前余额没有单笔扣款信息 |
| `evidence.apple.refunds` | 客户退款与 Apple 预期／实际回款状态 | 使用复制的 Apple 退款 DTO。预期金额和实际入账分开验；状态为已到账时须有实际时点和账本记录 ID |
| `evidence.apple.walletEntries` | Apple 扣款与到账流水 | 每项是 `{ appleAccountId, entry }`，按原钱包、订单、流水编号和金额核对。已确认的订阅扣款 debit 和有对应回款记录的 credit 才可直接适配 |

标准成本的 `emailCost` 为 `{amount,currency}`，`issueFeeSnapshot` 为 `{cardId,applied,amountUsd?}`。实际成本为 `{amount,currency,appleRecoverableAmount?}`。客户退款证据为 `{id,orderId,amount,currency}`，银行卡实际回款另含 `cardId`。Apple 扣款分配为 `{orderId,appleIdId,amount,returned}`，`returned` 还要与逐笔到账流水对平。完整合成输入见 [migration-demo.mjs](migration-demo.mjs)。

真实导出仍需人工确认完整性、订单归属、原币费用、历史报价和回款凭据。遇到旧 Apple 退款撤回、扣款更正或其他流水种类，需要对照原始流水整理为独立新版账本后再核对。当前只读验收使用合成数据。没有正式供应商凭据时，历史汇率缺口保留原状，正式自动报价仍由主窗口单独配置。
