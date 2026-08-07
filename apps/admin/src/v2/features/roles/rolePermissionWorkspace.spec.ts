import { describe, expect, it } from 'vitest';
import type { V2RolePermissionGroup } from './contracts';
import {
  filterRolePermissionGroups,
  getInitialExpandedPermissionModules
} from './rolePermissionWorkspace';

const groups: V2RolePermissionGroup[] = [
  {
    module: 'apple.account',
    label: 'ID 资料',
    permissions: [
      {
        id: 'account-view',
        name: '查看 ID',
        code: 'apple.account.view',
        module: 'apple.account',
        action: 'view'
      }
    ]
  },
  {
    module: 'apple.order',
    label: '订单',
    permissions: [
      {
        id: 'order-create',
        name: '订单录入',
        code: 'apple.order.create',
        module: 'apple.order',
        action: 'create'
      }
    ]
  },
  {
    module: 'finance',
    label: '财务',
    permissions: [
      {
        id: 'finance-view',
        name: '查看财务',
        code: 'finance.view',
        module: 'finance',
        action: 'view'
      },
      {
        id: 'finance-close',
        name: '财务关账',
        code: 'finance.close',
        module: 'finance',
        action: 'close'
      }
    ]
  }
];

describe('role permission workspace', () => {
  it('matches group labels and keeps all permissions in a matched group', () => {
    const result = filterRolePermissionGroups(groups, '财务', false, []);

    expect(result).toHaveLength(1);
    expect(result[0]?.permissions).toHaveLength(2);
  });

  it('matches permission names and codes without exposing unrelated options', () => {
    const result = filterRolePermissionGroups(groups, 'finance.close', false, []);

    expect(result[0]?.permissions.map((permission) => permission.id)).toEqual(['finance-close']);
    expect(result[0]?.allPermissions).toHaveLength(2);
  });

  it('keeps the order entry permission searchable by its business label', () => {
    const result = filterRolePermissionGroups(groups, '订单录入', false, []);

    expect(result[0]?.permissions).toEqual([
      expect.objectContaining({
        name: '订单录入',
        code: 'apple.order.create'
      })
    ]);
  });

  it('shows only selected permissions and reports full-group selection counts', () => {
    const result = filterRolePermissionGroups(groups, '', true, ['finance-view']);

    expect(result).toHaveLength(1);
    expect(result[0]?.permissions.map((permission) => permission.id)).toEqual(['finance-view']);
    expect(result[0]?.selectedCount).toBe(1);
    expect(result[0]?.allPermissions).toHaveLength(2);
  });

  it('expands only the first selected group when editing and the first group when creating', () => {
    expect(getInitialExpandedPermissionModules(groups, ['finance-close'])).toEqual(['finance']);
    expect(getInitialExpandedPermissionModules(groups, ['account-view', 'finance-close'])).toEqual([
      'apple.account'
    ]);
    expect(getInitialExpandedPermissionModules(groups, [])).toEqual(['apple.account']);
  });
});
