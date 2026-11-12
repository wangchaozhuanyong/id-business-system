# 独立新版在线工具验收

左侧插件管理提供邮箱查询与邮箱池、网站监控，工具箱保留计算 2FA 验证码和抖音解析。数据中心提供网站统计和谷歌表格同步，沿用管理员权限。

| 工具 | 本机接入 | 实际服务配置 |
| --- | --- | --- |
| 2FA | 手工计算支持 Base32、验证器链接和多行输入。保存账号按登录身份隔离，加密落盘，取码和变更审计不包含密钥或验证码 | 使用新版登录，支持本机验证，无外部依赖 |
| 网站监控 | 公开网站健康检测。管理员访问明细支持 7／30 天、排序分页、按 IP 查询、默认遮挡与经审计查看 | 签名采集使用 `--website-visits-secret-file` |
| 网站统计 | 装修站展示浏览量、访问次数和时段去重访客数。三个商城展示浏览量与访问次数，按站点与时间范围分别查看 | `--website-analytics-config` 读取装修站 GA4，`--website-cloudflare-config` 读取商城 Cloudflare Web Analytics |
| 谷歌表格同步 | 查看持续运行的同步进程回执，以及邮箱、账号、订单和客户的工作表字段。刷新只读取回执 | 优先读取同步进程的专用回执。正式站的现有备份状态采集器也从同步进程的日志投影最后核验时间和失败状态，通过现有只读挂载提供给页面 |
| 抖音解析 | 沿用原执行器协议、公开作品平台规则，按视频、原声、图片显示，统一登录下载 | 通过 `--media-resolver-url` 挂载独立执行器，详见 [解析执行器](MEDIA_RESOLVER.md) |
| 邮箱查询与邮箱池 | 登录工具和买家查询页共用查询码。管理员可登记、批量登记谷歌／苹果、修改授权、启停、重发查询码、设定默认有效期。Microsoft 逐个完成 OAuth，已接通的 Apple 隐藏邮箱查询入口继续可用 | 谷歌、苹果填写应用专用密码；Microsoft 使用 `--microsoft-mailbox-config`，包含 `clientId`、`clientSecret`、`redirectUri`。独立回调路径为 `/api/local/tools/mailbox-microsoft/callback`。详见 [Microsoft 回调要求](https://learn.microsoft.com/entra/identity-platform/reply-url) 和 [IMAP 授权范围](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth/) |

真实配置文件由管理员在本机单独提供并限制文件访问权限。网页登录或日志不显示配置值。收件内容仅在查询响应中返回，邮箱池不保存邮件正文。采集只接受固定网站与签名原始事件，明细按北京时间统计，最近 30 天以外的记录不展示，并在后续写入时修剪。独立本机版访问明细容量为 20,000 条，达到上限会明确报错。此版本使用现有加密业务文档存储，无新表或数据库迁移。

已用随机回环端口、合成账号、隔离 SQLite 与服务替身验证四项入口。集成测试覆盖权限隔离、只读分析、签名去重、查询码替换、OAuth 防重放和备份回读。真实邮件账号、采集器、GA4 数据与公开媒体执行器仍需在配置后分别验证。

## 私有配置读取接入

`server/tools/read-tool-config.mjs` 提供统一读取。配置文件须由运行预览的当前用户拥有，权限为 `0600` 或 `0400`，并使用普通文件的实际路径。文件及路径中的符号链接、文件硬链接和 macOS 附加 ACL 均会被拒绝。限制为 64 KiB，读取前后核对文件身份与状态。错误只报告工具名和检查类型，省略文件路径、配置内容和底层错误。缺省参数才表示未启用；指定后读取失败会阻止启动。JSON 对象的业务字段由对应工具继续校验。

共享入口移除原有同名读取函数，再从独立模块导入。保留 `preview.mjs` 原本用于静态资源的 `readFile`。

```js
import { readToolConfig } from './tools/read-tool-config.mjs';

const websiteAnalyticsConfig = await readToolConfig(
  values['website-analytics-config'], 'website-analytics'
);
const websiteVisitsSecret = await readToolConfig(
  values['website-visits-secret-file'], 'website-visits'
);
const microsoftMailboxConfig = await readToolConfig(
  values['microsoft-mailbox-config'], 'microsoft-mailbox'
);
```

三项返回值仍按原名称传给 `startPreview`。合成文件验收运行 `node --test test/tools-config-file.test.mjs`。

## 商城统计接入

`--website-cloudflare-config` 接收私有 JSON 文件，字段为 `accountId`、`apiToken` 和 `sites`。令牌使用目标账户的 Analytics 读取权限。`sites` 按域名映射各 Web Analytics 报表的 `siteTag`，支持 `damatong.net`、`moyaoai.com`、`shop.flashcast.com.my`，可分批接入。闪铸商城可与装修站复用 Cloudflare 的站点标识，查询仍精确限定商城域名。

商城按 UTC 自然日统计，装修站保留 GA4 属性的统计时区。最近 7／30 天包含读取当天。上线验收需按同一域名、日期、时区和机器人过滤条件逐站核对读数，并回读同步进程的真实回执。访问次数定义见[Cloudflare Web Analytics 指标](https://developers.cloudflare.com/web-analytics/data-metrics/high-level-metrics/)。

## 线上配置与新版接入

已核对成功的 [生产发布记录](https://github.com/wangchaozhuanyong/id-business-system/actions/runs/40105506608) 对应源码和部署清单，以及原系统 GA4 和邮箱接入说明。生产 ID API readiness 和装修网站公开页面均返回 HTTP 200。以下是部署契约与新版待验收项，公开健康检查只覆盖对应端点。

| 能力 | 线上接法 | 新版落地与待验收 |
| --- | --- | --- |
| GA4 只读统计 | 属性 `540413787`，数据流 `15010607367`，过滤 `flashcast.com.my`、`www.flashcast.com.my`。服务端通过 `WEBSITE_ANALYTICS_SERVICE_ACCOUNT_JSON` 读取标准服务账号 JSON | 传入获准供新版使用的只读账号文件即可使用同一报表源。核对相同属性时区和 7／30 天范围的浏览量、访客数与会话数 |
| 网站访问明细采集 | 浏览器请求同源 `POST /__visit`，Cloudflare 服务端校验路径和来源、读取可信 IP，再通过 HTTPS 签名转发至 ID API。签名头为 `x-website-visit-signature`，对 `JSON.stringify([eventId, host, path, ip, occurredAt])` 做 HMAC-SHA256，接收端允许 60 秒时钟偏差 | 回环接收端 `POST /api/local/tools/website-visits/ingest` 接受同一事件格式。独立采集端需能到达新版接收端，并与新版使用同一份独立密钥。用授权事件核对签名、去重与查阅审计 |
| 抖音解析 | API 通过服务网络访问 `http://media-resolver:8787`，执行器提供 `/health`、`/resolve`、`/download` | 独立执行器沿用端口 `8787` 时，预检和启动参数为 `--media-resolver-url http://127.0.0.1:8787`。执行器就绪后验证公开作品解析、分类及下载 |
| Microsoft 邮箱 | 服务端读取 `MICROSOFT_MAIL_OAUTH_CLIENT_ID`、`MICROSOFT_MAIL_OAUTH_CLIENT_SECRET`、`MICROSOFT_MAIL_OAUTH_REDIRECT_URI`，通过 Microsoft OAuth 委派授权后访问 Outlook IMAP | 用专用应用配置 `clientId`、`clientSecret` 和在 Entra 注册的本地 `redirectUri`。回调地址形如 `http://localhost:<新版端口>/api/local/tools/mailbox-microsoft/callback`，须与新版实际访问的主机和端口一致。测试邮箱授权后用查询码核对测试邮件 |

凭据由获授权的部署环境通过私有文件注入。服务器切换可沿用原域名和 HTTPS，按下面的接入契约保留老版公开路径。

## 沿用线上域名的接入契约

- 正式宿主用服务器侧确定的唯一 HTTPS 源地址作为 `publicOrigin`，传给 `createMicrosoftMailbox`、`createWebsiteVisits`、`createManagedMailboxQuery`、`createMediaResolver` 和 `createWebsiteMonitor`。反向代理保留对应的 `Host`，应用监听留在受控内部地址。工具使用固定源和真实请求 `Host` 校验，忽略客户端转发头。省略参数时沿用本机规则。
- Microsoft 若沿用已登记的老回调，保留 `GET /api/public/mailbox/microsoft-oauth/callback`，由宿主交给同一个 Microsoft 实例的 `handle(..., 'callback')`。原请求路径须传到处理器。也可登记并使用 `/api/local/tools/mailbox-microsoft/callback`，实际匹配以 `redirectUri` 为准。授权开始和完成仍走新版管理员路由。
- 访问采集可保留 `POST /api/id-business-v2/workspace-website-monitor/visits/ingest`，由宿主交给访问采集处理器的 `ingest` 操作。保留原请求体和 `x-website-visit-signature`，签名仍需校验。查询和明细查看继续走管理员路由。若继续使用已有采集签名，获准后由部署端注入与采集器相配的密钥。
- 在宿主完成域名校验后、通用登录拦截前，调用 `legacy-public-routes.mjs` 的路由处理器。它只接上述两个精确的旧路径，并校验域名和请求方法。使用和管理员路由相同的 Microsoft 实例，以便授权开始、回调和保存共享状态。

```js
const handleLegacyToolRoute = createLegacyToolRoutes({
  publicOrigin, microsoftMailbox, handleWebsiteVisits
});
// Within the host's request handler:
if (await handleLegacyToolRoute(request, response)) return;
```

本机 `preview.mjs` 仍是回环入口。正式宿主接入、会话及反向代理由公共入口统一配置。随机回环 HTTP 测试覆盖两条旧路径，真实域名联调在切换前执行。

## 本机配置预检

从独立新版 Git 根运行。省略选项时可直接列出缺项；提供路径后复用安全文件读取和运行时构造校验。参数里的路径、回调地址、主机名、密钥和健康响应正文均不会写进结果。

```sh
node server/tools/online-tools-preflight.mjs
node server/tools/online-tools-preflight.mjs \
  --website-analytics-config "$ga4_private_file" \
  --website-cloudflare-config "$cloudflare_private_file" \
  --website-visits-secret-file "$visits_private_file" \
  --media-resolver-url "$worker_loopback_origin" \
  --microsoft-mailbox-config "$microsoft_private_file" \
  --preview-origin "$planned_preview_origin"
```

- GA4 用相同的加载路径读取标准凭据或已有显式配置，检查属性、数据流、主机名及服务账号私钥格式。访问采集检查私有密钥文件与签名密钥格式。这两项默认无网络请求。
- Microsoft 检查应用配置和回调格式。提供 `--preview-origin` 后比较回调与计划预览地址的主机及端口。未提供时，这一项标记未检查。预检不打开授权页面、不换取令牌。
- 计划沿用线上域名时，用 `--public-origin "$planned_https_origin"` 替换 `--preview-origin`。预检检查正式 HTTPS 域名与 Microsoft 配置是否匹配，同时接受老版已登记的回调路径。此检查不会访问该域名。
- 正式宿主挂载两条旧路由后，可同时加 `--probe-public-routes` 检查 HTTPS 入口。预检对两条旧路径各发一次不带参数和凭据的 GET。Microsoft 应返回 HTTP 400 的授权未完成页面，采集入口应返回 HTTP 405 和 `Allow: POST`。报告只记录探测状态。此步骤验证路由可达，真实邮箱授权和签名采集另行验收。
- 媒体默认只检查回环配置。对已单独启动、获准测试的执行器，可加 `--probe-media`，仅直连 `127.0.0.1` 发送一次 `GET /health`。超时 2 秒，健康响应须为 JSON 且 `ok: true`。拒绝跳转和 4348；提供计划预览地址时，也拒绝使用与该地址相同的端口。该结果只证明回环健康响应，作品解析与下载仍需独立验收。

每项输出 `valid`、`missing`、`invalid` 或 `unavailable`，并列出真实联调所需输入。退出码 0 表示四项配置检查及请求的健康检查通过，2 表示至少一项有缺口，1 表示命令参数无效。无论退出码，真实联调状态仍为 `not_verified`。

抖音真实联调还需独立执行器回环地址及可公开访问的授权测试作品，登录后验证解析、媒体分类和文件下载。预检合成验收运行 `node --test test/tools-online-preflight.test.mjs`。
