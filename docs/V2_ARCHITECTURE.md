# ID 业务管理系统架构

## 1. 唯一运行入口

- 管理端入口：`apps/admin/index.html` → `apps/admin/src/main.ts` → `apps/admin/src/App.vue`
- 管理端路由：`apps/admin/src/v2-router.ts`
- API 入口：`apps/api/src/main.ts` → `apps/api/src/app.module.ts`
- 业务 API 前缀：`/api/id-business-v2`
- Cloudflare 入口：`apps/api/src/cloudflare-v2-bootstrap.ts`

仓库不维护第二套前端入口、第二套 API 根模块或兼容路由。

## 2. 前端模块

每个业务模块位于 `apps/admin/src/v2/features/<module>`，包含页面、composable、子组件、领域
contracts 和模块样式。跨模块能力优先放在 `components`、`composables`、`runtime`、`router`、
`api` 和 `types` 公共目录；确需复用另一业务模块时，只能通过目标 feature 的 `public-api.ts`，禁止
引用其内部页面、组件、composable 或工具文件。feature 实现必须通过本模块 `api.ts` 和
`contracts.ts` 访问全局 API 与类型实现。页面不得复制另一模块的业务状态和 API 逻辑。

## 3. 后端模块

业务模块全部位于 `apps/api/src/id-business-v2`：

- `accounts`（含 ID 报损冻结、解除冻结与报损记录）
- `customers`
- `options`
- `balances`
- `gift-cards`
- `topup-supplier-funds`
- `orders`
- `activations`
- `renewals`
- `exchange-rates`
- `change-sync`
- `finance`
- `dashboard`
- `business-monitoring`
- `system-monitoring`
- `data-governance`

公共运行能力包括 `v2-auth`、`auth`、`audit-logs`、`common` 和 `security`。模块通过
`public-api.ts` 暴露稳定边界，禁止跨模块引用内部 service 文件。

`runtime`、`sensitive-access` 和 `table-preferences` 作为 V2 内部基础域同样纳入依赖门禁。
`apps/api/src/id-business-v2` 下所有一级目录都必须登记，跨域 import 只能指向目标域
`public-api.ts`，并且完整生产依赖图不得出现循环。

每个业务模块按职责拆分为 command/query service 与 `persistence/` repository。Prisma Client、
raw SQL、Prisma runtime 错误识别和数据库 Decimal 行只能出现在 persistence adapter；业务层只能
接收领域值对象或规范化字符串。写命令不得自行开启 Prisma 事务。

## 4. 数据边界

业务表统一使用 `id_business_v2_*`。共享身份与审计只使用用户、角色、权限、审计、登录会话、
Supabase 身份映射，以及续费预警设置所需的系统规则记录。

Prisma migration 目录是现有数据库的执行历史，不属于运行模块。业务代码不得读取当前模块未声明的
数据表。

## 5. 金额、事务与账务规则

- 业务层金额统一使用 `Amount4`，汇率与平均成本统一使用 `Rate8`；两者基于共享 BigInt 小数算法，
  不依赖 Node 或 Cloudflare 的 Prisma Decimal runtime。
- API、DTO 和数据库边界统一使用规范十进制字符串。repository 从数据库读取金额后必须立即通过
  `mapAmount4`、`mapRate8` 或对应 optional mapper 转为领域值对象，禁止把 Prisma Decimal 行传入
  command/query service。
- 余额与人民币成本保存 4 位小数。
- 汇率与平均成本最多保存 8 位小数。
- 所有写命令使用唯一入口 `V2CommandTransactionManager`，默认 Serializable，并携带 request ID、
  操作人、业务时间和显式幂等策略。业务记录、不可变流水、财务凭证与审计必须同事务等待完成；
  财务或审计失败必须回滚整单。
- 只有能在新事务中重读并核验完整请求证据的稳定幂等命令才允许冲突重试。相同键、相同请求返回
  原结果；相同键、不同请求返回 409。非幂等命令遇到事务冲突直接返回冲突，不自动重放写操作。
- 财务账户和资金账户按稳定 ID 顺序锁定；余额校验与写入使用同一锁定快照。嵌套礼品卡报损复用
  外层事务，不允许开启第二个事务。
- 加卡使用移动加权平均成本。
- 订单利润由服务端按 `实收 - 平台手续费 - 余额成本 - 实际计入的 ID 成本 - 退款成本` 计算。
- 订单通过 `accountSource=inventory|customer_owned` 区分库存 ID 与客户已购 ID。
  `customer_owned` 必须保存后端生成的 `sourceSoldOrderId`，并固定为 `retained`。
- 订单保留 `accountCostAmount` 购买成本快照；只有首次
  `accountSource=inventory + accountDisposition=sold` 由 `appliedAccountCostAmount` 计入利润。
  `customer_owned`、`retained` 与 `recovered` 的实际计入值均为 0。
- ID 通过唯一的 `soldByOrderId` 与 `soldAt` 保存当前卖出证据；普通订单锁释放不解除销售占用。
- 客户已购订单只建立按业务分类的锁，不改写 `soldByOrderId`、`soldAt` 或 ID 采购成本。
  原销售订单只有通过回收预检并在同一事务内复核后才能解除归属。
- ID 报损通过 `IdBusinessV2AccountLoss` 快照、`activeLossRecordId` 和 `account_loss` 余额流水保存；
  报损冻结不清零账户余额与余额人民币成本，余额流水只记录冻结证据，损耗由财务日记确认。
- 数据库触发器禁止修改或删除报损快照，并在报损时校验冻结、停用和 active loss 必须同一事务成立；
  冻结期间账户业务更新会被数据库拒绝，解除冻结前必须先把 active loss 标记为已冲回并写入冲回财务日记。
- 报损亏损包含余额人民币成本，未售 ID 同时确认 ID 采购成本；已售 ID 的 ID 采购成本损失固定为 0，
  已售关系和历史订单利润保持不变，
  解除冻结不会自动恢复历史开通记录。
- 礼品卡“被赎回”可在同一事务内调用账户报损核心逻辑：先写 `gift_card_redeemed` 扣卡流水，再以
  扣卡后快照写 `account_loss` 流水和报损记录；任一步失败都回滚。
- 礼品卡损失与 ID 剩余余额损失分开记账，共用处理原因；扣卡后余额为零也保留 0 元 ID 报损记录。
- 卖出、切换、取消、退款和明确收回必须与订单、ID、流水和审计处于同一事务。
- 余额流水不可变；纠错通过反向流水完成。
- 加卡供应商资金使用独立的 CNY 账户与不可变流水。付款按到账 USDT 和付款结算汇率增加余额，
  加卡按礼品卡成本快照扣减；两种汇率互不覆盖。
- 供应商账户、ID 余额和礼品卡在加卡事务内原子写入；付款、加卡、撤回、调账与供应商更正均锁定
  CNY 供应商账户，允许扣减后为负数但不允许余额快照错序。
- 被赎回和 ID 报损不触发供应商流水；撤回引用原 `gift_card_debit` 生成
  `gift_card_withdrawal_reversal`，按原金额返还。
- 供应商更正对切账后礼品卡在同一事务内完成原供应商返还和新供应商扣减；切账前记录只更正归属。
- 订单、余额、开通记录和审计必须处于同一事务或明确的补偿边界内。
- 幂等键相同且请求一致时返回原结果；内容不一致时拒绝。

### ID 报损冻结接口

```text
POST /api/id-business-v2/accounts/:id/report-loss
POST /api/id-business-v2/accounts/:id/unfreeze-loss
GET  /api/id-business-v2/account-losses
```

- 报损写操作同时需要 ID 修改和余额调整权限；记录页使用余额查看权限。
- 报损原因、余额快照与幂等键由服务端校验，有活动订单锁时拒绝。
- 报损事务同步冻结 ID、保留余额与成本、写入损失财务日记和快照，并把未结束开通记录标记为异常。
- 解除冻结复用报损权限组合，校验当前 active loss，自动冲回原损耗财务日记，恢复 ID 可用状态但不自动恢复开通记录。

### 礼品卡被赎回联动报损

`POST /api/id-business-v2/gift-cards/:giftCardId/reversals` 支持可选
`reportAccountLoss=true`。普通被赎回仍只需余额调整权限；同时报损还需 ID 修改权限，且撤回操作
不得携带该选项。礼品卡反向幂等键会派生稳定的报损幂等键，重放时“是否同时报损”必须与首次请求
一致。

### 加卡供应商资金接口

```text
GET  /api/id-business-v2/topup-supplier-funds/suppliers
GET  /api/id-business-v2/topup-supplier-funds/suppliers/:supplierOptionId/ledger
GET  /api/id-business-v2/topup-supplier-funds/payments
POST /api/id-business-v2/topup-supplier-funds/suppliers/:supplierOptionId/initialize
POST /api/id-business-v2/topup-supplier-funds/suppliers/:supplierOptionId/payments
POST /api/id-business-v2/topup-supplier-funds/suppliers/:supplierOptionId/adjustments
POST /api/id-business-v2/topup-supplier-funds/payments/:paymentId/reversals
POST /api/id-business-v2/gift-cards/:giftCardId/supplier-reassignments
POST /api/id-business-v2/gift-cards/:giftCardId/reveal-code
```

资金只读接口使用 `apple.topup_supplier_fund.view`，资金写操作使用
`apple.topup_supplier_fund.manage`。供应商更正还要求 `apple.balance.adjust`。加卡记录和余额变动
接口使用 `apple.balance.view`，响应直接包含完整礼品卡号；数据库继续加密保存，审计和业务日志只
记录脱敏值。`reveal-code` 保留为兼容接口，当前管理端不再调用。

## 6. 续费工作台

当前续费只做系统内手工录单：

```text
GET   /api/id-business-v2/renewals/workbench
GET   /api/id-business-v2/renewals/workbench/bootstrap
GET   /api/id-business-v2/renewals/workbench/filter-options
GET   /api/id-business-v2/renewals/workbench/manual-renewal-options
POST  /api/id-business-v2/renewals/:activationId/manual-renewals
GET   /api/id-business-v2/renewals/warning-settings
PATCH /api/id-business-v2/renewals/warning-settings
GET   /api/id-business-v2/renewals/warning-summary
```

- 默认预警 3 天，可设置 1–365 天。
- 日期范围只扩展查看范围。
- 实际续费仍只允许处理 7 天内到期或已到期记录。
- 提醒汇总只返回计数和脱敏预览，不发送外部消息。
- 手工续费原子创建完成订单、扣减余额、结转成本并生成新开通记录。
- 已售 ID 继续进入续费工作台；续费前同时校验原开通客户和销售归属客户。
  已售 ID 续费订单标记为 `customer_owned`，关联原销售订单，并通过统一完成入账路径确认余额成本与利润。

## 7. 汇率采集

汇率模块是唯一联网采集模块。系统固定支持 `CNY、MYR、USD、USDT`：`CNY=1` 作为主币种固定值，
不采集入库；`USDT` 采集 Binance 与 OKX 公开 P2P 商家报价并分层保存原始报价、平台平均值和合并
结果；`MYR` 与 `USD` 使用 ECB 参考汇率交叉折算到 CNY。每次自动采集都会为非 CNY 币种生成可查询的
财务汇率快照，区分自动采集与人工录入。失败币种明确记录失败，不使用缓存或默认值伪造成功。
自动记录按汇率设置的保留天数清理，人工记录和被业务引用的快照永久保留。

## 8. 认证与权限

- 当前只提供内部登录，不提供公开注册。
- `AUTH_PROVIDER=local` 使用本地 JWT；`AUTH_PROVIDER=supabase` 使用 Supabase Auth。
- `V2IdentityService` 只读取当前用户、角色与权限。
- 前端隐藏无权限操作，后端守卫必须再次拒绝。
- 敏感字段查看与所有写操作必须记录审计。

### 会话协调与错误契约

- `SessionCoordinator` 是凭据、会话状态、请求取消、恢复和跨标签同步的唯一写入者。状态固定为
  `cold | anonymous | validating | ready | refreshing | degraded | blocked`。
- 浏览器只持久化一个带 schema version、`credentialId`、`tokenRevision`、Token 和用户缓存的原子
  凭据对象；跨标签消息不携带 Token。每个响应提交前必须匹配当前 credential ID 与 revision。
- 冷启动必须先完成 `/auth/me`，缓存用户不得解锁业务数据。冷启动认证不可用进入
  `/session-unavailable`；已验证会话短暂 503 时保留最后内容并统一切为只读，恢复后重新验证权限和
  失效查询，禁止重放写请求。
- 401 才清凭据；403 进入明确阻断状态；502/503/504 只按 `/auth/me` 的有界策略重试。所有程序化
  导航必须通过 `navigateSafely()` 消费 Vue Router NavigationFailure。
- API 错误统一包含 `errorCode`、`message`、`retryable`、`requestId`、`timestamp`，可选
  `retryAfterMs` 与 `fieldErrors`；响应头同时返回 `X-Request-Id`。日志不得包含 Token、请求体、完整
  查询参数或敏感字段。

## 9. 加载、路由与表格

- Vue 根应用先挂载中性 Boot Gate；会话和目标路由确认前不得挂载业务壳、权限导航或缓存业务页。
- 路由代码只由悬停、聚焦或点击等明确意图预取。
- 远程数据由 `useV2ModuleQuery` 以 `clean | dirty | pending` 状态缓存；时间流逝本身不会让
  event-driven 缓存过期。
- `V2DataScope` 和依赖映射只在 `@apple-business/shared` 定义。数据库 statement trigger 在业务
  事务内递增 scope version，并通过私有 Supabase Broadcast 发送最小变化事件。
- 管理端只建立一个 `id-business-v2:changes` 私有频道。当前页面变化立即后台刷新，非当前页面只
  标 dirty；重连、恢复联网、隐藏超过 60 秒后恢复时通过
  `GET /api/id-business-v2/change-versions` 补偿漏事件。
- 开通、续费、预警、汇率和订单匹配用 `revalidateAt` 表达没有数据库写入的时间语义变化。
- 页面使用 `V2AsyncRegion` 统一首次加载、刷新、错误与空状态。
- 路由指标区分 code ready 与 data ready。
- 订单录入是唯一允许 KeepAlive 的业务页。
- 桌面业务表统一使用显式 `V2Table + typed schema`。schema 是列顺序、语义宽度、固定方向、操作列、
  行键和移动模式的唯一来源；manifest 只引用 schema，禁止复制列契约或恢复 `<el-table>` 隐式代理。
- 表格使用 fixed layout、共享最小宽度与容器内滚动。新 schema/标签同步回到最左侧；同表刷新、
  排序、分页和数据替换保留横向位置。901px 显示桌面表，900px 及以下按 schema 使用移动卡片或
  内部滚动模式。

详细规则见 `docs/V2_LOADING_STANDARD.md`。

## 10. 实时授权与降级

- Broadcast 主题固定为私有 `id-business-v2:changes`，载荷只包含 schemaVersion、eventId、
  occurredAt 和 scope/version。
- `realtime.messages` 只授予已绑定、enabled、内部用户 active 且未删除身份的 SELECT 权限；
  客户端没有 Broadcast INSERT 权限。
- Realtime 健康时每 5 分钟静默校验版本，断开时页面可见期间每 60 秒校验。连接异常不得阻塞导航。
- 管理端可通过 `VITE_V2_REALTIME_CHANGES_ENABLED=false` 关闭 Broadcast 传输并保留版本校验；
  不恢复导航触发的完整业务列表轮询。
- Supabase 项目必须在发布前由环境管理员确认关闭公开频道访问；该控制台设置不由仓库 migration
  代替。
- migration 会尝试安装 `realtime.messages` 私有 SELECT policy；若托管表属于
  `supabase_realtime_admin` 且发布角色不是其成员，migration 记录 Notice 后继续，环境管理员需由
  表所有者补装 policy。补装前客户端自动降级为版本接口校验。
- 发布顺序固定为：部署 migration/RLS → 发布版本接口 → 发布管理端协调器 → 启用
  `VITE_V2_REALTIME_CHANGES_ENABLED`。回滚 Broadcast 时保留版本校验，不恢复导航 TTL 或完整列表
  轮询。

## 11. 模块新增流程

1. 写入 `docs/V2_PRODUCT_SCOPE.md` 和 `docs/V2_TASKS.md`。
2. 建立独立前端 feature 与后端 domain module，并登记模块门禁；跨模块复用只暴露必要的
   `public-api.ts`。
3. 明确权限、审计、数据表和事务边界。
4. 提供加载、错误、空状态和移动端方案。
5. 添加 service 单测与架构检查。
6. 通过 typecheck、test、lint、build 和 Prisma 校验。
