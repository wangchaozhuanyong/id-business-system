import { computed, effectScope, reactive, ref } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import { clearV2SessionDrafts, useV2FormDraft } from '@/v2/composables/useV2SessionDraft';
import type { V2Order, V2OrderReceiptFinanceAccount } from './contracts';
import {
  getOrderReceiptFinanceAccountChoices,
  getOrderReceiptFinanceAccountError,
  requiresOrderReceiptFinanceAccount,
  useOrderReceiptFinanceAccount
} from './order-receipt-account';
import { createEmptyOrderEditForm } from '../orders/components/order-edit-form';

const cny: V2OrderReceiptFinanceAccount = {
  id: 'cash-cny',
  name: '人民币银行账户',
  currency: 'CNY',
  isActive: true
};
const myr: V2OrderReceiptFinanceAccount = {
  id: 'cash-myr',
  name: '马币银行账户',
  currency: 'MYR',
  isActive: true
};

afterEach(clearV2SessionDrafts);

describe('普通订单真实收款账户', () => {
  it('零实收与零平台费可留空，任一正额必须明确选账户', () => {
    expect(requiresOrderReceiptFinanceAccount('0.0000', '0')).toBe(false);
    expect(requiresOrderReceiptFinanceAccount('0.0001', '0')).toBe(true);
    expect(requiresOrderReceiptFinanceAccount('0', '1.0000')).toBe(true);
    expect(getOrderReceiptFinanceAccountError('', 'CNY', [cny], false)).toBe('');
    expect(getOrderReceiptFinanceAccountError('', 'CNY', [cny], true)).toContain('真实收款账户');
  });

  it('停用、删除及跨币种选择均拒绝，零金额也不接受失效选择', () => {
    expect(getOrderReceiptFinanceAccountError(cny.id, 'CNY', [cny], true)).toBe('');
    expect(getOrderReceiptFinanceAccountError(myr.id, 'CNY', [cny, myr], true)).toContain('币种');
    expect(getOrderReceiptFinanceAccountError(cny.id, 'CNY', [], false)).toContain('失效');
    expect(
      getOrderReceiptFinanceAccountError(cny.id, 'CNY', [{ ...cny, isActive: false }], true)
    ).toContain('停用');
  });

  it('币种变化与选项更新保留原选择，显式显示错误，不自动改到账户', () => {
    const form = reactive({
      receivedFinanceAccountId: cny.id,
      receivedOriginalAmount: '100',
      receivedCurrency: 'CNY' as 'CNY' | 'MYR'
    });
    const accounts = ref([cny, myr]);
    const state = useOrderReceiptFinanceAccount(
      form,
      () => accounts.value,
      () => '0'
    );
    form.receivedCurrency = 'MYR';
    expect(form.receivedFinanceAccountId).toBe(cny.id);
    expect(state.receiptFinanceAccountError.value).toContain('币种');
    expect(state.receiptFinanceAccountChoices.value).toEqual([
      { value: cny.id, label: '人民币银行账户 · CNY（币种不匹配）', disabled: true },
      { value: myr.id, label: '马币银行账户 · MYR', disabled: false }
    ]);
    form.receivedCurrency = 'CNY';
    accounts.value = [myr];
    expect(form.receivedFinanceAccountId).toBe(cny.id);
    expect(state.receiptFinanceAccountError.value).toContain('失效');
    expect(state.receiptFinanceAccountChoices.value[0]?.disabled).toBe(true);
  });

  it('已过账订单保留停用账户显示，账户锁定时不阻止非财务编辑', () => {
    const form = reactive({ receivedFinanceAccountId: cny.id, receivedOriginalAmount: '100' });
    const order = ref({
      receivedCurrency: 'CNY',
      receivedFinanceAccount: { ...cny, isActive: false },
      operations: { canEditReceiptAccount: false }
    } as V2Order);
    const state = useOrderReceiptFinanceAccount(
      form,
      () => [],
      () => '1',
      () => order.value
    );
    expect(state.receiptFinanceAccountChoices.value[0]?.label).toContain('人民币银行账户');
    expect(state.receiptFinanceAccountError.value).toBe('');
    order.value.operations.canEditReceiptAccount = true;
    expect(state.receiptFinanceAccountError.value).toContain('失效');
  });

  it('收款账户草稿按订单隔离，恢复原版本，迟到保存不清除后续改选', () => {
    const scope = effectScope();
    const draft = scope.run(() =>
      useV2FormDraft('receipt-account-test', createEmptyOrderEditForm)
    )!;
    draft.open(
      'first',
      { ...createEmptyOrderEditForm(), receivedFinanceAccountId: cny.id },
      'original-version'
    );
    const completeSave = draft.beginSave();
    draft.form.receivedFinanceAccountId = myr.id;
    completeSave();
    draft.open(
      'other',
      { ...createEmptyOrderEditForm(), receivedFinanceAccountId: '' },
      'other-version'
    );
    draft.open(
      'first',
      { ...createEmptyOrderEditForm(), receivedFinanceAccountId: '' },
      'new-server-version'
    );
    expect(draft.form.receivedFinanceAccountId).toBe(myr.id);
    expect(draft.version.value).toBe('original-version');
    expect(JSON.parse(draft.original.value).receivedFinanceAccountId).toBe(cny.id);
    scope.stop();
  });

  it('续费开单只提供人民币候选，正额手续费同样要求账户', () => {
    const form = reactive({ receivedFinanceAccountId: '', receivedAmount: '0' });
    const state = useOrderReceiptFinanceAccount(
      form,
      () => [cny, myr],
      () => '2'
    );
    expect(state.receiptFinanceAccountRequired.value).toBe(true);
    expect(state.receiptFinanceAccountChoices.value.map((item) => item.value)).toEqual([cny.id]);
    expect(state.receiptFinanceAccountError.value).toContain('CNY');
  });

  it('没有候选时仍显示已记录账户名称，并保留删除后的选择值', () => {
    expect(getOrderReceiptFinanceAccountChoices([], 'CNY', cny.id, cny)).toEqual([
      { value: cny.id, label: '人民币银行账户 · CNY（已停用或失效）', disabled: true }
    ]);
    expect(
      computed(() => getOrderReceiptFinanceAccountChoices([], 'CNY', 'deleted')).value[0]?.value
    ).toBe('deleted');
  });
});
