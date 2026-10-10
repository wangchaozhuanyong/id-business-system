# 发布依赖备份保护修复

本次用户已授权修复剩余问题并统一发布。真实诊断 `38065767775/1` 确认 RECOVERY 和 RESTORED 两份原备份再次 MISSING；current `0a03fa28e6b844a18833d5c63f1de700f091fc64` 与七个业务服务未变化。原脚本按数量和容量裁剪，没有保护发布回执所引用的原件。发布切换前也会显式启动同一备份服务，因此仅恢复原件或仅暂停 timer 都不能覆盖完整窗口。

修复仅涉及备份维护入口，不发布业务代码、不执行数据库恢复、DDL、业务任务或清理生产资源。

- 原脚本通过同目录 helper 规划和裁剪。固定 RECOVERY/RESTORED 历史绑定、current/previous 的实际引用以及持有发布锁时唯一新鲜活动发布引用受保护；尚不存在的引用也先登记保护。
- 坏引用、引用或备份集合变化、无法满足原数量和容量上限时停止。原上限保持，不能为了通过检查扩大容量或删除受保护原件。
- helper 默认仅规划，`--apply` 才裁剪；正常备份继续继承原 FD9 备份锁。环境、Compose、数据库选择和 normalizer 保持来自原 current。
- `install_backup_retention_protection` 必须在 main、Quality 通过且 expected_current 为上述原版本时执行。以受审源码 SHA 安装独立 root 拥有的维护副本和固定 systemd drop-in，使 timer 和 `fresh_backup` 的显式启动使用同一保护入口；不修改旧 release 源码。
- 安装不停止或重启原 timer，避免 SSM 超时或进程被杀后留下长期停机。先等待旧 oneshot 结束，原子安装固定维护入口并重载 systemd，再确认没有仍使用旧入口的备份进程；原 timer 状态持续保持。两原件只在实际安装成功后恢复，后续定时与显式备份使用同一保护入口。
- 安装前后核验原 current、环境、Compose、normalizer 和七个服务保持，实际安全回执按真实 workflow run/attempt、commit/tree 和原字节记录；不把本地 fixture 视为实际安装。

本地 leaf 检查：原 26 项 Python 测试通过后，补充活动清单先于 current 切换的 4 个案例，受影响 10 项在 Python 3 和原助手 Python 3.11 各通过；原备份 40 项通过。安装器在两 Python 版本各 37 项合成测试通过；不停止 timer，共用 760 秒预算，最大 producer 的 SSM 载体为 19445 字节（低于 20480）。shell/compile/diff 检查通过。CI 控制检查首轮发现的三个旧分类／新操作文案期望已修正，五个受影响检查补跑通过；实际 guards、远端 Quality 和服务安装另列结果。

实际安装、两原件恢复、只读 F、统一业务发布和上线回读仍需各自真实结果，不能互相替代。ONLINE 九表保持 APPLIED，禁止重放迁移。真实付款不在此次验收范围。
