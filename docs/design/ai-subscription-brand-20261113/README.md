# AI订阅管理系统 · 品牌

2026-11-13 用户要求将网站更名为「AI订阅管理系统」，设计并接入 Logo。

## 设计与使用

- 标准名称：AI订阅管理系统。中文名称与图标并排展示，不将中文烘焙进位图。
- Logo：白色 Ai 字母、薄荷绿色圆点和向上循环弧线，深青色底。循环弧线对应订阅与续费。
- 侧栏 36px、登录页桌面 36px／手机 32px、公开查询页 32px；保持正方形比例，由界面设置圆角。折叠侧栏只显示图标，链接保留完整无障碍名称。登录页沿用用户后续选定的 [暖白极简方案](../login-styles-20261113/IMPLEMENTATION.md)。
- 深浅主题使用同一图标，文字沿用系统主题颜色。图标旁已有名称时使用空 alt，避免重复朗读。
- 原有导航、业务内容、目录、模块标识与数据库名称沿用原值。独立预览和本机测试仍在页面标题中标明环境。

## 资产

| 文件 | 用途 |
| --- | --- |
| `logo-source.png` | 内置 image_gen 生成的选定原图 |
| `../../../frontend/brand/ai-subscription-mark.png` | 256 × 256，站内图标 |
| `../../../frontend/brand/favicon-32.png` | 32 × 32，浏览器图标；兼容 /favicon.ico |
| `../../../frontend/brand/apple-touch-icon.png` | 180 × 180，移动设备书签 |

使用内置 image_gen 生成，未使用 API/CLI 回退。选定原图复制到本项目，部署尺寸由 macOS sips 等比导出。最终生成提示词见 [prompt.txt](prompt.txt)。

## 本地验收

验收脚本、逐状态几何数据、改名前后截图及统一门禁日志保存在项目 `.runtime/ai-subscription-brand-20261113/`。使用拦截请求的离线 Chromium，虚构资料不作为业务结果；未启动网站、数据库或 Docker。实际检查结果见该目录的 `validation.json` 和 `ui-contract/result.json`。

以下为品牌设计交付时的本地检查：

- `node test/check-ui-contract.mjs`：unit、browser、spacing、mailbox、tabs、feedback 六组全部通过。其中单元检查 318 项、浏览器检查 70 项；包含共享布局和手机导航专项。
- 品牌专项：32 个场景通过，覆盖 320/390/900/1440px、深浅主题、空列表/有资料、登录页、公开查询、说明浮层、图标解码和侧栏折叠。所有请求被本地拦截。
- `node --test test/auth-remember-device.browser.mjs`：通过；使用既有 Playwright 和模拟请求，验证登录表单、保持登录及设备控件。
- 修改的 JavaScript 语法检查和 `git diff --check`：通过。
- 浏览器实际检查登录页、后台及公开查询页截图；完整后台服务和生产环境未启动或验收。

## 修改文件

| 范围 | 文件 |
| --- | --- |
| 页面标题、页脚和图标声明 | `frontend/index.html`、`frontend/bitbrowser-local.html` |
| 侧栏名称和 Logo | `frontend/prototype.js`、`frontend/prototype.css` |
| 登录页品牌 | `frontend/local-auth.js`、`frontend/local-auth.css` |
| 公开邮箱查询页品牌 | `frontend/apple-relay-public.html`、`frontend/apple-relay-public.css` |
| 静态图片、favicon 和环境标题 | `server/preview.mjs` |
| 监控消息中的系统名称 | `server/monitoring-policy.mjs`，只改文案，未发送消息 |
| 标题、图片响应和安全策略断言 | `test/local-business.test.mjs` |
| Logo 与说明 | `frontend/brand/` 下三张 PNG、本目录原图和提示词、根 `README.md` |

原有未提交的充值改动及 `docs/DESIGN_SPEC.md` 未由本任务修改。验收期间记录到充值资源文件有其他并行更新，保留现场，未回滚或合并该部分。
