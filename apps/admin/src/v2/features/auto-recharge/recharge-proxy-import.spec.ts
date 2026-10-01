import { describe, expect, it } from 'vitest';
import { parseRechargeProxyImport } from './recharge-proxy-import';

describe('代理 IP 批量粘贴', () => {
  it('提取代理使用所选协议，直连代理仍由链接确定协议', () => {
    const rows = parseRechargeProxyImport(
      'US https://proxy.example.test/get 动态住宅\nUS http://proxy.example.test:8080 移动代理',
      'socks5'
    );
    expect(rows[0]?.protocol).toBe('socks5');
    expect(rows[1]).not.toHaveProperty('protocol');
  });
  it('支持空格或 Tab 分列、中文国家和属性', () => {
    expect(
      parseRechargeProxyImport(
        '美国 https://proxy.example.test/get 动态住宅 备注一 备注二\nPH\thttp://user:pass@proxy.example.test:8080\t移动代理\t含 空格\t-'
      )
    ).toEqual([
      {
        countryCode: 'US',
        url: 'https://proxy.example.test/get',
        kind: 'dynamic_residential',
        remark1: '备注一',
        remark2: '备注二'
      },
      {
        countryCode: 'PH',
        url: 'http://user:pass@proxy.example.test:8080',
        kind: 'mobile',
        remark1: '含 空格',
        remark2: ''
      }
    ]);
  });

  it('缺列或超过 100 行时提示行号且不部分导入', () => {
    expect(() => parseRechargeProxyImport('美国 https://proxy.example.test/get')).toThrow(
      '第 1 行'
    );
    expect(() => parseRechargeProxyImport('US https://proxy.example.test/get 错误属性')).toThrow(
      '第 1 行'
    );
    expect(() =>
      parseRechargeProxyImport(
        Array(101).fill('US https://proxy.example.test/get 动态住宅').join('\n')
      )
    ).toThrow('100');
  });
});
