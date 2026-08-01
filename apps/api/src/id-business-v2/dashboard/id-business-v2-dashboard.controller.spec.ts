import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { IdBusinessV2DashboardController } from './id-business-v2-dashboard.controller';

describe('IdBusinessV2DashboardController', () => {
  it('passes only the authenticated user to the overview service', async () => {
    const overview = vi.fn().mockResolvedValue({ generatedAt: 'now' });
    const controller = new IdBusinessV2DashboardController({ overview } as never);
    const currentUser: AuthenticatedUser = {
      id: 'user-id',
      username: 'operator',
      displayName: '操作员',
      roles: ['operation'],
      permissions: []
    };

    await controller.overview(currentUser);

    expect(overview).toHaveBeenCalledWith(currentUser);
  });
});
