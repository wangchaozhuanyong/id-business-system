'use strict';

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

const createProPricingPage = ({ tier = '20x' } = {}) => {
    const radio = {
        selected: false,
        count: async () => 1,
        isVisible: async () => true,
        click: async () => { radio.selected = true; },
        getAttribute: async (name) => (name === 'aria-checked' && radio.selected ? 'true' : 'false')
    };
    return {
        page: {
            getByRole: (role, options) => role === 'radiogroup' && /^\d+$/.test(tier) ? { count: async () => 1, getByRole: () => radio } : role === 'radio' && options.name === tier ? radio : { count: async () => 0 },
            waitForTimeout: async () => {}
        },
        radio
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
            pro_500: { checkoutValue: null, pricingRadioLabel: null, pricingTierLabel: '500' }
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
    it('selects Pro 500 only through its exact visible tier, without a guessed checkout ID', async () => {
        const pricing = createProPricingPage({ tier: '500' });
        await expect(selectProVariantOnPricingPage(pricing.page, 'pro_500')).resolves.toBe(true);
        expect(pricing.radio.selected).toBe(true);
        const checkout = createProCheckoutPage({ count: 0 });
        await expect(selectProVariantOnCheckoutPage(checkout.page, 'pro_500')).rejects.toThrow('Checkout 未显示明确 Pro 500 选项');
        expect(checkout.option.selected).toBe(false);
    });

    it('stops before clicking a generic Pro choice when the requested tier is unavailable', async () => {
        const pricing = createProPricingPage({ tier: '20x' });
        await expect(selectProVariantOnPricingPage(pricing.page, 'pro_500')).rejects.toThrow('Pro 档位按钮数量异常');
        expect(pricing.radio.selected).toBe(false);
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

});
