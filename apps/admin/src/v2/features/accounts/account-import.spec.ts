import { describe, expect, it } from 'vitest';
import type { V2OptionSelector } from './contracts';
import { prepareAccountImport } from './account-import';

const country = {
  id: 'country-us',
  type: 'country',
  code: 'us',
  name: '美国',
  parentId: null,
  parent: null,
  countryOptionId: null,
  country: null,
  businessAmount: null,
  currencyCode: 'USD'
} satisfies V2OptionSelector;

const status = {
  id: 'status-normal',
  type: 'id_status',
  code: 'normal',
  name: '正常',
  parentId: null,
  parent: null,
  countryOptionId: null,
  country: null,
  businessAmount: null,
  currencyCode: null
} satisfies V2OptionSelector;

describe('account CSV import', () => {
  it('uses balance multiplied by exchange rate as the RMB cost', () => {
    const result = prepareAccountImport(
      [
        ['ID账号', '国家', 'ID状态', '余额', '汇率', '人民币成本'],
        ['user@example.com', '美国', '正常', '20', '5.7', '999']
      ],
      {
        countries: [country],
        statuses: [status],
        suppliers: []
      }
    );

    expect(result.failures).toEqual([]);
    expect(result.rows[0]).toEqual(
      expect.objectContaining({
        currentBalance: '20',
        balanceCostAmount: '114'
      })
    );
  });

  it('requires a reason when importing a disabled ID', () => {
    const missingReason = prepareAccountImport(
      [
        ['ID账号', '国家', 'ID状态', '资料状态', '停用原因'],
        ['disabled@example.com', '美国', '正常', '停用', '']
      ],
      { countries: [country], statuses: [status], suppliers: [] }
    );
    const withReason = prepareAccountImport(
      [
        ['ID账号', '国家', 'ID状态', '资料状态', '停用原因'],
        ['disabled@example.com', '美国', '正常', '停用', '暂不投入使用']
      ],
      { countries: [country], statuses: [status], suppliers: [] }
    );

    expect(missingReason.failures[0]?.reason).toContain('停用原因');
    expect(withReason.rows[0]).toMatchObject({
      recordStatus: 'disabled',
      disabledReason: '暂不投入使用'
    });
  });
});
