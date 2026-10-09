# 开源自动注册本地接入记录

2026-10-09：代码完成、本地验证完成。未提交、推送、创建 PR 或部署。

## 来源与保留范围

- 上游：[cf-jx/codex-register](https://github.com/cf-jx/codex-register)。
- 固定提交：`93ab9842004adc263f2089a07f281ec34a7560d7`，发布版本 `1.0.4`，MIT 许可；上游内部另显示 `2.0.0`，保留这一原有差异。
- 原运行源码及资源完整放入 `apps/api/src/id-business-v2/auto-registration/upstream/`，保留 LICENSE 和 README。
- 72 个上游文件与下载源逐字节一致。接入改动放在独立适配层，不直接修改上游注册、邮箱、并发、账号和任务算法。
- 保留原注册控制台、账号管理、邮箱服务、订阅管理、系统设置，以及原导入、导出、代理、令牌处理和外部上传入口。
- 原自研注册页面、Worker 和名字数据表继续退役；本次没有恢复它们。

## 系统接入

左侧新增一级“自动注册”，路由 `/v2/auto-registration`，内部五个页签对应上游五个页面。
界面使用本系统名称、简体中文、共享主题和控件样式；取消上游重复导航及独立密码登录。
原页面通过同源工作区运行，原业务请求和实时任务消息由适配层转发。

必要适配包括：

- 复用系统管理员身份、有效登录令牌、MFA、密码重置限制和权限检查。
- 浏览器工作区使用短时、同源、HttpOnly 的随机会话标识；原访问令牌只留在 API 内存。
- 每次访问校验身份和权限；实时连接每 15 秒复核权限，保持原上游连接以避免日志丢失。
- 工作区会话固定有效期 30 分钟，页面会续期；旧实时连接到期后按原界面机制降级轮询，新读写使用续期会话。
- 敏感查看、导出和修改走系统审计，审计不写密码、令牌或请求正文。
- SQLite 中的密码、令牌、Cookie、邮箱配置、代理认证和服务密钥等敏感列加密保存；列表默认脱敏，密码查看和复制走审计入口。
- 日志、任务错误及外发状态屏蔽秘密；普通草稿接入系统会话草稿，不保留密码、密钥、验证码或付款授权。
- 父子页面同步主题、页签和普通输入；原任务取消命令继续送到原 WebSocket 任务通道。
- 私有服务仅监听本机回环地址，并需要内部认证；API 关闭时停止子进程。

## 数据与运行

当前本地入口：<http://localhost:5374/v2/auto-registration>，沿用项目本地配置的管理员登录。

| 项目              | 本地位置或端口                                       |
| ----------------- | ---------------------------------------------------- |
| 管理端            | `127.0.0.1:5374`                                     |
| 系统 API          | `127.0.0.1:3000`                                     |
| 私有注册服务      | `127.0.0.1:55323`                                    |
| 原开源模块数据库  | `.runtime/auto-registration/database.db`             |
| Python 环境及日志 | `.runtime/auto-registration/`                        |
| 系统隔离开发库    | 本项目本地 MySQL 的 `id_business_registration_local` |

新增系统接口：

- `GET /api/id-business-v2/auto-registration/status`：本地服务状态和来源版本。
- `POST /api/id-business-v2/auto-registration/workspace-session`：建立工作区会话。
- `/api/id-business-v2/auto-registration/workspace/*`：管理员专用页面、资源和原业务接口网关，含实时任务桥接。
- 工作区内的账号密码读取适配接口：`GET /api/accounts/:id/credentials`，只返回已审计的密码读取结果。

没有新增主系统 Prisma 表、字段或 migration，没有修改现有迁移和根 `.env`。
本机原有数据库连接不能使用，因此新建上述独立开发库，应用项目已有的 46 个迁移，并按本地配置初始化管理员。
开源模块仍使用自己的 SQLite 数据，不自动合并到当前系统账号库。
现有业务数据、自动充值未提交改动和本机其他 Python 服务保留。

复用运行方式：

```bash
npm run auto-registration:setup
npm run build --workspace @apple-business/api
npm run auto-registration:local
```

首次环境配置需要 Python 3.10 或以上；可传入 `-- --python=/绝对路径`。
依赖已锁定在 `worker/requirements.lock.txt`，安装目录属于本项目。
`auto-registration:local` 要求本项目本地 MySQL 已运行；它只初始化指定的隔离开发库。
如使用原有可用的本地数据库配置，可继续分别启动系统 API 和管理端；API 自动启动私有注册服务。

## 修改文件

| 范围                   | 文件                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 新前端功能             | `apps/admin/src/v2/features/auto-registration/` 内页面、接口、主题与草稿桥接及测试                                                             |
| 导航、路由及数据范围   | 前端 `feature.ts`、`registry.ts`、`registry.spec.ts`、`tableSchemas.ts`、`router/routes.spec.ts`；共享 `packages/shared/src/v2/data-scopes.ts` |
| 共享界面皮肤与同源嵌入 | `apps/admin/src/v2/styles/base.css`、`apps/admin/vite.config.ts`、`apps/admin/public/_headers`                                                 |
| 新后端功能             | `apps/api/src/id-business-v2/auto-registration/` 内控制器、服务、模块、路径边界、测试、上游及 Python 适配层                                    |
| 登录与退出生命周期     | `apps/api/src/auth/registration-workspace-session.ts` 及测试、`jwt-auth.guard.ts` 及测试、`apps/api/src/main.ts`                               |
| 模块注册               | `apps/api/src/id-business-v2/id-business-v2.module.ts`                                                                                         |
| 本地运行及检查         | `scripts/setup-auto-registration.mjs`、`scripts/start-auto-registration-local.mjs`、`package.json`、`scripts/check-v2-module-architecture.mjs` |
| 上游格式保留           | `.prettierignore`、`eslint.config.js` 排除未经修改的上游资源                                                                                   |
| 项目文档               | `README.md`、`docs/V2_PRODUCT_SCOPE.md`、`docs/V2_TASKS.md`、本文                                                                              |

没有新增 npm 包，没有升级原框架。

## 实际验证

| 检查                                | 结果                            |
| ----------------------------------- | ------------------------------- |
| API 类型检查及构建                  | 通过                            |
| 管理端类型检查及构建                | 通过                            |
| 定向 ESLint、Prettier、桥接脚本语法 | 通过                            |
| 登录会话、登录守卫和网关路径测试    | 64 项通过                       |
| 前端桥接、功能注册和路由测试        | 31 项通过                       |
| Python 适配层离线测试               | 13 项通过                       |
| Python 锁定依赖一致性               | 通过                            |
| `check:admin-ui`                    | 通过                            |
| `check:v2-ui-language`              | 通过                            |
| `check:v2-color-contrast`           | 通过                            |
| `check:v2-table-standard`           | 通过                            |
| `check:v2-loading-standard`         | 通过                            |
| `check:v2-module-architecture`      | 通过                            |
| `check:v2-isolation`                | 通过                            |
| 上游源码完整性                      | 72 个文件逐字节一致             |
| 真实本地登录及浏览器验收            | 69 个场景通过，页面脚本错误为 0 |

浏览器使用真实本地 API、系统登录和私有 Python 服务；外部网络请求被阻止。
覆盖五个页面 × 深浅主题 × 1440、1024、901、900、768、390px 六种宽度，未发现页面横向溢出。
另外验证普通页签输入恢复、内部“查看全部”链接与父页签同步、36px 桌面控件和左侧标签、复选框不重叠、日志主题颜色。
实时通道在跨越一次权限复核后仍能收发，原取消命令可回传状态；使用不存在的合成任务标识，没有创建真实注册任务。
匿名访问网关及直连私有服务返回 401；退出登录后工作区移除，网关访问返回 401。

证据位于 `.runtime/auto-registration/acceptance/results.json`，同目录保存桌面／手机的深浅主题截图。
Python 测试日志为 `.runtime/auto-registration/worker-tests.log`；源码核对记录为 `.runtime/auto-registration/source-integrity.json`。

## 未测事项

本地接入不等于真实平台注册成功。
本轮没有执行真实账号注册、外部邮箱收码、令牌刷新、支付／订阅开通或上传到外部服务。
原业务能力的真实运行仍取决于实际邮箱、代理和外部服务配置；真实业务结果为 `NOT_MEASURED`。
当前数据库为空，没有用真实账号数据验收分页首末页和外部业务结果。
生产发布、线上配置、数据合并与主系统账号库导入均未执行。
