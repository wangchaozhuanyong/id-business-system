# 2026-09-13 安全审查整改记录

状态：3 项代码整改和本地验证完成；管理员 MFA 配置、发布及生产验收尚未完成。

基线为 main `7026df6628565a55ed785e3f4f76c5c3ba9ca1fb`。
修改位于项目内部独立工作树 `.codex-worktrees/id-business-security-remediation-20260913`，
分支 `codex/security-remediation-20260913`。本轮未 commit、push、创建 PR 或部署；
未修改生产数据、管理员 MFA、SSH 规则或用户其他工作树中的改动。

## 已完成的代码整改

### SEC-01：充值窗口登录态同步

- 新窗口显式关闭 Cookie、Local Storage、IndexedDB、密码和标签页同步。
- 打开窗口前使用比特浏览器的 `/browser/detail` 回读配置。窗口 ID 不符、字段缺失、
  字段不是布尔 false 或读取失败时停止，不能继续打开窗口并写入登录态。
- 管理端显示中文错误说明。
- 本地连接器依赖清单或 setuptools 版本变化时，重启会更新虚拟环境并检查依赖；
  安装失败不写成功标记，第二次启动无需重复安装。

边界：新逻辑已通过模拟 API 的分支测试，未连接真实比特浏览器账号。
部署 API/Admin 不能替换已运行的本机连接器，发布后需重启连接器。
已有窗口及第三方同步存储未盘点或清除，不能将此次代码修复写成“历史会话已清理”。
比特浏览器实际版本若不返回完整同步字段，会安全停止，需要核实版本和窗口设置。

### SEC-04：密码保护参数

- 新密码使用 PBKDF2-HMAC-SHA256、600,000 次迭代；保留旧 PBKDF2 和原有 scrypt 格式验证。
- 旧密码仅在账号密码和必要 MFA 验证成功后重哈希，随后才签发会话。
- 更新使用原哈希、用户状态和删除标记作为条件；并发修改密码时不覆盖新密码、不签发旧会话。
- 哈希升级与审计处于同一数据库事务。审计不含密码、盐或哈希，前端显示中文标签。
- 不需要数据库迁移、批量密码重置或撤销所有现有会话。旧账号会在下一次成功登录时逐步升级。

本地 Node 基准：8 次新哈希，中位数 99 ms、最大 101 ms；不是生产服务器延迟测量。

### SEC-03：Python 依赖和持续扫描

- Worker 与本机连接器使用 pip 26.2.1；媒体服务三个 Python 环境和本机连接器使用
  setuptools 84.0.0。
- F2 保留原提交的业务源码。构建前核验源码归档和原始 pyproject 的 SHA-256，
  仅修正依赖声明：click 8.3.3、protobuf 5.29.6、cryptography 50.0.1；
  移除开发测试依赖 black、pytest、pytest-asyncio。修改来源记录在 THIRD_PARTY_NOTICES。
- 安装使用正常依赖解析并执行 pip check，没有使用忽略依赖或跳过漏洞的安装方式。
- 新增无额外库依赖的 OSV 检查脚本，读取实际已安装包，覆盖媒体系统 Python、
  两个虚拟环境及 Worker。漏洞命中、空清单、接口故障或不完整响应均不能通过构建。
- 新增 Python Dependency Security 工作流，相关 PR、每天定时和手动运行都会构建复扫；
  PR 镜像保留为不可变发布产物，合入 main 后核对相同源码树并直接提升，避免重复构建；
  每个镜像内保留 `/opt/security/python-dependencies.json` 依赖及扫描记录。
- F2 兼容测试仅替换导入时访问平台的 token 请求；真实执行入口导入、模型构造、
  AES/RSA 往返和 protobuf JSON 往返。测试进程退出后不会改变生产运行行为。

两个本地 Linux arm64 镜像合计 58 个去重包名/版本组合：OSV 0 命中。
本机连接器虚拟环境 6 个包名/版本组合：OSV 0 命中。
这是实际 Python 包检查，不等于完整 OS/系统库镜像漏洞扫描。

## SEC-02：管理员 MFA 仍待本人完成

审查时 3 个启用管理员中 2 个未绑定 MFA。现有防锁死逻辑正确，本次保留。

1. 这 2 位管理员分别在“我的账户”完成 MFA 绑定并验证动态码，恢复码由本人安全保管。
   不要把密码、MFA 密钥或恢复码发给自动化工具。
2. 确认三位管理员均能使用 MFA 登录，并至少保留一个可用管理员会话。
3. 由有权限的管理员在安全中心启用 MFA、开启管理员强制 MFA。
   现有接口会在仍有未绑定管理员时拒绝开启，不能绕过。
4. 回读策略和绑定统计，验证无 MFA 登录被拒绝、有效 MFA 登录成功，再记录生产关闭该发现。

本轮已提出绑定请求，尚未取得完成确认；未代管 MFA 或强行开启策略。

## 实际验证

本地依赖通过 npm ci 从锁文件安装，Vitest 4.1.11。

| 检查                                                    | 结果                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------- |
| API 认证、权限、MFA、充值相关测试                       | 165 通过，1 个既有充值 MySQL 集成测试因未配置专用测试库而跳过 |
| 充值和审计日志前端测试                                  | 30 通过                                                       |
| Python Worker 全部 unittest                             | 152 通过；无外网、非 root、只读文件系统、临时目录写入         |
| 容器约束测试                                            | 6 通过                                                        |
| OSV 检查器失败处理测试                                  | 4 通过                                                        |
| F2 运行依赖兼容测试                                     | 4 通过；另以无外网、非 root、只读文件系统复核                 |
| 合计                                                    | 361 通过、1 跳过                                              |
| API 类型检查与构建、Admin 类型检查与构建                | 通过                                                          |
| lint、修改文件格式、git diff --check、连接器 shell 语法 | 通过                                                          |
| 中文界面、模块架构、系统隔离、Prisma 边界、并发规范     | 通过                                                          |
| Worker 与媒体镜像构建、pip check、OSV 复扫              | 通过                                                          |
| 媒体服务 --self-test                                    | 通过                                                          |
| 本机连接器首次安装、依赖升级、第二次 --help 启动        | 通过；未启动监听服务、创建真实窗口或执行支付                  |
| npm 高危依赖审计                                        | 0 漏洞                                                        |

没有执行真实扣款、真实跨账号写入、生产删除恢复或生产密码升级。
没有运行远端 CI；本地镜像结果不代表部署成功。MySQL 集成测试的跳过不能记为通过。

## 变更文件

- 认证：`apps/api/src/auth/password-hasher.ts`、`auth.service.ts` 及对应测试。
- 充值连接器：worker 目录下的 `bitbrowser_connector.py`、`test_bitbrowser_connector.py`、
  `requirements.lock.txt`、`Dockerfile`；`scripts/start-auto-recharge-connector.sh`。
- 媒体依赖：media-resolver 目录下的 `Dockerfile`、`prepare_f2.py`、
  `test_runtime.py`、`THIRD_PARTY_NOTICES.md`。
- 扫描：`scripts/audit-python-dependencies.py`、对应 `.test.py`、
  `scripts/container-hardening.test.mjs`、`.github/workflows/python-dependency-audit.yml`。
- 中文说明：`recharge-presentation.ts`、`audit-log-presentation.ts` 及审计文案测试。
- 记录：本文、`docs/V2_TASKS.md`。

无新增业务接口、数据库表、字段、migration 或环境变量。

## 统一发布集成调整

- 与慢代理重试一起集成，已有同步开关统一转换为关闭，并在设置清单中显示固定关闭说明。
- 后端及连接器均兼容旧 JSON；创建窗口时额外关闭 IndexedDB 和授权同步，打开前仍回读验证。
- 本次无数据库变更；生产发布及验收结果另记统一发布报告。

## 发布后必须补齐的验证

- 按项目发布流程构建并发布 API、Admin、Worker、媒体服务，核对运行版本与镜像扫描记录。
- 重启本机连接器；用实际比特浏览器版本核对新窗口同步全部关闭，异常时不能注入会话。
- 对已有相关窗口单独盘点同步状态；历史服务端数据清理需明确范围，不能批量删窗口。
- 核验 MFA 绑定和强制策略；使用授权账号验证登录后密码参数升级及审计记录，不输出哈希。
- 验证实际媒体解析请求；本轮离线兼容测试没有证明第三方平台当前可用。

本地取证目录：工作树内 `.codex-audit/security-remediation-20260913/`。
