# 线上代充订单同步与双页签实施记录

## 当前结论

代码和本地验证完成，尚未上线。328 项不同用例、前后端类型检查与构建、七项界面规则及 10 组离线实际 Vue 页面交互验收通过。远端隔离数据库迁移、真实任务端到端及线上页面验收尚未执行；不能将本记录作为生产发布或真实充值成功证明。

本轮没有提交、推送、PR、生产数据库访问、部署、真实付款、订阅更改或外部通知，也没有启动本机网站、Docker 或数据库。

## 范围和基线

用户已确认：完整复用订单功能；比特与线上收费独立；补录可核实历史记录；金额或日期缺失时建立待补全订单。

隔离工作树：`.codex-worktrees/online-order-sync-20261016`，分支 `codex/online-order-sync-20261016`，基础提交 `d6d042f8c96847dcd99bf06e1cb9ae8f5fc5b24e`。主目录的并行修改未纳入。

此前已部署的十八个执行器修复文件按摘要复制为受保护基线，记录在 `.runtime/online-order-sync-20261016/preserved-engine-baseline.json`。其中十六个文件与原摘要相同。本功能仅在 `engine/confirmation.cjs` 的原单只读核对结果中增加白名单付款凭据投影，并更新 `SOURCE_MANIFEST.json`、新增 `test/order-sync-recheck.test.cjs`。原付款、账号、套餐核对条件及 Pro 500 执行保护未放宽。

## 已实现的页面和业务

- 原“比特订单”入口改为“充值订单”，保留 `/v2/auto-recharge/bank-orders`；默认比特页签，`channel=online` 打开线上页签。
- 两侧共用业务清单、回收站、全部／已到期、搜索、分页、列设置及现有手工录入、补全、完成财务、更正、退款与回款、订阅核对、作废和恢复能力。筛选、分页、列设置及编辑草稿按渠道隔离。
- 线上任务详情显示关联订单和同步状态，支持直接打开订单、只补同步订单；历史补录提供统计预览、分批处理和版本复核。
- 套餐映射统一为 Plus、Pro 100、Pro 200、Pro 500；来源原始套餐保留在安全快照中。线上银行卡继续属于线上卡池，不复制进比特卡库，只关联原任务实际使用卡和脱敏快照。
- 账号按已核实官网身份的 SHA-256 指纹关联现有账号库；无冲突且资料充分时建立加密账号记录，冲突保留待核对。不复制 Session、密码或安全码。
- 比特与线上收费、套餐参考价和两项手续费独立保存，线上价格与比例初始留空。共用 Decimal、汇率快照、利润、财务凭证和内部退款登记，不向官网发起退款。设置变化不重算已完成订单。
- 自动建单只建立待补全记录，不确认客户收款、不自动入账。未知金额、币种、国家和日期保持未知，不用套餐售价、默认美元或任务完成时间补造。明确零元升级不生成扣款或资金扣减分录。

## 数据变化与迁移

新增迁移 `apps/api/prisma-mysql/migrations/20261016090000_online_recharge_orders/migration.sql`，不修改已有迁移、历史订单号或现有记录归属。

| 对象                               | 变化                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `IdBusinessV2RechargeOrderChannel` | 新增 `bitbrowser`、`online` 受控渠道                                                                                |
| `IdBusinessV2BankRechargeOrder`    | 新增 `channel`（默认比特）、唯一 `onlineRechargeTaskId`、`onlineRechargeCardId`、`onlineSourceSnapshot` 和索引      |
| 订单实付金额／币种                 | 允许线上待补全订单为 null；数据库 CHECK 保持比特侧必填，INSERT／UPDATE 触发器限制各渠道专属来源引用                 |
| `OnlineRechargeOrderSync`          | 新增 `online_recharge_order_sync` 表：原任务主键、pending／synced／needs_review、尝试次数、下次执行时间和受控错误码 |
| 原任务与线上卡                     | 增加订单反向关联；原任务删除 RESTRICT，卡删除 SET NULL，订单安全快照保留                                            |

队列不保存登录资料或完整卡号。迁移已与 Prisma 离线生成 DDL 对照，schema 静态校验及 Client 生成通过，尚未对生产数据库应用。发布准备中发现 MySQL 不允许 CHECK 引用带级联动作的外键列，已将渠道来源约束改为同语义的 BEFORE INSERT／UPDATE 触发器，保留金额 CHECK 和线上卡删除 SET NULL。七项结构／事务测试同时覆盖插入与更新拒绝混用来源、渠道切换原子失败及删除卡后保留快照；须经远端隔离 MySQL 实际验证后再安排生产步骤。

## 接口变化

| 接口范围                                                                | 行为                                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `id-business-v2/bank-recharge/orders` 列表、录入与 `orders/options`     | 增加渠道参数，缺省保留比特行为；修改已有订单时按持久化渠道校验                       |
| `id-business-v2/bank-recharge/order-pricing-settings` 读取／保存        | 增加渠道参数，分别保存两套配置                                                       |
| 原订单完成财务、更正、退款、回收站和订阅核对                            | 按渠道校验原卡、账号、原任务及证据；不增加自动付款                                   |
| 线上任务详情                                                            | 返回安全订单编号、关联订单 ID 与 `orderSync` 状态                                    |
| `POST id-business-v2/online-recharge/admin/jobs/sync-order`             | `{id}`：登记原任务补同步，不重执行充值                                               |
| `POST id-business-v2/online-recharge/admin/jobs/order-backfill-preview` | `{cursor?}`：每批最多 100 条，返回统计与短期预览凭据                                 |
| `POST id-business-v2/online-recharge/admin/jobs/order-backfill`         | `{previewToken}`：消费当前管理员、原任务版本及执行租约绑定的预览，重新核对后登记同步 |

复用现有管理员角色、线上代充读写权限、版本检查及审计。新增线上订单动作同时要求管理员身份和明确的线上代充读写权限；不能用直接传订单 ID 绕过。客户查询接口不暴露订单财务。

## 同步可靠性和证据

正式 `recharge` 任务核实成功和原单复查成功时，在原事务登记同步；复查始终投影回原充值任务。调试、失败、待核对、订阅查询及续费开关不生成成功充值订单。

内部定时处理每轮最多二十条，通过原任务锁、任务唯一键、付款凭据和结账标识去重，回收站订单仍参与去重。订单创建与同步完成标记同事务提交。临时错误有限重试，冲突或耗尽转人工核对。同步失败不会修改成功充值为待执行，不调用付款或充值重试。

本地和第三方证据都要求原任务、官方账号、精确套餐与付款成功事实匹配。只有供应商明确给出的实际支付字符串金额和币种才能写实付；只有调试链接、活动会员状态、估算售价或含糊成功标记不能补录。原单第三方核对只投影订单／任务编号、已核实状态、结果和明确实付字段，不复制供应商任意返回体。

历史补录预览有效十分钟，绑定管理员、原任务版本和租约版本；提交重新核对。已核实成功但金额或日期不足的记录可建立待补全订单；来源不可信则不补录。现有线上账单继续作为消费证据，不重复计入财务。

## 实际验证结果

| 检查                     | 结果和范围                                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 订单后端定向测试         | 10 文件、212 项不同用例通过；覆盖同步建单、资料、财务、更正、退款、回收站、订阅、收费、套餐和查询                                                                                          |
| 线上同步域定向测试       | 3 文件、42 项不同用例通过；最后的跨边界凭据投影仅补跑受影响 16 项，通过                                                                                                                    |
| 前端定向测试             | 51 项不同用例通过；最终资源／页面／API／权限 32 项，输入未变化的收费 19 项复用                                                                                                             |
| 原单执行器只读核对       | 10 项通过，其中新增同步凭据契约 3 项，原核对 7 项                                                                                                                                          |
| 表格规则与数据库权限控制 | 表格 schema 别名测试 4 项、数据库权限控制 9 项通过                                                                                                                                         |
| 类型、构建、代码规范     | shared 构建、API 类型与构建、Admin 构建（包含 vue-tsc）、相关 ESLint／Prettier、diff check 通过                                                                                            |
| 七项 UI 规则             | `check:admin-ui`、`check:v2-ui-language`、`check:v2-color-contrast`、`check:v2-table-standard`、`check:v2-loading-standard`、`check:v2-module-architecture`、`check:v2-isolation` 全部通过 |
| 后端架构                 | Decimal、并发和 Prisma runtime 边界检查通过；业务层无直接 Prisma 模型、事务或 SQL 访问                                                                                                     |
| 实际 Vue 页面离线验收    | 10 组通过；合成 API、无本机网站／数据库、无外部网络请求和页面异常                                                                                                                          |
| 远端隔离 MySQL           | 已接入七项结构／约束／并发／事务测试及原比特独立库回归；首轮确认渠道 CHECK 与外键级联不兼容（MySQL 3823），触发器修复等待远端复验                                                          |

以上合计 328 项不同用例，不把修复后补跑的子集重复计数。首轮新增测试 fixture 缺少 decrypt stub、类型契约及 CommonJS fixture 兼容问题均已修复，保留原失败日志和受影响复验回执，不以旧失败日志冒充最终状态。

页面验收覆盖双页签、独立筛选／编辑／收费草稿与列设置、第一页／末页／空列表、回收站／到期、明确零元与未知资料、付款凭据、耗尽原卡、补同步／历史补录、关联入口、读写权限、深浅主题及 390px 窄屏。第一页、末页和空列表外框均为 1560×1172；窄屏文档宽度与视口同为 390px。

验收过程中修复：线上补币种错误清空原卡、比特卡选项读取来源错误、补录预览被误当修改导致自身失效，以及新增线上订单权限前后端不一致。最终复验通过。

## 文件与证据索引

主要实现文件：

- 前端 `auto-recharge/V2BankRechargeOrdersView.vue`、`V2RechargeOrdersChannelView.vue`、`useBankRechargeOrdersPage.ts`、`useBankRechargeOrderResources.ts`，以及对应表单、收费、API、表格 schema。
- 前端 `online-recharge/OnlineResultDialog.vue`、`OnlineOrderBackfill.vue`、`orderPermissions.ts` 和 API 接入。
- 后端 `auto-recharge/bank-recharge-online-order.service.ts`、`bank-recharge-channel.ts`、手工／核实事实 helper、对应持久层，以及现有订单生命周期、财务、订阅、收费和查询接入。
- 后端 `online-recharge/order-sync-facts.ts`、`order-sync.service.ts`、`persistence/order-sync.repository.ts`、worker 原终态与原单复核接入。
- Prisma schema 与新增迁移；专用隔离测试、原隔离入口、CI 配置；表格规则共享别名校验与控制测试。

完整路径与摘要清单：`.runtime/online-order-sync-20261016/final-source-inventory.json`。该清单分别标注受保护执行器前置文件和本功能增量。

项目内 `.runtime/online-order-sync-20261016/` 保存：

- `backend-conclusion.md`、`backend-management-tests.log`、`backend-helper-signature-tests.log`。
- `online-domain-final-verification.json`、`order-sync-receipt-contract-tests.log`、`provider-recheck-tests.log`。
- `frontend-verification.json`、`frontend-fixture/acceptance-result.json` 及深浅主题／窄屏截图。
- `api-final-typecheck-r2.log`、`api-final-build.log`、`prisma-boundary-final.log`、`root-format.log`。
- `preserved-engine-baseline.json`、`source-manifest-verification.json`、`expected-migration.sql`。

## 尚未完成和实际限制

- 远端隔离 MySQL 的迁移、唯一约束、并发和事务行为仍需实际运行，当前只有已准备测试和离线 DDL 证据。
- 本轮页面验收使用真实 Vue 组件与合成接口，并非生产后端或真实账号验收；尚无真实充值至订单的端到端记录。
- 第三方 Pro 500 合成凭据契约通过不代表实际 Pro 500 付款已可执行；现有付款保护保持，真实付款、菲律宾计价及网页版 Plus 升级组合均未验收。
- 生产迁移、部署和线上验收未执行；新功能不会因本地代码完成自动出现在当前线上管理台。按本轮范围保留未提交代码，后续提交、推送、CI 和发布另按用户授权执行。
