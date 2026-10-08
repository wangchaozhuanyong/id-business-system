import { apiListenerHost } from './listener-options';

describe('API 原生监听参数', () => {
  it('无参数保留容器默认监听', () => {
    expect(apiListenerHost([])).toBeUndefined();
  });

  it.each([['--host=127.0.0.1'], ['--host', '127.0.0.1']])('明确传递回环地址 %j', (...argv) => {
    expect(apiListenerHost(argv)).toBe('127.0.0.1');
  });

  it('允许显式 IPv4 地址，且不把无效参数当作默认监听', () => {
    expect(apiListenerHost(['--host=0.0.0.0'])).toBe('0.0.0.0');
    for (const argv of [
      ['--host'],
      ['--host='],
      ['--host=localhost'],
      ['--host=::1'],
      ['--host=https://127.0.0.1'],
      ['--host=999.1.1.1'],
      ['--host=127.0.0.1', '--host=0.0.0.0'],
      ['--unknown=127.0.0.1']
    ]) {
      expect(() => apiListenerHost(argv)).toThrow('API 监听参数无效');
    }
  });
});
