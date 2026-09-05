# 装修网站访问统计

## 本次修复范围

ID 系统的个人工作区网站监控新增访问统计区；原有健康检测独立保留。
统计固定属于 `https://flashcast.com.my`，不随健康检测输入网址变化。
只使用当前 AWS API 的出站 HTTPS 请求，不引入其他云运行时、数据库或依赖。

2026-09-05 现场确认的装修网站资源：GA4 媒体资源 `540413787`、数据流 `15010607367`、
衡量 ID `G-LLJGRG2YNP`。原来线上使用的 `G-K71PQ0MSV2` 属于大马通，不能复用。
装修网站单独在其仓库修正埋点默认值和报表入口，两个项目不直接依赖对方代码或数据库。

## 接口与指标

- `GET /api/id-business-v2/workspace-website-monitor/analytics?days=7`，日期范围仅支持 7 或 30。
- 登录且具有 admin 角色才可读取；接口使用现有错误响应格式和 `private, no-store`。
- 服务端固定查询上述媒体资源、数据流和 `flashcast.com.my` / `www.flashcast.com.my` 域名。
- summary 的 pageViews、visitors、sessions 分别来自 screenPageViews、totalUsers、sessions。
  区间访客数单独向 GA4 查询，不能对每天去重访客数求和。
- daily 返回按统计媒体资源时区排列的日期。页面标明该时区，更新时间仍按系统北京时间展示。
- `not_configured` 表示无专用凭据；`empty` 表示 GA4 在所选范围没有返回记录；
  `ready` 表示已收到有效报表。未返回某天记录使用 null，并展示“—”。
- GA4 的阈值限制在界面提示；截断、错误指标或无效日期直接报错，不输出虚假的正常统计。
- 同日期范围的请求合并；服务端成功结果缓存 60 秒，令牌仅存 API 进程内存。
- 不新增数据库表、字段或 migration，不保存访问历史副本。

## 只读连接与发布条件

2026-09-05，网站所有者已明确授权并由本任务完成专用服务账号连接。
账号 `flashcast-website-reports@flash-cast-managed-growth.iam.gserviceaccount.com` 位于现有
`flash-cast-managed-growth` 项目，未授予 Cloud IAM 角色或其他主体访问权；
仅在装修网站媒体资源 `540413787` 授予 Viewer 权限，同时限制费用和收入指标。
Google Analytics Data API 现场已启用，未复用其他业务账号或表格同步的 token。

服务器环境变量 `WEBSITE_ANALYTICS_SERVICE_ACCOUNT_JSON` 保存专用账号 JSON；示例文件为空。
仅在受控服务端配置中设置，权限限定为本机可读；不要在聊天、日志、构建产物或 Git 中粘贴私钥。
生产 Compose 已提供可选变量透传，未配置时不会阻止原有系统启动。
凭据的 token_uri 不作为请求目标，令牌和报表请求仅发往固定 Google 官方接口；OAuth scope
固定为 `https://www.googleapis.com/auth/analytics.readonly`。

专用凭据已在持有生产部署锁时写入 AWS 当前发布目录的 `.env.aws.production`，权限为 `0600`，
写入前保留同目录的私有回滚副本。未重启运行容器或发布代码，当前运行版本尚未包含统计服务和
环境变量透传；正式发布本次改动后才会由 API 进程使用这项配置。
仅完成授权不代表网站开始采集；发布装修站后还须在其 GA4 实时报表看到正确域名的访问事件，
再核对 ID 系统的同日期范围数据。该媒体资源缺少的历史数据无法凭空补回。

凭据使用本机生成的 RSA 公钥证书上传方式，私钥只保存在 Git 忽略的本机受控目录与 AWS 私有配置，
不写入文档、日志或发布制品。证书于 2027-09-05 到期，需在到期前轮换。
首次由 Google 生成但下载失败的未使用密钥已删除；Google 公共证书接口确认旧密钥不再发布、
当前使用的上传公钥仍已注册。其他既有服务账号及其凭据保持不变。

### 真实连接验证

- 本地通过本次编译后的 Google 客户端和统计服务读取 7／30 天真实报表成功，状态均为 `empty`，
  时区 `Asia/Kuala_Lumpur`。GA4 当前未返回该域名和数据流的采集记录，不能解释为网站无人访问。
- AWS 当前 API 容器内进行只读验证，OAuth 令牌换取及两次 GA4 报表请求成功，HTTP 均为 200，
  两个范围均未返回每日记录。验证脚本从服务器私有配置通过标准输入传递凭据，不记录凭据值。
- 验证后 API readiness 返回 200；确认运行容器尚无统计服务代码、尚未接收统计环境变量。
  验证只证明网络、专用凭据和资源权限可用，不代表 ID 系统报表界面已经上线。
- 真实空报表会省略无维度汇总的指标表头，已据此补充兼容和回归测试；有数据却缺少表头仍拒绝。

## 原始 IP 的剩余工作

GA4 不提供原始访客 IP，也不能用 totalUsers 冒充独立 IP。
当前装修站代码只有表单防刷 IP 哈希，不是全站访客日志。若要在这里展示原始 IP，必须另行确认
网站侧的可信访问日志来源、保留期限、管理员访问控制及是否需要新增数据表。
新增采集或数据库迁移前，先提交准确的数据结构与保留方案取得批准；本次没有实施该部分。

## 验证与回滚

本地测试覆盖专用只读令牌、固定域名和数据流、管理员边界、参数校验、缓存和请求合并、
去重访客、时区日界、无数据与无效上游响应。界面验收用专门测试入口的模拟数据，不能替代线上报表验收。
回滚时撤回本次访问统计代码和可选环境变量即可，数据库无需回滚。

### 2026-09-05 本地检查结果

- 发布分支从最新 `origin/main` 单独建立，完整 `npm run check` 通过：发布脚本 68 项、
  shared 1 项、管理端 476 项、API 902 项测试通过；另有 5 项按条件跳过的集成测试。
  `npm run acceptance:v2-financial-integrity` 在一次性 MySQL 中通过真实集成测试及 38 项完整性检查，
  `npm run git:readiness` 通过。原始工作区的并行任务改动没有进入本发布分支。
- ID 系统：shared build、API typecheck/build、管理端 build（含 vue-tsc）通过。
  两个 analytics 测试文件及原网站健康检测测试共 15 项通过；工作区 UI 契约测试 18 项通过。
- ID 系统：本次源码文件 ESLint、`check:v2-ui-language`、`check:v2-loading-standard`、
  `check:v2-table-standard`、`check:v2-module-architecture`、`check:v2-isolation`、
  `check:v2-prisma-runtime-boundary`、`check:cloud-independence`、`check:v2-timezone-standard`
  和 `git diff --check` 通过。未运行全仓库发布门禁。
- 装修网站：在 Node 22 下执行 `npm test -- src/lib/analytics.test.ts`（13 项）、
  `npm run typecheck`、`npm run lint`、`npm run arch:check`，全部通过。
  Vite 生产编译通过，编译后的主 JS 包包含正确衡量 ID 和报表地址，不含原错误衡量 ID。
  此次直接编译 Vite，未执行会重新生成其他资源的完整 prebuild／发布流程。
- 真实浏览器本地验收：1440×1000 桌面、390×844 窄屏；7／30 天切换、第一页／最后一页、
  无数据、未配置和刷新失败状态。第一页、最后一页与空状态的统计区高度一致；
  窄屏无整页横向溢出；刷新失败保留上一份成功结果。
- 以上报表界面使用测试数据，不能作为已接通真实 GA4 数据的证据。未提交、创建 PR 或部署。

## 本次文件清单

ID 系统路径相对于 `/Users/wangchao/Desktop/源码文件夹/ID业务管理系统`：

- 共享契约：`packages/shared/src/v2/website-analytics.ts`、`packages/shared/src/index.ts`。
- 前端 API：`apps/admin/src/v2/api/workspace.ts`。
- 工作区组件（`apps/admin/src/v2/components/workspace/`）：`V2WebsiteAnalyticsPanel.vue`、
  `V2WebsiteMonitorDrawer.vue`、`V2WorkspaceLauncher.vue`、`workspace-ui.contract.spec.ts`。
- 表格与测试入口：`apps/admin/src/v2/features/tableSchemas.ts`、
  `apps/admin/src/v2/testing/workspace-design-fixture.ts`。
- 后端工作区（`apps/api/src/id-business-v2/workspace/`）：
  `id-business-v2-website-analytics-report.ts`、`id-business-v2-website-analytics.service.ts`、
  `id-business-v2-website-analytics.service.spec.ts`、`id-business-v2-website-monitor.controller.ts`、
  `id-business-v2-workspace.module.ts`。
- 后端 Google 客户端（上述工作区的 `providers/`）：
  `id-business-v2-website-analytics.client.ts`、`id-business-v2-website-analytics.client.spec.ts`。
- 可选配置：`.env.example`、`.env.aws.production.example`、`docker-compose.aws-mysql.yml`。
- 文档：`docs/V2_PRODUCT_SCOPE.md`、`docs/V2_TASKS.md`、本文档。

装修网站路径相对于 `/Users/wangchao/Desktop/装修网站/zhuangxiuwangzhan-main`：
`src/lib/analytics.ts`、`src/lib/analytics.test.ts`、`.env.example`。
本机被忽略的 `.env` 仅修正两个公开的 GA4 配置值，报表 URL 加引号避免 `#` 被当作注释；
未改动其他配置或凭据。两个仓库中的既有、并行任务改动不属于本次修复。

## 装修网站 Architecture Compliance Report

1. Target module: `system`。
2. Target layer: `src/lib` 前端统计工具。
3. Edited files: `src/lib/analytics.ts`、`src/lib/analytics.test.ts`、`.env.example`；
   本机忽略文件 `.env` 的两个公开统计配置。
4. Forbidden files touched: no。
5. API paths changed: no。
6. Database access changed: no。
7. Cross-module dependency introduced: no。
8. Business behavior changed: yes，默认埋点和报表入口改为装修网站自己的 GA4 资源，显式配置仍可覆盖。
9. arch:check result: pass，16 个模块。
10. Remaining architecture risk: 线上制品尚未更新，报表授权和 AWS 只读连接已验证，真实采集待验收；
    未增加服务器访问日志或原始 IP 采集。

官方接口：[GA4 报表](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport)、
[服务账号只读授权](https://developers.google.com/identity/protocols/oauth2/service-account)、
[服务账号公钥上传](https://docs.cloud.google.com/iam/docs/keys-upload)、
[GA4 不保存 IP 地址](https://support.google.com/analytics/answer/11598602?hl=en)。
