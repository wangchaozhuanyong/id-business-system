'use strict';

const { beforeExternalSubmit, wasSubmitted, ResultUnknownError } = require('../rpc.cjs');

const UPGRADE_DIALOG_TITLE = /确认套餐变更|Confirm (?:your )?plan change|Confirm subscription change/i;
const TARGET_LABELS = Object.freeze({ pro_5x: '100', pro_20x: '200', pro_500: '500' });
const FINAL_BUTTON_NAME = /^(?:立即支付|Pay now|Confirm and pay)$/i;
const CURRENCY_MAP = Object.freeze({ 'US$': 'USD', '$': 'USD', '₱': 'PHP', RM: 'MYR', 'S$': 'SGD', 'A$': 'AUD', 'CA$': 'CAD', 'HK$': 'HKD', '€': 'EUR', '£': 'GBP' });
const CURRENCY = '(USD|PHP|EUR|GBP|MYR|SGD|AUD|CAD|HKD|JPY|CNY|THB|IDR|US\\$|HK\\$|CA\\$|A\\$|S\\$|RM|₱|\\$|€|£)';
const DECIMAL = '((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\\.[0-9]{2})?)(?![0-9.,])';

function parseLabelledMoney(text, label, { negative = false } = {}) {
    const prefix = negative ? '-?\\s*' : '';
    const pattern = new RegExp(label + '[\\s:：]*' + prefix + CURRENCY + '\\s*' + DECIMAL, 'gi');
    const values = [...String(text || '').matchAll(pattern)].map((match) => ({
        amount: match[2].replace(/,/g, '').replace(/^0+(?=\d)/, '').replace(/^(\d+)$/, '$1.00'),
        currency: CURRENCY_MAP[match[1].toUpperCase()] || match[1].toUpperCase()
    }));
    const chile = require('./chile-money').parseLabelledChileMoney(text, label, { negative });
    if (chile) values.push(chile);
    const unique = new Map(values.map((value) => [`${value.currency}:${value.amount}`, value]));
    return unique.size === 1 ? unique.values().next().value : null;
}

function parseUpgradeQuote(text, targetPlan, expectedCurrency) {
    const tier = TARGET_LABELS[targetPlan];
    if (!tier) throw new Error('不支持该升级目标套餐');
    if (!UPGRADE_DIALOG_TITLE.test(String(text || ''))) throw new Error('未识别到套餐变更确认窗口');
    const explicitTiers = [...String(text).matchAll(/(?:ChatGPT\s+)?Pro\s+(100|200|500)(?!\d)/gi)].map((match) => match[1]);
    if (!explicitTiers.length || explicitTiers.some((observed) => observed !== tier)) {
        throw new Error('升级确认窗口的准确目标档位不匹配');
    }
    const due = parseLabelledMoney(text, '(?:今天应付(?:总额|金额)?|今日应付(?:总额|金额)?|Due today|Total due today|Amount due today)');
    const recurring = parseLabelledMoney(text, `(?:ChatGPT\\s+)?Pro\\s+${tier}(?!\\d)`);
    if (!due || !recurring) throw new Error('升级确认窗口的官网应付或周期价格不明确');
    const currency = String(expectedCurrency || '').toUpperCase();
    if (!currency || due.currency !== currency || recurring.currency !== currency) {
        throw new Error('升级确认窗口币种与本次任务不一致');
    }
    const creditPresent = /(?:^|\n)\s*(?:抵扣金额|Credit(?: amount)?)(?:\s*[:：]?\s*(?:\n|-|CLP|CL\$|PHP|USD|EUR|GBP|MYR|SGD|US\$|\$|₱)|\s*$)/im.test(text);
    const taxPresent = /(?:^|\n)\s*(?:税费|税款|Tax(?:es)?)(?:\s|:|：|\()/im.test(text);
    const credit = creditPresent ? parseLabelledMoney(text, '(?:抵扣金额|Credit(?: amount)?)', { negative: true }) : null;
    const tax = taxPresent ? parseLabelledMoney(text, '(?:税费|税款|Tax(?:es)?)(?:\\s*\\([^)]*\\))?') : null;
    if ((creditPresent && !credit) || (taxPresent && !tax) || [credit, tax].some((part) => part && part.currency !== currency)) {
        throw new Error('升级确认窗口的折抵或税费不明确');
    }
    return { targetPlan, amount: due.amount, currency, recurringAmount: recurring.amount, creditAmount: credit?.amount ?? null, taxAmount: tax?.amount ?? null, source: 'subscription_change', zeroDue: !/[1-9]/.test(due.amount) };
}

async function findUpgradeDialog(page) {
    const dialogs = page.getByRole('dialog').filter({ hasText: UPGRADE_DIALOG_TITLE });
    const count = await dialogs.count();
    if (!count) return null;
    if (count !== 1 || !(await dialogs.isVisible({ timeout: 500 }).catch(() => false))) {
        throw new Error('套餐变更确认窗口不唯一或不可见');
    }
    return dialogs;
}

function normalizedExpiry(value) {
    const match = String(value || '').match(/\b(0?[1-9]|1[0-2])\s*\/\s*(\d{2}|\d{4})\b/);
    return match ? `${match[1].padStart(2, '0')}/${match[2].slice(-2)}` : null;
}

function expectedCardBrand(number) {
    const pan = String(number || '').replace(/\s/g, '');
    if (/^4\d{12,18}$/.test(pan)) return 'visa';
    if (/^(?:5[1-5]\d{14}|2(?:2[2-9]\d|[3-6]\d{2}|7(?:[01]\d|20))\d{12})$/.test(pan)) return 'mastercard';
    if (/^3[47]\d{13}$/.test(pan)) return 'amex';
    return null;
}

function matchSavedCard(cards, cardInfo) {
    const last4 = String(cardInfo.number || '').replace(/\s/g, '').slice(-4);
    const expiry = normalizedExpiry(cardInfo.expiry);
    const brand = expectedCardBrand(cardInfo.number);
    if (!/^\d{4}$/.test(last4) || !expiry || !brand) throw new Error('获准银行卡的匹配资料不完整');
    const sameTail = cards.filter((card) => card.last4 === last4);
    // A last-four match by itself is not proof of card identity. Never trust the
    // site's default selection; require one matching brand and visible expiry.
    if (sameTail.length !== 1) throw new Error('保存卡尾号缺失或不唯一，禁止扣款');
    const card = sameTail[0];
    if (card.brand !== brand || normalizedExpiry(card.expiry) !== expiry) {
        throw new Error('保存卡品牌或有效期无法证明与获准银行卡一致，禁止扣款');
    }
    return card;
}

async function readSavedCards(dialog) {
    return dialog.evaluate((root) => {
        const visible = (node) => Boolean(node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
        return Array.from(root.querySelectorAll('[role="radio"], input[type="radio"]')).map((node, index) => {
            if (!visible(node)) return null;
            let row = node.closest('label') || node.parentElement;
            // The payment row must contain one radio only; larger shared lists
            // cannot be used as evidence for an individual payment method.
            for (let parent = row?.parentElement; row && parent && parent !== root && !/\d{4}/.test(row.innerText || ''); parent = parent.parentElement) {
                if (parent.querySelectorAll('[role="radio"], input[type="radio"]').length !== 1) break;
                row = parent;
            }
            const text = [node.getAttribute('aria-label'), row?.innerText, ...Array.from(row?.querySelectorAll('img') || []).map((img) => img.alt)].filter(Boolean).join(' ');
            const tails = [...text.matchAll(/(?:[•·*●]{2,}|ending in|尾号)\s*(\d{4})(?!\d)/gi)].map((match) => match[1]);
            const brand = /mastercard|万事达卡/i.test(text) ? 'mastercard' : /\bvisa\b/i.test(text) ? 'visa' : /american express|amex|美国运通/i.test(text) ? 'amex' : null;
            const expiry = text.match(/\b(?:0?[1-9]|1[0-2])\s*\/\s*(?:\d{4}|\d{2})\b/)?.[0] || null;
            return { index, last4: new Set(tails).size === 1 ? tails[0] : null, brand, expiry };
        }).filter(Boolean);
    });
}

function buildPaymentContext(options, cardInfo, quote) {
    const preflight = options.preflight || {};
    const accountId = preflight.confirmation?.expectedAccountId;
    const sourcePlan = preflight.sourcePlan;
    const kind = options.operation;
    const cardLast4 = String(cardInfo.number || '').replace(/\s/g, '').slice(-4);
    if (!preflight.allowed || !accountId || preflight.confirmation?.accountId !== accountId || !sourcePlan || !cardInfo.id || !['initial', 'upgrade'].includes(kind) || preflight.kind !== kind || preflight.targetPlan !== options.planType) {
        throw new Error('付款前账号、原套餐或银行卡租约核验资料缺失');
    }
    if (!['plus', ...Object.keys(TARGET_LABELS)].includes(options.planType) || !/^\d+(?:\.\d{1,2})?$/.test(quote.amount) || !/^[A-Z]{3}$/.test(quote.currency) || !/^\d{4}$/.test(cardLast4) || (quote.targetPlan && quote.targetPlan !== options.planType) || (kind === 'initial' && !/[1-9]/.test(quote.amount))) throw new Error('付款前准确套餐、金额或银行卡资料无效');
    return { kind, sourcePlan, targetPlan: options.planType, accountId, cardId: String(cardInfo.id), cardLast4, amount: quote.amount, currency: quote.currency };
}

async function completeUpgradePayment(page, cardInfo, options = {}) {
    if (wasSubmitted()) throw new ResultUnknownError();
    const originalPageUrl = page.url();
    const originalLocation = new URL(originalPageUrl);
    if (originalLocation.protocol !== 'https:' || originalLocation.hostname !== 'chatgpt.com') return { success: false, submitted: false, error: '套餐变更窗口不在已核实的官网页面', canRetryCard: false };
    const dialog = await findUpgradeDialog(page);
    if (!dialog) return { success: false, submitted: false, error: '未识别到套餐变更确认窗口', canRetryCard: false };
    try {
        const quote = parseUpgradeQuote(await dialog.innerText(), options.planType, options.expectedCurrency);
        const card = matchSavedCard(await readSavedCards(dialog), cardInfo);
        const radios = dialog.locator('[role="radio"], input[type="radio"]');
        const selected = radios.nth(card.index);
        await selected.click({ timeout: 8000 });
        if (await selected.getAttribute('aria-checked') !== 'true' && !(await selected.isChecked().catch(() => false))) {
            throw new Error('获准保存卡未确认选中，禁止扣款');
        }
        const cvcInput = dialog.locator('input[autocomplete="cc-csc"], input[name="cvc"], input[name="cardCvc"]');
        const cvcCount = await cvcInput.count();
        if (cvcCount > 1) throw new Error('保存卡安全码输入框不唯一，禁止扣款');
        if (cvcCount === 1 && await cvcInput.isVisible({ timeout: 500 })) {
            const cvc = cardInfo.cvc || await require('./mysql-store').requireCardCvc(cardInfo.id);
            if (!/^\d{3,4}$/.test(String(cvc || ''))) { const error = new Error('等待补齐本次临时安全码'); error.code = 'PENDING_CREDENTIALS'; throw error; }
            await cvcInput.fill(String(cvc));
        }
        // Selection may recalculate the quote. Use the final values and verify the
        // actual selected method again before recording the durable submit mark.
        const finalQuote = parseUpgradeQuote(await dialog.innerText(), options.planType, options.expectedCurrency);
        if (JSON.stringify(finalQuote) !== JSON.stringify(quote)) throw new Error('付款方式选择后官网报价变化，请核对后继续');
        const finalCard = matchSavedCard(await readSavedCards(dialog), cardInfo);
        if (finalCard.index !== card.index) throw new Error('保存卡列表发生变化，禁止扣款');
        const button = dialog.getByRole('button', { name: FINAL_BUTTON_NAME });
        if (await button.count() !== 1 || !(await button.isVisible()) || await button.isDisabled()) {
            throw new Error('套餐变更最终付款按钮不唯一或不可用');
        }
        if (await selected.getAttribute('aria-checked') !== 'true' && !(await selected.isChecked().catch(() => false))) throw new Error('最终保存卡选择已变化，禁止扣款');
        const paymentContext = buildPaymentContext({ ...options, operation: 'upgrade' }, cardInfo, quote);
        const paymentEvidence = { ...paymentContext, source: 'subscription_change', quoteVerified: true, verified: quote.zeroDue };
        require('../payment-limit.cjs').assertPaymentLimit(options.paymentLimit, quote);
        await beforeExternalSubmit({ provider: 'local', stage: 'upgrade_submit', paymentContext });
        await button.click({ timeout: 8000 });
        if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(1500);
        if (require('./stripe-payment').isVerifiedCheckoutOutcome(originalPageUrl, page.url())) paymentEvidence.verified = true;
        // UI errors cannot authorize a replay. The caller now queries only the
        // original authenticated account and records the exact target if proven.
        return { success: false, submitted: true, resultUnknown: true, canRetryCard: false, dueAmount: quote.amount, dueCurrency: quote.currency, paymentEvidence, upgradeQuote: quote };
    } catch (error) {
        if (['LEASE_LOST', 'PENDING_CREDENTIALS'].includes(error.code)) throw error;
        if (wasSubmitted()) throw new ResultUnknownError();
        return { success: false, submitted: false, canRetryCard: false, manualIntervention: true, error: error.message };
    }
}

async function applyPostPaymentRenewalPolicy(operation, token, email, cancel) {
    if (operation === 'upgrade') return null;
    if (operation !== 'initial' || typeof cancel !== 'function') throw new Error('未核实开通类型，禁止附加续费变更');
    return cancel(token, { email });
}

module.exports = { UPGRADE_DIALOG_TITLE, TARGET_LABELS, FINAL_BUTTON_NAME, parseLabelledMoney, parseUpgradeQuote, findUpgradeDialog, normalizedExpiry, expectedCardBrand, matchSavedCard, readSavedCards, buildPaymentContext, completeUpgradePayment, applyPostPaymentRenewalPolicy };
