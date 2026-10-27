# 查询码有效期选择：2026-10-27

状态：代码与本地验证完成，用户已授权提交、推送、合并与正式发布。最终发布与线上回读结果记录在项目内 `backups/query-code-validity-release-20261027/`。所有本地浏览器数据均为模拟邮箱。

## 完成范围

- 工作区“邮箱查询与管理 → 邮箱池管理”与“邮件验证码查询 → 主/虚拟邮箱管理”共用重置弹窗。
- 提供 30 天、3 个月（90 天）、半年（180 天）、1 年（365 天），按固定天数计算；不是自然月。
- 展示邮箱、原到期时间、预计到期时间；重置成功从服务端本次操作时间重新计时，不叠加旧剩余时间。
- 确认成功后旧码失效；显示新码、服务端实际到期时间及复制按钮。失败保留所选周期，提交期间禁止关闭和重复提交。
- 按邮箱保留未提交时长草稿。重置成功才清理对应草稿；不把查询码放入草稿或浏览器存储。
- 列表显示剩余时长和到期时间；过期明确标示。保留两套系统现有的手动/自动换码规则，Vendure 自动换码继续读取保存的周期。
- 全局设置作为新建邮箱默认值；已有记录保持原值。原有显式同步勾选功能继续保留，只有勾选才同步现有码的期限和周期。

## 数据与接口

用户在本对话中明确允许新增邮箱周期字段。

- ID 当前 MySQL schema 新增 `IdBusinessV2ManagedMailbox.queryCodeValidityDays`，默认 30。
- 新迁移：`apps/api/prisma-mysql/migrations/20261027010000_managed_mailbox_query_code_validity/migration.sql`。仅添加列，不修改旧码或原到期时间，不删除数据。
- 新建、微软授权创建、重置、显式同步现有码均保存周期。旧客户端省略重置时长时沿用邮箱已保存周期。
- ID 现有邮箱池 `POST .../workspace-mailboxes/:mailboxId/query-code` 和 Vendure 主/虚拟邮箱 `POST .../reset-code` 增加可选请求字段 `validityDays`。
- Vendure 两个既有 GraphQL reset mutation 增加可选 `codeResetIntervalDays` 参数；新码、周期、到期时间在一次条件更新中写入，保留原事务、权限与并发冲突保护。Vendure 无新增数据库字段。
- 没有新依赖、新环境变量或新 API 路径。

## 修改归属

ID 项目：

- `apps/admin/src/v2/components/workspace/V2MailboxQueryCodeResetDialog.vue`、`mailboxQueryCodeValidity.ts`：共用弹窗与选项/预览。
- `apps/admin/src/v2/components/workspace/V2ManagedMailboxPanel.vue`、`managedMailboxExpiry.ts`：邮箱池入口、默认设置、状态显示。
- `apps/admin/src/v2/features/auto-recharge/VendureMailboxManager.vue`、`vendure-mailbox-api.ts`、`apps/admin/src/v2/api/workspace.ts`、`apps/admin/src/v2/features/tableSchemas.ts`：Vendure 入口、请求与桌面/手机显示。
- `apps/api/src/id-business-v2/workspace/` 下 managed-mailbox / vendure-mailbox 的 controller、dto、service、repository、client 与相关测试；复用最新 main 已有的输入校验。
- `packages/shared/src/v2/workspace.ts`、MySQL schema、新迁移：邮箱周期持久化与返回契约。
- `apps/admin/src/v2/testing/V2MailboxQueryCodeValidityFixture.vue`、`mailbox-query-code-validity-fixture.ts`、`apps/admin/mailbox-query-code-validity-fixture.html` 及 `scripts/acceptance-v2-mailbox-query-code-validity.mjs`：隔离模拟浏览器验收，不进入生产入口。

Vendure 项目（`../vendure开源/vendure-master`）：

- `packages/icloud-relay-plugin/src/api/api-extensions.ts`、`icloud-admin.resolver.ts`。
- `packages/icloud-relay-plugin/src/services/icloud-admin.service.ts`、`icloud-admin.service.spec.ts`、`icloud-access-code.service.ts`。
- `packages/icloud-relay-plugin/src/client/admin.graphql`、`admin.generated.ts`。

两个仓库原有其他工作区改动均保留；不把这些文件的原有未提交内容视为本任务的独立发布候选。

## 已运行的验证

- ID API：最新 main 隔离发布工作树的 6 个定向测试文件，共 56 项通过。
- ID Admin：4 个定向测试文件，31 项通过，包含预览日期跨月/年、到期状态和现有页面契约。
- Vendure：隔离发布工作树的插件单元测试 173 项通过，SQL.js 集成测试 35 项通过；远端原生 CI 另验证 MySQL 并发保护。
- ID Shared 编译、API/Admin 类型检查与生产构建；Vendure 插件类型检查与构建。
- ID 七项强制 UI/架构规则及北京时间规则通过；定向 ESLint、Prisma schema 校验。
- 模拟浏览器：2 个实际管理组件、深浅主题、1440/1024/901/900/768/390px 共 24 个布局场景；取消保留、邮箱隔离、失败重试、防重复、复制、记忆周期、写入后读取失败两条流程均通过。
- 原工作区首次架构失败和浏览器初始定位器问题的证据保留；隔离候选复用最新 main 的既有校验，未提高架构上限。
- 浏览器使用 Vite 构建静态夹具，由 Playwright 拦截请求提供文件；没有启动本机网站/API 服务、Docker 或数据库，也没有真实邮箱请求。

复验入口：`node scripts/acceptance-v2-mailbox-query-code-validity.mjs`。布局截图与 `browser-result.json` 在 `.runtime/mailbox-query-code-validity-20261027/`。

## 正式发布流程与验证边界

1. 先发布支持可选 reset 周期参数的 Vendure 后端，再发布 ID；旧 Vendure schema 不接受新参数。
2. `mailbox-validity-publication.yml` 复用生产全局锁、OIDC/SSM 传输、备份及独立回读。发布前核对原生 PR/main 质量证据、隔离 MySQL 迁移用例和当前部署基线；只允许新增这一周期列。
3. 构建精确 main，复现线上现有 Admin 与选定 API 模块，覆盖本次受影响模块、生成的 Prisma 客户端与 Admin。保留其余运行组件、环境变量和 Prisma 原生引擎；旧查询码、原到期时间在迁移前后以数据库内聚合指纹核对。
4. 不重置真实查询码，不执行真实付款、通知或其他业务写入测试。版本、镜像、迁移、页面及非写入线上检查分别记录，不能用模拟验收代替线上验证。
