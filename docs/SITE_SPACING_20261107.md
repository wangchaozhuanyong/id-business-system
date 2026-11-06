# 2026-11-07 全站卡片留白修复

## 范围与根因

用户反馈苹果隐藏邮箱「查询中心」的文字、输入框、底部说明和按钮贴着卡片边框，要求检查全站同类问题。
本次修改属于独立版 `frontend/`，保留此前工具弹窗与旧邮箱功能补齐的未提交修改。

`.panel` 本来是供页签、表格使用的无内距边框容器，但部分页面直接把表单或按钮放在下面。
同时，页首操作在找不到显式插槽时会追加无内距的底栏，导致续费「提醒设置」贴右边和底边。
不同内容容器、工具栏和分页区各自维护间距，嵌套后还会重复缩进。

## 修改

- `frontend/prototype.css`：共享卡片内容、标题、页签、工具栏、分页和侧栏的横向内距。
  桌面 22px、1150px 及以下 20px、900px 及以下 16px；正文纵向内距 20／18px。
  新增 `.panel-body` 内容容器，已有内容容器复用同一规则；直接嵌套的分组不再重复缩进。
- `frontend/prototype.js`：页首按钮优先进入现有工具栏或页签操作行，最终兜底也使用带内距的工具栏。
  续费「提醒设置」现在与筛选同组。
- `frontend/apple-relay-prototype.js`：查询中心使用共享内容容器；服务读取失败及邮箱资料读取失败的重试按钮进入工具栏。
- `frontend/operations-prototype.js`：员工权限占位页的「查看操作记录」进入工具栏。
- `frontend/commerce-prototype.js`：汇率来源说明使用共享内容内距。
- 全站回归额外发现订单统计在 320px 下被金额与单位撑宽；在共享统计卡片层限制列宽，允许单位换行，保留完整金额。
- `docs/DESIGN_SPEC.md`：登记容器留白归属、按钮兜底规则及离线验收入口。

没有新增或修改 API、表、字段、依赖、环境变量、登录或权限逻辑。本次没有数据迁移。

## 浏览器验收

测试读取实际前端源码，API 使用隔离合成资料，全部网络请求由 Playwright 拦截。
没有启动本机网站、Docker、数据库或连接线上业务接口。

| 检查 | 实际结果 |
| --- | --- |
| 全部 38 个导航页面及页签，1440／1024／901／900／768／390／320px，深浅主题；另含 76 个抽屉状态及 API 模式空／失败分支 | 共 1474 个状态，贴边检查及整页横向溢出检查全部通过，无页面脚本错误 |
| 共享布局：标签、提示浮层、页签、阅读位置、充值嵌入区域和日志表格 | 7 项通过 |
| 手机导航与长列表边界：257 条合成客户、第一页／末页／空结果／详情抽屉 | 18 项通过 |
| 2FA、解析、邮箱查询及邮箱池的既有工具布局与交互 | 24 组通过 |
| `node --test frontend/*.spec.mjs` | 162 项通过 |
| 变更 JavaScript 的 `node --check` 与 `git diff --check` | 通过 |

查询区的真实测量值（含 1px 边框）：

| 视口 | 修复前标签左侧／输入框右侧／按钮右侧 | 修复后 | 修复后按钮距卡片底部 |
| --- | --- | --- | --- |
| 1440px | 1／1／1px | 23／23／23px | 21px |
| 390px | 1／1／1px | 17／17／17px | 19px |

实际查看了桌面浅色、手机深色查询中心截图，以及续费工具栏和 320px 订单统计截图。
查询输入在切换「主邮箱管理」再返回后仍保留。表格与长页签使用容器内横向滚动，不以裁切全页掩盖溢出。

测试文件：

- 新增 `test/site-spacing.browser.mjs` 和共享离线加载器 `test/helpers/offline-design.mjs`。
- `test/shared-layout.browser.mjs`、`test/mobile-navigation-layout.browser.mjs`、`test/design-list-boundaries.browser.mjs`
  增加可选 `ID_LAYOUT_QA_OFFLINE=1` 模式，保留原断言及默认运行方式。

复现命令（在本独立项目根目录执行，Playwright 使用已有安装）：

```sh
node test/site-spacing.browser.mjs
ID_LAYOUT_QA_OFFLINE=1 ID_RECHARGE_QA_PLAYWRIGHT=/absolute/path/to/playwright/index.mjs node --test test/shared-layout.browser.mjs test/mobile-navigation-layout.browser.mjs test/design-list-boundaries.browser.mjs
node test/online-tools-parity.browser.mjs
node --test frontend/*.spec.mjs
```

几何记录和日志在 `.runtime/site-spacing-20261107/`，其中 `spacing-results.json` 为最终全站结果。
同目录的 `after-relay-api-1440-light.png`、`after-relay-api-390-dark.png`、
`after-renewal-1440.png`、`after-statistics-320.png` 为截图；均为合成资料。

## 交付状态与限制

代码及本地离线布局验证完成，未 commit、push、创建 PR 或部署。
本独立版没有单独 typecheck、lint、build 脚本，未套用旧 Vue 项目的检查入口。
上述结论只覆盖本次留白、操作可达和响应式回归，不代表全部业务功能、真实收信、支付或生产效果已经验收。
上线后仍需用正式构建核对实际页面；当前线上页面不会因本地修改自动变化。
