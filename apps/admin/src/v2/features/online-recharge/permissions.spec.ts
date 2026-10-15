import { describe, expect, it } from 'vitest';
import { canUseOnlineAction } from './permissions';
import { canReadOnlineOrders, canManageOnlineOrders } from './orderPermissions';
const user = {
  id: 'fixture',
  username: 'fixture',
  displayName: '合成员工',
  roles: ['employee'],
  permissions: [],
  mustResetPassword: false
};
describe('线上代充操作权限', () => {
  it('新订单入口要求管理员且显式拥有读取权限，管理权限不能代替读取', () => {
    expect(canReadOnlineOrders({ ...user, roles: ['admin'] })).toBe(false);
    expect(
      canManageOnlineOrders({
        ...user,
        roles: ['admin'],
        permissions: ['id_business_v2.online_recharge.manage']
      })
    ).toBe(false);
    expect(
      canReadOnlineOrders({ ...user, permissions: ['id_business_v2.online_recharge.read'] })
    ).toBe(false);
  });
  it('新订单入口管理员只有读取权限时保持只读，显式管理权限才可补同步和补录', () => {
    const reader = {
      ...user,
      roles: ['admin'],
      permissions: ['id_business_v2.online_recharge.read']
    };
    expect(canReadOnlineOrders(reader)).toBe(true);
    expect(canManageOnlineOrders(reader)).toBe(false);
    expect(
      canManageOnlineOrders({
        ...reader,
        permissions: [...reader.permissions, 'id_business_v2.online_recharge.manage']
      })
    ).toBe(true);
  });
  it('普通员工默认无线上代充操作权限', () =>
    expect(canUseOnlineAction(user, 'cards', 'detail')).toBe(false));
  it('读取授权不自动取得管理或敏感查看权限', () => {
    const reader = { ...user, permissions: ['id_business_v2.online_recharge.read'] };
    expect(canUseOnlineAction(reader, 'jobs', 'detail')).toBe(true);
    expect(canUseOnlineAction(reader, 'jobs', 'artifacts')).toBe(true);
    expect(canUseOnlineAction(reader, 'cards', 'reveal')).toBe(false);
    expect(canUseOnlineAction(reader, 'jobs', 'start')).toBe(false);
    expect(canUseOnlineAction(reader, 'jobs', 'recheck')).toBe(false);
  });
  it('原单核对需要管理授权，不需要重新提交支付凭据', () => {
    const manager = {
      ...user,
      permissions: ['id_business_v2.online_recharge.read', 'id_business_v2.online_recharge.manage']
    };
    expect(canUseOnlineAction(manager, 'jobs', 'recheck')).toBe(true);
    expect(canUseOnlineAction(manager, 'cards', 'reveal')).toBe(false);
  });
  it('敏感查看独立授权，复制出库还需要管理授权', () => {
    const reader = {
      ...user,
      permissions: [
        'id_business_v2.online_recharge.read',
        'id_business_v2.online_recharge.sensitive'
      ]
    };
    expect(canUseOnlineAction(reader, 'sessions', 'reveal')).toBe(true);
    expect(canUseOnlineAction(reader, 'cdks', 'copy')).toBe(false);
  });
  it('管理员沿用现有权限助手默认通过', () =>
    expect(canUseOnlineAction({ ...user, roles: ['admin'] }, 'cards', 'reveal')).toBe(true));
  it('登录日志与后端一致，只允许管理员读取', () => {
    const reader = { ...user, permissions: ['id_business_v2.online_recharge.read'] };
    expect(canUseOnlineAction(reader, 'login-logs', 'detail')).toBe(false);
    expect(canUseOnlineAction({ ...reader, roles: ['admin'] }, 'login-logs', 'detail')).toBe(true);
  });
  it('现有身份标记需要敏感审批时直接取密关闭', () => {
    const restricted = {
      ...user,
      permissions: [
        'id_business_v2.online_recharge.read',
        'id_business_v2.online_recharge.sensitive'
      ],
      sensitiveApprovalPermissionCodes: ['id_business_v2.online_recharge.sensitive']
    };
    expect(canUseOnlineAction(restricted, 'cards', 'reveal')).toBe(false);
    expect(canUseOnlineAction(restricted, 'jobs', 'detail')).toBe(true);
  });
});
