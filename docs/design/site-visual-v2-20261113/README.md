# 全站视觉第二版 · 本地候选

已将第二版视觉落到本项目实际前端，共享样式覆盖导航、表单、列表、抽屉、总览、工具和设置；登录、公开邮箱查询、比特工作区及充值外围沿用同一套色板。候选及离线验证记录如下；正式发布另以 GitHub 主线提交和生产回执为准。

- 基线：`4f49095e98a45e9de4e0b2b27aec42517918dab4`，本轮开始时核对的最新 main。
- 隔离目录：项目内 `.codex-worktrees/site-visual-v2-20261113`；原工作区品牌、充值等未提交改动保留。
- 本轮已获提交、推送、合并 main、正式发布及本次临时资源清理授权；本机仍不启动整站、Docker 或数据库，不产生真实测试订单、支付和外部通知。
- 截图使用同一份合成资料，固定时钟为 2026-11-13；`.test` 邮箱及客户、订单均为演示资料，没有写入正式前端的数据源。

## 查看效果

打开 [本地截图画廊](gallery.html)，切换页面、深浅主题、1920／1440／390／320px。三张主页面在 1920px 浅色下可查看前后对照。

| 页面 | 浅色 | 深色 | 1920px 完整可见记录 |
| --- | --- | --- | --- |
| 订单提交 | [查看](after-order-entry-1920-light.png) | [查看](after-order-entry-1920-dark.png) | 15 → 16 |
| 账号管理 | [查看](after-accounts-1920-light.png) | [查看](after-accounts-1920-dark.png) | 11 → 11 |
| 订单管理 | [查看](after-orders-1920-light.png) | [查看](after-orders-1920-dark.png) | 14 → 14 |

订单页保留左侧录入与右侧记录，1920×1080 下合成草稿的完整表单可见。较窄桌面通过表单内部滚动访问长内容；手机保留原有录入／最近记录切换与固定提交区。账号、订单对照使用相同列设置，全部原有列仍可选择。

## 实现范围

- `frontend/design-tokens.css`、`prototype.css`、`title-help.css`：深色导航、冷灰画布、轻填色控件、统一字级、顶置标签、细分隔、焦点与状态、表格数字和时间层级。订单客户／套餐／业务类型重组，付款短字段并排，代付和售卖合为一块金额区。
- `frontend/commerce-prototype.js`：最近订单、最近客户、最近租户新增即时模糊搜索；忽略大小写、支持多关键词，与日期共同过滤后再分页。订单可搜姓名、联系方式、订单号、订阅账号、套餐、付款方式和备注；客户／租户可搜姓名、联系方式、套餐和备注。保留草稿、权限范围、脱敏显示及各入口搜索条件。
- `frontend/prototype.js`、`inventory-prototype.js`：仅展示调整；日期拆行不重新解析、不改变时区。订单原币种与金额保留，未修改财务计算。
- `frontend/local-auth.*`、`apple-relay-public.*`、`bitbrowser-local.html`、`brand/`、`index.html`：统一外围颜色与品牌资源。三张品牌 PNG 与现有批准文件 SHA-256 相同。
- `server/preview.mjs`：仅补品牌静态 PNG 白名单、favicon、页面标题和同源图片 CSP；认证、接口和业务逻辑不变。
- `modules/recharge/codexdaichong/shell.css`：仅外围显示。锁定执行器及原版追踪文件没有修改，现有锁定资产加载核验通过。
- 更新 `docs/DESIGN_SPEC.md`、`ENGINEERING_RULES.md`；旧左标签几何断言按批准的顶置标签更新，原有业务、草稿、长内容和可访问性断言保留。

## 原候选离线验证

所有浏览器请求由本地静态资源或合成回执拦截，不监听网站端口。以下记录保存在项目 `.runtime/site-visual-v2/`。

| 检查 | 结果与证据 |
| --- | --- |
| 统一 UI 门禁 `node test/check-ui-contract.mjs` | 六组最终均 code 0；初次暴露的布局问题修复后，用同一入口重跑 browser／spacing。单元 318 项、浏览器 70 项、反馈 1 项通过；[结果](../../../.runtime/site-visual-v2/ui-contract/result.json) |
| 共享贴边扫描 | 53 个路由、2452 场景，0 失败；[日志](../../../.runtime/site-visual-v2/ui-contract/spacing.log) |
| 邮箱与页签 | 邮箱 64 场景通过，页签 2996 场景通过；分别见门禁 mailbox／tabs 日志 |
| 录入工作台 | 11 项通过；覆盖六种录入入口、9 个宽度、深浅主题、模糊搜索、日期、空结果、千／万条、草稿、刷新失败、长卡序列号；[日志](../../../.runtime/site-visual-v2/entry-final.log) |
| 最后一次列表／付款回归 | 27 项通过；长列表首末页与操作裁切、万条分页、卡片资料、录单／更正／续费；[日志](../../../.runtime/site-visual-v2/pagination-final.log) |
| 账号归属、手机与监控 | 定向通过；账号归属 14 个主题／尺寸与 4 种读取保存状态，手机资料卡、固定操作、导航返回草稿、监控字段布局。早期合并日志另含已由后续日志关闭的录入失败，不当作全组通过证据 |
| 登录专项 | 记住登录、设备控件、断线与重连保留状态通过；[日志](../../../.runtime/site-visual-v2/login-final.log) |
| 色板、图表、交互与充值外围 | 色板 2 项；图表键盘、空状态、音效及外围展示 9 项通过；[色板](../../../.runtime/site-visual-v2/contrast-tokens-final.log)、[视觉专项](../../../.runtime/site-visual-v2/visual-theme-recharge.log) |
| 充值原版资产 | 仅运行不启动服务的静态资产专项，完整固定资产加载核验通过；[日志](../../../.runtime/site-visual-v2/recharge-assets.log) |
| 实际截图与控件测量 | 三张主页面 24 场景，其他表面与控件 94 场景；无整页横向溢出，已测分隔距离无失败，未出现外部请求或真实写入；[主页面测量](preview-checks.json)、[表面测量](surfaces/checks.json) |
| 静态检查 | 修改的 JavaScript 通过 `node --check`；`git diff --check` 通过；本地画廊的前后、深色、手机与登录截图均可加载 |

正常、空、加载、失败、长内容、多页、抽屉及手机导航由现有业务专项和统一门禁组合覆盖。新增截图脚本直接读取实际前端；未注入概念稿 CSS，也未重写 DOM 美化截图。

## 对比度与验收差异

| 实际控件 | 浅色 | 深色 |
| --- | ---: | ---: |
| 输入文字／背景 | 14.45:1 | 13.15:1 |
| 标签／面板 | 6.29:1 | 8.78:1 |
| 聚焦边界／背景（含鼠标悬停） | 5.43:1 | 7.54:1 |
| 常态下边线／填色背景 | 3.26:1 | 3.87:1 |

发布前补齐了常态边界：保留轻填色与轻侧边，使用1px下边线标识输入区域，文字、常态下边线及聚焦边界均达标。日期输入继续使用原生控件，显示格式随浏览器环境变化。

## 边界与复现

HTTP 服务端品牌资源路由只做源代码／资源核对，未启动整站做 HTTP 验收；本轮不证明登录服务、数据库并发、外部绑定、真实付款或线上发布结果。真实付款、订阅变更和外部通知不属于本轮验收。

在本工作区运行：

```sh
export ID_LAYOUT_QA_OFFLINE=1
export ID_RECHARGE_QA_PLAYWRIGHT="$PWD/node_modules/playwright/index.mjs"
export ID_LAYOUT_QA_OUTPUT="$PWD/.runtime/site-visual-v2/recheck"
node test/check-ui-contract.mjs
node --test test/entry-workspace.browser.mjs test/auth-remember-device.browser.mjs test/design-tokens.test.mjs
node test/site-visual-v2.browser.mjs --matrix
node test/site-visual-v2-surfaces.browser.mjs
node test/site-visual-v2-border.browser.mjs
```

不要用整套 `npm test` 代替上述离线范围。

## 正式发布整合记录

- 从最新 main afa5862d 新建 codex/site-visual-v2-release-20261113。逐块处理品牌标题及资源版本冲突，保留主线新合入的暖白登录页；只提高其输入样式作用域，避免共享控件覆盖。
- 普通边界改为细下边线；实测8类页面及其可见充值嵌入页、深浅主题的110个控件均达到3:1，见 [实际控件边界](control-borders.json)。录入、付款、登录、色板、充值显示及图表专项35项通过。
- 补齐两个库存单测的共享日期渲染接口替身，保持原有字段完整性和历史归属断言。
- 复用既有 tableActionsPresentation 纯样式发布路径，只更新精确哈希清单 deploy/website/table-actions-20261112.json。前后产物只有 /shell.css 变化，另外10个资源及锁定上游版本完全相同；没有扩大执行器准入或修改发布流程。51项发布门禁单测通过。
- 发布候选统一 UI 门禁六组最终均通过：单元318项、浏览器70项、间距2452场景、邮箱64场景、页签2996场景及反馈专项。一次文件监听超时已保留失败日志，独立复测及整组复测均通过，未修改监听业务实现。
- 原候选、发布前补丁、范围清单、运行日志及发布回执归项目内 backups/releases/site-visual-v2-20261113/。最初本地候选日志保持历史含义，正式发布验证以该目录最终回执为准。
