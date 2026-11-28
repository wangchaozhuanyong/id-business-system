# 手动续费浏览器工作区

每个工作区启动一个 Debian 图形环境和一个普通 Chromium。操作员首次在浏览器中自行登录。财务工作区关闭管理页面时仅断开显示连接，重新连接会回到同一个窗口。财务工作区正常退出后，下次启动由 Chromium 恢复上次的标签。手动充值窗口由连接服务统一处理后退、断线与无操作回收，再次启动先验证本次测速 IP 和国家，再用原资料卷打开 ChatGPT。官网决定登录状态的有效期。

## 宿主运行条件

- 受信的调度服务根据服务端已验证的工作区键选取持久卷。同一工作区使用固定的容器主机名和同一个卷。容器运行 UID/GID 均为 10001，只接收该工作区自己的目录。
- 将工作区资料目录作为可写挂载放在 `/profile`，将单独的显示套接字目录作为可写挂载放在 `/run/workspace`。两者所有者均为运行用户，权限为 0700。每次启动会独占锁定这两个目录；数据卷应支持本地文件锁和 Chromium 的进程单例锁。
- 系统盘只读，`/tmp` 为本容器专用的可写 tmpfs，使用私有 PID、IPC、挂载和网络命名空间，给 Chromium 配备独立的 `/dev/shm`。运行身份清空全部 capabilities，启用 no-new-privileges 和 seccomp 过滤。宿主需允许 Chromium 沙箱使用必要的非特权用户命名空间。宿主是否支持需在对应内核和配置下实际验证。[Chromium Linux 沙箱](https://chromium.googlesource.com/chromium/src/+/main/sandbox/linux)
- 受管宿主在启动浏览器前落实网络策略。隔离验收使用断网或封闭测试网；正式互联网访问需要逐个工作区阻断宿主、其他工作区、项目业务网络、云元数据和内部地址，覆盖 IPv4、IPv6 和本机可达的服务。容器镜像自身无法替宿主实现网络出口隔离。挂载清单仅包含所需的工作区目录与系统临时盘。

## 显示连接和停止

在 Chromium 的首个窗口出现后，worker 原子发布 `/run/workspace/rfb.sock`。该套接字权限为 0600，RFB 与 X11 的 TCP 监听均关闭。外部显示代理以授权身份接入这个 Unix 套接字，对每次访问独立校验操作者和记录归属。跨设备剪贴板和主选择区转发均关闭。键盘和指针输入照常工作。[Debian Xtigervnc 参数](https://manpages.debian.org/trixie/tigervnc-standalone-server/Xtigervnc.1.en.html)

镜像使用 `tini` 作为 PID 1，外层调度向它发送 SIGTERM。直接使用 systemd 隔离时也要保留镜像的 `tini --` 入口。worker 先撤下显示入口，再请求 Chromium 正常退出，等浏览器完成写盘后关闭窗口管理器和显示服务。浏览器仍有未保存提示时，应先由操作员处理并通过浏览器菜单退出。外层调度应给浏览器留足退出时间，并将超时显示为待处理。异常中断后保留资料卷及 Chromium 自己的锁文件。[Chromium POSIX 退出处理](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/chrome_browser_main_posix.cc)

## 隔离验证

Docker 工作区单独加载 [Chromium seccomp 配置](../chromium-seccomp.json)。部署时用 `--security-opt seccomp=<已部署配置的绝对路径>`，同时保留 `--cap-drop ALL`、`--security-opt no-new-privileges=true`、非特权 10001 用户、宿主现有 LSM 以及工作区的私有命名空间。配置基于 Apache-2.0 的 Moby seccomp v0.2.1 默认拒绝规则，仅为 amd64 和 arm64 的 Chromium 增加必需的用户、PID 和网络命名空间创建操作，以及新建用户命名空间内的沙箱根目录切换。Linux 在执行该切换时仍检查能力。平台必须支持非特权用户命名空间。验收由实际 renderer 的嵌套 PID 命名空间和附加 seccomp 过滤器提供证据。[配置许可证](../chromium-seccomp.LICENSE) · [Moby 默认配置](https://github.com/moby/profiles/blob/seccomp/v0.2.1/seccomp/default.json) · [Chromium 命名空间沙箱](https://chromium.googlesource.com/chromium/src/+/main/sandbox/linux/services/namespace_sandbox.cc)

构建上下文为本目录。运行 `python3 -B -m unittest discover -s deploy/manual-desktop/worker -v` 检查挂载约束、双目录独占、套接字权限、禁用剪贴板、断开重连和退出顺序。单元测试使用本地临时套接字以及模拟的图形进程。

真实 Linux 验收需使用专用测试卷、隔离测试网页和已生效的网络规则。通过显示客户端打开两个不同测试网页，手工登录测试站，再依次验证断开重连、正常关闭重开、另一个工作区的空白初态，以及阻断内部目标。另检查 `chrome://sandbox`、监听端口和挂载信息。只记录测试结果与合成页面标识。
