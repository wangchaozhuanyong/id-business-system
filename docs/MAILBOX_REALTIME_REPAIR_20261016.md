# 邮件自动收信与页面刷新修复（2026-10-16）

状态：代码及本地验证完成；用户已授权单独发布，正在准备隔离候选。生产实时闭环待验收。

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

2026-10-16 用户授权本窗口单独发布两项修复：人工未注册状态优先级、邮件自动收信与页面刷新。隔离候选基于 main `13e52ad670c6b6daa94ab2df009aaa8a9d69b97c`，原目录混合 WIP 保留。生产 API/Admin 使用已经实测的 d443 组件来源重建并只叠加本窗口 9 项业务源码，完整保留其他组件、数据库与生成客户端。独立入口 `Mailbox Realtime Repair Release` 继承已有发布锁、运行任务保护、备份、组件来源及独立回读要求；不触发真实邮件、注册、付款或通知验收。正式结果取得后再追加。

此次候选继续保留新合入的账号搜索源码；实际发布投影仅从 `reviewedApplicationCommit` 读取本窗口已冻结的 9 项源码，未发布的共享自动搜索能力不会随邮箱修复上线。
