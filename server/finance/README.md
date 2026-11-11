# 汇率快照和利润核算接入

2026-11-07 新增「系统设置 → 汇率采集」，持久采集、设置、日志、重启恢复及订单引用保护见 [汇率采集合同](../../docs/FX_COLLECTION_20261107.md)。该管理服务接入现有 `preview.mjs` 和自动快照路由；下文早期纯内存适配器说明保留用于兼容与隔离测试。

手工财务模块使用原有订单文档和订单事务，不新增接口、数据库表、迁移或运行配置。手工快照是订单上的可选 `fxSnapshot`，保存手工来源与凭据、报价时点、有效截止、订单核算时点（均为 UTC ISO）和 CNY 基准汇率表。实际 Apple 总成本可登记 `appleRecoverableCostAmount`，沿用实际成本币种；它仅表示总成本中随 Apple 面额比例收回的部分。

## 公共入口所有者的两个接入点

1. 在 `server/preview.mjs` 导入 `installFinanceAssets`（`./finance/preview-assets.mjs`），在本机数据分支中完成其他 HTML 注入后、创建 HTTP server 前执行 `await installFinanceAssets(assets)`。该函数添加两个明确白名单的同源 JS 资源，并在 commerce 经典脚本之后插入财务模块入口。不需要改 `frontend/index.html`。
2. 在 `server/local-business.mjs` 从 `../modules/finance/accounting.mjs` 导入 `snapshotAction` 并加入 commerce 操作白名单。从 `./finance/snapshot-integrity.mjs` 导入 `checkFinanceSnapshots`，在 `saveBatch` 的 commerce 事务段、版本检查和操作者归属之后加入以下检查；保留银行卡与 Apple 既有校验。

   ```js
   const { action } = writes.find((write) => write.domain === 'commerce');
   const financeError = checkFinanceSnapshots(priorCommerce, incoming.get('commerce'), { action });
   if (financeError) throw new LocalDataError(409, financeError);
   ```

操作继续走原有同源、会话、角色、订单及文档版本、加密保存和审计机制。汇率登记只能为一笔已有订单追加一次快照及审计。退款、到账、订单更正和补偿撤回继续沿用已有入口。该模块不改动付款、余额和库存。

## 订单统计口径

已确认净收款按实际收款减去客户退款汇总。同币种收款无需汇率，跨币种只使用有效的订单汇率。缺少成本、开卡费凭据或代付确认的订单仍可汇总已确认的净收款；利润按各自缺项单独核算。

标准成本使用原订单的费用规则快照。GPT 银行卡付款分别核算订阅原币、比例手续费、每笔固定费用和同卡开卡费分摊。适用的补充成本独立显示。按稳定卡编号归集已确认开通，保留成功后退款、撤单或续费形成的用卡事实。无效、失败、未开通和重复任务不进入分母。已知同卡记录或开卡凭据不完整时列待核算。按开通时间和原单编号分配四位小数尾差。原订单上的一次性开卡费凭据继续作为总额依据。

已确认收付款的手工或历史入库 GPT 银行卡订单，原单未登记卡编号时仍按冻结的汇率和费用规则计算参考利润。原单已登记的开卡费计入本单；其余显示「开卡费未分摊」。续费独立使用本次银行卡及费用记录。

自动订单优先用真实开通时间匹配冻结汇率。统计将已登记实际总成本且具有实际结算汇率凭据的订单列为实账核算，按冻结费用规则或历史报价核算的订单列为参考核算。实际总成本沿用完整账单金额，不叠加可能已含的规则费用。退款、银行卡到账和 Apple 到账继续分别核算。参考报价和实际结算凭据由快照来源及登记类型区分。

当前页面按完整业务订单集合重算，截至时间及分摊笔数可在原订单详情回查。对于具有完整卡历史的隔离导出，可给对账命令加上 `--full-card-history`，输出原份额、新份额和原币差额。该预览为只读，旧版迁移对账默认沿用原一次性费用口径。历史关账需要原始结算版本及已入账调整凭据，当前统计不生成关账分录。

## 本机点测

使用 `startPreview(0, { databasePath: ':memory:' })`；业务样例仅写入这个隔离实例。

1. 通过「核对并保存」确认付款和实收。打开「数据管理 → 订单统计 → 待核算」，核对缺汇率的原因。
2. 点击「查看原单 → 成本与汇率 → 登记汇率快照」。输入测试凭据、覆盖订阅时点的报价和截止时间，按提示填写 MYR 和订单相关原币的兑 CNY 汇率；把截止设为订阅时点，预期不能冻结。
3. 使用有效报价确认冻结。详情应显示来源、时点、费率及利润，重新打开应仍可读；同一单没有覆盖入口。两笔订单使用不同历史快照时，切换到 MYR 后应分别换算再汇总。
4. 登记部分客户退款后净收款下降。银行卡实际回款按原代付币种抵减成本；Apple 待回款时成本不变，确认到账后才抵减。Claude Apple 标准成本使用订单折扣；采用实际总成本时，按已登记的 Apple 可收回部分及实际到账比例核算。该部分缺失时，到账后的订单进入待核算。

缺失或无效的报价不会使用固定演示值兜底。已冻结报价随历史订单保存，今天过期不会使原本有效的旧单失效；订阅时点更正到原报价窗口之外或更正后缺少币种时，订单转待核算。默认采用手工报价。冻结的快照保持只读。

隔离 Chrome 验证样例：PHP 1000 代付、CNY 250 实收、CNY 70 客户退款、PHP 200 实际回款。冻结后净收款 CNY 180，实际收回成本 CNY 25，利润 CNY 73.24；按该单历史汇率切换为 MYR 后，净收款 112.50，利润 45.7750。样例仅用于测试。

## 自动报价接入

自动报价默认关闭。2026-11-11 改用 [Fawaz Currency API](https://github.com/fawazahmed0/exchange-api)，无需密钥，采用 CC0-1.0 许可。固定查询 jsDelivr 的 CNY 日报价，网络或 HTTP 故障可尝试官方 Cloudflare 备援；两次请求共用 4 秒预算。覆盖 CNY、MYR、USD、PHP、CLP、IDR、EGP，不接受自定义来源地址。报价用于参考换算，退款和到账仍以业务台账为准。

站内订单列表、统计和成本详情不再插入供应商外跳链接；汇率采集页只显示来源文字。报价日期按来源的 UTC 日解释，有效期固定为当日零点起 36 小时，重复采到旧报价不延长有效期。默认于下一 UTC 日重新采集，发布延迟时最多每小时重试；固定间隔、暂停、币种选择和失败冷却继续按原设置执行。非法报价不尝试拼接备用来源，429 冷却 20 分钟。

既有 `exchange-rate-api-open` 配置只投影为新来源，不在读取时写库；后续正常配置保存或采集沿用已有文档版本事务。已冻结的旧来源名称、报价、时点和凭据编号保持原值，仍可核算和验证；已有历史报价可以为覆盖时点的订单补核算。没有有效报价时保留待核算，不用今天行情替代过去。无需数据库迁移、API Key 或新增环境变量。

主窗口接入时在共享文件补以下两处。

1. `server/preview.mjs` 的 `startPreview` 选项增加 `financeProvider`、`financeFetch`。缺省即关闭，`financeFetch` 只用于隔离替身。已有本机存储初始化完成后创建服务与处理器，并将启用标记传给现有资源挂载函数。

   ```js
   import { createFinanceQuoteService } from './finance/quote-service.mjs';
   import { automaticSnapshotRoute, createAutomaticSnapshotHandler } from './finance/quote-route.mjs';

   // 在 startPreview 的本机模式内，替换原 installFinanceAssets 调用。
   const quoteService = createFinanceQuoteService({
     provider: financeProvider,
     fetchQuote: financeFetch
   });
   handleAutomaticSnapshot = createAutomaticSnapshotHandler({ store, quoteService });
   await installFinanceAssets(assets, { automaticQuotes: quoteService.enabled });

   // handleAutomaticSnapshot 声明在请求回调的外层。
   // 在既有回环地址和会话角色解析之后，放在通用 /api/local/ 路由之前。
   if (store && route === automaticSnapshotRoute) {
     if (!canManage) return forbidden();
     return void handleAutomaticSnapshot(request, response, actor);
   }
   ```

2. `server/local-business.mjs` 的服务端 `saveBatch` 选项从 `{ actor }` 改为 `{ actor, verifyAutomaticSnapshot }`，把该回调随 `action` 传给 `checkFinanceSnapshots`。通用 HTTP 文档写入继续只传 `actor`，服务器只在专用自动冻结路由注入校验回调。自动和手工冻结共用原有订单文档、版本检查和审计动作。自动快照新增 `kind: 'automatic'`、`provider`、`fetchedAt`，已有手工格式兼容，无新增数据库表或迁移。

运行入口可传入 `financeProvider: 'currency-api'`；既有旧来源配置兼容映射，未启用时仍默认关闭。新单保存成功后会自动尝试冻结；旧单可从「成本与汇率」点「获取并冻结自动报价」，或沿用「登记汇率快照」。取价失败时查看「待核算」。

验证使用随机回环端口和内存 SQLite。临时接入共享入口后，实际 HTTP 冻结写入成功，订单和审计可回读，重复请求返回 409。财务测试同时覆盖六币种换算、缓存更新、超时、限流、缺失／过期、手工抢先提交及旧单利润保持。

Chrome 隔离点测通过。已有单可手工登记或点取价冻结，新单保存后自动取价并显示核算收益。两笔测试订单均可回读汇率登记审计。

## 旧订单与财务迁移前核对

在独立新版 Git 根执行以下命令。命令只读取标准输入或内置虚构批次，并把核对结果写到标准输出。

```sh
node server/finance/reconcile-cli.mjs --demo
node server/finance/reconcile-cli.mjs --strict --as-of 2026-11-05T06:00:00.000Z < ./backups/finance-precheck-input.json
```

第二条命令的文件名是示例。输入是独立新版已整理的隔离 JSON，顶层包含 `commerce.orders` 和 Apple 订单所需的 `appleBalance.allocations`、`appleBalance.refunds`、`appleBalance.movements`。沿用订单文档字段，金额为十进制字符串。订单、退款、银行卡回款及 Apple 流水必须有稳定编号。订单的 `refunds` 和银行卡订单的 `bankReturns` 用空数组明确表示零笔。Apple 数据按同一批订单导出，保留原扣款与冲正、退款登记和已到账的对应流水，便于按原订单核对。

输出按订单列出原币代付、实收、客户退款、银行卡实际回款、Apple 待回款与流水已到账、邮箱及实际成本、费用规则版本、快照类型、CNY／MYR 的核算状态和缺口。缺少明细时金额为 `null`。明确零笔时才显示零。某个统计币种缺报价时，该币种待核算，另一个币种的可核算结果仍可单独核对。撤单标记为 `excluded`，批次缺口另列。报告只保留核对所需的编号与金额，省略邮箱、银行卡和 Apple 账号标识及凭据原文。

`--demo` 默认使用固定检查时点。真实核对可使用 `--as-of` 固定时点以重跑比较，省略时使用当前时点。正常退出码为 0，输入无效为 1。使用 `--strict` 时，存在未撤单的待核算订单或批次缺口返回 2，仍会输出完整报告。

虚构批次预期 4 单可核算、1 单缺有效历史汇率快照。银行卡样例的 CNY 70 客户退款与 PHP 200 实际回款分别列账，利润为 CNY 73.2400。Apple 样例的 7 USD 待回款只保留占额。实际收到 7 USD 并匹配原订单流水后，按该单折扣计入 CNY 40.3200 成本收回。三种费用规则版本与六种币种均有覆盖。

待补的真实数据通常包括可覆盖原订阅时点的历史报价凭据、原费用版本、确认的收付款事实、明确的空退款记录、银行卡实际到账明细，以及可互相对应的 Apple 扣款、回款登记和到账流水。本命令核对导出内部的一致性。银行卡和 Apple 原始账单仍需人工复核，Apple 钱包的全量余额和期初余额由独立余额迁移核对处理。核对结果不直接执行迁移。

旧通用订单与 GPT 订阅投影的隔离转换、字段映射及管道命令见 [迁移输入说明](MIGRATION_INPUT.md)。
