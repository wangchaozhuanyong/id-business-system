'use strict';

/**
 * Payment Retry with Card Rotation Module
 *
 * 支付逻辑：
 * 1. 获取当前地区和账单配置
 * 2. 选取免税地址
 * 3. 从卡池预留卡片，拒付时自动换卡（最多 PAYMENT_MAX_CARD_ATTEMPTS 次）
 * 4. 成功 → 绑定地址/姓名到卡片、标记地址已绑定
 */

const store = require('./mysql-store');
const { ResultUnknownError } = require('../rpc.cjs');
const { completeStripeCardPayment, readCheckoutDueAmount, estimateTaxFreeAmount } = require('./stripe-payment');
const { pickBillingAddressForCheckout, markAddressBound } = require('./tax-free-address');
const { getRegionConfig } = require('./region-config');

const MAX_CARD_ATTEMPTS = Number(process.env.PAYMENT_MAX_CARD_ATTEMPTS) || 3;
const MAX_AUTOMATION_ATTEMPTS = MAX_CARD_ATTEMPTS;
const isZeroAmount = (value) => typeof value === 'string' && /^0+(?:\.0{1,2})?$/.test(value);

function isPaymentDeclined(errorMsg) {
    const text = String(errorMsg || '');
    return [
        /\b(?:card_declined|insufficient_funds|expired_card|incorrect_cvc|lost_card|stolen_card|do_not_honor)\b/i,
        /(?:your )?card (?:was |has been |is )?declined/i,
        /(?:payment|transaction) (?:was )?declined/i,
        /^declined$/i,
        /insufficient funds|do not hono[u]?r|expired card/i,
        /银行卡(?:被拒绝|被拒|拒付)|余额不足/
    ].some((pattern) => pattern.test(text));
}

/**
 * 解析应写入账单的实际扣款金额（优先免税后应付）
 */
async function resolveBilledAmountForRecord(page, paymentResult, preTaxAmount, currency) {
    const evidence = paymentResult?.paymentEvidence;
    if (evidence?.verified === true && /^\d+(?:\.\d{1,4})?$/.test(String(evidence.amount)) && /^[A-Z]{3}$/.test(evidence.currency)) {
        return {
            amount: evidence.amount,
            currency: evidence.currency,
            amountSource: 'checkout'
        };
    }
    // A quote or a post-submit page amount is not an actual payment receipt.
    return { amount: null, currency, amountSource: 'unknown' };
}

/**
 * 执行支付；拒付时在同一会话内换卡重试
 * @param {import('playwright').Page} page - Playwright Page 实例
 * @param {object} options - 支付选项
 * @returns {Promise<{ success: boolean, error?: string, cardLast4?: string, manualIntervention?: boolean, screenshots?: string[] }>}
 */
async function executePaymentWithRetry(page, options) {
    const { planType, cdkCode, email, onProgress, stripeSessionId, confirmPayment, operation, preflight, expectedCurrency, checkoutKind, paymentLimit } = options || {};
    const maxCardAttempts = preflight ? 1 : MAX_CARD_ATTEMPTS;
    if (preflight && typeof confirmPayment !== 'function') return { success: false, submitted: false, error: '缺少原账号准确套餐核验，未提交付款' };

    const progress = (msg) => {
        console.log(`[PaymentRetry] ${msg}`);
        if (typeof onProgress === 'function') {
            try { onProgress(msg); } catch (_) { /* ignore callback errors */ }
        }
    };

    const regionOverride = String(process.env.PAYMENT_REGION_OVERRIDE || '').trim().toUpperCase();
    const region = regionOverride || await store.getPaymentRegion();
    const regionConfig = getRegionConfig(region);
    if (!regionConfig) {
        return { success: false, error: '不支持的支付地区配置' };
    }
    const { currency } = regionConfig;
    progress(`支付地区: ${region}, 币种: ${currency}`);

    let address = null;


    const ownerKey = require('../rpc.cjs').scope().taskId;

    const screenshots = [];
    const declinedLast4s = [];
    const attemptedCardIds = new Set();
    let lastError = '';
    let lastCardLast4 = '';
    let billingHolderName = '';

    let billedAmount = null;
    let billedCurrency = currency;
    try {
        const due = await readCheckoutDueAmount(page);
        if (due?.amount) {
            billedAmount = due.amount;
            if (due.currency) billedCurrency = due.currency;
            progress(`Checkout 应付金额: ${billedCurrency} ${billedAmount}`);
        }
    } catch (_) { /* ignore */ }

    progress(`开始支付（最多尝试 ${maxCardAttempts} 张卡）...`);

    for (let cardAttempt = 1; cardAttempt <= maxCardAttempts; cardAttempt += 1) {
        const card = await store.reserveCard(ownerKey, [...attemptedCardIds], { requireCvc: operation !== 'upgrade' });
        if (!card) {
            progress(cardAttempt === 1 ? '卡池无可用卡，终止支付' : `卡池已无更多可用卡（已拒 ${declinedLast4s.length} 张）`);
            if (cardAttempt === 1) {
                if (preflight) return { success: false, submitted: false, error: '卡池资产枯竭', cardPoolEmpty: true };
                await store.createBillingRecord({
                    card_last4: '----',
                    amount: billedAmount,
                    currency: billedCurrency,
                    plan_type: planType || 'plus',
                    cdk_code: cdkCode,
                    email,
                    stripe_session_id: stripeSessionId || null,
                    status: 'failed',
                    error_code: 'card_pool_exhausted',
                    error_message: '卡池资产枯竭'
                });
                return { success: false, error: '卡池资产枯竭', cardPoolEmpty: true };
            }
            break;
        }

        const cardInfo = {
            id: card.id,
            number: card.card_number,
            expiry: card.card_expiry,
            cvc: card.card_cvc,
            holder: card.card_holder
        };
        const cardLast4 = String(card.card_number || '').slice(-4);
        lastCardLast4 = cardLast4;
        attemptedCardIds.add(card.id);
        progress(`已预留卡片 #${cardAttempt}: ...${cardLast4}`);

        let cardHandled = false;

        try {
            if (operation === 'upgrade' && checkoutKind === 'checkout' && !cardInfo.cvc) cardInfo.cvc = await store.requireCardCvc(card.id);
            if (operation !== 'upgrade' || checkoutKind === 'checkout') {
                const lastUsedId = await store.getAppConfigValue('last_used_address_id', null);
                address = card.billing_address || await pickBillingAddressForCheckout(lastUsedId || null, card.address_id);
                billingHolderName = card.card_holder || [address.firstName, address.lastName].filter(Boolean).join(' ');
                progress('已读取现有账单地址，未生成随机资料');
            }
            let paymentResult;
            try {
                paymentResult = await completeStripeCardPayment(page, cardInfo, address, {
                    cardAttempt,
                    holderName: billingHolderName,
                    planType, operation, preflight, expectedCurrency, checkoutKind, paymentLimit
                });
            } catch (error) {
                if (error.code !== 'RESULT_UNKNOWN') throw error;
                paymentResult = { success: false, resultUnknown: true };
            }
            // Authenticate the original account before any success bookkeeping or
            // handling an ambiguous post-submit page. Never submit a second payment
            // just because the first page failed to refresh after charging.
            let confirmation = null;
            if (typeof confirmPayment === 'function' && (
                paymentResult.success || paymentResult.resultUnknown || paymentResult.declined ||
                require('../rpc.cjs').wasSubmitted()
            )) {
                try {
                    confirmation = await confirmPayment({ deadlineAt: performance.now() + 45000 });
                } catch (error) {
                    if (error.code === 'LEASE_LOST') throw error;
                    confirmation = { verified: false, querySucceeded: false, queryErrorCode: error.code || 'NETWORK_UNAVAILABLE' };
                }
                if (confirmation?.verified) {
                    const actualPaymentProven = !preflight || paymentResult.paymentEvidence?.verified === true;
                    paymentResult = { ...paymentResult, success: actualPaymentProven, resultUnknown: !actualPaymentProven, confirmation, subscriptionChangedVerified: operation === 'upgrade' };
                } else if (paymentResult.success || (confirmation?.querySucceeded &&
                    confirmation.expectedAccountId && confirmation.accountId !== confirmation.expectedAccountId)) {
                    paymentResult = { ...paymentResult, success: false, resultUnknown: true, confirmation };
                }
            }


            if (paymentResult.holderName) {
                billingHolderName = paymentResult.holderName;
            }

            if (paymentResult.success) {
                if (preflight && !paymentResult.paymentEvidence?.verified) throw new ResultUnknownError('付款证据缺失，等待原单核对');
                const zeroDue = operation === 'upgrade' && isZeroAmount(paymentResult.dueAmount);
                if (zeroDue) {
                    cardHandled = true;
                    return { success: true, confirmedPaid: false, subscriptionChangedVerified: true, cardLast4, screenshots, confirmation, paymentEvidence: paymentResult.paymentEvidence, upgradeQuote: paymentResult.upgradeQuote };
                }
                require('../rpc.cjs').recordKnownOutcome('success');
                try {
                    const resolved = await resolveBilledAmountForRecord(
                        page,
                        paymentResult,
                        billedAmount,
                        billedCurrency
                    );
                    billedAmount = resolved.amount;
                    billedCurrency = resolved.currency;
                    progress(`实际扣款金额（免税后）: ${billedCurrency} ${billedAmount}`);

                    const holderName = paymentResult.holderName || card.card_holder || billingHolderName || '';
                    if (operation !== 'upgrade') {
                        await store.bindCardPaymentProfile(card.id, { holderName, address });
                        if (address?.id) await markAddressBound(address.id, card.id);
                    }
                    const usageResult = await store.recordCardUsage(card.id, { paymentEvidence: paymentResult.paymentEvidence });
                    await store.createBillingRecord({
                        card_number: card.card_number,
                        card_last4: cardLast4,
                        amount: billedAmount,
                        currency: billedCurrency,
                        plan_type: planType || 'plus',
                        cdk_code: cdkCode,
                        email,
                        stripe_session_id: stripeSessionId || null,
                        status: 'success', amountSource: resolved.amountSource || 'checkout', paymentEvidence: paymentResult.paymentEvidence
                    });
                    cardHandled = true;
                    progress(operation === 'upgrade' ? `套餐升级成功，实际付款卡片: ...${cardLast4}` : `支付成功！卡片: ...${cardLast4}，姓名: ${holderName}，地址: ${address.line1}, ${address.city}`);
                    if (usageResult.exhausted) {
                        progress(`卡 ...${cardLast4} 已达到订阅绑定上限，已标记为订阅额度用尽`);
                    }
                    if (paymentResult.screenshot) {
                        screenshots.push(paymentResult.screenshot);
                        progress(`SUCCESS_SCREENSHOT: ${paymentResult.screenshot}`);
                    }
                    return { success: true, confirmedPaid: true, subscriptionChangedVerified: operation === 'upgrade', cardLast4, holderName, screenshots, confirmation, paymentEvidence: paymentResult.paymentEvidence, upgradeQuote: paymentResult.upgradeQuote };
                } catch (error) {
                    if (preflight) return { ...paymentResult, success: false, confirmedPaid: true, resultUnknown: true, localAccountingPending: true, cardLast4, confirmation, screenshots, error: '付款已证实，本地记账待原单核对，禁止重复付款' };
                    throw error;
                }
            }

            if (paymentResult.resultUnknown) {
                if (preflight) return { ...paymentResult, success: false, confirmedPaid: paymentResult.paymentEvidence?.verified === true, cardLast4, confirmation,
                    error: paymentResult.paymentEvidence?.verified === true ? '付款已确认，等待准确目标套餐生效或完成入账，禁止重复付款'
                        : confirmation?.querySucceeded === false ? '订阅查询未成功，原单付款结果待核对，禁止重复付款'
                            : confirmation?.verified ? '套餐已变更，实际扣款凭证仍待核对，禁止重复付款' : '原单结果仍待核对，禁止重复付款' };
                throw new ResultUnknownError();
            }
            lastError = paymentResult.error || '支付失败';
            if (paymentResult.screenshot) {
                screenshots.push(paymentResult.screenshot);
                progress(`FAILURE_SCREENSHOT: ${paymentResult.screenshot}`);
            }

            if (!require('../rpc.cjs').wasSubmitted() &&
                ['CHECKOUT_RECOVERY_INVALID', 'CHECKOUT_RECOVERY_UNSUPPORTED'].includes(paymentResult.errorCode)) {
                return {
                    success: false,
                    submitted: false,
                    canRetryCard: false,
                    errorCode: paymentResult.errorCode,
                    error: paymentResult.errorCode === 'CHECKOUT_RECOVERY_INVALID'
                        ? '原结账单来源或付款绑定无效，未提交付款'
                        : '原结账单来源或格式尚未核实支持，未提交付款',
                    cardLast4,
                    screenshots
                };
            }

            const declined = operation !== 'upgrade' && paymentResult.declined === true && isPaymentDeclined(lastError);
            if (require('../rpc.cjs').wasSubmitted() && !declined) throw new ResultUnknownError();
            if (declined) {
                await store.createBillingRecord({
                    card_number: card.card_number,
                    card_last4: cardLast4,
                    amount: billedAmount,
                    currency: billedCurrency,
                    plan_type: planType || 'plus',
                    cdk_code: cdkCode,
                    email,
                    stripe_session_id: stripeSessionId || null,
                    status: 'failed',
                    error_code: 'card_declined',
                    error_message: lastError
                });
                const declineResult = await store.recordCardDecline(card.id);
                progress(
                    declineResult.exhausted
                        ? `Stripe 拒绝支付，卡 ...${cardLast4} 已达到拒付上限并标记为已报废`
                        : `Stripe 拒绝支付，卡 ...${cardLast4} 拒付计数 ${declineResult.declineCount}`
                );
                declinedLast4s.push(cardLast4);

                if (cardAttempt < maxCardAttempts && paymentResult.canRetryCard !== false) {
                    progress(`卡 ...${cardLast4} 被拒，换上下一张卡 (${cardAttempt}/${maxCardAttempts})`);
                    continue;
                }

                const summary = declinedLast4s.length > 1
                    ? `${declinedLast4s.length} 张卡均被拒 (...${declinedLast4s.join(', ...')})`
                    : `银行卡被拒绝: ${lastError}`;
                return {
                    success: false,
                    error: summary,
                    cardLast4: lastCardLast4,
                    manualIntervention: true,
                    screenshots,
                    cardsDeclined: declinedLast4s.length
                    , definitiveFailure: true
                };
            }

            if (paymentResult.captchaRequired) {
                progress('检测到 Cloudflare/hCaptcha 人机验证，自动化无法可靠通过');
            }

            await store.createBillingRecord({
                card_number: card.card_number,
                card_last4: cardLast4,
                amount: billedAmount,
                currency: billedCurrency,
                plan_type: planType || 'plus',
                cdk_code: cdkCode,
                email,
                stripe_session_id: stripeSessionId || null,
                status: 'failed',
                error_code: 'form_validation_failed',
                error_message: lastError
            });

            progress('本次自动充值未完成');
            return {
                success: false,
                error: lastError,
                ...(paymentResult.errorCode ? { errorCode: paymentResult.errorCode } : {}),
                ...(paymentResult.formDiagnostics ? { formDiagnostics: paymentResult.formDiagnostics } : {}),
                cardLast4,
                manualIntervention: true,
                screenshots
            };
        } finally {
            cardInfo.cvc = '';
            card.card_cvc = '';
            card.cvv = '';
            if (card?.id && !cardHandled && !require('../rpc.cjs').wasSubmitted() && !require('../rpc.cjs').wasPaymentConfirmed()) {
                await store.releaseCard(card.id).catch(() => { });
            }
        }
    }

    const summary = declinedLast4s.length
        ? `${declinedLast4s.length} 张卡均被拒 (...${declinedLast4s.join(', ...')})`
        : (lastError || '支付失败');
    return {
        success: false,
        error: summary,
        cardLast4: lastCardLast4,
        manualIntervention: true,
        screenshots,
        cardsDeclined: declinedLast4s.length
    };
}

module.exports = {
    executePaymentWithRetry,
    isPaymentDeclined,
    MAX_AUTOMATION_ATTEMPTS,
    MAX_CARD_ATTEMPTS
};
