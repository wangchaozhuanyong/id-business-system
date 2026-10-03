import { describe, expect, it, vi } from 'vitest';
import { RegistrationRepository } from './registration.repository';

describe('注册任务未结束占用', () => {
  it('授权过期、部分完成与关闭未知仍占用，只排除已取消和已完成任务', async () => {
    const rows = [
      { id: 'cancelled', state: 'cancelled' },
      { id: 'completed', state: 'completed' },
      { id: 'expired', state: 'running', leaseUntil: new Date(0) },
      { id: 'partial', state: 'partial', leaseUntil: null },
      { id: 'close-unknown', state: 'partial', reason: 'builtin_cancel_unconfirmed' },
      { id: 'queued', state: 'queued' }
    ];
    const tx = {
      idBusinessV2RegistrationJob: {
        findFirst: vi.fn(
          async ({
            where
          }: {
            where: {
              state: { notIn: string[] };
              id?: { not: string };
              OR?: Array<{ leaseUntil: null | { gt: Date } }>;
            };
          }) =>
            rows.find(
              (row) =>
                !where.state.notIn.includes(row.state) &&
                (!where.id || row.id !== where.id.not) &&
                (!where.OR ||
                  where.OR.some((clause: { leaseUntil: null | { gt: Date } }) =>
                    clause.leaseUntil === null
                      ? row.leaseUntil == null
                      : row.leaseUntil && row.leaseUntil > clause.leaseUntil.gt
                  ))
            )
        )
      }
    };
    const repository = new RegistrationRepository({} as never);
    expect(await repository.active(tx as never)).toMatchObject({ id: 'expired' });
    expect(await repository.active(tx as never, 'expired')).toMatchObject({ id: 'partial' });
    rows.splice(2, 1);
    expect(await repository.active(tx as never, 'partial')).toMatchObject({ id: 'close-unknown' });
    rows.splice(2, 3);
    expect(await repository.active(tx as never)).toBeUndefined();
  });
});
