# 原版核心的生产运行配套

本目录只包含外围部署代码，200 个追踪文件全部按 `f4d7761e0036892e6dd68ec64c5447b513ca37da` 及用户批准的选路、未使用码归还两份精确补丁核验（196 个原文件不变，4 个按哈希核验）。未使用码归还边界见 `docs/RECHARGE_CODE_RETURNS_20261108.md`。不得在此加入请求内支付重试或付款逻辑。选路授权边界和两张新增表见 `docs/RECHARGE_PLAN_ROUTING_20261108.md`。

- `Dockerfile`：从既有固定 Node 24 镜像重新构建，安装原版锁定依赖、Chromium 和按现网状态选择的可选 Python 配套。构建上下文为 `source/`（确定 main 的归档）、`upstream/`（固定原仓库）、`engine/`（未改写原版加两份版本标记）。构建时必须设置 `org.opencontainers.image.revision` 和 `org.id-business.upstream.revision` 标签。
- `entry.mjs`：私有 stdin 依次接收数据库密码、既有桥接密钥、原运行设置 JSON，adapter 额外接收宿主签发的短期网络证明。原版角色启动前全量核验；宿主预检专用库后直接运行原版 server.js，不向原进程预加载监控；adapter 不加载或替换任何原版执行函数。
- `entry.mjs migrate-native-routing`：同一私有输入、确定镜像，仅执行新增两张选路表和 INSERT IGNORE 初始配置。必须先完成入口暂停、空闲核验和加密备份；隔离合成数据库对应 `migrate-canary-routing`。不启动充值、不触碰原业务表。
- `run-recharge.py native <main-sha>`：在独立 bridge 容器运行原版，直连同一受管 MySQL 的私网接口，端口只映射至宿主 `127.0.0.1:44579`。共享内存为 2 GiB，精确挂载私有截图/录像、导出及 data 目录，保留 Python 原路径 /app/data，源码来自确定镜像。
- `run-recharge.py adapter <main-sha>`：外围容器继续使用原 `127.0.0.1:44575` 接入地址，数据库仍为宿主回环；宿主真实 inspect 后签发 30 秒证明，容器不挂载 Docker socket。两个角色使用独立 systemd 服务，adapter 停止不影响原版进程。
- `capture-options.mjs`：只通过私有管道将旧原版及其父进程的白名单配置交给 `systemd-creds encrypt`；有效原生签名设置保留，原设置缺失时派生稳定内存签名值。密钥不出现在 Docker 参数、源码、发布回执或本机备份。
- `snapshot.py` / `seal-backup.mjs`：在服务器项目私有备份目录保存 AES-256-GCM 逻辑备份，绑定正式 SHA。SQL 明文只经过管道，不落盘；独立解密校验只输出字节数和摘要。恢复生产数据必须另行授权。
- `health.mjs`：从本容器子进程读取内存配置，执行只读签名健康检查，仅输出就绪状态。

正式 unit 延用平台加密 credential `independent-mysql-app`、`independent-recharge-bridge`，新增同平台加密的配置快照 `independent-recharge-options`（保存原值，不轮换）。切换前先保留旧容器唯一的截图、录像、导出文件，目标为 `formal/recharge-data/{debug_screenshots,product_files,data}`，权限 `0700`。禁止复制整个旧源码目录或覆盖已有同名文件。

发布沿用现有正式锁和 app 金丝雀流程。先在外围暂停新充值受理，并确认商城 worker 不再领取，再检查原版活动任务、待核对付款和资产锁均为空。构建与隔离金丝雀通过、加密备份验证和媒体保留完成后，停止旧原版、启动新 native，再启动 adapter、同 SHA 网站与商城回读服务。核对真实文件、数据库身份、健康和客户拒绝访问银行卡后再解除临时受理暂停。

现有商城维护模式和充值码配置不会因部署自动改变。本轮发布不产生测试订单、真实付款或通知，不自动回滚生产。所有命令、镜像和实际回执按确定 main SHA 记录；未确认的步骤不得记为完成。

入口暂停由 `release-gate.py` 精确添加和移除本次 SHA 标记，只挡充值变更请求。Caddy 2.11 起支持信号重载；现网 2.10 且管理 API 关闭时使用同一容器的短暂重启，不升级网关或开放管理 API。重载后必须核对同容器、同镜像、同挂载，以及三个变更路由的固定响应和 `Retry-After`；不能只凭 HTTP 503 判定暂停生效。正式保护记录允许本次网关重启改变启动时间，MySQL 和媒体服务仍要求原容器及启动时间不变。

宿主 native 启动器使用独立 flock 与唯一容器名/端口阻止并发启动；Docker 查询失败直接停止该次启动。数据库只读预检发生在启动前的短生命周期容器中；启动后不再持有数据库监控连接，不因辅助监控断线杀死正在付款的原版进程。服务明确停止仍按原信号退出。

未使用码归还发布另执行 `entry.mjs migrate-native-code-returns`，只创建一张幂等回执附属表。隔离金丝雀先验证新增迁移和与原占用条件更新的八次并发竞争，再允许正式切换；不在生产库创建测试充值码。
