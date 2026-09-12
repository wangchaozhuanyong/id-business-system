# 本机比特浏览器自动充值

自动充值的当前主流程是：管理端创建脱敏任务，当前电脑上的本机连接器调用比特浏览器 Local API 创建窗口，再通过 Playwright CDP 在该窗口中恢复 JSON 登录并执行官网充值。管理端不再以服务器 Worker 作为新任务的主执行入口；原有记录和原单数据继续兼容，原有服务端接口只供旧记录恢复使用，新页面不再调用。

## 操作流程

1. 首次在“比特浏览器设置”保存 Local API 地址与密钥、本机连接密钥、动态 IP 提取链接、窗口分组、标签／备注和代理协议。三个秘密值由 API 加密保存，页面只回显脱敏状态。
2. 粘贴授权 JSON 后页面自动载入，套餐默认为 ChatGPT Plus，账单邮箱使用 JSON 中唯一的 ChatGPT 注册邮箱。不需要填写登录网址，官网入口固定为 `https://chatgpt.com`。
3. 填写本次窗口名称、卡资料，选择一条未使用地址，设定锁定币种和最高付款金额，再明确授权本任务最多发送一次官网付款请求。
4. 点击“连接比特浏览器并执行本次充值”后，本机连接器创建新窗口，加入设定分组，把“标签”写入比特公开 API 支持的窗口备注，并在每次新建窗口时从动态链接提取新 IP。
5. 连接器核对官网账户、套餐、浏览器出口和当前订单，填写官网账单表单，读取官方最终金额。只有套餐、今日应付、税费、续费、周期、币种和订单绑定都明确，且币种与锁定值一致、金额不超上限时，才允许提交一次付款。
6. 遇到网页真人验证、邮箱／短信验证或银行 3DS 时，原浏览器窗口、IP 和订单保持不变，页面进入“等待本人验证”。本人在原窗口处理后点击“继续原任务”；系统不绕过验证、不新建订单、不重试付款。
7. 如果本机接收回执丢失，页面只查询原任务，不重发。确认未接收时安全结束并保留卡资料；已接收则继续观察原任务。
8. 付款结果不明时只能点击“只读复查原订单”，复查请求不包含卡资料、地址或付款授权。

## 固定设置与付款边界

- 账单地区由现有地址库提供：`US / Portland / OR / 97204`；只有街道地址随本次选择变化。
- 新窗口的浏览器语言和界面语言固定简体中文，时区和定位跟随代理 IP。
- 账单地址不用于猜测币种；币种以当前官网／Stripe 绑定订单回执为准。与用户锁定币种不一致时安全停止。
- 本地只做通用 PAN 长度和 Luhn 校验，不限制卡组织、卡号开头或信用卡／借记卡。是否可用由官网支付页判断。
- JSON、完整卡号、有效期和安全码由当前页面直接发给 `127.0.0.1` 连接器，不进入生产 API 正文、数据库、审计或日志。页面离开、用户取消或观察到真实付款请求后清除卡资料；核价失败保留当前页面输入。
- 第一次真实付款请求前必须先把不可回退的原单标记回传 API；标记成功后才放行请求。此时地址立即标记已使用，包括付款结果未知。
- 付款结果不明时一律视为“原单待核验”，不能再选地址、再建单或再付款。

## 本机连接器

要求：当前电脑已启动比特浏览器并开启 Local API，安装 Python 3.11 或更高版本。连接器只监听 `127.0.0.1:55321`，只接受启动命令中允许的管理端 origin，并使用独立连接密钥。

```sh
npm run auto-recharge:connector -- --allowed-origin=https://管理端域名
```

首次启动会在已忽略的 `.runtime/auto-recharge-connector` 创建独立运行环境和权限为 `0600` 的连接密钥文件。将终端显示的密钥保存到网站设置，不要发送到聊天、提交到 Git 或写入日志。

## 接口与存储

- `GET/PUT /api/id-business-v2/auto-recharge/bitbrowser-settings`：读取脱敏设置或加密更新设置。
- `POST /api/id-business-v2/auto-recharge/jobs/bitbrowser`：建立脱敏本机任务，只接受套餐、地址编号、窗口名称、锁定币种、付款上限和单次授权。
- `POST /api/id-business-v2/auto-recharge/jobs/bitbrowser-recheck`：只为已尝试付款的原任务建立只读复查，不取新地址、不发付款。
- `POST /api/id-business-v2/auto-recharge/jobs/:id/bitbrowser-unreceived`：只能结束仍处于“等待本机接收”且付款请求为零的任务。
- `POST /api/id-business-v2/auto-recharge/local/:id`：本机连接器使用当任务一次性密钥回传脱敏进度、原单标记和结果。
- `IdBusinessV2RechargeBrowserSetting`：每个管理员的比特默认设置；三个秘密值只保存密文和掩码。
- `IdBusinessV2RechargeJob` 和 `IdBusinessV2RechargeRecord`：保存脱敏状态、原单证据和不可重复的付款标记。
- 新 migration：`apps/api/prisma-mysql/migrations/20260912180000_auto_recharge_bitbrowser_settings/migration.sql`，只新增设置表，不修改生产数据。

## 验证

```sh
npm run prisma:mysql:validate
npm run typecheck
npm run lint
npm run check:v2-ui-language
npm run check:v2-loading-standard
npm run check:v2-module-architecture
npm run acceptance:v2-auto-recharge
```

Worker 回归使用本地夹具和被拦截的 Chromium 请求，不连接真实 ChatGPT、动态 IP 提取链接或支付网络。代码完成不代表真实卡已付款或会员已开通。
