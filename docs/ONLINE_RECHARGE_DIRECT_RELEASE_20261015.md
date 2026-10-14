# 线上代充标准部署候选

2026-10-15 用户授权按最新发布方案执行。本次以实际已上线 `3e152c09` 的 API/Admin 角色源码为基础，精确接回冻结的 ONLINE 模块及必要入口，保留首次充值和 Pro 结果核验补丁。原主目录 WIP 不纳入、不覆盖。

本轮只替换 API、管理端并增加 ONLINE 执行器，既有其他五项服务保留。采用服务器标准 Docker Compose；不使用旧发布器、旧来源认证或旧恢复调用链。原九表迁移已经完成，实际结构和表级授权已只读核验，本次不迁移、不清空资源池。

执行器复用实际固定镜像 `sha256:39e07d0691948cd63f6fe7e953cb92c799c4be3a8cf1180f1be302114f5f8f1c`，其镜像 ID 为 `sha256:477bd66944dd6368b0a6a73de6c2fde9e528931acd73dd5e1c5cf97985e299ea`，62 个源码文件与实际原构建逐字节一致。源码与镜像复用不代表新的上线已经成功。

## 本轮实际运行修复

只读根目录下的 Chromium 因 node 用户目录不可写而启动崩溃，报 `chrome_crashpad_handler: --database is required`。切换前的隔离验收已复现，回执 `a0826d46-e231-48c6-a742-e2a283a55d4f` Failed/1。增加 `/home/node` 的私有易失 tmpfs 后，只补验受影响的浏览器运行：回执 `9883cf7c-1a89-4ad1-aa20-d1640c81803a` Success/0，Chromium 147、Node Playwright 1.59.1 与 Python CDP 附着通过，根目录仍只读、profile 位于私有 `/tmp`，正常退出无 OOM。没有外网、生产卷或真实业务。

运行配置增加 `/home/node:rw,noexec,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0700`，不改变 HOME 环境值，不改冻结上游、付款逻辑或执行器镜像。该目录在容器退出后销毁；原任务 Cookie/Session/profile 仍由已有私有临时目录实现管理。

Compose 的 `ONLINE_RECHARGE_ENGINE_ENABLED` 缺省从 1 改为 0，部署同时显式设置 0。首次上线只运行现有 credentials-only 模式，独立验证内部认证和只读 RPC，不领取任务，不执行真实充值、订阅变更、供应商建单或通知。

## 候选检查与交付

管理端完成七项规则、类型/构建/lint、138 项针对性测试；API 完成 Prisma 校验及隔离 Linux 客户端生成、类型/构建/lint、37 项针对性测试。新增客户端匹配 ONLINE 九模型，不复用 CORE 客户端或重放迁移。只在真实输入变化时补受影响验证。

最终源码、依赖、编译产物、备份、切换与用户指定 Chrome 页面验收回执统一保存于本工作树 `.runtime/online-direct-release-20261015/`。最终发布结论以实际切换和线上验收记录为准；本文件初版记录的是候选准备。

## 并发发布后的基线刷新

准备期间另一项已获用户独立授权的 Admin 发布 `f91e7d85c83c` 完成，实际运行镜像为 `sha256:4698b702fefdbcdc5cae9fcff95760f91c6589bb4dcf2b6f15c0e3430e9579ab`。本轮在切换前检测到变更并停止，没有覆盖该版本。随后从其实际 published-admin-context 精确保留已发布的 12 个表单文件，包括保持 Pro 修复的两份三方合并文件；不能用 Git 原树替代实际发布来源。

新线上基线为 `/opt/id-business-v2/releases/20261014T181446Z-f91e7d85c83c-recharge-ui`。API 及执行器输入未变，复用已经通过的 API、Linux client、生产依赖和离线浏览器结果，只补受影响的 Admin 组合检查。运行挂载按同一内容排序后计算摘要，避免 Docker 检查返回顺序变化被误判为配置改变；全部挂载字段仍完整核对。
