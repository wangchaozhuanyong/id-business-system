# 邮件自动收信与页面刷新修复（2026-10-16）

状态：Vendure 后台修复已上线；ID 代码和本地投影验证完成，独立发布候选待云端检查及生产状态恢复。真实邮件闭环待验收。

## 边界和当前证据

ID 基线 main `b922b2d900e683f565ff3c5f95576ebc5f07803f`。Vendure 基线 main `5d97c5f169bbab000f95eb08e7cdc04a94b36076`；两个项目各自保留现有 WIP，没有混合提交。

此前只读核对已确认线上同条件“查询”不会强制重读。本机 AWS CLI 缺少凭据，未取得当前生产监听租约、通知队列和服务版本的完整只读回执，因此不能断言本次线上故障已精确定位或已经修复。

不新增固定间隔收信、依赖、环境变量、表、列或迁移；保留前端邮箱请求 70 秒、上游同步请求 60 秒和禁止自动重放写请求的规则。本轮没有启动本机网站服务或数据库，没有发送邮件、执行注册或付款。

## 实现

- Vendure：增加幂等监听恢复；测试或同步成功后用最新账号及原凭据依据核对后恢复，健康连接和连接重试不重复创建。停止后的迟到结果不能操作新监听；同进程同主邮箱并发手动同步合并。原 UID/UIDVALIDITY、邮件与通知同事务、断线补收和持久投递重试保持。
- 不支持 IDLE 的错误不会被手动成功清空；只有实际建立支持 IDLE 的新连接后清除此错误。更新状态及清错带原状态、凭据和错误依据保护，不覆盖并发更改。
- 新增管理员专用 Vendure GraphQL `icloudMailHealth` 和 ID `GET /id-business-v2/vendure-mailboxes/health`。只读主邮箱监听状态、租约与通知记录的数量和时间，不读取邮件正文或触发收信，不返回密码、查询码、签名密钥或原始错误。
- ID 响应 `status` 为 `available | unsupported | unavailable`，包含 `checkedAt`、`listeners` 和可空 `delivery`。上游不支持健康接口或读取失败时，不以零或正常伪装；邮件列表独立可用。
- 同条件查询强制重读，改变条件仍由共享查询生命周期发起一次读取；主邮箱、虚拟邮箱和收件记录均提供“刷新列表”。“立即同步”表示补收，进行中的重复点击不产生新请求。
- 复用共享总览组件展示后台接口、自动收信、通知投递及页面连接；状态注明检查时间。仅进入、刷新、回到前台、事件或重连时更新，无新增邮件轮询。
- 邮件变更保留筛选和分页，非第一页提示查看第一页。同步请求中断后先回读列表，不自动重放；连接测试成功后也回读状态。原事件版本补齐和错误保留内容机制继续使用。

## 本轮文件

业务与类型：

- `packages/shared/src/v2/vendure-mailbox.ts`
- `apps/api/src/id-business-v2/workspace/id-business-v2-vendure-mailbox.controller.ts`
- `apps/api/src/id-business-v2/workspace/id-business-v2-vendure-mailbox.service.ts`
- `apps/api/src/id-business-v2/workspace/providers/id-business-v2-vendure-mailbox.client.ts`
- `apps/admin/src/v2/features/auto-recharge/vendure-mailbox-api.ts`
- `apps/admin/src/v2/features/auto-recharge/VendureMailboxManager.vue`
- `apps/admin/src/v2/features/auto-recharge/VendureMailboxHealth.vue`
- `apps/admin/src/v2/features/auto-recharge/vendure-mailbox-health.ts`

验证：新增 API `mail-health.spec.ts`、管理端 `vendure-mailbox-health.spec.ts`、`scripts/acceptance-v2-mailbox-realtime.mjs`；原 `V2VendureMailboxDesignFixture.vue` 增加离线健康响应，避免访问真实服务。

Vendure 源码与独立检查记录归该项目 `docs/local-validation/mailbox-realtime-20261016/RESULT.md`。

## 实际检查

| 范围                                                              | 结果      |
| ----------------------------------------------------------------- | --------- |
| ID API：健康权限、兼容、邮件代理、通知回执                        | 28 项通过 |
| 管理端：健康文案、页面契约、事件恢复、70 秒请求策略               | 19 项通过 |
| 共享包 Node ESM 及既有契约                                        | 7 项通过  |
| Vendure 监听、恢复、通知、同步、插件接线                          | 39 项通过 |
| Shared/API/Admin 类型检查及构建                                   | 通过      |
| Vendure 插件类型检查和构建                                        | 通过      |
| ID 定向 ESLint、格式检查                                          | 通过      |
| 七项 UI/加载/架构/隔离规则及 Prisma 边界、并发规则                | 通过      |
| 离线真实路由：深浅主题 × 1440/900/390                             | 6 组通过  |
| 离线测试/同步操作：测试成功回读、中断回读、不重放及进行中重复点击 | 1 组通过  |

浏览器执行 `node scripts/acceptance-v2-mailbox-realtime.mjs`、`--actions-only`。默认矩阵不产生模拟写请求；操作场景仅向隔离合成接口发送一次测试和一次同步，真实外部请求为零。覆盖相同/不同条件各一次读取、事件更新、非首页提示、旧版健康兼容、配置缺失、SSE 断线补齐、失败保留旧内容及空状态。

`.runtime/mailbox-realtime-20261016/browser/report.json`、`report-actions.json`、`report-captures.json` 与 PNG 为本轮离线证据。合成事件场景记录 157–219ms，该场景包含回到第一页的自动化点击，不能作为生产邮件延迟证明。

## 待完成的生产验收

获得明确发布授权后，先发布 Vendure，再发布 ID。健康接口兼容旧上游，但两端各自版本、配置与实际回读仍须核对。

生产检查监听租约、通知积压与投递回执、页面 SSE 和重连结果。在用户指定邮箱，由用户自行触发三封唯一标识邮件，不点击“立即同步”，记录入库与页面显示时间；正常网络目标每封不超过 5 秒。发送方到 iCloud 的时间另计。还需验证真实断线及授权恢复。以上均未执行，不能登记为实时闭环已验收。

## 独立发布记录

用户授权本窗口单独发布人工未注册状态优先级和邮件刷新修复。原目录混合 WIP 保留，发布候选仅叠加本窗口 9 项业务源码；不修改表、字段、依赖、环境变量或既有超时。

Vendure 修复已由 PR #748 合入，相关完整插件检查通过。发布控制修复为 PR #749、#750；其中独立后台通道支持保留前台。用户随后明确允许另一窗口正在执行的全量发布，本窗口等待其结果。正式运行 [38882368498](https://github.com/wangchaozhuanyong/kaiyuangouwu/actions/runs/38882368498) 已成功，线上版本 `626f1d066ec19eb3697d64147173e9b64e0b4403` 包含本窗口收信修复，取得 `PRODUCTION_DEPLOY_OK` 与精确版本回执；该次商城前台亦随用户同意一并更新。本窗口未启动重复发布。

ID 已分别验证两批成功发布的后继：账号/搜索 `13e52ad670c6b6daa94ab2df009aaa8a9d69b97c`，结算恢复 `c0238525bb4b2a1c3fe6688eaed5f74f504ee529`。候选继承其已核实的运行来源、数据库、客户端和服务保护。重建的 587 个 API 运行文件、258 个干净 Admin 文件匹配原生证据；邮箱 API 增量只有 4 个模块、11 个编译文件，Shared 运行代码不变。独立入口继承原发布锁、备份、任务保护和独立回读，不进行迁移。

已上线的自动搜索继续保留。状态筛选增加立即查询；“刷新列表”重新读取当前搜索条件，二者均检查一次有效读取。实际投影 API 85 项、Admin 19 项、类型检查、构建和七项界面/架构规则通过。深浅主题 × 1440/900/390 六组及中断/重复点击操作组通过；本轮合成事件记录 152–457ms，不代表生产邮件延迟。

后续运行 [38883922525](https://github.com/wangchaozhuanyong/id-business-system/actions/runs/38883922525) 在另一批自动注册发布的切换后校验失败，原始回执为 `REGISTRATION_PARITY_DIAGNOSTICS_RUNTIME_CONFIGURATION_CHANGED`，位置 `smoke`。本窗口没有覆盖该中间状态，也没有重复触发该失败发布。ID 独立发布仍待该批生产状态恢复一致，届时必须核对实际版本并重新绑定候选；不能将上述旧基线直接发布。

真实三封邮件、断线恢复、授权恢复及入库到显示不超过五秒均待生产验收；没有发送测试邮件或执行注册、付款、订阅变更及外部通知。
