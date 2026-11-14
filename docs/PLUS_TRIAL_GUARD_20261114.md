# Plus / Pro 0 元试用处理规则（2026-11-14）

## 规则

- **Plus**：定价页出现 0 元试用（`Try Plus free for N month`、`Claim free offer` 或 0 元月费）时，停止开通并提示「该账号为 Plus 0 元试用资格账号，不能继续充值 Plus，请转人工核对」。任务转待人工核对，不再进入支付流程。
- **Pro**：出现 0 元试用时按正常开通继续，允许 0 元月费与 `Claim free offer` 按钮，结账页档位核对在 0 元时只核对套餐与档位，不核对金额。

## 现场依据

线上任务 `ddapoas9w0fl`（PH/PHP，`missals.glosses-7v@icloud.com`）实测：

1. `POST /backend-api/payments/checkout` 返回 400 `Our systems have detected unusual activity`（requestId `a5a5eda8ad39b92e-CEB`）。
2. 回退定价页成功后，PH 地区展示 `Try Plus free for 1 month`，Plus 卡片按钮为 `Claim free offer`。
3. `pricing-checkout.js` 的 `PLAN_UPGRADE_PATTERNS.plus` 与 `findPlusStartNowButton()` 都不匹配该文案，最终抛「未找到 plus 套餐的升级按钮」。
4. 证据：容器内 `pricing-checkout.js` 中 `Claim` 出现 0 次；失败截图 `debug_screenshots/checkout_debug/error_1794658423024.png`。

## 实现

新增第 5 份精确补丁 `modules/recharge/codexdaichong/plus-trial/`，只改 `pricing-checkout.js`：

| 位置 | 内容 |
| --- | --- |
| 常量区 | `PLUS_FREE_TRIAL_BANNER`、`FREE_TRIAL_CLAIM_BUTTON`、`FREE_TRIAL_ZERO_PRICE`、`PRO_ACTION_PATTERN`、`PLUS_TRIAL_REFUSAL` |
| `findPlusFreeTrialOffer(page)` | 三层识别：试用横幅、Plus 卡片内的 Claim 按钮、卡片 0 元月费 |
| `clickPlanUpgrade()` Plus 分支 | 点击升级前拦下，抛 `PLUS_FREE_TRIAL_ACCOUNT` |
| `readMoneyCents()` / `readProMonthlyAmount()` | 新增 `allowZero`，正常付费路径仍拒绝 0 元 |
| `selectAndOpenProTier()` | Pro 读不到正价时按 0 元重试并继续，开通按钮改用 `PRO_ACTION_PATTERN`（含 `Claim free offer`） |
| `verifyProPricingCheckout()` | `amount === 0` 时只核对套餐与档位后返回 |

`stripe-payment.js`、`index.js`、`session-auth.js`、`payment-retry.js`、`mysql-store.js`、`server.js` 均不修改；0 元结账在税区与应付金额读取上沿用原逻辑（`readCheckoutDueAmount` 只接受正数，0 元时既有分支直接跳过税区核对）。

## 哈希链

- 补丁基准（选路补丁后的 `pricing-checkout.js`）：`17d5982142eec44b1d9aa56adff5db50617df9fe`
- 补丁结果：`1daed6e9ef154ffd7dc26e6a2575fac7c1a4d577`
- 补丁 SHA-256：`5744993126bf1bc508a4d8002978e1b63fe2b80d23203ead12078c9c8fc3f726`
- 全量核验仍是 203 个追踪文件；`originalFiles` 保持 198（`pricing-checkout.js` 已在选路补丁名单内）。

`prepare.mjs` 增加 `approvedPlusTrial()`、应用步骤与链式基准校验，`verifyCodexdaichongSource()` 的期望值改为「选路 → 归还 → 供应商退役 → 银行卡套餐 → 0 元试用」串联。

## 验收

- `node --test modules/recharge/codexdaichong/*.test.mjs`：通过（含新增 `plus-trial.test.mjs` 7 项：清单一致、基准哈希、`git apply` 结果哈希、Plus 拦截顺序与文案、Pro 放行分支、准备脚本接线、清单篡改拒绝）。
- `test/codexdaichong-upstream-parity.test.mjs` 已同步为五份补丁并新增 `plusTrialFiles` 断言；本机缺少 `.upstream/codexdaichong`，该全量测试未在本机执行。
- `test/check-ui-contract.mjs` 本机因缺少 `playwright` 依赖无法执行；本次未改前端。

## 待现场确认

Pro 的 0 元试用结账页是否仍要求填写银行卡（Stripe 0 元是否需要 payment method）。若结账页不出现卡号表单，`Stripe Step 0～2` 的填卡步骤会超时，需要另行决定是否对 0 元任务跳过填卡。验证方式：以 Pro 套餐跑一次 `CHECKOUT_DEBUG_ONLY=1` 调试任务，停在支付表单截图，不填卡不付款。

## 回滚

删除 `modules/recharge/codexdaichong/plus-trial/`，并还原 `prepare.mjs` 中的 `plusTrialPatch` / `approvedPlusTrial` / 应用步骤 / 链式期望值 / 返回字段五处改动，随后重新 prepare 并核验。

## 未做（需另行授权）

提交、推送、镜像构建、native 容器切换、线上发布与真实付款验证。
