import { describe, expect, it, vi } from 'vitest';
import { parseRechargeProxy, proxyLink } from './recharge-proxy-validation';
import { RechargeProxyService } from './recharge-proxy.service';

const id = '123e4567-e89b-42d3-a456-426614174000';
const operator = { id: 'operator-id' } as never;
const link = 'https://proxy.example.test/extract?token=synthetic-token';

function setup() {
  const repository = {
    create: vi.fn().mockResolvedValue({ id, countryCode: 'US', kind: 'dynamic_residential' }),
    findInTransaction: vi.fn().mockResolvedValue(null),
    hasJobs: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue({ id }),
    delete: vi.fn().mockResolvedValue({ id })
  };
  const transactions = { execute: vi.fn((work: (tx: object) => Promise<unknown>) => work({})) };
  const audit = { append: vi.fn().mockResolvedValue(undefined) };
  const encryption = {
    encrypt: vi.fn((value: string) => `encrypted:${value}`),
    decrypt: vi.fn((value: string) => value.slice('encrypted:'.length)),
    hash: vi.fn((value: string) => `hash:${value}`)
  };
  const service = new RechargeProxyService(
    repository as never,
    transactions as never,
    audit as never,
    encryption as never
  );
  return { service, repository, transactions, audit };
}

describe('充值代理 IP', () => {
  it('提取链接可指定 SOCKS5，直连链接拒绝不一致的协议', async () => {
    const f = setup();
    await f.service.create(
      { countryCode: 'US', kind: 'mobile', protocol: 'socks5', url: link },
      operator
    );
    expect(f.repository.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ protocol: 'socks5', connectionMode: 'extraction' })
    );
    expect(() =>
      parseRechargeProxy({
        countryCode: 'US',
        kind: 'mobile',
        protocol: 'socks5',
        url: 'http://proxy.example.test:8080'
      })
    ).toThrow('协议不一致');
    expect(() =>
      parseRechargeProxy({ countryCode: 'US', kind: 'mobile', protocol: 'invalid', url: link })
    ).toThrow('代理协议无效');
  });

  it('更换提取协议不改密文链接，已使用代理拒绝更换协议', async () => {
    const f = setup();
    f.repository.findInTransaction.mockResolvedValue({
      id,
      countryCode: 'US',
      kind: 'mobile',
      active: true,
      protocol: 'http',
      connectionMode: 'extraction',
      urlHash: `hash:${link}`,
      urlEncrypted: `encrypted:${link}`
    });
    await f.service.update(id, { protocol: 'socks5' }, operator);
    const updated = f.repository.update.mock.calls[0]?.[2];
    expect(updated).toMatchObject({ protocol: 'socks5' });
    expect(updated).not.toHaveProperty('urlEncrypted');
    expect(JSON.stringify(f.audit.append.mock.calls)).not.toContain(link);
    f.repository.findInTransaction.mockResolvedValue({
      id,
      countryCode: 'US',
      kind: 'mobile',
      active: true,
      protocol: 'socks5',
      connectionMode: 'extraction',
      urlHash: `hash:${link}`,
      urlEncrypted: `encrypted:${link}`
    });
    await expect(f.service.forCharge(id, operator, 'US')).resolves.toMatchObject({
      mode: 'dynamic',
      type: 'socks5',
      extractionUrl: link
    });
    await f.service.update(id, { url: 'https://proxy.example.test/new-extract' }, operator);
    expect(f.repository.update.mock.calls.at(-1)?.[2]).toMatchObject({ protocol: 'socks5' });
    f.repository.hasJobs.mockResolvedValue({ id: 'job-id' });
    await expect(f.service.update(id, { protocol: 'https' }, operator)).rejects.toThrow('不能更换');
  });
  it('识别提取链接及 HTTP、HTTPS、SOCKS5 直连链接', () => {
    expect(proxyLink(link)).toMatchObject({ connectionMode: 'extraction', protocol: 'http' });
    expect(proxyLink('http://user:pass@proxy.example.test:8080')).toMatchObject({
      connectionMode: 'direct',
      protocol: 'http'
    });
    expect(proxyLink('https://proxy.example.test:443')).toMatchObject({
      connectionMode: 'direct',
      protocol: 'https'
    });
    expect(proxyLink('socks5://proxy.example.test:1080')).toMatchObject({
      connectionMode: 'direct',
      protocol: 'socks5'
    });
    expect(
      parseRechargeProxy({ countryCode: 'us', url: link, kind: 'mobile', remark1: '', remark2: '' })
        .countryCode
    ).toBe('US');
  });

  it.each([
    'http://proxy.example.test/extract',
    'https://localhost/extract',
    'https://127.0.0.1/extract',
    'http://proxy.example.test:8080/path',
    'http://user@proxy.example.test:8080',
    'https://proxy.example.test/extract#fragment'
  ])('拒绝无效或内部地址 %s', (value) => {
    expect(() => proxyLink(value)).toThrow();
  });

  it('整批先验证，密文保存且审计不记录链接', async () => {
    const f = setup();
    await expect(
      f.service.importMany(
        {
          proxies: [
            { countryCode: 'US', url: link, kind: 'dynamic_residential', remark1: '', remark2: '' },
            { countryCode: 'US', url: 'https://localhost/extract', kind: 'mobile' }
          ]
        },
        operator
      )
    ).rejects.toThrow('第 2 行');
    expect(f.transactions.execute).not.toHaveBeenCalled();
    await expect(
      f.service.importMany(
        {
          proxies: [
            { countryCode: 'US', url: link, kind: 'dynamic_residential', remark1: '', remark2: '' }
          ]
        },
        operator
      )
    ).resolves.toEqual({ imported: 1 });
    expect(f.repository.create.mock.calls[0]?.[1].urlEncrypted).toBe(`encrypted:${link}`);
    expect(JSON.stringify(f.audit.append.mock.calls)).not.toContain(link);
  });

  it('停用与国家不符的代理不能充值，已用于任务的代理不能删除或换链接', async () => {
    const f = setup();
    const item = {
      id,
      countryCode: 'US',
      kind: 'dynamic_residential',
      active: false,
      urlEncrypted: `encrypted:${link}`,
      urlHash: `hash:${link}`
    };
    f.repository.findInTransaction.mockResolvedValue(item);
    await expect(f.service.forCharge(id, operator, 'US')).rejects.toThrow('已停用');
    item.active = true;
    await expect(f.service.forCharge(id, operator, 'PH')).rejects.toThrow('国家不一致');
    f.repository.hasJobs.mockResolvedValue({ id: 'job-id' });
    await expect(f.service.delete(id, operator)).rejects.toThrow('请改为停用');
    await expect(
      f.service.update(id, { url: 'https://proxy.example.test/other' }, operator)
    ).rejects.toThrow('不能更换');
    expect(f.repository.delete).not.toHaveBeenCalled();
  });

  it('选用代理时解密链接并记录不含链接的审计', async () => {
    const f = setup();
    f.repository.findInTransaction.mockResolvedValue({
      id,
      countryCode: 'US',
      kind: 'mobile',
      active: true,
      connectionMode: 'direct',
      protocol: 'https',
      urlEncrypted: 'encrypted:https://user:pass@proxy.example.test:443'
    });
    await expect(f.service.forCharge(id, operator, 'US')).resolves.toMatchObject({
      mode: 'static',
      host: 'proxy.example.test',
      port: 443,
      username: 'user',
      password: 'pass'
    });
    expect(JSON.stringify(f.audit.append.mock.calls)).not.toContain('pass@');
  });
});
