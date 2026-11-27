# 生产宿主的手动充值工作区

网站正式发布流程在同一提交的制品校验完成后调用宿主安装器。准备同一份 CI 已测试的本地 Docker 镜像、noVNC 模块及对应 Python 的 aiohttp 依赖。制品的路径及父目录归 root 所有，组和其他用户没有写权限。镜像按 `sha256:` 开头的本地镜像 ID 运行。

```bash
/usr/bin/python3 -IB "$release/source/deploy/manual-desktop/host/provision.py" check \
  --release-root "$release" \
  --image-id "$image_id" \
  --assets "$release/manual-runtime/novnc" \
  --site-packages "$release/manual-runtime/site-packages" \
  --max-active "$max_active" \
  --min-available-mib "$min_available_mib" \
  --block-network "$host_public_ip/32"
```

- `check` 检查宿主工具、已加载的镜像、Python 依赖及当前内存。宿主需具备 systemd、Polkit、可用的非特权用户命名空间以及支持 cgroup v2、seccomp、内存和进程限制的本地 Docker。可重复传递 `--block-network`，提供仍能被公网代理访问的本组织网络 CIDR。
- `install` 使用相同参数激活连接服务。回执 `started: true` 表示本次新启动，`started: false` 表示对应服务已经运行。同一套参数可执行 `verify`，回读私有套接字、noVNC 模块和实际进程的 Polkit 授权。
- 网站切换失败时，先回滚网站。若本次激活的回执为 `started: true`，用同一套参数执行 `deactivate`。它仅停止并取消开机启用对应的连接服务，检查在用工作区，保留用户资料与归属记录。
- `--min-available-mib` 是新启动浏览器前的最低可用内存，至少 512 MiB。并发和业务余量取自目标宿主实测。

网站容器将宿主目录 `/run/id-manual-bridge` 只读挂载在同名路径，添加补充组 `--group-add 10001`，设置 `ID_MANUAL_WORKSPACE_SOCKET=/run/id-manual-bridge/site.sock`。目录权限为 0750，套接字为 0660。网站登录、角色与记录归属仍由网站和连接服务核验。

连接服务以固定宿主 UID/GID 10001 运行。Polkit 只授权它启停带规范工作区键的服务实例。每个浏览器容器使用独立的 0700 持久资料目录和显示目录，另以只读方式挂载连接服务准备的输入目录。Docker 网络为 `none`，每次运行需要该工作区的引导及中继套接字。浏览器使用已校验的 Chromium seccomp 配置、非特权用户、空能力集和 no-new-privileges。

在开发环境运行 `python3 -B -m unittest discover -s deploy/manual-desktop/host -v`。测试使用临时目录和本机测试套接字，不安装宿主服务。
