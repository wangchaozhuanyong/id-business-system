# 租户归属规则接入记录

日期：2026-11-08。状态：代码完成、无数据库本地验证完成；未提交、推送或部署，未修改线上资料。

## 范围与行为

- 普通租户录入、列表新增抽屉及 Claude 录单快捷新增统一复用订单的员工选择控件和现有 `GET /api/local/auth/order-owners`。
- 新增默认当前登录人。管理员和超管可搜索选择启用的系统员工；员工归属规则固定自己，服务端拒绝指定其他人员。既有模块访问权限保持原样：当前普通员工没有租户录入页面访问权，本次没有扩大该权限。
- 新租户保存 `ownerId` 员工编号和 `owner` 姓名快照，服务端按实时目录确认姓名、角色及启用状态，不信任客户端提交的归属文字。
- 业务归属、录入人和修改人分别记录。租户新增时即使客户端省略或伪造录入、修改字段，服务端仍写入实际操作者；修改时保留原录入字段。
- 按订单已有规则，已保存租户的归属只读保留。历史租户不按姓名自动补绑，未知录入人不补造。租户资料的保存不更改历史订单归属。
- 员工目录刷新、失效选择提示、保存失败、关闭和切页保留草稿。快捷新增后自动选中新租户，订单原归属和输入保持独立。

## 文件

- `frontend/commerce-prototype.js`：复用归属控件、人员读取与刷新，区分租户和订单控件编号，保存归属及草稿。
- `server/order-policy.mjs`：共享订单及租户归属规则，按资料类型返回中文错误。
- `server/local-business.mjs`：在真实 commerce 保存归属处理入口接入租户，区分业务归属与实际操作者；导出纯归属处理函数供无数据库验证。
- `frontend/customer-provenance-prototype.spec.mjs`：更新新增租户及历史归属断言，补员工只读界面断言。
- `test/tenant-owner.test.mjs`：服务端规则和真实归属处理入口的定向单元测试。
- `test/tenant-owner.browser.mjs`：离线浏览器交互回归，保存响应接入真实服务端归属处理函数。

沿用前一轮隔离目录，基线 HEAD 为 `43aed364f063c8e1572f72a13c99119edfa5d2ac`。前序客户邮箱按产品隔离的未提交修改保留，并纳入受影响回归；其他工作区未修改。

## 接口、字段与迁移

没有新增 HTTP 接口、数据库表或列。租户已有 JSON 业务记录新增使用 `ownerId` 属性，原 `owner` 属性保存姓名快照。无需数据库结构迁移，不执行历史资料回填。

## 实际验证

语法检查和 `git diff --check` 通过。

以下无数据库定向检查共 31 项通过：

```sh
node --test test/order-owner-policy.test.mjs test/tenant-owner.test.mjs test/order-owner-directory.test.mjs frontend/customer-provenance-prototype.spec.mjs frontend/commerce-columns-prototype.spec.mjs
```

以下三份离线 Chromium 浏览器脚本通过，Node 统计 9 个测试（含子测试）：

```sh
ID_RECHARGE_QA_PLAYWRIGHT=<可用的 Playwright 模块绝对路径> node --test test/tenant-owner.browser.mjs test/order-owner.browser.mjs test/order-customer-email-history.browser.mjs
```

覆盖普通新增、快捷新增回填、管理员和超管选人、员工原访问权限、目录失败刷新、保存 503 后重新读取并恢复草稿、提交时员工失效的 409 拦截、历史资料保护及订单归属不变。租户说明默认收起、点击展开及 Escape 收起且不挤动控件；1440／390／320px、深浅主题下浮层、左侧标签和按钮无横向溢出。订单已有归属及 GPT／Claude 邮箱隔离回归通过。

最终租户选择草稿登记调整后，再补跑受影响租户浏览器脚本，通过。截图使用虚构资料，位于项目 `.runtime/tenant-owner-20261108/tenant-owner-1440-light.png` 和 `tenant-owner-390-light.png`，已实际查看。

## 验证边界

本机没有启动网站服务、Docker 或数据库，没有执行迁移。浏览器请求均被离线拦截；保存调用真实纯归属处理函数，不代表真实数据库事务、持久化或生产端到端验证已完成。该独立项目没有针对上述 JavaScript 的独立 lint／build／架构检查命令，本次使用语法、定向单元测试和浏览器交互验证；未运行包含数据库和监听服务的整套测试。真实持久化和发布后验收仍待对应授权及环境验证。
