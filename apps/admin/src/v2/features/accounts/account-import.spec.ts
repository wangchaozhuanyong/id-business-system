import { afterEach, describe, expect, it } from 'vitest';
import { clearV2SessionDrafts } from '@/v2/composables/useV2SessionDraft';
import type { V2OptionSelector } from './contracts';
import { prepareAccountImport, useAccountImportDraft } from './account-import';

afterEach(clearV2SessionDrafts);

describe('account CSV import session draft', () => {
  it('restores the selected file metadata and review results when returning to the page', () => {
    const draft = useAccountImportDraft();
    draft.importFilename.value = 'review.csv';
    draft.importSourceRowCount.value = 3;
    draft.importFailures.value = [{ rowNumber: 3, reason: '国家未配置' }];
    draft.importCompleted.value = true;
    draft.importSuccessCount.value = 2;
    const restored = useAccountImportDraft();
    expect(restored.importFilename.value).toBe('review.csv');
    expect(restored.importSourceRowCount.value).toBe(3);
    expect(restored.importFailures.value).toEqual([{ rowNumber: 3, reason: '国家未配置' }]);
    expect(restored.importCompleted.value).toBe(true);
    expect(restored.importSuccessCount.value).toBe(2);
  });

  it('drops import metadata with the shared session boundary', () => {
    useAccountImportDraft().importFilename.value = 'review.csv';
    clearV2SessionDrafts();
    expect(useAccountImportDraft().importFilename.value).toBe('');
    expect(useAccountImportDraft().importRows.value).toEqual([]);
  });
});

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

  it('restores the text safety prefix from an application-generated export', () => {
    const result = prepareAccountImport(
      [
        ['ID账号', '手机号码', '国家', 'ID状态', '备注'],
        ['user@example.com', "'+8613800000000", '美国', '正常', "'=HYPERLINK(...)"]
      ],
      { countries: [country], statuses: [status], suppliers: [] }
    );

    expect(result.failures).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      phone: '+8613800000000',
      remark: '=HYPERLINK(...)'
    });
  });
});
