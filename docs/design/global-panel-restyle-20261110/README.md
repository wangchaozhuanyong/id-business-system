# 全站模块装饰线替换 · 2026-11-10

状态：代码完成、离线页面验证完成；未提交、推送或部署，线上页面未由本轮改变。

## 本轮修改

按用户截图和明确要求，统一采用素面卡片：中性细边框、主题底色、标题和留白建立层级，业务色用于图标、状态标签及图表。

| 文件 | 本轮变化 |
| --- | --- |
| `frontend/overview-prototype.css` | 删除总览统计卡片彩色顶边和染色渐变底，复用 `.panel` 的统一边框、背景和阴影。 |
| `frontend/prototype.css` | 删除子导航的左侧装饰边；当前项沿用柔和底色、文字和选中标记。保留本文件此前的录入、账号／邮箱及充值码工作台修改。 |
| `modules/recharge/codexdaichong/shell.css` | 充值卡片顶部伪元素装饰线从部分页面禁用扩展为所有受管充值页统一禁用，覆盖嵌入与独立入口。动态生成的 Orbitcard 自动选路摘要改为四边一致的中性细边框；已有标题侧条禁用规则继续生效。充值面板段落支持长文字换行。 |
| `docs/DESIGN_SPEC.md` | 写入全站规则：现有及新增模块不使用顶部／左侧彩色边、渐变亮线、伪元素色条或单侧内阴影。 |

原版充值文件、JavaScript 业务行为、审批、归还、支付、登录及权限均未修改。无新增接口、表、字段或环境变量，无数据库迁移。

真实加载进度、键盘焦点、页签选中线、结构分隔线及数据图表保留原有语义。

## 验证

全部通过浏览器请求拦截读取实际静态文件和合成数据；未启动本机网站、API、Docker 或数据库，未请求生产服务或执行真实业务写入。

- 全站装饰边检查：50 个导航页面、12 个充值子页、3 个独立充值入口；1440、1024、390、320px，浅色与深色。累计 640 个页面／嵌入文档状态、1,120 次模块检查。最终装饰色条发现为 0，页面横向溢出为 0，脚本异常、缺失资源、外部请求均为 0。
- 真实点击银行卡池的「Orbitcard 开卡策略」页签，等待原有读取与渲染流程生成摘要，核对其左右边框宽度及颜色一致；未保存开卡策略。
- `test/shared-layout.browser.mjs`、`test/mobile-navigation-layout.browser.mjs`、`test/website-overview.browser.mjs`、`test/design-tokens.test.mjs`：共 21 项通过。覆盖表单及标题说明、导航、总览读取与失败恢复、空状态、权限显示、响应式和主题对比度。
- 增加充值段落换行后重新执行受影响的全站渲染检查和共享布局检查；共享布局最终 9 项通过。输入未改变的总览、导航及颜色检查复用此前结果。
- `git diff --check` 通过。本项目是原生 HTML/CSS/JavaScript，未配置单独的 TypeScript、lint 或 build 命令；未借用旧 Vue 仓库命令。

窄屏初次检查发现系统配置提示内的长配置名称撑出页面：修改前、后的嵌入视口均为 286px、内容宽度均为 316px，确认是已有文字换行问题。已在充值共享面板段落补充 `overflow-wrap: anywhere`，最终检查通过。未改提示含义或任何配置值。

## 复核材料

以下资料位于本项目 `.runtime/global-panel-restyle-20261110/`，截图均为合成测试数据，不代表生产业务数值。

- `edge-audit.json`、`edge-audit.log`、`verify.mjs`：最终覆盖范围、逐状态结果及可重现的离线检查。
- `regression.log`、`shared-final.log`：原有检查入口的通过结果。
- `before/`：本轮修改前的三份样式快照，保留当时已有工作；`config-320-comparison.json` 记录原有窄屏问题对比。
- `before-overview-1440-light.png`、`before-overview-1440-dark.png`：修改前同数据总览。
- `after-cards-light.png`、`after-cards-dark.png`：修改后的统计卡片。
- `after-preview-light.png`、`after-preview-dark.png`：修改后桌面首屏。
- `after-overview-390-light.png`、`after-overview-390-dark.png`：手机总览。
- `after-channel-summary-*`、`after-subscription-*`：动态摘要及独立订阅页面。

## 交付边界

本次验证的是样式和相关界面回归，不是生产发布或真实支付验收。既有未提交修改均保留，尚未 commit、push、创建 PR、修改线上系统；后续发布需沿用用户授权的正式流程，并重新读取线上实际页面。
