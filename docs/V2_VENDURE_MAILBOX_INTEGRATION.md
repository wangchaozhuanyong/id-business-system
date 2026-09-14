# Vendure 邮件验证码查询互通

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

## 发布验收

本地代码完成后仍需在两个生产环境配置接口地址和专用 API Key。上线验收必须分别确认部署版本、Vendure 权限角色、双向新增与更新回读、查询码重置后旧码失效、收件同步、公开查询限流和两端页面布局。未完成这些步骤前不能把本地结果表述为线上已互通。
