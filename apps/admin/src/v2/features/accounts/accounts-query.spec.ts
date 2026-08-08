import { describe, expect, it } from 'vitest';
import {
  countActiveAccountsFilters,
  normalizeAccountsListQuery,
  resetAccountsListFilters,
  type AccountsListQueryDraft
} from './accounts-query';

function createQuery(): AccountsListQueryDraft {
  return {
    page: 3,
    pageSize: 20,
    keyword: '',
    countryOptionId: '',
    statusOptionId: '',
    supplierOptionId: '',
    recordStatus: '',
    saleState: '',
    lifecycle: 'available',
    sortBy: 'updatedAt',
    sortOrder: 'desc'
  };
}

describe('accounts list filters', () => {
  it('counts active business filters and ignores blank search text', () => {
    const query = createQuery();
    query.keyword = '   ';
    query.countryOptionId = 'country-us';
    query.saleState = 'sold';

    expect(countActiveAccountsFilters(query)).toBe(2);
  });

  it('resets filters and page while preserving page size and sorting', () => {
    const query = createQuery();
    Object.assign(query, {
      keyword: 'test@example.com',
      countryOptionId: 'country-us',
      statusOptionId: 'status-normal',
      supplierOptionId: 'supplier-a',
      recordStatus: 'disabled',
      saleState: 'sold'
    });

    resetAccountsListFilters(query);

    expect(countActiveAccountsFilters(query)).toBe(0);
    expect(query).toMatchObject({ page: 1, pageSize: 20, sortBy: 'updatedAt', sortOrder: 'desc' });
  });

  it('normalizes optional filters before sending the list request', () => {
    const query = createQuery();
    query.keyword = '  account@example.com  ';

    expect(normalizeAccountsListQuery(query)).toMatchObject({
      keyword: 'account@example.com',
      countryOptionId: undefined,
      recordStatus: undefined,
      saleState: undefined,
      lifecycle: 'available'
    });
  });
});
