# 同浏览器新标签页登录恢复

2026-09-05 本地修复与验收完成。未提交代码、创建 PR 或部署生产。

## 问题和行为

原有登录凭据仅保存在标签页的 `sessionStorage`；新开相同网址时没有凭据，直接进入登录页。
现在登录成功或旧标签页通过 `/auth/me` 校验后，服务器设置浏览器会话 Cookie。新标签页调用
`GET /api/auth/session` 恢复现有会话，再进入权限允许的业务页，无需再次填写账号密码。

退出、重新登录及已确认的会话撤销通过共享身份标记同步其他标签页。标记只包含随机身份编号、
JWT 会话编号和退出状态，不含令牌或用户资料。延迟恢复响应不能覆盖更新的登录，断网退出后也
不会因旧 Cookie 在刷新时恢复登录。旧 Cookie 与当前登录代际不一致时拒绝恢复。

## 接口与边界

- 新增 `GET /api/auth/session`，返回当前有效的 `accessToken` 和服务器查询的用户资料，响应为 `no-store`。
- Cookie 为 host-only、HttpOnly、SameSite=Strict；生产增加 Secure，不设置长期有效期。
- Cookie 仅发送到 `/api/auth/session`，后端也只允许该 GET 路由的 `Sec-Fetch-Site: same-origin`
  请求使用 Cookie。JWT、在线会话、MFA、IP 和用户状态仍由现有守卫校验。
- 其他 API 仍要求 Bearer；Cookie 不能授权普通业务读取或写入。退出、改密会清除 Cookie。
- 保留 `sessionStorage` 原子凭据格式、身份代际、请求取消、冷启动错误边界与已验证内容的只读降级。
- 不新增表、字段、migration、依赖或环境变量。

浏览器属性依据：[MDN Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)、
[MDN Sec-Fetch-Site](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-Fetch-Site)。

## 本次文件

前端认证与路由：

- `apps/admin/src/auth/browserSessionMarker.ts`（新增）：不含令牌的浏览器会话标记。
- `apps/admin/src/auth/sessionCoordinator.ts`：恢复、代际校验、登录/退出同步和失效处理。
- `apps/admin/src/auth/sessionCoordinator.spec.ts`：恢复、并发、错误、退出和旧响应回归。
- `apps/admin/src/api/auth.ts`：恢复请求。
- `apps/admin/src/api/requestPolicy.ts`、`apps/admin/src/api/requestPolicy.spec.ts`：精确端点例外与有界重试。
- `apps/admin/src/v2-router.ts`：其他标签页登录后自动离开已打开的登录页。

后端认证：

- `apps/api/src/auth/browser-session-cookie.ts`（新增）：Cookie 的设置、清除与严格读取边界。
- `apps/api/src/auth/jwt-auth.guard.ts`、`apps/api/src/auth/jwt-auth.guard.spec.ts`：沿用现有校验链，拒绝跨源、其他路由、过期与撤销会话。
- `apps/api/src/v2-auth/v2-auth.controller.ts`、`apps/api/src/v2-auth/v2-auth.controller.spec.ts`（测试新增）：登录/校验/刷新时建立 Cookie，退出/改密时清除，以及受保护的恢复接口。

验收和文档：

- `scripts/acceptance-v2-browser-session.mjs`（新增）：真实浏览器与编译后认证控制器、JWT 守卫的本地验收。
- `scripts/acceptance-v2-session-reliability.mjs`：给无 Cookie 的登录预热补充恢复端点 401 测试响应。
- `scripts/acceptance-v2-table-layout.mjs`：登录页滚动验收同步模拟无 Cookie 时的恢复端点 401 响应。
- `docs/V2_ARCHITECTURE.md`、`docs/V2_TASKS.md`、本文档。

工作区已有的网站统计和 Microsoft 邮箱回调等修改未纳入本次修复。

## 已执行检查

```bash
npm run test --workspace @apple-business/admin
npm run test --workspace @apple-business/api -- src/auth/ src/v2-auth/v2-auth.controller.spec.ts
npm run typecheck --workspace @apple-business/admin
npm run typecheck --workspace @apple-business/api
npm run build --workspace @apple-business/admin
npm run build --workspace @apple-business/api
npm run check:v2-ui-language
npm run check:v2-loading-standard
npm run check:v2-module-architecture
npm run check:v2-isolation
node scripts/acceptance-v2-browser-session.mjs
npm run acceptance:v2-session-reliability
git diff --check
```

上述检查通过：管理端 107 个测试文件、489 项测试；API 认证相关 6 个测试文件、43 项测试。
另对本次修改的 TypeScript 和验收脚本执行定向 `npx eslint`，通过；格式由 Prettier 检查。

新增浏览器验收使用隔离测试账号、临时签名密钥和内存中的在线会话集合，连接真实的本地
NestJS 编译后认证控制器与 JWT 守卫；业务列表使用空数据 fixture，不连接数据库或生产账户。
正常 BroadcastChannel 和禁用 BroadcastChannel 两种情况下均验证：

- 一个密码登录后新标签页恢复，原标签页刷新保持登录。
- 不同浏览器 context 互不继承，普通接口不能仅凭 Cookie 访问。
- 退出后其他标签页回到登录页，刷新和第三个标签页保持退出。
- 重新登录后已打开的其他标签页恢复业务页。
- 服务器撤销会话后拒绝新标签页恢复，并同步退出。

原有会话可靠性验收覆盖桌面 1440px 与手机 390px 冷启动 503；已验证会话 503 时保留内容、
进入只读并在恢复后重新验证，全部通过。

## 发布与尚未验证事项

需要将管理端与 API 放在同一正式发布中，维持现有同源 `/api` 反向代理；不需要数据库迁移。
首次上线后，之前已打开的旧版本页面须刷新一次，或重新登录一次，以建立恢复 Cookie。
后续新标签页会自动恢复有效登录。

浏览器关闭后的 Cookie 保留取决于浏览器会话恢复设置；服务端 JWT 的原有效期和撤销策略不延长。
生产 HTTPS Cookie、实际管理员账号与生产双标签页验收尚未执行，不能以本地测试替代上线验收。
