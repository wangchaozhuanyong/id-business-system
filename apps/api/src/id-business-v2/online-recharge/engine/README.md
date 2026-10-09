# 线上代充独立执行器

来源为 PAY-GPT-UPGRADE 的冻结提交 `ba6cf96312a6953e62edb9d74299d438d12549df`，保留原 CommonJS 和 Python 充值实现。`upstream/` 不包含原 Express 管理服务、MySQL 实现、认证、SQL 或部署脚本；`mysql-store.js` 是当前 ID 系统的受控 RPC 兼容层。逐文件来源、原版与适配 SHA256、改动理由见 `SOURCE_MANIFEST.json`，许可证保留在 `upstream/LICENSE`。

## 运行

需要 Node.js 22、冻结浏览器版本对应的 Chromium、ffmpeg，以及启用 hCaptcha 时 `requirements-hcaptcha.lock.txt` 中的独立 Python 环境。Node 包锁以原版为基础，只将 `ws 8.20.0` 定向修补并精确固定为 `8.21.0`；其余依赖版本、Playwright／Chromium 和上游 `requirements-hcaptcha.txt` 保持不变。安装命令只安装 Node 包，不执行安装脚本或下载浏览器：

```sh
npm ci --prefix upstream --ignore-scripts --no-audit --no-fund
npm test
npm run test:upstream
npm start -- --credentials-only
npm run health
```

从本目录执行上述命令。`--credentials-only` 仅启动本机临时安全码服务，既不领取任务，也不启动浏览器或调用外部服务。正常执行使用 `npm start`，必须显式设置 `ONLINE_RECHARGE_ENGINE_ENABLED=1`。只有完成单独的真实服务授权后才能开启执行；本次交付没有调用真实充值、订阅、代理检测、验证码平台或 Telegram。

执行器不自动读取 API 的 `.env`。由进程管理器注入环境，或使用 Node.js 的 `node --env-file=/项目绝对路径/.env /执行器绝对路径/worker.cjs --credentials-only` 显式载入所属 ID 项目环境；省略 `--credentials-only` 为正常执行。不要依赖启动目录推断环境文件。相对输出路径会被拒绝，运行目录和媒体目录必须属于 ID 项目。

环境项由项目根 `.env.example` 统一维护，本目录 `.env.example` 提供独立进程的占位说明：

| 环境项                               | 用途                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `ONLINE_RECHARGE_RPC_URL`            | ID API 的 `/api/id-business-v2/online-recharge/worker/rpc` 完整内部地址；HTTPS 或本机 HTTP |
| `ONLINE_RECHARGE_WORKER_KEY`         | API 与执行器共享的内部认证值，至少 32 字符，不写入文件                                     |
| `ONLINE_RECHARGE_WORKER_ID`          | 执行器实例编号                                                                             |
| `ONLINE_RECHARGE_CREDENTIALS_URL`    | 本机临时安全码监听地址，默认 `http://127.0.0.1:8053`                                       |
| `ONLINE_RECHARGE_ENGINE_ENABLED`     | 默认关闭，`1` 才领取任务                                                                   |
| `ONLINE_RECHARGE_WORKER_CONCURRENCY` | 可选硬上限；实际并发仍取管理配置 `maxConcurrent`，浏览器池槽位按原配置                     |
| `ONLINE_RECHARGE_RUNTIME_DIR`        | 项目内运行目录，默认本目录 `runtime/`                                                      |
| `ONLINE_RECHARGE_MEDIA_DIR`          | 项目内脱敏诊断目录，按任务建立子目录                                                       |
| `ONLINE_RECHARGE_FFMPEG_PATH`        | ffmpeg 可执行文件，默认从 PATH 查找                                                        |
| `PLAYWRIGHT_BROWSERS_PATH`           | 已安装的原 Playwright Chromium 所在目录                                                    |
| `PYTHON`                             | 可选 Python 可执行文件，原求解器运行时解析规则保持不变                                     |

API 不保存 CVC，导入或补充安全码只透传到执行器本机服务；需要该服务在线，否则前端显示不可用/等待。所有安全码仅在执行器内存中存在，最长 30 分钟；领取后绑定任务，完成、失去租约或退出时清除引用。重启后必须重新补充，原任务恢复执行，不能跳过缺安全码的卡另选下一卡。浏览器使用独立任务 context，任务结束或中断后清理，浏览器槽位仅复用空白持久 context；其磁盘 profile 与任务／solver 临时目录均置于进程专属、权限 0700 的系统临时目录，禁止进入持久卷。任务结束删除对应临时目录，退出删除本进程所有临时目录。

## 私网协议

RPC 请求为 `{method,args}`，带 `x-online-recharge-worker`；任务与资源操作包含 `taskId/workerId/leaseId/leaseVersion`，卡操作另含 `cardId/cardLeaseId/cardLeaseVersion`。执行器没有数据库连接参数、任意 SQL 方法或管理员认证逻辑。每 10 秒续租，外部提交前调用 `beforeExternalSubmit`，不能取得有效租约时停止。

临时安全码监听仅允许本机地址、相同认证头和以下 POST：

- `/credentials`：`{cards:[{id,cvc}]}`；不回显安全码。
- `/credentials/status`：`{ids}`，仅返回 `{availableIds}`。
- `/credentials/forget`：`{ids}`，清理对应临时凭据。
- `/health`：相同内部认证，只返回运行模式、就绪状态和任务数量。开启执行时，内部 RPC 最近 60 秒可达才就绪；停机后立即撤销就绪状态。没有任何卡号、安全码、会话或租约资料。

主执行器将选中卡的临时凭据通过 IPC 传给隔离子进程，不放进子进程环境、磁盘、日志、数据库或状态响应。内部认证值需要由运行环境提供，不能放入截图、通知或错误输出。

## 功能与结果边界

- 本地代充：原 Session 安装、API Checkout 优先和 UI 回退、地区/套餐、免税地址、原卡池排序、拒付计数、最多三张卡、hCaptcha/视觉与平台求解、成功后取消本地自动续费。
- 第三方代充：原客户端会话预检、原 `new_card` 提交和稳定幂等键、订单/任务轮询、套餐/余额和平台测试。不自动换卡新建单，不新增第三方取消续费或本地账单。
- 调试：到付款按钮前停止，实际页面脱敏截图/录像；调试结账链接只通过认证 IPC/RPC 交给 ID API 加密保存，经敏感权限及审计查看。
- 订阅查询和续费取消/恢复、代理检测、浏览器池统计/重载/模式切换、solver/VLM/平台/API/通知检测及受限通知。
- 原单核对：`subscription` 任务带 `recheckTaskId/originalProvider/providerOrderId/providerTaskId/targetPlan/sourceVersion`，只查询原单和原 Session 的订阅，绝不重新领取卡片或付款。原任务/CDK/资源锁的收敛由后端版本校验事务处理。

支付成功必须取得结构化证据：认证订阅接口返回实际账户编号与原 Session 的账户一致，且原始套餐字段精确匹配目标 Plus/Pro 5x/Pro 20x。普通 `pro`、`paid`、`active`、日志中的“支付成功”或跳转到登录页均不足以完成任务。未知结果保持 `awaiting_review`，保留 CDK 和卡片归属，禁止自动重试。已确认付款后绑定、计数或账单写入失败，也保留资产锁，交给完整 `finish(succeeded)` 事务释放。

账单金额仅使用实际结账页面读到的应付，交给 API 的 Decimal 字符串处理；没有读到就保存未知值 `null`，不能用免税估算补成事实。Python 的原始挑战、会话元数据、结果文件与原始 stdout 不落盘，只保留脱敏任务日志。

## 诊断媒体

只保存真实页面经过强制遮罩后的截图：所有输入框、文本区域、可编辑内容、iframe、代码/画布/视频/图像、敏感标记以及疑似账号/卡号/安全码/Token 文本均遮罩；遮罩准备失败就不截图。原页面 `recordVideo` 永久关闭。WebM 由同一批脱敏截图通过 ffmpeg 编码；文件仅通过有效任务租约上传 API，访问由 API 的敏感权限、现有会话校验与取密审计控制。没有 ffmpeg 时返回截图，不产生原始录像。

本地验证包含原 18 测试、付款误判/原子租约/临时安全码/未知结果/真实金额/原三卡重试回归，以及完全隔离的合成 Chromium 像素遮罩和 WebM 编码检查。合成页面没有外部路由，全部外网请求在 context 层拒绝。它验证媒体接口，不代表真实充值或反机器人求解验证。

`Dockerfile` 以官方 Node 22 的固定多架构 digest 构建；Node 包和 Chromium 使用仅包含上述 `ws` 安全补丁的 `upstream/package-lock.json`，调用已安装的 Playwright CLI，不临时下载另一份 CLI。独立 `requirements-hcaptcha.lock.txt` 固定 Linux amd64 实际解析且成功导入的 43 个 Python 包，Torch 为 CPU 版，不携带 NVIDIA 依赖；原 `upstream/requirements-hcaptcha.txt` 不改写。原 Node Playwright 为 1.59.1，而 PyPI 的对应 Python 驱动只有 1.59.0；实际无外网 CDP 附着检查验证两者兼容。镜像构建执行 `pip check` 和 CLIPModel／CLIPProcessor 等必需模块导入，在 `/opt/solver-venv/requirements.resolved.txt`、`node-version.txt`、`browser-versions.json` 保存实际清单。最终发布必须固定该镜像 digest。

API 与执行器需共享 API 的网络命名空间，RPC 和 CVC 都走 `127.0.0.1`，不要发布安全码端口或 CDP 端口。执行器不取得数据库凭据。镜像内 `tini` 转发进程组信号；`SIGTERM`／`SIGINT` 停止领取，清理临时凭据并等待完整任务收尾，最长 20 秒后退出，未确认付款交由后端租约恢复为待核对。已退出子进程仍等待记录事务，避免关停卡在迟到注册的 `exit` 事件上。容器 `stop_grace_period` 应至少 30 秒。

生产挂载只写运行卷 `/workspace/engine/runtime`，其中脱敏媒体使用 `media/`，CLIP 模型缓存使用 `cache/huggingface/`；浏览器 Cookie、Session、profile 和验证码临时文件走 `/tmp` 易失卷。运行镜像可设为只读，用户为 `node`，丢弃所有 Linux capabilities 并启用 `no-new-privileges`。建议以 2 GiB 内存、512 进程、512 MiB `/tmp` 与 512 MiB `/dev/shm` 起步，实际并发仍按后台原配置，后续依据测量调整资源上限；这些建议尚未做生产负载验证。

实际 Linux amd64 镜像已构建并以 `verify-image-runtime.cjs` 验收：无外网、非 root、只读镜像、易失 `/tmp` 下启动 headful Chromium，Python 驱动通过本机 CDP 读取合成文字，检查 CPU Torch／CLIP 导入、完整依赖与锁一致、私有健康和正常退出。验收脚本只使用合成数据，模型权重不下载；输出路径必须显式指定在所属项目 `.runtime/`。镜像验收不代表生产部署、真实充值、真实验证码求解或生产并发负载已通过。

## ws 安全补丁

原 `ws 8.20.0` 受到[小片段内存耗尽拒绝服务公告](https://github.com/websockets/ws/security/advisories/GHSA-96hv-2xvq-fx4p)和[关闭帧内存披露公告](https://github.com/websockets/ws/security/advisories/GHSA-58qx-3vcg-4xpx)影响。`8.21.0` 修复前者，并包含 `8.20.1` 对后者的修复。ID API 与本执行器均精确使用 `8.21.0`，Puppeteer 复用同一修补版本；没有升级上游提交、其他依赖、浏览器或付款逻辑。来源清单保留原锁摘要与修补后摘要，`dependencyLockPreserved=false` 表示锁文件确有必要安全变更。

关闭安装脚本的实际安装后，根 `npm run audit:high` 通过且报告 0 项；上游全量审计仍报告 24 个包条目（18 high、1 critical、5 moderate），只有 `ws` 条目消失，其余条目与修补前完全相同。API 授权等 19 项、真实 Nginx/WebSocket 合成网关 9 项、原版 18 项通过。执行器首次 46 项中 45 项通过，媒体项因指定的本机 ffmpeg 路径不存在而失败；改用已安装的 ffmpeg／ffprobe，仅补验该项通过，等价覆盖全部 46 项。没有进行漏洞攻击或真实业务测试。

剩余 critical 为未迁移的原 Express → proxy-addr 链；实际 HTTP／SOCKS 路径仍保留有条件的依赖风险，例如恶意上游重定向结合环境代理设置。公共 Session 不控制请求地址／选项，代理仅接受管理员配置的 HTTP(S)／SOCKS5；这些源码边界判断不能代替生产环境或攻击验证。精确包名、依赖链、触发前提与日志保存在项目 `.runtime/online-recharge-release-20261009/build/source-review-ws-security/`。不把本次定向补丁表述为全上游安全通过。旧镜像验收发生在该补丁前，修补后的镜像需要重新构建与验收，不能沿用旧镜像摘要作为修补后的运行证明。
