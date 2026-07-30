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
contracts 和模块样式。跨模块能力只允许放在 `components`、`composables`、`runtime`、`router`、
`api` 和 `types` 公共目录。页面不得复制另一模块的业务状态和 API 逻辑。

## 3. 后端模块

业务模块全部位于 `apps/api/src/id-business-v2`：

- `accounts`（含 ID 永久报损与报损记录）
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

公共运行能力包括 `v2-auth`、`auth`、`audit-logs`、`common` 和 `security`。模块通过
`public-api.ts` 暴露稳定边界，禁止跨模块引用内部 service 文件。

## 4. 数据边界

业务表统一使用 `id_business_v2_*`。共享身份与审计只使用用户、角色、权限、审计、登录会话、
Supabase 身份映射，以及续费预警设置所需的系统规则记录。

Prisma migration 目录是现有数据库的执行历史，不属于运行模块。业务代码不得读取当前模块未声明的
数据表。

## 5. 账务规则

- 金额使用 Prisma Decimal。
- 余额与人民币成本保存 4 位小数。
- 汇率与平均成本最多保存 8 位小数。
- 加卡使用移动加权平均成本。
- 订单利润由服务端按 `实收 - 平台手续费 - 余额成本 - 实际计入的 ID 成本 - 退款成本` 计算。
- 订单保留 `accountCostAmount` 购买成本快照；仅 `accountDisposition=sold` 时由
  `appliedAccountCostAmount` 计入利润，`retained` 与 `recovered` 的实际计入值为 0。
- ID 通过唯一的 `soldByOrderId` 与 `soldAt` 保存当前卖出证据；普通订单锁释放不解除销售占用。
- ID 报损通过唯一 `IdBusinessV2AccountLoss` 快照和 `account_loss` 余额流水保存，账户余额与余额
  人民币成本原子归零，`lossReportedAt` 一旦写入不得清除。
- 数据库触发器禁止修改或删除报损快照，并在 ID 首次报损时校验冻结、停用、余额清零和快照必须
  同一事务成立；已报损 ID 的后续账户更新会被数据库直接拒绝。
- 报损亏损只包含余额人民币成本；已卖出关系和历史订单利润保持不变，报损 ID 不能通过退款收回恢复。
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

### ID 永久报损接口

```text
POST /api/id-business-v2/accounts/:id/report-loss
GET  /api/id-business-v2/account-losses
```

- 报损写操作同时需要 ID 修改和余额调整权限；记录页使用余额查看权限。
- 报损原因、余额快照与幂等键由服务端校验，有活动订单锁时拒绝。
- 报损事务同步冻结 ID、清零余额与成本、写入损失流水和快照，并把未结束开通记录标记为异常。

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
- 已卖出的 ID 不进入续费工作台，普通手工续费订单固定为“保留 ID”。

## 7. 汇率采集

汇率模块是唯一联网采集模块。它采集 Binance 与 OKX 公开 P2P 商家报价，分层保存原始报价、平台
平均值和合并结果，区分自动采集与人工录入。失败批次明确记录失败，不使用缓存或默认值伪造成功。

## 8. 认证与权限

- 当前只提供内部登录，不提供公开注册。
- `AUTH_PROVIDER=local` 使用本地 JWT；`AUTH_PROVIDER=supabase` 使用 Supabase Auth。
- `V2IdentityService` 只读取当前用户、角色、权限与强制改密状态。
- Supabase 会话使用 JWT 的稳定 `session_id` 生成不可逆哈希并登记到 `ActiveSession`；access token
  刷新不新增会话。未登记、已撤销、归属不一致或已过期的会话一律失败关闭。
- 强制改密期间后端只允许读取当前身份、修改密码和退出登录；修改成功后清除标记、撤销该用户全部
  会话并要求重新登录。审计只记录结果和撤销数量，不记录新旧密码。
- Supabase access token 由前端 SDK 刷新，Supabase 模式不得通过 `/auth/refresh` 签发本地 JWT。
- 前端隐藏无权限操作，后端守卫必须再次拒绝。
- 敏感字段查看与所有写操作必须记录审计。

## 9. 加载与路由

- 应用壳在会话和首路由完成前挂载。
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
2. 建立独立前端 feature 与后端 domain module。
3. 明确权限、审计、数据表和事务边界。
4. 提供加载、错误、空状态和移动端方案。
5. 添加 service 单测与架构检查。
6. 通过 typecheck、test、lint、build 和 Prisma 校验。
