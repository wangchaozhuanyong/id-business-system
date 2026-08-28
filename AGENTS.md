# AGENTS.md

## 项目边界

项目名称：ID 业务管理系统。

本仓库只有一套当前系统。功能范围以 `docs/V2_PRODUCT_SCOPE.md` 为准，业务代码只能进入：

- 前端：`apps/admin/src/v2`
- 后端：`apps/api/src/id-business-v2`
- 认证与审计：`apps/admin/src/auth`、`apps/api/src/auth`、`apps/api/src/v2-auth`、
  `apps/api/src/audit-logs`

禁止恢复已删除的旧页面、旧 API、Telegram/外部消息推送、旧通知中心、兑换码业务、平台接口中心或
Apple 官网执行器。Prisma 主 schema 只允许定义当前系统实际使用的模型；migration 目录只允许保留
当前系统纯净基线和此后新增的当前系统迁移，不得导入其他仓库的历史迁移。

## 生产基础设施边界

- 生产环境只允许部署在 AWS：EC2 运行前端、API 和 MySQL，S3 保存备份。
- 禁止重新引入、配置或部署 Supabase 和 Cloudflare 运行时，包括 Supabase Auth、
  Supabase Database/Realtime/Edge Functions、Cloudflare Worker/Pages 及其密钥、环境变量和发布脚本。
- 认证固定使用本地 JWT 会话，业务数据库固定使用 AWS EC2 内的 MySQL。
- 部署前必须运行 `npm run check:cloud-independence`；检查失败时禁止发布。
- 历史 PostgreSQL 基线中已存在的文字仅作为不可修改的迁移记录，不得恢复为运行时配置。
- 本机生产连接信息固定保存在被 Git 忽略的 `.deploy/aws-production.local.env`；执行生产检查或部署时必须先读取并复用，
  仅当文件缺失或连接已失效时再向用户确认。
- `.deploy/aws-production.local.env` 和其中引用的私钥必须保持仅本机可读，禁止在日志、回复、提交或部署包中输出、复制或上传。

## Git 与生产发布强制流程

- `origin/main` 是唯一生产代码来源，不设“线上最新分支”，不得从本地未提交文件、功能分支或服务器临时补丁发布。
- 每次发布先同步 `origin/main`，再从其创建 `codex/<scope>-release-<date>` 发布分支；禁止直接向 `main` 推送和强制推送。
- 提交前必须运行相关专项检查、`npm run check`、`npm run acceptance:v2-financial-integrity` 和
  `npm run git:readiness`。任何失败都必须阻断提交或发布。
- 发布分支推送后必须创建 PR；只有 GitHub CI 全部通过并完成审查，才允许合并到 `main`。
- 生产部署必须使用合并后的 `origin/main` 精确 commit SHA。部署前工作区必须干净，且本地 `HEAD`、
  `origin/main` 和待部署 SHA 必须一致；禁止在服务器发布目录直接修改代码。
- 每次部署创建 `/opt/id-business-v2/releases/<UTC>-<short-sha>` 不可变目录，保留上一版；禁止覆盖旧发布目录。
- 发布期间必须持有生产部署锁，并确认没有其他 Compose、迁移、同步或部署进程并发执行。
- 数据库变更只允许向前 migration。更新应用容器前必须完成 S3 备份及校验、镜像构建、migration 和 38 项只读财务完整性门禁；
  任一失败都不得更新应用容器。
- 应用容器更新后必须通过健康检查和整站冒烟，才允许原子切换 `current`；切换后必须再次执行整站冒烟、
  38 项财务完整性门禁，并核验备份与恢复验证定时器。
- 应用异常优先将 `current` 回切上一已验证版本；数据库 migration 不自动回滚，数据恢复必须先在隔离实例验证。
- 紧急修复也必须走“发布分支 → PR/CI → `main` → 精确 SHA 部署”流程，不得绕过门禁。

## 开发规则

- 默认使用简体中文。
- 修改前确认项目路径、技术栈、包管理器、当前分支和工作区状态。
- 先阅读相关入口、路由、模块、测试和本文档，再修改代码。
- 只完成 `docs/V2_TASKS.md` 中一个明确任务，优先最小改动。
- 遵守现有 Vue 3、NestJS、Prisma、Pinia 和 Element Plus 写法，不随意新增依赖。
- 金额统一使用 Decimal，禁止用 float/double 做业务金额计算。
- ID 密码、密保和手机号等敏感字段必须加密保存、默认脱敏；查看和修改必须做权限校验并写审计。
- 礼品卡号继续加密保存，但加卡记录和余额变动页面允许直接显示完整值。
- 创建、修改、删除操作必须写审计；日志禁止输出密码、密保、完整卡号或 token。
- 状态使用枚举或受控联合类型，不允许任意字符串。
- 列表必须考虑分页、搜索、排序、空状态、错误状态和移动端。
- 数据库结构修改必须使用 Prisma migration。不得删除生产数据或已有迁移。
- 当前纯净基线不得被修改；后续数据库变更必须新增 migration。
- 新环境变量同步写入 `.env.example`，只允许占位值。

## UI 强制规则

- 中文界面的用户可见文案默认使用简体中文；中文界面不得直接展示内部字段 key、枚举值或数据库字段名，
  必须先映射为中文标签。新增或修改界面后必须运行 `npm run check:v2-ui-language`。
- 表单标签必须在控件左侧；禁止顶部标签布局。
- 必填星号紧跟字段标题右侧；统一使用 `require-asterisk-position="right"`。
- 窄屏可缩窄或换行标签，也可变为单列，但不得把标签移到控件上方。
- 关联资料快捷新增使用右侧抽屉并停留当前页；保存成功后自动回填并选中新资料。
- 抽屉、弹窗和表单必须处理校验、提交中、失败重试和关闭保护。
- 桌面表格操作列必须使用 `V2TableActionColumn` 和统一宽度档位，禁止手写固定列宽。
- 操作按钮不得被裁切、遮挡或静默隐藏；操作过多时使用有明确文字标签的“更多操作”菜单。
- 同一视觉行的标题和值必须使用一致的语义结构、字号、行高和垂直对齐模型；禁止混用
  `flex + center` 与 `grid + baseline` 后仅凭父容器同高判定对齐。
- 整页设计验收必须测量并排模块外框和实际文字节点，并覆盖分页第一页、最后一页、空状态与窄屏；
  切换状态时框架不得自动缩小、跳动、重叠或产生横向溢出。
- UI 规则详见 `docs/UI_DESIGN.md`。

## 加载规则

- 所有业务页面遵守 `docs/V2_LOADING_STANDARD.md`。
- 应用壳先挂载，再完成会话和首路由确认。
- Element Plus 使用 resolver 按需引入，禁止全量 CSS。
- 远程数据使用 `V2AsyncRegion` 和 `useV2ModuleQuery`。
- 已有内容刷新时保留最后成功内容，只显示区域进度线。
- 同一读取请求只允许一个主加载反馈。
- 禁止业务页直接使用 `v-loading`、`el-skeleton`、`ElLoading` 或全页遮罩。
- KeepAlive 只允许订单录入草稿页。

## 检查与交付

修改后至少运行最相关的 typecheck、test、lint、build 和架构检查。完成时说明：

1. 改了什么
2. 修改了哪些文件
3. 新增了哪些接口、表或字段
4. 如何迁移和测试
5. 未完成事项与风险

未经用户明确要求，不得 commit、push、创建 PR、部署或修改生产环境。
