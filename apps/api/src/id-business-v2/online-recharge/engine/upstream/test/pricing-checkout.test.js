'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');
const {
    PLAN_UPGRADE_TEST_IDS,
    PRO_VARIANTS,
    getUniqueVisiblePlanButton,
    isPricingPlanSelectorVisible,
    resolvePlanUpgradeTestId,
    selectProVariantOnCheckoutPage,
    selectProVariantOnPricingPage
} = require('../pricing-checkout');

const createPage = ({ count, visible }) => ({
    getByTestId: (testId) => ({
        count: async () => count,
        isVisible: async () => visible,
        testId
    })
});

const createPricingReadinessPage = (visibleTestIds) => ({
    getByTestId: (testId) => ({
        count: async () => (visibleTestIds.includes(testId) ? 1 : 0),
        isVisible: async () => visibleTestIds.includes(testId)
    })
});

const createProPricingPage = ({
    tier = '20x', groupCount = 1, groupName = 'Pro usage', cardCount = 1,
    cardVisible = true, radioCount = 1, radioVisible = true, selectedAfterClick = true,
    native = false, radioInGroup = true, allRadioCount = radioCount,
    hiddenGroupCount = groupCount, hiddenRadioCount = allRadioCount,
    ctaCount = 1, ctaVisible = true, ctaLabel = 'Upgrade to Pro'
} = {}) => {
    const missing = { count: async () => 0 };
    const diagnostics = [];
    const calls = { globalRadio: 0, clicked: 0 };
    const radio = {
        selected: false,
        count: async () => radioCount,
        isVisible: async () => radioVisible,
        click: async () => { calls.clicked++; radio.selected = selectedAfterClick; },
        getAttribute: async (name) => name !== 'aria-checked' || native ? null : radio.selected ? 'true' : 'false',
        isChecked: async () => radio.selected
    };
    const findRadio = (role, options) => role !== 'radio' ? missing
        : !options?.name ? { count: async () => options?.includeHidden ? hiddenRadioCount : allRadioCount }
            : options.name === tier ? radio : missing;
    const cta = { count: async () => ctaCount, isVisible: async () => ctaVisible };
    const group = {
        count: async () => groupCount,
        getByRole: (role, options) => radioInGroup ? findRadio(role, options) : missing
    };
    const card = {
        count: async () => cardCount,
        isVisible: async () => cardVisible,
        getByTestId: () => missing,
        getByRole: (role, options) => {
            if (role === 'button') return options.name.test(ctaLabel) ? cta : missing;
            if (role !== 'radiogroup') return findRadio(role, options);
            if (options?.includeHidden) return { count: async () => hiddenGroupCount };
            return !options?.name || options.name.test(groupName) ? group : missing;
        }
    };
    return {
        page: {
            getByTestId: (testId) => testId === 'pro-pricing-modal-column-top-half' ? card : missing,
            getByRole: () => { calls.globalRadio++; throw new Error('禁止全页选择档位'); },
            evaluate: async (callback) => {
                diagnostics.push(callback.toString());
                return [[{ role: 'radio', tag: 'input', testid: null, 'aria-label': 'private@example.invalid', label: '500', checked: false }]];
            },
            waitForTimeout: async () => {}
        },
        radio, calls, diagnostics, cta
    };
};

const createProCheckoutPage = ({ count = 1, visible = true } = {}) => {
    const option = {
        selected: false,
        count: async () => count,
        isVisible: async () => visible,
        click: async () => { option.selected = true; },
        getAttribute: async (name) => ({
            role: 'radio',
            value: 'chatgptpro',
            'aria-checked': option.selected ? 'true' : 'false',
            'data-state': option.selected ? 'checked' : 'unchecked'
        })[name]
    };
    return {
        page: {
            locator: () => option,
            getByRole: () => ({ count: async () => 0 }),
            waitForTimeout: async () => {}
        },
        option
    };
};

const createLegacyProPricingPage = ({ tier = '20x', groups = 1, ctas = 1 } = {}) => {
    const missing = { count: async () => 0 };
    let checked = false;
    const radio = {
        count: async () => 1, isVisible: async () => true,
        click: async () => { checked = true; },
        getAttribute: async () => String(checked)
    };
    const group = {
        count: async () => groups, isVisible: async () => true,
        getByRole: (role, options) => role === 'radio'
            ? options?.name === tier ? radio : options?.name ? missing : { count: async () => 1 }
            : missing
    };
    const cta = { count: async () => ctas, isVisible: async () => true };
    return {
        page: {
            getByTestId: (id) => id === 'select-plan-button-pro-upgrade' ? cta : missing,
            getByRole: (role, options) => {
                if (role === 'radio') throw new Error('禁止全页选择档位');
                return role === 'group' && options?.name?.test('Pro plan') ? group : missing;
            },
            evaluate: async () => [], waitForTimeout: async () => {}
        },
        selected: () => checked
    };
};

const createPricingPageOpening = ({ switchFails = false } = {}) => {
    const source = fs.readFileSync(path.join(__dirname, '../pricing-checkout.js'), 'utf8');
    const start = source.indexOf('async function waitForPricingPage(');
    const end = source.indexOf('\n/**', start);
    const calls = [];
    let businessSelected = true;
    const page = {
        goto: async () => { calls.push('navigate'); },
        waitForLoadState: async () => {},
        waitForTimeout: async () => {},
        url: () => 'https://chatgpt.com/#pricing'
    };
    const wait = runInNewContext(source.slice(start, end) + '\nwaitForPricingPage;', {
        PRICING_URL: 'https://chatgpt.com/#pricing',
        PRICING_PAGE_INITIAL_WAIT_MS: 0,
        clearHumanVerification: async () => {},
        assertChatGptLoggedIn: async () => { calls.push('authenticated'); },
        switchToPersonalPlans: async () => {
            calls.push('personal');
            if (switchFails) throw new Error('定价页停留在 Business 套餐，未能切换到 Personal');
            businessSelected = false;
        },
        waitForPricingPlanSelector: async () => {
            calls.push('selectors');
            expect(businessSelected).toBe(false);
        },
        console: { log() {} }
    });
    return { page, wait, calls };
};

describe('pricing checkout plan button', () => {
    it('uses the verified test ids for Plus and Pro', () => {
        expect(PLAN_UPGRADE_TEST_IDS).toEqual({
            plus: 'select-plan-button-plus-upgrade',
            pro_5x: 'select-plan-button-pro-upgrade',
            pro_20x: 'select-plan-button-pro-upgrade',
            pro_500: 'select-plan-button-pro-upgrade'
        });
    });

    it('maps each Pro CDK plan to its verified checkout option', () => {
        expect(PRO_VARIANTS).toEqual({
            pro_5x: { checkoutValue: 'chatgptprolite', pricingRadioLabel: '5x', pricingTierLabel: '100' },
            pro_20x: { checkoutValue: 'chatgptpro', pricingRadioLabel: '20x', pricingTierLabel: '200' },
            pro_500: { checkoutValue: 'chatgptpromax', pricingRadioLabel: null, pricingTierLabel: '500' }
        });
    });

    it('rejects unsupported plans instead of falling back to another button', () => {
        expect(() => resolvePlanUpgradeTestId('go')).toThrow('不支持 UI 定价页套餐: go');
    });

    it('rejects a missing or duplicate target button', async () => {
        await expect(getUniqueVisiblePlanButton(createPage({ count: 0, visible: false }), 'plus'))
            .rejects
            .toThrow('定价页套餐按钮数量异常: plus / select-plan-button-plus-upgrade / 0');
        await expect(getUniqueVisiblePlanButton(createPage({ count: 2, visible: true }), 'pro_5x'))
            .rejects
            .toThrow('定价页套餐按钮数量异常: pro_5x / select-plan-button-pro-upgrade / 2');
    });

    it('rejects an invisible target button', async () => {
        await expect(getUniqueVisiblePlanButton(createPage({ count: 1, visible: false }), 'pro_20x'))
            .rejects
            .toThrow('定价页套餐按钮不可见: pro_20x / select-plan-button-pro-upgrade');
    });

    it('requires the requested plan button before treating the pricing page as ready', async () => {
        const proOnly = createPricingReadinessPage(['select-plan-button-pro-upgrade']);

        await expect(isPricingPlanSelectorVisible(proOnly, 'pro_20x')).resolves.toBe(true);
        await expect(isPricingPlanSelectorVisible(proOnly, 'plus')).resolves.toBe(false);
    });

    it('selects and confirms the requested Pro variant in both UI stages', async () => {
        const pricing = createProPricingPage();
        const checkout = createProCheckoutPage();

        await expect(selectProVariantOnPricingPage(pricing.page, 'pro_20x')).resolves.toBe(true);
        await expect(selectProVariantOnCheckoutPage(checkout.page, 'pro_20x')).resolves.toBeUndefined();

        expect(pricing.radio.selected).toBe(true);
        expect(checkout.option.selected).toBe(true);
    });

    it('stops when the Checkout Pro option is missing', async () => {
        const checkout = createProCheckoutPage({ count: 0 });

        await expect(selectProVariantOnCheckoutPage(checkout.page, 'pro_20x'))
            .rejects
            .toThrow('Checkout Pro 档位按钮数量异常: pro_20x / chatgptpro / 0');
    });
    it('stops when the verified Pro 500 Checkout option is absent', async () => {
        const pricing = createProPricingPage({ tier: '500' });
        await expect(selectProVariantOnPricingPage(pricing.page, 'pro_500')).resolves.toBe(true);
        expect(pricing.radio.selected).toBe(true);
        const checkout = createProCheckoutPage({ count: 0 });
        await expect(selectProVariantOnCheckoutPage(checkout.page, 'pro_500')).rejects.toThrow('Checkout Pro 档位按钮数量异常: pro_500 / chatgptpromax / 0');
        expect(checkout.option.selected).toBe(false);
    });

    it('selects official ID-free Pro tiles by exact value, independent of currency or translated label', async () => {
        for (const [plan, value] of [['pro_5x', 'chatgptprolite'], ['pro_20x', 'chatgptpro'], ['pro_500', 'chatgptpromax']]) {
            let selected = false;
            const option = {
                count: async () => 1, isVisible: async () => true,
                click: async () => { selected = true; },
                getAttribute: async (name) => ({ role: 'radio', value, 'aria-checked': String(selected), 'data-state': null })[name]
            };
            const missing = { count: async () => 0 };
            const page = {
                getByRole: (role, options) => !options && role === 'radiogroup' ? {
                    filter: ({ has }) => { expect(has).toBe(option); return { count: async () => 1 }; }
                } : missing,
                locator: (selector) => selector === `[role="radio"][value="${value}"]` ? option : missing,
                waitForTimeout: async () => {}
            };
            await expect(selectProVariantOnCheckoutPage(page, plan)).resolves.toBeUndefined();
            expect(selected).toBe(true);
        }
    });

    it('rejects duplicate, hidden, ungrouped, mismatched or unselected ID-free Pro options', async () => {
        for (const setup of [{ count: 2 }, { visible: false }, { groups: 0 }, { groups: 2 }, { value: 'chatgptpro' }, { selected: false }, { state: 'unchecked' }]) {
            let clicks = 0;
            const option = {
                count: async () => setup.count ?? 1, isVisible: async () => setup.visible ?? true,
                click: async () => { clicks++; },
                getAttribute: async (name) => ({ role: 'radio', value: setup.value || 'chatgptpromax',
                    'aria-checked': String(setup.selected ?? Boolean(clicks)), 'data-state': setup.state ?? null })[name]
            };
            const missing = { count: async () => 0 };
            const page = {
                getByRole: (role, options) => !options && role === 'radiogroup' ? { filter: () => ({ count: async () => setup.groups ?? 1 }) } : missing,
                locator: (selector) => selector.startsWith('[role=') ? option : missing,
                waitForTimeout: async () => {}
            };
            await expect(selectProVariantOnCheckoutPage(page, 'pro_500')).rejects.toThrow(/Checkout Pro/);
            if (setup.count || setup.visible === false || setup.groups !== undefined || setup.value) expect(clicks).toBe(0);
        }
    });

    it('waits for delayed exact Checkout tiles without clicking the default Pro tier', async () => {
        let rounds = 0, clicked = 0;
        const missing = { count: async () => 0 };
        const option = {
            count: async () => rounds >= 2 ? 1 : 0,
            isVisible: async () => true,
            click: async () => { clicked++; },
            getAttribute: async (name) => ({ role: 'radio', value: 'chatgptpromax',
                'aria-checked': String(Boolean(clicked)), 'data-state': null })[name]
        };
        const page = {
            getByRole: (role, options) => role === 'radiogroup' && !options ? { filter: () => ({ count: async () => 1 }) } : missing,
            locator: (selector) => selector === '[role="radio"][value="chatgptpromax"]' ? option : missing,
            waitForTimeout: async (ms) => { if (ms === 200) { expect(clicked).toBe(0); rounds++; } }
        };
        await expect(selectProVariantOnCheckoutPage(page, 'pro_500')).resolves.toBeUndefined();
        expect(rounds).toBe(2);
        expect(clicked).toBe(1);
    });

    it('stops before clicking a generic Pro choice when the requested tier is unavailable', async () => {
        const pricing = createProPricingPage({ tier: '20x' });
        await expect(selectProVariantOnPricingPage(pricing.page, 'pro_500')).rejects.toThrow('Pro 档位按钮数量异常');
        expect(pricing.radio.selected).toBe(false);
    });

    it('recognizes an exact Pro plan group and verifies a native numeric radio before proceeding', async () => {
        for (const role of ['radiogroup', 'group']) {
            let checked = false;
            const radio = {
                count: async () => 1, isVisible: async () => true,
                click: async () => { checked = true; },
                getAttribute: async () => null, isChecked: async () => checked
            };
            const group = { count: async () => 1, getByRole: (foundRole, options) => {
                expect(foundRole).toBe('radio');
                expect(options.name).toBe('500');
                expect(options.exact).toBe(true);
                return radio;
            } };
            const page = { getByRole: (foundRole, options) => foundRole === role && options.name.test('Pro plan') ? group : { count: async () => 0 } };
            await expect(selectProVariantOnCheckoutPage(page, 'pro_500')).resolves.toBeUndefined();
            expect(checked).toBe(true);
        }
    });

    it('uses the verified Pro card boundary for the new pricing page without touching Plus', async () => {
        const proButton = { count: async () => 1, isVisible: async () => true };
        const proCard = { count: async () => 1, getByRole: (_, options) => {
            expect(options.name.test('升级订阅')).toBe(true);
            return proButton;
        } };
        const page = { getByTestId: (id) => id === 'pro-pricing-modal-column-top-half' ? proCard : { count: async () => 0 } };
        expect((await getUniqueVisiblePlanButton(page, 'pro_500')).button).toBe(proButton);
    });

    it('accepts exact numeric tiers inside the unique Pro card with named, unnamed or renamed groups', async () => {
        for (const groupName of ['Pro usage', '', '套餐档位']) {
            for (const [plan, tier] of [['pro_5x', '100'], ['pro_20x', '200'], ['pro_500', '500']]) {
                const pricing = createProPricingPage({ tier, groupName });
                await expect(selectProVariantOnPricingPage(pricing.page, plan)).resolves.toBe(true);
                expect(pricing.radio.selected).toBe(true);
                expect(pricing.calls.globalRadio).toBe(0);
            }
        }
    });

    it('accepts ungrouped exact radios and native checked state inside the Pro card', async () => {
        const pricing = createProPricingPage({ tier: '500', groupCount: 0, native: true });
        await expect(selectProVariantOnPricingPage(pricing.page, 'pro_500')).resolves.toBe(true);
        expect(pricing.calls.clicked).toBe(1);
        expect(pricing.calls.globalRadio).toBe(0);
    });

    it('retains exact 5x and 20x labels inside the Pro card', async () => {
        for (const [plan, tier] of [['pro_5x', '5x'], ['pro_20x', '20x']]) {
            const pricing = createProPricingPage({ tier, groupName: '' });
            await expect(selectProVariantOnPricingPage(pricing.page, plan)).resolves.toBe(true);
            expect(pricing.radio.selected).toBe(true);
        }
    });

    it('retains legacy 5x and 20x controls in one explicit Pro group without the top-half marker', async () => {
        for (const [plan, tier] of [['pro_5x', '5x'], ['pro_20x', '20x']]) {
            const fixture = createLegacyProPricingPage({ tier });
            await expect(selectProVariantOnPricingPage(fixture.page, plan)).resolves.toBe(true);
            await expect(getUniqueVisiblePlanButton(fixture.page, plan, { requireProCard: true }))
                .resolves.toMatchObject({ plan, testId: 'select-plan-button-pro-upgrade' });
            expect(fixture.selected()).toBe(true);
        }
    });

    it('requires the legacy explicit Pro group and unique stable CTA, and keeps Pro 500 bounded', async () => {
        for (const setup of [{ groups: 0 }, { groups: 2 }, { ctas: 0 }, { ctas: 2 }]) {
            const fixture = createLegacyProPricingPage(setup);
            await expect(selectProVariantOnPricingPage(fixture.page, 'pro_20x')).rejects.toThrow(/Pro|套餐按钮/);
            expect(fixture.selected()).toBe(false);
        }
        const fixture = createLegacyProPricingPage({ tier: '500' });
        await expect(selectProVariantOnPricingPage(fixture.page, 'pro_500')).rejects.toThrow('Pro 卡片');
        expect(fixture.selected()).toBe(false);
    });

    it('rejects multiple groups, duplicate target radios, missing cards and duplicate cards before clicking', async () => {
        for (const setup of [
            { groupCount: 2 }, { radioCount: 2 }, { cardCount: 0 }, { cardCount: 2 },
            { cardVisible: false }, { radioVisible: false }, { radioInGroup: false }
        ]) {
            const pricing = createProPricingPage({ tier: '500', ...setup });
            await expect(selectProVariantOnPricingPage(pricing.page, 'pro_500')).rejects.toThrow(/Pro/);
            expect(pricing.calls.clicked).toBe(0);
            expect(pricing.calls.globalRadio).toBe(0);
        }
    });

    it('stops when the requested radio does not become selected', async () => {
        const pricing = createProPricingPage({ tier: '500', selectedAfterClick: false });
        await expect(selectProVariantOnPricingPage(pricing.page, 'pro_500')).rejects.toThrow('Pro 档位未选中');
    });

    it('preserves business email in structural diagnostics on an invalid card boundary', async () => {
        const pricing = createProPricingPage({ tier: '500', cardCount: 0 });
        const original = console.warn;
        const messages = [];
        console.warn = (...parts) => messages.push(parts);
        try {
            await expect(selectProVariantOnPricingPage(pricing.page, 'pro_500')).rejects.toThrow('Pro 卡片');
        } finally {
            console.warn = original;
        }
        expect(pricing.diagnostics).toHaveLength(1);
        const diagnostic = JSON.parse(messages[0][1]);
        expect(Object.keys(diagnostic[0][0])).toEqual(['role', 'tag', 'testid', 'aria-label', 'label', 'checked']);
        expect(JSON.stringify(diagnostic)).toContain('private@example.invalid');
        expect(pricing.diagnostics[0]).not.toMatch(/\.value|\.innerText|outerHTML|innerHTML/);
    });

    it('keeps region selection for initial subscriptions and skips it for upgrades', async () => {
        const source = fs.readFileSync(path.join(__dirname, '../pricing-checkout.js'), 'utf8');
        const start = source.indexOf('async function openPricingCheckout(');
        const end = source.indexOf('\nmodule.exports =', start);
        for (const operation of [undefined, 'initial', 'upgrade']) {
            const calls = [];
            const open = runInNewContext(source.slice(start, end) + '\nopenPricingCheckout;', {
                waitForPricingPage: async () => calls.push('page'),
                waitForPricingPlanSelector: async () => calls.push('plans'),
                switchToPersonalPlans: async () => calls.push('personal'),
                selectPricingRegion: async (_, region) => calls.push(`region:${region}`),
                selectProVariantOnPricingPage: async (_, plan) => calls.push(`variant:${plan}`),
                clickPlanUpgrade: async () => calls.push('open'),
                waitForCheckoutPage: async () => ({ kind: 'upgrade' }),
                selectProVariantOnCheckoutPage: async () => { throw new Error('Unexpected checkout'); }
            });
            await expect(open({}, { region: 'PH', planType: 'pro_500', operation })).resolves.toMatchObject({ kind: 'upgrade' });
            expect(calls.includes('region:PH')).toBe(operation !== 'upgrade');
            expect(calls).toContain('variant:pro_500');
        }
    });

    it('switches a default Business pricing view to Personal before waiting for plan buttons', async () => {
        const fixture = createPricingPageOpening();
        await expect(fixture.wait(fixture.page)).resolves.toBeUndefined();
        expect(fixture.calls).toEqual(['navigate', 'authenticated', 'personal', 'selectors']);
    });

    it('stops before plan readiness when switching from Business to Personal fails', async () => {
        const fixture = createPricingPageOpening({ switchFails: true });
        await expect(fixture.wait(fixture.page)).rejects.toThrow('未能切换到 Personal');
        expect(fixture.calls).toEqual(['navigate', 'authenticated', 'personal']);
    });

    it('defers selection to exact Checkout confirmation when the unique Pro card has no radios or groups', async () => {
        const fixture = createProPricingPage({ tier: '500', radioCount: 0, groupCount: 0 });
        for (const debugOnly of [false, true])
            await expect(selectProVariantOnPricingPage(fixture.page, 'pro_500', { debugOnly }))
                .resolves.toEqual({ deferredToCheckout: true });
        expect(fixture.calls.clicked).toBe(0);
    });

    it('never defers ambiguous, partial or differently tiered Pro controls even during debug', async () => {
        for (const setup of [
            { groupCount: 2, radioCount: 0 }, { groupCount: 1, radioCount: 0 },
            { groupCount: 0, radioCount: 0, allRadioCount: 2 },
            { groupCount: 0, radioCount: 0, hiddenRadioCount: 1 },
            { groupCount: 0, radioCount: 0, hiddenGroupCount: 1 },
            { groupCount: 0, tier: '200' }, { groupCount: 0, radioCount: 2 },
            { groupCount: 0, radioCount: 0, cardCount: 0 },
            { groupCount: 0, radioCount: 0, cardCount: 2 }
        ]) {
            for (const debugOnly of [false, true]) {
                const fixture = createProPricingPage({ tier: '500', ...setup });
                await expect(selectProVariantOnPricingPage(fixture.page, 'pro_500', { debugOnly })).rejects.toThrow(/Pro/);
                expect(fixture.calls.clicked).toBe(0);
            }
        }
    });

    it('requires a visible Pro card and unique canonical CTA, keeping text fallback inside the card', async () => {
        const fixture = createProPricingPage({ tier: '500', groupCount: 0, radioCount: 0 });
        const canonicalCta = { count: async () => 1, isVisible: async () => true };
        const page = {
            ...fixture.page,
            getByTestId: (id) => id === 'select-plan-button-pro-upgrade'
                ? canonicalCta : fixture.page.getByTestId(id)
        };
        expect((await getUniqueVisiblePlanButton(page, 'pro_500', { requireProCard: true })).button).toBe(canonicalCta);
        expect((await getUniqueVisiblePlanButton(fixture.page, 'pro_500', { requireProCard: true })).button).toBe(fixture.cta);
        for (const count of [2, 3]) {
            const ambiguous = { ...page, getByTestId: (id) => id === 'select-plan-button-pro-upgrade' ? { count: async () => count } : fixture.page.getByTestId(id) };
            await expect(getUniqueVisiblePlanButton(ambiguous, 'pro_500', { requireProCard: true })).rejects.toThrow('套餐按钮数量异常');
        }
        for (const setup of [{ ctaCount: 0 }, { ctaCount: 2 }, { ctaVisible: false }, { ctaLabel: 'Subscribe' }]) {
            const invalid = createProPricingPage({ tier: '500', ...setup });
            await expect(getUniqueVisiblePlanButton(invalid.page, 'pro_500', { requireProCard: true })).rejects.toThrow(/套餐按钮/);
        }
    });

    it('debug observes the current region but requires exact checkout selection after deferral', async () => {
        const source = fs.readFileSync(path.join(__dirname, '../pricing-checkout.js'), 'utf8');
        const start = source.indexOf('async function openPricingCheckout(');
        const end = source.indexOf('\nmodule.exports =', start);
        for (const checkoutMatches of [true, false]) {
            const calls = [];
            const open = runInNewContext(source.slice(start, end) + '\nopenPricingCheckout;', {
                console: { log() {} },
                waitForPricingPage: async () => {},
                waitForPricingPlanSelector: async () => {},
                selectPricingRegion: async () => { throw new Error('No region picker'); },
                selectProVariantOnPricingPage: async (_, plan, options) => {
                    expect(plan).toBe('pro_500');
                    expect(options.debugOnly).toBe(true);
                    return { deferredToCheckout: true };
                },
                clickPlanUpgrade: async (_, plan, options) => {
                    expect(plan).toBe('pro_500');
                    expect(options.requireProCard).toBe(true);
                    calls.push('scoped-cta');
                },
                waitForCheckoutPage: async () => ({ kind: 'checkout', checkoutUrl: 'https://chatgpt.com/checkout/synthetic' }),
                selectProVariantOnCheckoutPage: async (_, plan) => {
                    calls.push('exact-checkout-tier');
                    expect(plan).toBe('pro_500');
                    if (!checkoutMatches) throw new Error('Checkout 未显示明确 Pro 500 选项');
                }
            });
            const action = open({}, { region: 'PH', planType: 'pro_500', operation: 'initial', debugOnly: true });
            if (checkoutMatches) await expect(action).resolves.toMatchObject({ kind: 'checkout', pricingRegionVerified: false });
            else await expect(action).rejects.toThrow('Checkout 未显示明确 Pro 500 选项');
            expect(calls).toEqual(['scoped-cta', 'exact-checkout-tier']);
            await expect(open({}, { region: 'PH', planType: 'pro_500', operation: 'initial' })).rejects.toThrow('No region picker');
        }
    });
});
