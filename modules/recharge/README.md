# 独立新版充值模块

[比特浏览器登录](http://127.0.0.1:4348/#/recharge/start)使用授权 JSON 打开本机比特窗口并核验账号。[线上 ChatGPT](http://127.0.0.1:4348/#/online-recharge/chatgpt)使用独立的代充服务。静态预览不启用该服务，本机业务宿主可按下述方式挂载。

## 线上代充 ChatGPT

下载的 MIT 项目位于 `.upstream/codexdaichong`，固定提交为 `f4d7761e0036892e6dd68ec64c5447b513ca37da`。兑换开通位于「工作台」，采用 Vendure 的紧凑双步骤表单，先验码锁定套餐，再显示目标账号和套餐并要求人工确认。使用原上游验码、提交与任务查询，继续保留轮询和 WebSocket。提交结果无法确认时，当前页面引导查原兑换码，并禁用同码再次提交。线上代充保留查询和管理页签。统一账号负责登录、密码和验证设置，上游敏感接口继续检查统一敏感权限。

`npm run prepare:codexdaichong` 可从固定提交生成 `.runtime/codexdaichong`，如已有副本则拒绝覆盖。生成过程进行语法检查。正式接入由新版宿主在同源 `/integrations/codexdaichong/` 挂载 `createCodexdaichongGateway`，并为每个请求提供经服务器校验的统一用户及授权信息。浏览器从全站会话进入，内部请求签名只在网关与回环服务之间传输。

### 独立测试副本启动与健康检查

在本项目根目录运行。复制目标必须是项目 `.runtime` 下尚不存在的目录。以下示例在本机已有锁定 npm 缓存时可离线安装。

```sh
npm run prepare:codexdaichong
npm --prefix "$PWD/.runtime/codexdaichong" ci --offline --ignore-scripts --no-audit --no-fund
node modules/recharge/codexdaichong/runtime.mjs preflight
node modules/recharge/codexdaichong/runtime.mjs start
```

`preflight` 和 `start` 从当前进程环境读取 `PORT`、`DB_HOST`、`DB_PORT`、`DB_NAME`、`DB_USER`、`DB_PASSWORD` 和 `ID_RECHARGE_BRIDGE_SECRET`。隔离启动只接受 `127.0.0.1` 上的专用测试 MySQL，库名为 `id_redesign_codexdaichong_test` 或带小写测试后缀，用户不得为 root。两个端口须不同。桥接密钥至少 32 字节，由宿主和代充副本共同读取。启动副本使用锁定源码，会按原行为初始化数据库、重置其资产锁并启动后台维护。应事先准备空的专用测试库和仅授权该库的用户，隔离出站，保持供应商、代理、支付和通知未配置。

另一个终端使用同一桥接密钥运行 `node modules/recharge/codexdaichong/runtime.mjs health <回环服务地址>`。探针只访问签名保护的原 `/api/public/runtime`。连接失败、签名被拒、原服务未就绪和返回格式无效会分别报告，失败退出码为 1。此检查不代表实际账号、卡池、供应商或付款可用。

需要验证浏览器启动时，使用 `codexdaichong/Dockerfile.local` 构建本机上游容器镜像。构建参数 `PLAYWRIGHT_VERSION` 从已准备副本的 `package-lock.json` 中读取 `packages['node_modules/playwright'].version`。镜像安装该版本的 Chromium、无头浏览器和 Linux 依赖，运行时仍挂载原来准备好的上游副本。用该副本的 `connectStandaloneBrowser` 打开本地内容即可验证浏览器启动和截图。此步骤不需要 Session 或网络出站。

本机 4371 使用隔离测试 MySQL。需要访问真实支付页时，可在隔离网络与出站网络之间运行 `codexdaichong/checkout-debug-proxy.mjs`，使用 `CHECKOUT_DEBUG_CLIENT_IPV4` 限定调用容器，不发布代理端口。在测试上游容器上设置 `ID_RECHARGE_CHECKOUT_DEBUG_PROXY`，仅支付链接调试的浏览器使用该代理。代理只接受允许域名的 HTTPS 隧道。原上游调试流程在支付页截图后停止。

### 本机完整站点演示

在项目根目录运行 `node modules/recharge/codexdaichong/demo-site.mjs 4356`，打开 [ChatGPT 充值后台](http://127.0.0.1:4356/#/online-recharge/chatgpt) 或 [工作台兑换开通](http://127.0.0.1:4356/#/workspace/recharge)。启动器使用本项目完整界面及进程内虚构资料。点「填入演示资料」，验证兑换码、勾选确认后提交，再到「兑换码查询」或「任务管理」查看。模拟任务先处理中，再转待人工核对。卡密查询沿用原上游规则，人工核对中的未消耗卡密仍显示「未使用」，原任务可按任务编号查到。

重复提交同一演示资料返回当前进程的同一任务。重新启动会清空演示资料及任务，旧任务编号返回未找到，旧演示授权失效。保存、批量生成、外部连接测试、支付、续费和发票查询在演示中禁用。演示使用内存数据库，真实业务文件和独立上游 MySQL 不参与测试。

在演示页选择 Plus、Pro 100 或 Pro 200 样例，再填入资料并验码。样例选择只用于填入测试码，页面的「已锁定套餐」来自模拟验码接口返回的绑定结果。缺少有效套餐类型时，兑换开通显示错误并禁用新提交。真实环境由原代充服务按库存记录验码。

用下述 Playwright 环境运行 `node --test test/codexdaichong-demo.browser.mjs`。专项用独立随机端口，覆盖 14 个视图、银行卡池与任务管理子页签、发票助手、桌面与窄屏布局、深浅主题、只读状态、验码、提交、按任务查询、并发重试、后台刷新失败与恢复、重启清空及旧授权拒绝。

### 本机统一会话接入

「系统设置 → 登录日志」集中提供两个来源。系统登录页签复用统一员工账号的登录和退出审计，即使代充服务不可用也可查看。充值登录与 IP 封禁页签保留原上游记录和原封禁范围。在本机演示站可通过 `/#/settings/login-logs` 查看入口，未启用统一登录时页面会显示对应提示。

`codexdaichong/local-gateway.mjs` 导出 `createLocalCodexdaichongGateway({ upstreamUrl, publicOrigin, secret, getActor })`。本机宿主应传入当前进程的员工会话读取函数，例如 `(request) => auth?.getActor(request)`。HTTP 和 WebSocket 必须复用同一网关实例。适配器从服务器会话读取用户，不接受客户端自报身份。沿用本机预览的现有入口限制，普通员工不可进入，管理员可使用代充，超级管理员额外获得原上游敏感操作权限。

现有宿主 CLI 已支持 `--codexdaichong-url`，配合 `--local-data`、已配置的员工账户和进程环境中的同一 `ID_RECHARGE_BRIDGE_SECRET` 使用。日常 CLI 本机业务模式会使用既有本机业务文件。自动化联调使用 `startPreview(0, { databasePath: ':memory:', authPath, rechargeConfig: { upstreamUrl, secret } })`，其中 `authPath` 指向独立合成员工配置。两种方式均保持 HTTP 与 WebSocket 在同源网关中。未启用时继续显示未就绪。第三方卡资产推送仍关闭，除非单独配置获准的服务身份。

4348 接入真实独立上游前，需由负责人提供已初始化并通过签名健康检查的回环代充地址、上游和宿主共用的桥接密钥，以及 4348 已配置的统一管理员账号。首次启动上游还需要前述专用 MySQL 与独立测试账号。已具备这些输入后，在相应终端加载密钥和回环地址，由负责人用下列命令挂载。真实渠道执行另需获准的供应商或浏览器执行环境及相应资产。

```sh
node modules/recharge/codexdaichong/runtime.mjs health "$RECHARGE_UPSTREAM_URL"
node server/preview.mjs --local-data --port 4348 --codexdaichong-url "$RECHARGE_UPSTREAM_URL"
```

浏览器回归命令使用已有 Playwright 及浏览器，设置 `ID_RECHARGE_QA_PLAYWRIGHT` 为 Playwright 入口绝对路径。可设 `ID_RECHARGE_QA_BROWSER_CHANNEL=chrome` 复用已安装的 Chrome，再运行 `node --test test/codexdaichong-workspace.browser.mjs`。浏览器只访问本次随机回环宿主。

宿主切换边界：兑换 iframe 在已有执行锁生效时同步设置 `document.documentElement.dataset.rechargeNavigationLocked = 'true'`，任务结束或提交请求结束并解锁后为 `'false'`。同源父页还会收到 `{ source: 'id-codexdaichong', type: 'navigation-lock', locked: boolean }`。专项用模拟上游确认了执行中禁止内嵌页签切换，结束后恢复，并验证了两个状态通知。

宿主接线时读取当前可见的同源充值 iframe 的上述属性。先在 `frontend/operations-prototype.js` 的 `ops-integrated-view` 和 `ops-integrated-refresh` 分支入口检查，锁定时直接返回，必须在改选中页签、发消息、开始请求或替换 iframe 之前。再在 `frontend/prototype.js` 的 `navigate()` 检查实际换页，锁定时用 `history.replaceState(null, '', '#/' + state.route)` 恢复地址并返回，保留当前页面。消息可用于更新提示，动作当下应同步读 iframe 属性，避免消息尚未送达。宿主专项应在模拟任务处理中触发后台页签、站内刷新和侧栏换页，断言 URL、可见 iframe 实例和任务编号不变，终态后再次执行并确认恢复。本段只涉及站内导航和刷新按钮。

`test/codexdaichong-local-session.test.mjs` 使用真实新版员工会话模块、随机回环端口和模拟上游。覆盖登录及退出、管理员与超级管理员、员工拒绝、角色降级撤销旧会话、验码／提交／查询、原任务 HTTP 查询及 WebSocket 进度推送。退出后已有 WebSocket 的下一次任务推送会被拦截，空闲连接仍定期复查。该测试不启动代充执行器、专用 MySQL 或任何正式站点。

### Vendure 与本机执行边界

固定 codexdaichong 继续使用原有 HTTP、WebSocket 和供应商状态轮询。`vendure/loopback-bridge.mjs` 可由隔离宿主通过 `startPreview(0, { vendureRehearsal })` 挂载。它使用 Vendure 的五个 POST 动作 `config`、`verify`、`submit`、`query`、`task`，沿用 `/api/id-business-v2/online-recharge/integrations/vendure/` 前缀和任务回执字段。请求校验专用密钥、客户 IP 格式和动作字段，任务套餐来自兑换码配置。正式 HTTPS 宿主拒绝挂载演练适配器，执行器领取和回执接口使用单独监听入口。

替身执行器使用另一组服务密钥签名 `POST /integrations/recharge-worker/claim` 和 `POST /integrations/recharge-worker/result`。签名覆盖方法、路径、请求体摘要、时间戳和一次性编号。领取返回短期租约与此次授权资料，查单和结果回执不返回授权资料。已领取任务租约超时或执行结果未知时，原任务保留为 `awaiting_review`，同一兑换码不会自动创建第二次执行。已记录的相同结果可安全重传，冲突结果或重复凭证须核对。测试使用随机回环端口、合成数据和本项目的独立临时存储。

隔离持久化接入使用 `openIsolatedRechargeStore({ file, storageKey })`，将返回的 `store` 传给 `createLoopbackVendureRechargeBridge`。文件必须是项目 `.runtime/` 专用子目录内的 `vendure-recharge-isolated.sqlite`。调用方负责关闭桥接和存储。重启继续使用同一份文件及同一组 32 字节存储密钥，桥接只供单实例使用。已有 Vendure 接口和任务回执格式保持一致。

- 提交、领取和结果确认先提交同一个快照，再返回确认。文件保存任务状态、兑换码占用、租约摘要、结果凭证摘要和已用签名编号摘要。兑换码、租约令牌、任务查询令牌和凭证明文不落盘。存储用独立密钥校验快照，错误密钥会被拒绝。
- 短期授权 JSON 仅在内存中等待首次有效领取，领取、过期或关闭即清除。重启时，未领取任务因无法恢复授权、已领取任务因结果不明，都会转待核对。原任务编号和兑换码占用保留，旧租约不能触发补跑。
- 提交未落盘时返回暂不可用，读取仍显示上次已确认状态。存储层报错但文件版本已经前进时，实例停止继续应答任务请求，重开后根据文件恢复真实结果。已确认的重复结果可使用新签名安全重传。

正式接入仍需确定生产任务库、备份和审计策略，接入已核验的执行器与来源限制，并完成实际断电恢复和切换验收。现有 Vendure 历史任务继续由原服务查询。

`node modules/recharge/codexdaichong/runtime.mjs preflight-production [副本目录]` 可对已初始化的独立正式库执行只读核对。沿用上述运行参数，库名为 `id_redesign_codexdaichong_prod`，专用账号为 `id_redesign_recharge`。预检确认实际连接身份，发现未结任务、待人工核对记录或资产锁时拒绝放行。此命令不初始化 MySQL 或启动执行器。

真实专用库、员工权限策略的生产验收、外部服务、设备和实际付款仍需独立验证。比特浏览器继续只接原授权 JSON 登录流程。
