# 比特浏览器 JSON 登录

`index.mjs` 在本机网页中导入。输入使用当前页提供的授权 JSON、BitBrowser 本机 API、窗口分组及标签。登录过程在本机比特窗口中恢复 ChatGPT 会话，回读邮箱、用户 ID、账号 ID 和页面状态，核验通过后保留窗口。需要真人验证时，用户在比特窗口中处理。

- `direct-login.mjs` 取自固定版本的 `bitbrowser-direct-login.ts`，保留分组、窗口配置、同步禁用检查、CDP 控制、JSON 会话恢复、账号比对和代理重试，去掉账号密码和付款分支。
- `direct-api.mjs`、`cdp.mjs` 和 `login-page.mjs` 分别沿用固定版本的本机请求、浏览器控制和官网读取。HTTP 和 WebSocket 只接受本机回环地址。
- `browser-options.mjs` 沿用固定版本中的浏览器默认参数和归一化规则。
- `index.mjs` 用独立新版的授权 JSON 校验器构造原流程的输入。原始 JSON 和密钥留在当前页内存。窗口归属仅保存在当前页，按本机接口与账号摘要复用，配置变化时要求核对原窗口。

固定版本为 `e51dd9c9974c6292dbbc6572a5d844a672f0d0f1`。对应原始文件位于 [比特浏览器参考快照](../reference/SOURCE-MANIFEST.json)。
