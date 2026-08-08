import { describe, expect, it } from 'vitest';
import orderList from './components/V2OrdersList.vue?raw';
import topupRecordsTables from '../topup-records/components/V2TopupRecordsTables.vue?raw';
import tableSchemas from '@/v2/features/tableSchemas.ts?raw';
import tableColumn from '@/v2/components/V2TableColumn.vue?raw';
import tableColumnSettings from '@/v2/components/V2TableColumnSettings.vue?raw';

describe('order and gift-card table action UI contract', () => {
  it('keeps order state transitions in the pinned status/next-step column', () => {
    const ordersSchema = tableSchemas.slice(
      tableSchemas.indexOf('  orders: {'),
      tableSchemas.indexOf('  profile: {')
    );
    const progressColumn = orderList.slice(
      orderList.indexOf('class="v2-order-progress"'),
      orderList.indexOf('<V2TableActionColumn')
    );
    const actionColumn = orderList.slice(
      orderList.indexOf('<V2TableActionColumn'),
      orderList.indexOf('</V2TableActionColumn>')
    );

    expect(ordersSchema).toContain("label: '状态/下一步'");
    expect(ordersSchema).toContain("widthPreset: 'wide'");
    expect(ordersSchema).toContain('hideable: false');
    expect(tableColumn).toContain('props.definition.hideable !== false');
    expect(tableColumnSettings).toContain('column.hideable !== false');
    expect(ordersSchema).toContain("layout: 'double'");
    expect(progressColumn).toContain('page.consumeOrderBalance(row)');
    expect(progressColumn).toContain('page.completeOrder(row)');
    expect(actionColumn).toContain('page.openDetail(row)');
    expect(actionColumn).not.toContain('page.consumeOrderBalance(row)');
    expect(actionColumn).not.toContain('page.completeOrder(row)');
  });

  it('keeps mobile state transitions beside the status instead of the generic footer actions', () => {
    const progress = orderList.slice(
      orderList.indexOf('class="v2-order-mobile-progress"'),
      orderList.indexOf('</header>', orderList.indexOf('class="v2-order-mobile-progress"'))
    );
    const footer = orderList.slice(
      orderList.indexOf('<footer>', orderList.indexOf('class="v2-order-mobile-progress"')),
      orderList.indexOf('</footer>', orderList.indexOf('class="v2-order-mobile-progress"'))
    );

    expect(progress).toContain('page.consumeOrderBalance(item)');
    expect(progress).toContain('page.completeOrder(item)');
    expect(footer).toContain('page.openDetail(item)');
    expect(footer).not.toContain('page.consumeOrderBalance(item)');
    expect(footer).not.toContain('page.completeOrder(item)');
  });

  it('uses the triple action width for both gift-card text buttons', () => {
    const giftCardSchema = tableSchemas.slice(
      tableSchemas.indexOf('    giftCards: table({'),
      tableSchemas.indexOf('    balanceLedger: table({')
    );

    expect(giftCardSchema).toContain("layout: 'triple'");
    expect(topupRecordsTables).toContain('更正供应商');
    expect(topupRecordsTables).toContain('更多操作');
  });
});
