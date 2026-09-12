# 自动充值代理与窗口设置清单

当前状态：账单邮箱自动读取、代理与窗口参数编辑保存、真实分组／标签下拉及建窗传参已完成本地代码。
29 项前端、34 项 API、17 项 Python 相关测试通过；1440／768／390px 模拟流程覆盖列表失败、空列表、
刷新重试、切换分组／标签、参数修改与回显、保存失败重试、固定代理凭据校验与清除，以及新任务使用保存配置。
新增两个可空字段的迁移已在独立临时 MySQL 8 验证：旧记录保留，新字段可读写；未连接生产数据库。
未连接真实代理、创建真实比特窗口、发起真实付款、提交、推送或部署。上线时需要按现有发布流程应用迁移并更新管理端/API；此电脑的本机连接器已在后续连接修复中更新。

## 页面和保存行为

- 自动充值资料区显示当前代理模式、代理来源脱敏摘要、窗口分组和语言；提供“修改代理 IP 与窗口设置”。
- 设置在右侧抽屉内分组，所有可修改项回显当前默认值；每次新建窗口使用最后成功保存的配置。
- 已运行任务继续使用启动时的配置；保存设置不替换运行中的 IP、不操作现有窗口。
- 密钥、代理密码及动态提取链接仅显示已保存状态；填写新值代表替换，留空保留原值。
- 保存失败保留输入并在抽屉显示错误；刷新不覆盖未保存输入；关闭前检查未保存修改。

## 设置清单

| 分组       | 设置项                          | 当前代码默认值                 | 本次可修改范围                       |
| ---------- | ------------------------------- | ------------------------------ | ------------------------------------ |
| 本机连接   | 连接器地址                      | `http://127.0.0.1:55321`       | 本机地址与端口                       |
| 本机连接   | 比特 Local API 地址             | `http://127.0.0.1:54345`       | 本机地址与端口                       |
| 本机连接   | 比特接口密钥、连接密钥          | 用户已保存值                   | 替换，继续加密保存                   |
| 代理连接   | 代理模式                        | 动态 IP 提取                   | 动态提取／固定代理                   |
| 代理连接   | 代理协议                        | HTTP                           | HTTP／HTTPS／SOCKS5                  |
| 代理连接   | 动态 IP 提取链接                | 用户已保存链接，页面不显示秘密 | 替换链接                             |
| 代理连接   | 动态代理服务商                  | 通用                           | 通用／Rola／DoveIP／Cloudam          |
| 代理连接   | 打开窗口重新提取 IP             | 开启                           | 开启／关闭                           |
| 代理连接   | 固定代理主机与端口              | 未配置                         | IP 或主机名、1–65535 端口            |
| 代理连接   | 固定代理账号与密码              | 未配置                         | 可选，成对填写，加密保存；可显式清除 |
| 代理连接   | IP 查询服务                     | ip-api                         | ip-api／ip123in／Luminati            |
| 窗口资料   | 窗口名称                        | 每笔任务填写                   | 主页面填写本次名称                   |
| 窗口资料   | 窗口分组                        | gpt账号注册                    | 下拉选择现有唯一分组，建窗前重新核对 |
| 窗口资料   | 窗口标签／备注                  | 申请gpt                        | 下拉选择真实标签，备注同步标签名称   |
| 窗口资料   | 设备类型                        | 电脑                           | 当前执行器支持电脑，显示为固定项     |
| 窗口资料   | 操作系统                        | macOS（MacIntel）              | macOS／Windows／Linux                |
| 语言与地区 | 浏览器语言                      | 简体中文，不跟随 IP            | 跟随 IP／指定语言                    |
| 语言与地区 | 浏览器界面语言                  | 简体中文，不跟随 IP            | 跟随 IP／指定语言                    |
| 语言与地区 | 时区                            | 跟随 IP                        | 跟随 IP／指定 IANA 时区              |
| 语言与地区 | 定位来源                        | 跟随 IP                        | 跟随 IP／指定经纬度与精度            |
| 同步选项   | 标签页、Cookie、本地存储同步    | 均开启                         | 分别开启／关闭                       |
| 系统固定   | 登录网址                        | ChatGPT 官网                   | 展示，固定官方入口                   |
| 系统固定   | 保存密码弹窗                    | 关闭                           | 展示，保持凭据保护                   |
| 系统固定   | 平台用户名、密码、Cookie 初始值 | 不预填                         | 由本次授权 JSON 恢复登录             |
| 系统固定   | 创建时按平台账号去重            | 关闭                           | 每笔任务创建独立窗口                 |
| 系统固定   | 打开窗口排队                    | 开启                           | 保持单任务连接流程                   |

其他未显式传入的浏览器指纹参数仍由比特浏览器生成；页面不冒充已读取真实生成值。

## 存储变更

在已有 `IdBusinessV2RechargeBrowserSetting` 表增加两个可空字段，对应迁移 `20260913100000_auto_recharge_browser_options`：

1. `browserOptions`（JSON）：代理模式、固定代理主机和端口、服务商、提取行为、操作系统、语言、时区、定位和同步选项。服务端只允许清单内字段，严格验证枚举和范围。
2. `staticProxyCredentialsEncrypted`（TEXT）：固定代理账号和密码的加密对象，不出现在查询接口、日志或审计明文中。

只新增向前 migration，不修改原基线，不删除、重写已有设置。旧记录的空配置回退到当前默认值。
复用原 GET／PUT 设置接口和任务启动接口；启动时使用已保存的配置快照，保留原权限、加密和审计。
本次仅本地修改及验证，不提交、推送、部署，不连接真实代理或创建真实比特窗口。

## 验证范围

- 前端：设置回显、修改、保存失败重试、秘密留空保留、关闭保护、桌面与窄屏。
- API：参数白名单、非法枚举与范围、旧记录默认、固定与动态模式要求、加密和审计脱敏。
- 本机连接器：动态／固定代理和每个窗口配置都映射到实际建窗请求；旧请求继续沿用现有默认值。
- 运行受影响模块测试、类型、lint、构建和项目必需架构检查；浏览器验收全部使用模拟接口。

参数依据：[比特浏览器公开 API 文档](https://doc.bitbrowser.cn/api-jie-kou-wen-dang/liu-lan-qi-jie-kou)。

## 本次已修改文件

- `apps/admin/src/v2/features/auto-recharge/V2AutoRechargeView.vue`、`auto-recharge.css`：主页面代理摘要和编辑入口；保留上一轮账单邮箱修复。
- `apps/admin/src/v2/features/auto-recharge/RechargeBrowserSettings.vue`、`recharge-browser-settings.css`：分组设置抽屉、校验、参数清单和关闭保护。
- `apps/admin/src/v2/features/auto-recharge/useRechargeBrowserSettings.ts`：设置读取、保存、错误、秘密输入清除和草稿保护。
- `apps/admin/src/v2/features/auto-recharge/useAutoRecharge.ts`：接入独立设置状态，保留原充值执行流程。
- `apps/admin/src/v2/features/auto-recharge/useAutoRecharge.spec.ts`、`scripts/acceptance-v2-auto-recharge.mjs`：设置回归与模拟流程。
- `docs/AUTO_RECHARGE.md`、`docs/V2_TASKS.md`、本文档：当前操作方式、验证与实施范围。

### 分组和标签下拉相关文件

- `packages/shared/src/v2/auto-recharge.ts`、管理端 `contracts.ts / api.ts`：列表与临时连接凭据契约。
- 管理端 `useRechargeBrowserCatalog.ts / useRechargeBrowserCatalog.spec.ts`：读取、刷新、连接变更失效与唯一选项校验。
- API 模块 `recharge.controller.ts / recharge-settings.service.ts / recharge-settings.spec.ts`：管理员连接凭据读取与审计。
- 连接器 `worker/bitbrowser_catalog.py / bitbrowser_connector.py` 及对应测试：只读列表、分页、唯一匹配、真正绑定标签。
- 上述模块目录分别为 `apps/admin/src/v2/features/auto-recharge` 与 `apps/api/src/id-business-v2/auto-recharge`。
- 标签路由及参数已通过本机安装的比特浏览器客户端 Local API 实现核对；真实列表读取需要已配置的接口密钥，当前未做真实账号验收。

### 参数编辑与持久化相关文件

- 共享契约 `packages/shared/src/v2/auto-recharge.ts`：可选参数对象、默认值和静态代理凭据契约，兼容旧客户端。
- 管理端 `RechargeProxyOptions.vue / RechargeWindowOptions.vue / recharge-browser-rules.ts / recharge-browser-presentation.ts`：代理、系统、地区和同步编辑，字段校验与当前配置摘要。
- API `recharge-browser-options.ts / recharge-settings-validation.ts / recharge-settings.service.ts / recharge-local.service.ts`：白名单校验、保存、脱敏回显、加密及新任务配置。
- `apps/api/prisma-mysql/schema.prisma` 与 `migrations/20260913100000_auto_recharge_browser_options/migration.sql`：新增 JSON 配置与加密凭据列。
- 连接器 `worker/bitbrowser_options.py / bitbrowser_connector.py`：动态／固定代理、系统语言地区同步参数映射，手动时区偏移按建窗时刻计算。
- 对应前端、API、Python 测试及 `scripts/acceptance-v2-auto-recharge.mjs`：兼容默认值、参数边界、保存回显、加密脱敏、实际建窗请求映射和三种屏宽模拟验收。

## 后续连接修复

2026-09-13 已增加建任务前只读连接预检和分层错误提示，并更新本机已安装连接器。
原线上页面实测显示“本机连接器已就绪”；前端 42 项、Python 20 项相关测试及三种屏宽模拟流程通过。
完整连接修复范围、文件和生效边界见 `docs/AUTO_RECHARGE.md` 的连接故障修复记录。

## 本次发布的增量检查

- 充值修改只运行相关前端、API、连接器、迁移和静态检查，不运行其他业务的全量测试。Prisma schema 只有充值设置模型发生变化时才能走该范围。
- 每个检查独立报告；失败后只重跑失败项和修复影响的部分。复用之前通过项时比较其实际测试源码树和本次相关输入，检查脚本、工作流或共同依赖变化会使对应证据失效。
- main 合并后只复核成功 PR 的编号、源码提交、实际测试树和 required quality 结果；源码树一致时复用，不再执行第二轮检查。无法证明一致时不能冒充通过。
- 此次失败是经纬度 6 位精度被金额规则误判；只为本组件的经度、纬度输入增加 6 位精度识别，金额输入和邻接控件继续受原规则限制。
