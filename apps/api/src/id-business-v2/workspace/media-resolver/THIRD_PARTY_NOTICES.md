# 第三方解析组件

- `yt-dlp`：版本 `2026.08.19`，固定为 commit
  `3a08beaf031ab68f966401ead017ac81fe8486cf`，项目采用 Unlicense。
- `curl-cffi`：版本 `0.16.0`，由 yt-dlp 官方 impersonation 可选依赖引入并固定为对应的 pin 版本，
  项目采用 MIT License。
- `deno`：版本 `2.9.5`，由 yt-dlp 官方 JavaScript runtime 可选依赖引入并固定为对应的 pin 版本，
  项目采用 MIT License。
- `F2`：固定为 commit `7dab3e2ffffaa2535834d28fca99dbc2e89fa9d3`，项目采用 Apache-2.0。

这些组件只在内网解析容器中运行。本系统不提供绕过登录、付费、私密内容或平台访问控制的能力；
使用者应只下载自己拥有或已获授权的公开内容，并遵守来源平台规则与适用法律。
