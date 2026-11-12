# 邮箱收信运行镜像

`server/tools/mailbox-pool.mjs` 通过 `python3 -B modules/tools/mailbox-imap.py` 收信。普通 Node slim 镜像没有 Python，会导致后台和商城的真实查询返回 503；健康检查及非法查询码检查不能发现这个缺项。

本镜像沿用当前部署的精确 Node 基础镜像，仅补齐 Python 3 标准库和 TLS 根证书。应用源码继续使用既有只读挂载，不放入镜像。构建仅在获准的远端执行，本机不启动 Docker 或整套服务。

部署要求：

1. 核对实际运行的源码版本、镜像、`operations/run-app`、邮箱公开地址及发布锁，保留当前 runner 和镜像标识作为回退基线。
2. 远端构建后记录镜像 ID、Dockerfile 摘要、Node/Python 版本、CA 证书检查结果。运行 `python3 -B modules/tools/test_mailbox_imap.py` 和现有应用隔离金丝雀。
3. 仅应用 runner 读取 `/opt/id-business-independent/formal/operations/mailbox-node-image-id`。该文件存放已经验证的镜像 ID；不改其他组件共用的 `formal/node-image-id`。
4. 沿用版本内标准 `operations/run-app` 路径，禁止另建名字不同的启动目录后只替换 ExecStart。后续发布必须保留独立应用镜像选择和 `mailboxPublicOrigin`，并确认 ExecStart 目标确实存在。
5. 在发布锁内切换并验证实际运行镜像、页面和健康检查、邮箱 GET 405、非法 POST 400。备份和表格同步为主应用的 PartOf 服务，其原有 runner 会采用当前 app 镜像，必须确认它们恢复；充值执行器、适配器和任务组件保持原容器。
6. 使用用户指定的现有邮箱通过后台、ID 公开接口和商城正常 GraphQL 查询做真实对照。只记录成功状态、封数及一致性统计；密码、查询码、验证码、邮件正文和邮件链接不得写入日志或报告。

运行环境调整不等于页面新版发布。失败时恢复切换前 runner 和镜像标识，按同一流程恢复应用及依赖服务。

本轮执行记录位于项目 `.runtime/mailbox-redesign-20261112/RESULT.md`。
