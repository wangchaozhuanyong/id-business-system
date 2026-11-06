# 在线工具 · 作品解析

本机业务模式的「抖音解析」沿用现有解析执行器的 `/resolve`、`/download` 契约。支持公开分享文本与作品链接、原有平台清单、视频／原声／图片选项。浏览器经过新版统一会话使用同源 API。下载凭证绑定当前账号、有效 10 分钟，单文件上限 256 MB。下载由服务端传输，浏览器收到的是短期下载凭证，原执行器票据留在服务端。

执行器源码和依赖固定方式保留在 `modules/tools/media-worker/`。Dockerfile 只调整了独立项目的构建上下文。需要在授权的独立环境启动执行器时，用该目录作为构建上下文，并将其服务端口限制在回环地址。预览入口通过 `--media-resolver-url http://127.0.0.1:<执行器端口>` 或 `startPreview` 的 `mediaResolverUrl` 显式指定。执行器须是独立的回环服务；缺配置时显示真实未就绪状态。直接打开本机工具不会连接上一版应用 API 或数据库。

隔离验收使用 `startPreview(0, { databasePath: ':memory:', authPath, mediaResolverUrl, mediaFetch })`，其中 `mediaFetch` 是测试替身。请求成功后检查媒体分类和本账号下载；其他账号与未登录请求均不可使用下载凭证。原执行器公开作品下载离线用例可在执行器目录用 `python3 -B -m unittest test_media_downloads` 运行。实际执行器安装、公开平台解析和真实文件下载需要独立服务验收。
