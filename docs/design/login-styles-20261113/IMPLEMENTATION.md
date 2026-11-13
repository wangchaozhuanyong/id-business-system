# 暖白极简登录页 · 接入记录

2026-11-13 用户通过效果图选定方案 03。以下记录接入范围和首次本地验证。

## 实际页面

[桌面效果](implemented-desktop.png) · [手机效果](implemented-mobile.png) · [深色适配](implemented-dark.png)

保留暖白底色、宋体标题、细线输入框和墨绿色按钮。桌面左侧展示品牌文案，右侧为登录表单；900px 及以下收起品牌文案，保留完整表单。已有深色主题使用同一排版和墨绿配色，不修改后台主题设置。

首次设置、密码显隐、保持登录、过期原因、错误提示、提交中状态及重复提交保护继续使用现有实现。密码显隐可通过键盘访问，触控区域至少 44px。浅色辅助文字对比度为 4.54:1，默认输入框细线为 3.04:1；标题和正文具有更高对比度。

## 修改文件

| 文件 | 修改 |
| --- | --- |
| `frontend/local-auth.js` | 仅改登录渲染模板：页首品牌、左右布局、字段分组、占位文字、页脚和按钮可访问性 |
| `frontend/local-auth.css` | 登录页独立样式、暖白／深色适配、手机与首次设置布局；账户设备和重连提示样式保持原内容 |
| `test/local-auth-layout.browser.mjs` | 新增无服务器、无数据库的登录布局与交互回归 |
| 本目录 `IMPLEMENTATION.md`、`implemented-*.png` | 记录方案选择和实际截图 |
| `docs/design/ai-subscription-brand-20261113/README.md` | 同步登录页 Logo 尺寸与方案引用 |

逐字比较确认：`local-auth.js` 渲染模板之外的代码保持原内容，包括请求、会话、初始化管理员、登录失败处理、密码清空及重载逻辑；账户设备与断线重连样式保持原内容。

## 实际检查

- `node test/check-ui-contract.mjs`：unit、browser、spacing、mailbox、tabs、feedback 六组通过。
- `node --test test/local-auth-layout.browser.mjs test/auth-remember-device.browser.mjs`：两项浏览器回归通过。新专项覆盖 34 个场景：1440/1024/901/900/768/390/320px、深浅主题、普通登录和首次设置，以及过期、失败和在途重复提交。
- 检查标题说明默认收起、点击和 Escape、浮层不移动表单、输入框与文字对比度、Logo 解码、表单尺寸、页首与页脚遮挡、密码显隐的键盘访问。
- 原有保持登录、设备控件、失联重试及恢复测试通过。
- JavaScript 语法检查、`git diff --check` 通过。

首次本地验证的日志、逐场景几何数据及额外截图在项目 `.runtime/paper-login-20261113/`，统一门禁结果为 `ui-contract/result.json`，登录回归日志为 `login-final.log`。本机使用拦截请求的浏览器验证页面。
