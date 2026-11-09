# 全站工具栏间距与邮箱单页验收（2026-11-09）

状态：代码完成，离线本地验证完成。未 commit、push、创建 PR 或部署；线上页面尚未应用本次改动。

## 源码与范围

- 截图对应当前独立新版的 `#/plugins/mailboxes`，实际入口为 `frontend/operations-prototype.js` 和 `frontend/prototype.css`。原主目录的旧 Vue 版本不承载该页面，本次未修改。
- 隔离工作区：`/Users/wangchao/Desktop/源码文件夹/ID业务管理系统/.codex-worktrees/ui-mailbox-spacing-20261109`。
- 分支：`codex/ui-mailbox-spacing-20261109`；基线：`bbea9dea9625ebb4c71bd3ad7ca8791d82a7ffb9`。用户原工作区与其他候选的未提交内容保留。
- 修改共享工具栏间距、搜索区换行，以及邮箱页面入口和手机布局。未新增接口、数据库表或字段、环境变量、依赖；无迁移操作。

## 原因与修复

1. 紧凑工具栏 `.list-controls--filters` 的 `padding: 0` 清除了控件与分页分隔线之间的留白。修改前在桌面与手机、深浅主题四组基线中测得 20 项贴线，其中按钮和输入框到分隔线距离为 0px。现在统一复用 `--toolbar-padding-block: 12px`，并要求实际距离不少于 8px。
2. 搜索区在 901px 临界宽度被压缩到小于搜索框最小宽度，右对齐使其侵入卡片留白。共享搜索容器现在保留实际最小宽度，空间不足时自然换行。
3. 邮箱池成为唯一主页面；取消原整页查询／管理页签。“邮箱查询”按钮打开共享右侧抽屉，行内查询复用同一个表单。关闭后保持列表搜索、筛选与分页；保留普通查询选项，清理查询码、邮件正文和自动刷新状态。现有员工查询权限边界保持原状。
4. 隐藏查询宿主不再留下空分隔行。手机端筛选和按钮使用整齐的双列布局，分页控件同宽对齐，消除重复横向内距。买家查询页保留在“相关入口”。
5. 全站离线布局检查加入控件与分隔线真实坐标测量，另增加邮箱单页与抽屉专项回归，并将要求写入 `AGENTS.md`、设计规范。检查覆盖全部当前导航路由；新增路由会由导航清单进入全站检查。

## 修改文件

| 文件 | 用途 |
| --- | --- |
| `frontend/prototype.css` | 共享间距、搜索容器最小宽度、手机邮箱筛选与分页 |
| `frontend/operations-prototype.js` | 单页邮箱池、查询右抽屉、买家页菜单入口 |
| `test/helpers/offline-design.mjs` | 分隔线距离测量并接入现有全站布局测量 |
| `test/mailbox-query-layout.browser.mjs` | 新增单页与查询抽屉布局、失败重试、关闭清理和员工边界验收 |
| `test/site-spacing.browser.mjs` | 适配共享离线拦截器返回值，继续严格检查外部请求及缺失接口 |
| `test/mailbox-pool-layout.browser.mjs` | 邮箱池直接可见后的分页／长列表验收 |
| `test/mailbox-operation-drawers.browser.mjs` | 单页入口与原有操作抽屉兼容验收 |
| `test/plugin-management.browser.mjs` | 插件页面直接展示邮箱池的断言 |
| `test/online-tools-layout.browser.mjs` | 修正已有动态口令验收中失效的旧卡片定位器，继续检验原工具兼容 |
| `AGENTS.md`、`docs/DESIGN_SPEC.md` | 强制共享规则与后续页面验收要求 |
| `docs/ONLINE_TOOLS_LAYOUT.md` | 当前邮箱单页交互说明 |
| `docs/UI_MAILBOX_SPACING_20261109.md` | 本次交付与证据记录 |

## 实际验证

所有浏览器验证使用真实前端源码、合成业务资料和完整网络拦截；未启动本机网站、API、Docker 或数据库，未发送真实业务写入、邮件查询或外部通知。

| 检查 | 结果 |
| --- | --- |
| `node --test frontend/*.spec.mjs` | 173 / 173 通过 |
| `node test/site-spacing.browser.mjs` | 47 个导航页面、7 档宽度、深浅主题，共 1,202 个状态场景通过；3,456 次分隔线距离测量，0 项异常 |
| `node test/mailbox-query-layout.browser.mjs` | 8 档宽度、深浅主题、64 个场景通过；单页、右侧抽屉、成功／失败／重试、查询码与正文清理、员工边界通过 |
| `node test/mailbox-pool-layout.browser.mjs` | 2,003 条合成数据，7 档宽度、深浅主题、84 个分页／长列表／空状态场景通过 |
| 六个相关浏览器回归文件（下列命令） | 首次 30 项中 29 项通过；原在线工具用例的动态口令旧卡片定位器超时。改为当前已存在的表格行定位器后，仅重跑该文件，1 / 1 通过；其余 29 项输入未变，复用通过结果 |
| `node --check`（8 个改动 JS/MJS 文件） | 通过 |
| PostCSS 解析 `frontend/prototype.css` | 通过 |
| `git diff --check` | 通过 |

最后一次调整仅提高邮箱分页选择器优先级，防止手机通用分页规则重复添加内距；已补跑邮箱 64 + 84 场景并通过。全站共享规则和其他页面输入未变，复用此前通过记录。

浏览器环境与组合回归命令：

```sh
export ID_LAYOUT_QA_OFFLINE=1
export ID_RECHARGE_QA_PLAYWRIGHT='/Users/wangchao/Desktop/源码文件夹/ID业务管理系统/node_modules/playwright/index.mjs'
node --test test/shared-layout.browser.mjs test/design-list-boundaries.browser.mjs test/mobile-navigation-layout.browser.mjs test/mailbox-operation-drawers.browser.mjs test/plugin-management.browser.mjs test/online-tools-layout.browser.mjs
node --test test/online-tools-layout.browser.mjs
```

当前独立项目未定义 typecheck、lint、build 或旧 Vue 的 `check:v2-*` 命令，本次执行上列源码、CSS 与实际浏览器检查。未运行涉及后台／数据库的完整 `npm test`，未执行远端 CI。

## 证据与页面效果

- 本次日志、基线测量、邮箱场景结果和截图：`../.runtime/ui-mailbox-spacing-20261109/`。
- 全站明细：`../.runtime/site-spacing-20261107/spacing-results.json`（沿用现有脚本输出目录名，内容为本次执行结果）。
- [桌面邮箱池（合成资料）](../.runtime/ui-mailbox-spacing-20261109/mailbox-panel-1440-light.png)
- [手机整页（合成资料）](../.runtime/ui-mailbox-spacing-20261109/after-390-light.png)
- [桌面查询抽屉](../.runtime/ui-mailbox-spacing-20261109/query-1440-light.png)
- [手机深色查询抽屉](../.runtime/ui-mailbox-spacing-20261109/query-390-dark.png)

## 未验范围

尚未提交或发布，因此不能把离线验收当作线上效果。真实邮件读取、第三方授权与生产业务流程没有在本次任务中执行；这次改动没有新增或替换这些接口。表格继续使用既有横向滚动以保留全部列，窄屏不隐藏操作。
