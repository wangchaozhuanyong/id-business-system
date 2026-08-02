import { describe, expect, it } from 'vitest';
import { createDataGovernanceQueryKey } from './data-governance-query-key';

describe('data governance query keys', () => {
  it('keeps recycle-bin and job-list caches isolated for identical pagination', () => {
    const pagination = { page: 1, pageSize: 20 };

    expect(createDataGovernanceQueryKey('recycle', pagination)).toBe(
      'recycle:{"page":1,"pageSize":20}'
    );
    expect(createDataGovernanceQueryKey('jobs', pagination)).toBe('jobs:{"page":1,"pageSize":20}');
    expect(createDataGovernanceQueryKey('recycle', pagination)).not.toBe(
      createDataGovernanceQueryKey('jobs', pagination)
    );
  });
});
