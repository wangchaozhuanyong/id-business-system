# GPT／Claude 订单设置隔离

2026-11-08。状态：代码完成、本地验证完成；未提交、推送、部署或修改线上资料。

## 用户可见行为

- GPT 和 Claude 录单的“代付”标题右侧显示“币种设置”；“售卖”标题右侧显示“币种设置”和“套餐售价设置”。按钮按现有共享样式排列，窄屏自然换行。
- GPT、Claude 各自维护币种名称和三位代码，支持新增、编辑、移除。Claude Pro／Max 共用 Claude 币种清单，套餐价格仍分别保存到对应套餐。
- 设置及未保存草稿按产品隔离。保存 Claude 的币种和售价不会覆盖 GPT，反向同样成立。旧版本提交先提示重新读取，不覆盖另一页面刚保存的设置。
- 设置抽屉关闭后恢复原录单内容；编辑原单时恢复原编辑抽屉。移除币种不改动历史订单的币种、金额和汇率快照；历史值会标注“已移出选项”。
- 套餐售价支持当前产品的可选币种。新订单切换套餐、售卖币种自动带入已配置售价；手动填写金额和历史订单继续沿用现有保护规则。
- Apple 内购代付仍固定美元。新币种没有有效汇率时保持待核算，可以通过现有手工汇率快照入口登记；本次不扩展汇率采集器的币种配置或外部支付行为。

## 本轮文件

- `frontend/commerce-prototype.js`：产品币种配置、独立草稿、设置抽屉、售价入口和原表单恢复。
- `frontend/prototype.css`：共享财务分组标题、右侧按钮及响应式布局。
- `server/order-currency-settings.mjs`：币种清单、产品分组格式校验与部分设置保存保留规则。
- `server/local-business.mjs`：配置校验、既有设置保存接入及审计动作；原币付款证据允许有效的三位代码。
- `server/order-policy.mjs`：套餐价格允许新增币种，金额精度规则不变。
- `modules/finance/accounting.mjs`：新增币种纳入必需汇率检查及原有精确核算，缺少汇率不生成有效核算结果。
- `test/order-currency-settings.test.mjs`、`test/order-product-settings.browser.mjs`：格式、隔离、原币核算和真实界面交互回归。

修改位于前一轮的隔离工作区，基线 HEAD `43aed364f063c8e1572f72a13c99119edfa5d2ac`。客户邮箱匹配隔离及租户归属未提交修改均保留，其他工作区未修改。

## 数据与兼容

沿用 `GET／PUT /api/local/settings`，无新增 HTTP 接口、表、数据库列或迁移。

设置 JSON 新增 `orderCurrenciesByProduct.GPT` 和 `orderCurrenciesByProduct.Claude`；每项含 `code`、`name`。历史 `orderCurrencies` 清单作为尚未独立配置产品的初始选择来源，未设置时使用原有默认币种。其他模块保存设置时保留两份配置，部分产品写入也保留另一产品。

套餐价继续使用已有 `orderPrices.GPT`、`orderPrices['Claude Pro']`、`orderPrices['Claude Max']`。不回填或重写历史订单。

## 实际检查

- 修改 JavaScript 的 `node --check` 和 `git diff --check` 通过。
- 最后一次定向检查 40 项通过：前端订单列／资料溯源、订单归属、租户归属、币种设置与财务核算。先前已执行且相关源码未变的自动汇率 5 项检查通过；其中 HTTP 契约测试只使用临时回环接口和虚构内存对象，没有数据库。
- 四份离线浏览器脚本通过（Node 统计 10 个测试，含子测试）：本轮产品设置、订单归属、租户归属、客户历史邮箱隔离。
- `test/shared-layout.browser.mjs` 以 `ID_LAYOUT_QA_OFFLINE=1` 执行通过（9 个测试，含子测试）。覆盖共享标题说明、左侧标签、订单栏对齐及现有布局变体。
- 本轮产品设置回归覆盖：币种增删、独立草稿、保存失败重试、旧版本冲突、Claude Pro／Max 售价带入、GPT 价格不变、编辑历史订单移除币种后保留原值和原金额、未写入订单数据。
- 两产品 1440／1024／390／320px、深浅主题的标题文字与按钮几何、视口边界检查通过。桌面及手机截图已经实际查看，位于项目 `.runtime/order-product-settings-20261108/claude-1440-light.png` 和 `claude-390-light.png`，均使用虚构资料。

运行浏览器检查需将 `ID_RECHARGE_QA_PLAYWRIGHT` 指向已有 Playwright 模块；截图可通过 `ID_ORDER_SETTINGS_SCREENSHOTS=1` 输出到上述项目目录。

本项目为原生 JavaScript 独立版，未运行父项目 Vue 专用检查，也没有本轮 JavaScript 专用 build／lint 脚本。没有启动整套网站、Docker 或数据库；真实数据库持久化及线上验收未执行，后续发布仍需用户明确授权。
