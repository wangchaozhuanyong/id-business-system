import { describe, expect, it } from 'vitest';
import view from './V2OrderEntryView.vue?raw';
import candidates from './components/V2OrderEntryCandidates.vue?raw';
import liveSummary from './components/V2OrderEntryLiveSummary.vue?raw';
import pricingFields from './components/V2OrderPricingFields.vue?raw';
import receiptFields from './components/V2OrderReceiptFields.vue?raw';

function sliceBetween(source: string, start: string, end: string) {
  return source.slice(source.indexOf(start), source.indexOf(end));
}

describe('order entry three-module UI contract', () => {
  it('groups the requested fields into paired columns without changing their bindings', () => {
    const businessGroup = sliceBetween(view, 'title="业务与对象"', 'title="客户与结算"');
    const settlementGroup = sliceBetween(view, 'title="客户与结算"', 'title="周期与备注"');
    const periodGroup = sliceBetween(view, 'title="周期与备注"', '<V2OrderEntrySubmitBar');

    for (const binding of ['form.categoryId', 'form.serviceOptionId', 'form.customerId']) {
      expect(businessGroup).toContain(binding);
    }
    for (const binding of ['form.countryId', 'form.accountId', 'idSelectionMode']) {
      expect(businessGroup).toContain(binding);
    }
    expect(settlementGroup).toContain('label="结算平台"');
    expect(settlementGroup).toContain('label="平台订单号"');
    expect(settlementGroup).toContain('label="客户业务账号"');
    expect(settlementGroup).toContain('label="目标/反算利率"');
    expect(settlementGroup).toContain('<V2OrderReceiptFields');
    expect(settlementGroup).toContain('<V2OrderPricingFields');
    expect(periodGroup).toContain('prop="balanceAmount"');
    expect(periodGroup).toContain('prop="openedAt"');
    expect(periodGroup).toContain('prop="dueAt"');
    expect(periodGroup).toContain('label="ID 购买成本"');
    expect(periodGroup).toContain('label="平台手续费"');
    expect(periodGroup).toContain('v-model="form.remark"');
  });

  it('uses a dedicated paginated ID module and a separate realtime summary', () => {
    expect(view).toContain('class="v2-order-entry-workspace"');
    expect(view).toContain('<V2OrderEntryCandidates');
    expect(view).toContain('<V2OrderEntryLiveSummary');
    expect(view).toContain('class="v2-order-entry-result-shell"');
    expect(candidates).toContain('title="ID 选择"');
    expect(candidates).toContain('v-for="candidate in paginatedCandidates"');
    expect(candidates).toContain('<el-pagination');
    expect(candidates).toContain('const pageSize = 12');
    expect(candidates).not.toContain('ID 处理方式');
    expect(liveSummary).toContain('title="实时核算"');
    expect(liveSummary).toContain('ID 处理方式');
  });

  it('uses the requested customer-facing pricing language', () => {
    expect(receiptFields).toContain('label="售卖价格"');
    expect(receiptFields).toContain('label="收款币种"');
    expect(receiptFields).toContain('label="折算人民币"');
    expect(pricingFields).toContain('label="推荐价格"');
    expect(pricingFields).toContain('当前为实收反算；直接修改利润率可切换为目标定价');
  });
});
