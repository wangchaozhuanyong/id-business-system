# 外部邮箱更新续做记录

日期：2026-11-12。起点：本项目 `main` / `93d6006e5a3da2ccdfae3f5db6f70b537bd2a17b` 及原有未提交修改。修改前副本在 `.runtime/external-events-20261112/baseline/`；没有回退其他工作，没有提交、推送或部署。

## 已完成

- 谷歌、苹果主邮箱和微软邮箱增加只读IMAP IDLE监听，用现有查询码及微软授权方式；不增加依赖、数据库结构、环境变量或业务按钮。原Python收信实现及其他任务补齐的运行镜像保持原状。
- 原自动查询选项接入通知流：无新邮件不查信，通知后调用原查询；相同结果不重建DOM。初始化、断线重连、从后台恢复时核对一次快照。保留手动查询、返回封数及立即刷新。
- 同邮箱多个窗口共用监听；通知不包含邮件、查询码、银行卡或Session。不同邮箱通知隔离，查询码改绑/停用/到期后关闭旧订阅。
- 连续通知在读取期间合并，旧查询码的迟到回执不能写入新查询结果；保留已展开邮件和筛选。网络失败最多重连3次，不支持IDLE或授权变化直接提示；旧结果保留。
- 实测发现查询表单从插件页移入抽屉后，原宿主关闭监听无法清理新连接，已接入现有 `onMailboxOperationClose` 流程。关闭、隐藏、切页和身份清理均停止通知。
- `ENGINEERING_RULES.md` 与统一审计报告已同步当前状态；通知专项纳入 `test/check-ui-contract.mjs`，供后续开发持续检查。

## 文件

新增：`server/tools/mailbox-idle.mjs`、`server/tools/mailbox-updates.mjs`、`test/mailbox-updates.test.mjs`、`test/mailbox-updates.browser.mjs`。

接入：`server/tools/mailbox-pool.mjs`、`mailbox-microsoft.mjs`、`server/preview.mjs`、`frontend/local-data.js`、`frontend/operations-prototype.js`、`test/check-ui-contract.mjs`。保留这些文件已有的长邮件验证码、邮箱管理和上轮搜索/刷新修复。

## 实际验证

证据目录：`.runtime/external-events-20261112/`。

| 检查 | 结果 | 回执 |
| --- | --- | --- |
| 前端规则、邮箱服务/协议、原邮件正文、候选邮箱、读取缓存与推送纯逻辑 | 224/224通过 | `unit-final.log` |
| 版本推送、搜索、邮箱抽屉、页面生命周期与通知浏览器组合 | 13/13通过，含桌面/手机、深浅主题子场景 | `browser-regression-final.log` |
| 最终通知专项，追加有界断线重连场景 | 5/5通过；虚拟静置120秒不查信、同结果节点不重建、重复事件、合并补读、隐藏恢复、关闭、查询码切换及身份清理 | `browser-notifications-final.log` |
| 邮箱页面/查询抽屉布局 | 8宽度×2主题及4状态，共64场景通过；员工边界通过 | `mailbox-layout.log`、`layout/mailbox-query-layout.json` |
| 语法与范围差异 | 相关JS/MJS语法、差异空白检查通过 | `verification.json` |

浏览器使用实际项目静态代码，全部业务和外部网络均拦截。协议测试使用合成TLS替身，处理器测试直接调用真实函数，不启动整站或数据库。截图 `layout/query-1440-light.png` 和 `layout/query-390-dark.png` 已实际查看，页面结构和操作保留。原版充值工作树状态为空。

早期失败记录保留：前两次通知浏览器测试定位了关闭抽屉后监听未停止；修复后通过。第一次组合回归漏传已有Playwright模块路径，3项在启动前失败；补齐该环境参数后的最终组合全部通过。未删除失败记录、未跳过测试，也没有运行其他数据库测试。

## 当前状态及余项

普通邮箱更新代码与本地验证完成，尚未连接真实邮箱做IDLE验收、未上线。项目既有3项隔离SQLite并发测试已经在上轮获准并通过，本轮没有重复运行或扩大许可。

充值全局事件发现仍保留60秒扫描；苹果隐藏邮箱仍保留默认关闭的30秒自动查询。这两个来源需要独立的外部事件出口。已形成具体接入与隔离验收清单 `EXTERNAL_EVENT_ACCESS_20261112.md`，正在请求下一阶段外围开发/依赖/远端隔离验证的授权；生产配置和其他项目修改不在本轮自动执行范围。不能将本轮结果记作“全站所有来源已经无轮询”。
