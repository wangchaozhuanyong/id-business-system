# 三个直接入口与在线工具布局整理

范围：截图对应的独立新版。保留原有混合工作区修改；不改旧后台、生产或数据库。

## 最终行为

1. 顶栏提供“个人工具”“在线工具”“话术文案”三个直接按钮；各自打开右侧内容，不再经过“工具箱”或重复分类页签。关闭后焦点返回入口。手机三个入口在标题下方同一行，均保留完整文字和 44px 触控高度。
2. 网站监控通过固定页签切换访问统计、访问记录与 IP、网站检测。滚动报表时仍可切页，保留筛选和结果；报表按钮距分隔线 13px（含边框）。
3. 邮箱查询与管理使用同一上限 860px 的右侧抽屉，手机全屏，页签固定，正文独立滚动。登记、导入、设置和刷新合并在邮箱池标题区。
4. 邮箱池已按用户后续纠正改为一个邮箱一行，保留完整查询码与复制、备注、状态、到期和最近查询。每页 20／50／100 条并支持页码跳转，手机列表内横向滑动。后续结果见 [逐行列表验收](MAILBOX_ROWS_20261107.md)；以下卡片专项数据是当时方案的历史验证。
5. 之前完成的 2FA 右侧抽屉、大号验证码和临期颜色继续保留。

## 修改文件

- `frontend/index.html`：顶栏三个直接入口。
- `frontend/prototype.js`：直接打开分类、抽屉标题、关闭后的焦点；移除原分类页签事件。
- `frontend/operations-prototype.js`：网站监控页签、固定导航、邮箱卡片及复制控件定位、合并管理区和相关文案。
- `frontend/prototype.css`：抽屉、顶栏、导航、邮箱卡片和窄屏布局，复用既有主题令牌。
- `frontend/overview-prototype.js`：旧“工具箱”入口说明改为“在线工具”。
- `docs/DESIGN_SPEC.md`、`docs/ONLINE_TOOLS_LAYOUT.md`：同步当前入口与工具布局。
- `test/website-tools-refresh.browser.mjs`、`test/helpers/offline-design.mjs`：现有刷新竞态测试支持离线拦截模式，按新页签操作。
- `test/online-tools-parity.browser.mjs`：直接入口、右侧整高抽屉和新标题结构；允许指定项目内证据目录。
- `test/online-tools-layout.browser.mjs`、`test/operations-draft-lifecycle.browser.mjs`：旧入口选择器与卡片结构更新。

无新增接口、表、字段、迁移、依赖或环境变量；不改变登录、权限、真实取信、查询码生成与有效期规则。

## 实际验证

全部浏览器检查通过 Playwright 请求拦截加载真实静态文件和合成资料，没有启动本机网站、Docker 或数据库，没有连接业务接口或实际外部邮箱。

- `node --test frontend/*.spec.mjs test/website-tools-refresh.browser.mjs`（刷新测试使用离线模式）：163 项通过。覆盖刷新保留结果、失败提示、过时响应、关闭重开后的旧响应隔离。
- `test/shared-layout.browser.mjs`：7 项通过；`test/design-list-boundaries.browser.mjs`：9 项通过。
- 手机长页导航最终诊断执行：8 个断点／主题子项及总项共 9 项通过。早期并行回归出现 900px 深色阅读位置超时；随后收齐手机顶栏网格间距，在最终源码上保留诊断信息逐项验证通过。未据此扩大修改业务导航状态机。
- `test/online-tools-parity.browser.mjs`：24 组工具布局和原有交互通过，包括 2FA、邮件查询、授权失败保留、邮件内容安全处理与分页。
- 网站监控专项：7 个宽度 × 2 个主题 × 5 个状态，共 70 组通过，另检查员工无管理报表入口与请求；覆盖固定导航、查询／表单保留、30 天报表滚动、分页末页、键盘页签和空结果。
- 三个入口与邮箱专项：84 组通过，覆盖 1440／1024／901／900／768／390／320px 与深浅主题、复制回读、分页首末页、长内容、空列表、无匹配、草稿恢复和固定导航。窄屏按钮／筛选整列调整后，768／390／320px 深浅主题共 36 组补验通过，结果另存 `mobile-controls-final.log` 与 `geometry-mobile-final.json`。
- 相关 JavaScript 语法和 `git diff --check` 通过。独立项目没有单独 typecheck、lint 或 build 脚本，不使用旧后台检查冒充。

证据：`.runtime/website-monitor-design-20261107/`、`.runtime/tools-entry-mailbox-20261107/`，均属于当前独立项目。

`test/online-tools-layout.browser.mjs` 和 `test/operations-draft-lifecycle.browser.mjs` 的原联网／数据库模式未运行，只更新入口并做语法检查；本轮交互由上述离线测试验证。真实管理员、邮箱授权、生产取信和线上视觉效果未验证。

状态：代码完成，离线浏览器验证完成；未 commit、push、创建 PR 或部署。
