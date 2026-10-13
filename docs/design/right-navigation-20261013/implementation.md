# 全局右侧工作区实施记录

项目：ID 业务管理系统。实施日期：2026-10-13。

当前状态：代码及本地验证完成，未提交、推送或部署。

## 已完成的界面

- 在全局应用布局中挂载独立右栏，所有业务路由共用；取消左下个人工作区及右下便捷操作入口。
- 顶部一行切换“个人工具／在线工具／话术文案”，不再额外占用一行标题。
- 个人工具、在线工具只保留单行标题与图标；原管理入口和工具抽屉继续使用。
- 话术列表每行只有标题、“复制文案”和“更多”；全文、编辑、删除收进更多菜单，保留搜索、添加和排序。
- 桌面展开宽度 368px、收起宽度 60px；小于 1440px 默认收起，900px 及以下从右侧抽屉展开。内容独立滚动，顶部导航固定。
- 当前页签、收起状态、搜索和编辑草稿沿用系统会话草稿；保留失败重试、迟到保存保护与现有权限。

## 修改范围

| 文件                                                                                    | 用途                                                   |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `apps/admin/src/v2/components/workspace/V2WorkspaceDock.vue`                            | 新增统一右栏、顶部页签、收起轨道和移动抽屉             |
| `apps/admin/src/v2/layouts/V2AdminLayout.vue`                                           | 全局接入右栏，移除旧浮动入口                           |
| `apps/admin/src/v2/components/workspace/V2WorkspaceLauncher.vue`                        | 个人与在线工具改为紧凑内容区                           |
| `apps/admin/src/v2/components/workspace/V2WorkspaceShortcutDrawer.vue`                  | 更新入口位置说明                                       |
| `apps/admin/src/v2/components/workspace/V2QuickActions.vue`                             | 单行话术列表及工具栏                                   |
| `apps/admin/src/v2/components/workspace/V2QuickActionsDrawer.vue`                       | 保留全文和编辑抽屉，移出原列表界面                     |
| `apps/admin/src/v2/styles/base.css`、`layout.css`、`v2.css`、`records.css`              | 共享皮肤、三栏布局、响应式及按业务区实际宽度换行的分页 |
| `apps/admin/src/v2/features/tableSchemas.ts`                                            | 移除已不使用的旧话术表格登记；不是数据库变更           |
| `apps/admin/src/v2/components/workspace/workspace-ui.contract.spec.ts`                  | 更新全局挂载、紧凑布局及会话契约断言                   |
| `apps/admin/src/v2/testing/V2WorkspaceDesignFixture.vue`、`workspace-design-fixture.ts` | 本地合成数据与失败、迟到响应验收场景                   |
| `scripts/acceptance-v2-workspace-dock.mjs`                                              | 新右栏浏览器验收                                       |
| `scripts/acceptance-v2-filter-layout.mjs`、`acceptance-v2-refresh-interaction.mjs`      | 原分页及排序迁移验收适配新入口                         |
| `docs/V2_TASKS.md`                                                                      | 登记任务与本地交付状态                                 |

未新增 API、数据库表或字段、迁移、依赖和环境变量，无需数据迁移。

## 本地检查

| 检查                             | 结果                                                                                                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin typecheck、生产构建        | 通过；构建含 `vue-tsc -b`                                                                                                                                                              |
| 修改范围 ESLint、Prettier        | 通过                                                                                                                                                                                   |
| 七项界面规则                     | `check:admin-ui`、`check:v2-ui-language`、`check:v2-color-contrast`、`check:v2-table-standard`、`check:v2-loading-standard`、`check:v2-module-architecture`、`check:v2-isolation` 通过 |
| 工作区契约测试                   | 18 项通过                                                                                                                                                                              |
| 话术查询、排序、历史顺序迁移测试 | 27 项通过                                                                                                                                                                              |
| 右栏浏览器验收                   | 52 项通过，覆盖深浅主题、6 个宽度和 3 个页签                                                                                                                                           |
| 100 条话术分页补验               | 24 项通过；深浅主题 × 1440／390px，首／中／末页及实际前后翻页；手机目标至少 44×44px                                                                                                    |
| 旧顺序迁移浏览器验收             | 20 项通过；深浅主题 × 1440／390px，12 次模拟写入、零真实业务写入                                                                                                                       |
| 共享皮肤浏览器回归               | 168 个场景通过                                                                                                                                                                         |
| 共享页面布局浏览器回归           | 176 项通过                                                                                                                                                                             |
| 真实页面路由筛选及分页回归       | 分阶段 234 项通过：124 项实际宽度筛选检查、98 项页面布局及 21／501 条分页、12 项深浅主题加载与草稿生命周期                                                                             |

右栏验收包括复制正文、更多菜单、键盘排序、分页首末页、空状态、读取失败重试、编辑失败后恢复、跨路由保留以及迟到响应。测量了实际文字位置、控件外框、独立滚动和窄屏溢出，并检查了生成截图。

测试采用本地合成数据和模拟 API；浏览器通过不代表生产环境验收。首次类型检查遇到本机旧共享类型产物，重新构建现有 shared 包后通过，没有为此改动无关业务源码。验收中修复了 900px 收起右栏时桌面三列规则优先级过高，以及 390px 时业务分页被右侧轨道遮挡的问题；分页保留完整操作和手机 44px 触控尺寸。

## 证据与边界

证据目录：项目内 `.runtime/workspace-dock-20261013/`。

- `checks.json`：右栏 52 项验收结果及几何信息。
- `pagination-checks.json`：100 条话术、13 页数据的 24 项分页验收。
- `light-1440-1.png`、`light-1440-2.png`、`light-1440-3.png`：桌面三页签实际截图。
- `light-390-1.png`、`light-390-2.png`、`light-390-3.png`：手机三页签实际截图。
- `dark-long-copy-drawer.png`、`dark-mobile-copy-editor.png`：深色长文及手机编辑抽屉。
- `quick-action-migration/checks.json`、`skin-consistency/checks.json`、`page-layout/geometry.json`：关联回归证据。
- `filter-layout/checks-summary.json`：234 项筛选、页面布局和生命周期检查总览；旧失败回执作为修复前历史证据保留。
- `final-admin-build.log`：最终源码的类型检查和构建回执。

未执行 commit、push、PR 或部署；线上界面仍以已部署版本为准。
