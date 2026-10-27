import { describe, expect, it, vi } from 'vitest';
import { V2_RECHARGE_BROWSER_DEFAULTS } from '@apple-business/shared';
import { RechargeSettingsService } from './recharge-settings.service';
import { RechargeSettingsRepository } from './persistence/recharge-settings.repository';

const profileA = '11111111-1111-4111-8111-111111111111';
const profileB = '22222222-2222-4222-8222-222222222222';
const operator = (id: string) => ({
  id,
  username: id,
  displayName: id,
  roles: ['admin'],
  permissions: []
});
const configuration = (groupName: string) => ({
  connectorUrl: 'http://127.0.0.1:55322',
  localApiUrl: 'http://127.0.0.1:54345',
  localApiTokenEncrypted: 'synthetic-api-ciphertext',
  localApiTokenMask: '已配置',
  connectorTokenEncrypted: null,
  connectorTokenMask: null,
  dynamicProxyUrlEncrypted: 'synthetic-proxy-ciphertext',
  dynamicProxyUrlMask: '已配置',
  groupName,
  tagName: '标签',
  proxyType: 'http',
  browserOptions: { ...V2_RECHARGE_BROWSER_DEFAULTS, openWidth: 1600 }
});

function fixture() {
  const now = new Date('2026-10-26T00:00:00.000Z');
  const bases = new Map(
    ['甲', '乙'].map((ownerId) => [
      ownerId,
      {
        ...configuration(`${ownerId}原分组`),
        ownerId,
        createdAt: now,
        updatedAt: now,
        browserOptions: {
          ...V2_RECHARGE_BROWSER_DEFAULTS,
          accountCopySuffix: `${ownerId}的其他设置`,
          selectedConnectionProfileId: null as string | null
        }
      }
    ])
  );
  const profiles = new Map([
    [
      profileA,
      {
        id: profileA,
        ownerId: '甲',
        name: '甲的电脑',
        configuration: configuration('甲的命名分组'),
        createdAt: now,
        updatedAt: now
      }
    ],
    [
      profileB,
      {
        id: profileB,
        ownerId: '乙',
        name: '乙的电脑',
        configuration: configuration('乙的命名分组'),
        createdAt: now,
        updatedAt: now
      }
    ]
  ]);
  const settings = {
    findUnique: vi.fn(async ({ where }) => bases.get(where.ownerId) ?? null),
    upsert: vi.fn(async ({ where, update }) => {
      const next = { ...bases.get(where.ownerId)!, ...update };
      bases.set(where.ownerId, next);
      return next;
    })
  };
  const profileModel = {
    findFirst: vi.fn(async ({ where }) => {
      const row = profiles.get(where.id);
      return row?.ownerId === where.ownerId ? row : null;
    }),
    findFirstOrThrow: vi.fn(async ({ where }) => profiles.get(where.id)),
    findMany: vi.fn(async ({ where }) =>
      [...profiles.values()]
        .filter((row) => row.ownerId === where.ownerId)
        .map(({ id, name }) => ({ id, name }))
    ),
    updateMany: vi.fn(async ({ where, data }) => {
      const before = profiles.get(where.id);
      if (
        !before ||
        before.ownerId !== where.ownerId ||
        before.updatedAt.getTime() !== where.updatedAt.getTime()
      )
        return { count: 0 };
      profiles.set(where.id, { ...before, ...data });
      return { count: 1 };
    })
  };
  const client = {
    idBusinessV2RechargeBrowserSetting: settings,
    idBusinessV2RechargeConnectionProfile: profileModel
  };
  const repository = new RechargeSettingsRepository(client as never);
  vi.spyOn(repository, 'lock').mockResolvedValue(undefined);
  const audit = { append: vi.fn() };
  const service = () =>
    new RechargeSettingsService(
      repository,
      {} as never,
      { execute: (work: (tx: unknown) => unknown) => work(client) } as never,
      audit as never,
      {} as never
    );
  const input = (id: string | null = profileA) => ({
    directMode: true,
    connectionProfileId: id,
    connectionProfileName: '甲的电脑',
    connectorUrl: 'http://127.0.0.1:55322',
    localApiUrl: 'http://127.0.0.1:54345',
    groupName: '甲的新分组',
    tagName: '甲的新标签',
    proxyType: 'http',
    browserOptions: { ...V2_RECHARGE_BROWSER_DEFAULTS, openWidth: 1800 },
    expectedUpdatedAt: now.toISOString()
  });
  return { bases, profiles, settings, profileModel, service, input, audit };
}

describe('比特连接首选项按系统账号持久保存', () => {
  it('保存命名连接后新服务实例恢复同一连接和参数，不改变原连接或其他账号', async () => {
    const f = fixture();
    const otherBefore = structuredClone(f.bases.get('乙'));
    await f.service().update(f.input(), operator('甲'));
    const restored = await f.service().get(operator('甲'));
    expect(restored.connectionProfileId).toBe(profileA);
    expect(restored.groupName).toBe('甲的新分组');
    expect(restored.browserOptions.openWidth).toBe(1800);
    expect(restored.connectionProfiles).toEqual([{ id: profileA, name: '甲的电脑' }]);
    expect(f.bases.get('甲')!.browserOptions.accountCopySuffix).toBe('甲的其他设置');
    expect(f.bases.get('甲')!.groupName).toBe('甲原分组');
    expect((await f.service().get(operator('甲'), null)).groupName).toBe('甲原分组');
    expect(f.bases.get('乙')).toEqual(otherBefore);
    expect((await f.service().get(operator('乙'))).connectionProfileId).toBeNull();
    expect(f.audit.append).toHaveBeenCalledOnce();
  });

  it('明确保存原连接才清除本人的首选项，其他账号及命名连接保持原样', async () => {
    const f = fixture();
    await f.service().update(f.input(), operator('甲'));
    const namedBefore = structuredClone(f.profiles.get(profileA));
    await f.service().update(f.input(null), operator('甲'));
    const restored = await f.service().get(operator('甲'));
    expect(restored.connectionProfileId).toBeNull();
    expect(restored.groupName).toBe('甲的新分组');
    expect(restored.browserOptions.openWidth).toBe(1800);
    expect(f.profiles.get(profileA)).toEqual(namedBefore);
    expect(f.bases.get('乙')!.groupName).toBe('乙原分组');
  });

  it('其他系统账号的配置不能读取或保存，也不能替换本人的首选连接', async () => {
    const f = fixture();
    await expect(f.service().get(operator('甲'), profileB)).rejects.toThrow('本人的连接配置');
    await expect(f.service().update(f.input(profileB), operator('甲'))).rejects.toThrow(
      '本人的连接配置'
    );
    expect(f.settings.upsert).not.toHaveBeenCalled();
    expect(f.profileModel.updateMany).not.toHaveBeenCalled();
    expect(f.audit.append).not.toHaveBeenCalled();
  });

  it('更新服务器参数不会清除本人已保存的比特首选连接', async () => {
    const f = fixture();
    await f.service().update(f.input(), operator('甲'));
    await f.service().update(
      {
        ...f.input(null),
        serverMode: true,
        browserOptions: {
          ...V2_RECHARGE_BROWSER_DEFAULTS,
          proxyMode: 'static',
          staticHost: 'proxy.example.invalid',
          staticPort: 8080
        }
      },
      operator('甲')
    );
    expect((await f.service().get(operator('甲'))).connectionProfileId).toBe(profileA);
    expect(f.bases.get('甲')!.browserOptions.selectedConnectionProfileId).toBe(profileA);
  });

  it('旧版本保存失败时不改变连接参数或首选项', async () => {
    const f = fixture();
    const before = structuredClone(f.profiles.get(profileA));
    await expect(
      f.service().update({ ...f.input(), expectedUpdatedAt: null }, operator('甲'))
    ).rejects.toThrow('已被修改');
    expect(f.settings.upsert).not.toHaveBeenCalled();
    expect(f.profiles.get(profileA)).toEqual(before);
  });
});
