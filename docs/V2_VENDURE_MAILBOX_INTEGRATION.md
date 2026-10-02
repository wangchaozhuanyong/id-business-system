# Vendure 邮件验证码查询互通

## 当前状态

ID 业务管理系统一侧已于 2026-09-14 完成代码、CI、发布与线上页面验收：

- PR #207 完成邮箱查询范围、最近 5 封限制、验证码复制、管理按钮交互、响应式布局及订单字段展示。
- PR #208 修复查询表单清空后残留默认校验提示。
- 最终 `main` 为 `1d4d79ec23b313c72a89728f4e5f3eb60edc3198`，对应生产标签
  `v2-production-20260914T145500Z`。
- 本次邮箱功能没有新增数据库表、字段或 migration。

本文档记录 ID 仓库的已交付边界。Vendure 仓库内邮件重新归属与邮件数量一致性修复仍未提交、未发布，不得由 ID 仓库的生产标签推断为已上线。

## 数据边界

Vendure iCloud Relay 是主邮箱、虚拟邮箱、查询码和收件记录的唯一数据源。ID 系统不复制这些业务记录，所有读取和写入都由 ID API 服务调用 Vendure GraphQL，因此两个管理站点读取的是同一份实时数据。

ID 系统原有工作台邮箱池继续管理本系统自有的 Gmail、iCloud 和 Microsoft 邮箱，不与 Vendure 数据合并。

## 入口与布局

左侧“自动充值”分组顺序固定为：

1. 自动充值
2. 邮件验证码查询
3. 地址管理

邮件验证码查询页与 Vendure 管理页使用相同的信息架构：主邮箱管理、虚拟邮箱管理、收件记录。桌面端使用统一表格操作列，窄屏允许表格在容器内滚动；新增和编辑使用右侧抽屉，危险操作使用确认弹窗。

## 连接方式

ID API 通过以下服务端环境变量连接 Vendure：

- `VENDURE_MAILBOX_ADMIN_API_URL`
- `VENDURE_MAILBOX_SHOP_API_URL`
- `VENDURE_MAILBOX_API_KEY`

API Key 只授予 Vendure 的 `CreateIcloudRelay`、`ReadIcloudRelay`、`UpdateIcloudRelay` 和 `DeleteIcloudRelay` 权限，不使用 SuperAdmin 凭证，也不发送到浏览器。公开查询由 ID API 代理到 Vendure Shop API，并转交经过可信代理规则解析的客户端 IP。

生产环境需要把 ID API 到 Vendure 的固定私网代理跳数写入 Vendure `VENDURE_TRUST_PROXY`，避免所有买家查询被识别为同一个 ID API 地址；不得使用允许任意来源伪造转发头的宽泛配置。

## ChatGPT 账号导入与邮箱管理边界（2026-10-02 更正）

ChatGPT 账号批量导入是独立的账号资料导入功能，按所选格式保存邮箱、可空密码、2FA 和备注，不选择主邮箱，也不自动添加或关联邮件验证码查询中的虚拟邮箱。邮箱管理仍使用自己的新增与批量导入入口。

ID 完整校验资料和本地重复账号后，用本地事务保存整批账号；并发创建同一账号仍受本地唯一约束保护。导入成功或失败均不读取、添加、修改或删除 Vendure 邮箱记录。此次更正不清理历史邮箱资料。

账号「复制」只读现有有效 BUY 码，不查询真实收件、不重置查询码。复制后缀设置在「ChatGPT 账号」页顶部操作区，位于「批量导入」左侧，按当前 ID 管理员保存；它是 ID 账号交付偏好，不是 Vendure 邮箱资料。

账号复制使用既有 ID API：`GET /id-business-v2/bank-recharge/account-copy-settings`、`PUT /id-business-v2/bank-recharge/account-copy-settings`、`POST /id-business-v2/bank-recharge/accounts/:id/copy`。账号导入请求只提交 `accounts`；旧请求携带的 `primaryAccountId` 被忽略。此次更正无新增接口、数据库表、列、migration、依赖或环境变量。

2026-10-01 的复制及后缀历史证据见 `.runtime/chatgpt-account-delivery-20261001/RESULT.md`，其中导入关联行为已由此次更正取代。此次导入更正的检查与浏览器证据归属 `.runtime/chatgpt-account-import-20261002/`；本地结果不代表生产发布。

## 发布验收

2026-09-14 的证据分层如下：

- 本地自动化：PR #207 记录 API 定向测试 59/59、Admin 定向测试 31/31，Shared/API/Admin 类型检查与生产构建通过；PR #208 记录邮箱工作区相关测试 24/24 通过。
- 远程 CI：PR #207 与 PR #208 的 Quality Gate 均通过后合并。
- 本地功能验收：隔离模拟数据覆盖虚拟邮箱仅返回所属邮件、买家查询最多 5 封、验证码一键复制、主邮箱“测试/同步”按钮以及桌面端和 390px 窄屏。
- 生产页面验收：公开 `/mailbox` 在 1280px 和 390px 下无页面级横向溢出；粘贴、BUY 查询“最近 5 封”状态、无效查询码的受控错误以及清空后移除校验提示均已核验。

仍未验证：

- 为避免读取真实用户邮件和验证码，没有使用有效的生产买家查询码执行真实邮件查询。
- Vendure 仓库待将邮件归属限制在同一主邮箱，并在重新归属或删除后重算原/新虚拟邮箱的 `mailCount`；该变更需在 Vendure 仓库单独检查、提交和发布。
