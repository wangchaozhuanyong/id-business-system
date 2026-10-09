# 苹果隐藏邮箱注册本地改造

用户已确认使用系统现有苹果隐藏邮箱注册 ChatGPT／Codex。
本地改造基线为 `0a03fa28e6b844a18833d5c63f1de700f091fc64`。
发布候选已接入线上代充恢复后的主线 `296c096af7c4c79a8ffc2f57d9a15ea75684f431`，
保留其代码、配置及迁移；本功能不代为执行该模块的迁移或真实业务。
本文记录已完成的代码和本地验收；用户于 2026-10-09 随后明确授权发布本次新增功能。
正式发布结果以独立运行回执为准，不以本地测试代替线上证明。
所有改动位于项目内 `.codex-worktrees/open-source-registration-release-20261009/`，
主目录已有充值、依赖和数据库 WIP 保持原状。

## 功能与数据

- 自动注册新增原生“苹果隐藏邮箱”页签，复用邮件验证码查询中的 Vendure iCloud 隐藏邮箱。
- 搜索、状态筛选、排序、分页、移动卡片、单个／批量标记与草稿恢复。
- 历史邮箱初始为待确认；明确标记未注册后，邮箱启用、主邮箱可用且授权有效时才可启动。
- 已注册邮箱可人工补录 IPv4／IPv6；不清楚时留空。来源区分人工填写和任务检测出口。
- 原流程发现已有账号会登记已注册；本次登录的 IP 不被写成该账号的历史注册 IP。
- 新账号创建的注册事实在后续 OAuth 失败时保留，不因普通失败或取消被降级。
- 加密登记按标准化邮箱保存，revision 防止覆盖新标记；同邮箱原子排他占用。
- 取消保留占用直到原线程实际返回；崩溃后的占用标为中断，管理员核对后可解除。
- 原注册引擎、代理选择和账号结果保持上游逻辑。72 个上游源码文件未改，MIT 版权保留。

注册状态、IP、来源、备注、版本、占用和任务事实写入既有 SQLite `settings` 的加密值，
没有新增主系统表、Prisma 字段或 migration。无需执行主数据库迁移。
不从邮件查询 IP、账号导入标志或后续登录 IP 推断历史注册。
查询码及取码授权不返回浏览器，验证码仅通过私有桥传递。
系统 JWT 按既有登录机制由浏览器提交、Node 校验，不转发给 worker 或上游。
读取 IP 与写操作沿用管理员限制和审计，日志不写邮箱凭据、验证码或完整代理链接。

## 修改文件

前端位于 `apps/admin/src/v2/features/auto-registration/`：
`V2AutoRegistrationView.vue`、`V2AppleMailboxes.vue`、`api.ts`、`contracts.ts`、
`useAppleMailboxes.ts`、`apple-mailbox-presentation.ts` 与相关测试；
`apps/admin/src/v2/features/tableSchemas.ts` 仅追加新表登记，`registry.spec.ts` 验证该表唯一登记并保留管理员主导航约束。

后端位于 `apps/api/src/id-business-v2/auto-registration/`：
`apple-mailboxes.controller.ts`、`apple-mailboxes.service.ts`、`apple-mailboxes.types.ts`、
相关测试及既有 `auto-registration.module.ts`、`auto-registration.service.ts`；
Python 功能改动仅涉及自有 `worker/apple_mailboxes.py`、`worker/workspace.py` 及测试；
续发保护另增加 `worker/release_safety.py` 及其测试，用于离线备份和恢复验证。
既有邮箱服务的公开边界已可供模块调用，无需新增环境变量、依赖或改认证/schema。
本地启动脚本在内存中加入 5378 的可信来源，未修改 `.env`。

## 接口

现有管理员认证下新增 `/api/id-business-v2/auto-registration/apple-mailboxes`：
GET 列表；POST `mark`、`start`、`recover`；GET `tasks/:id`；POST `tasks/:id/cancel`。
批量标记最多 100 个地址，输入不能指定权威邮箱、操作者或查询授权。

worker 的 `/internal/apple-mailboxes` 仅内部令牌可访问，支持登记、取码请求桥及任务操作；
不进入浏览器工作区的转发白名单，不增加公开可执行接口。

## 本地运行与验收

真实新入口：`http://localhost:5378/v2/auto-registration`，指向真实本地 API。
原 5374 管理端和现有 MySQL 保留；新 SQLite 与原目录数据独立，业务记录为零。
5378 同源登录与可信来源配置已核验，未使用真实凭据登录。
浏览器功能验收另用 5376／3032 的 loopback 合成数据服务；该证据不代表真实邮件或注册成功。

测试和运行证据位于 `.runtime/apple-hidden-mailbox-20261009/` 及同目录前端冻结记录。
功能开发阶段通过 Python 51 项、API 39 项、前端 53 项定向测试及类型、lint、build；
界面统一七项规则检查通过，共 143 项定向测试。发布准备新增 24 项工作区维护与恢复保护测试，
Python 合计 75 项通过，功能与适配定向测试合计 167 项；发布控制测试另行登记。
另通过注册表 23 项定向测试，精确核验隐藏邮箱表格、管理员角色与主导航登记；该文件 lint、格式检查通过。
浏览器实际验收通过单个／批量标记、IP 校验与错误聚焦、失败重试、草稿及搜索恢复、
任务进度／取消、刷新失败保留内容和空状态恢复后翻页。最终冻结源码下，第一页、最后一页
与空状态的列表外框同为 1149px；实际文字节点与控件对齐已测量。
1440、1024、901、900、768、390px 六种宽度均无整页横向溢出，已核验深浅主题及移动卡片。
详细结果为 `browser-acceptance.json`，截图为 `desktop-light-fixture.jpg` 与
`mobile-dark-fixture.jpg`，均为本地合成数据，不含真实邮箱或注册结果。

接入新主线后重新通过前端 53 项、API 39 项、前后端 typecheck/build、定向 lint/format
及全部七项界面规则。共享表格变化后的第一页、最后一页、空状态外框同为 1187×1089px；
六宽度无整页溢出，移动端 20 张卡片与深色主题复验通过。
补充证据为 `rebased-local-evidence.json`、`rebased-browser-geometry.json` 和
`rebased-mobile-dark-fixture.png`；这些仍为合成数据验收。

## 边界与后续

真实注册、真实收码未执行，业务结果为 `NOT_MEASURED`。
用户追加的发布授权仅覆盖本功能与必要工作区续发保护，不覆盖其他并行候选或真实业务执行。
正式发布继续使用 `API_ADMIN_WORKSPACE` 的来源、任务、49 项零违规财务检查和备份门禁。
非空注册 SQLite 卷必须完成一致性备份、独立恢复证明和切换期间的注册写入保护；
不得用本地空卷验收绕过，不能删除或覆盖线上已有记录。具体控制见
`AUTO_REGISTRATION_OPEN_SOURCE_RELEASE_CONTROL_20261009.md`；主数据库无迁移需求。
