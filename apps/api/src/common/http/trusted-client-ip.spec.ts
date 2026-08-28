import { configureProductionTrustedProxy, resolveTrustedClientIp } from './trusted-client-ip';

describe('resolveTrustedClientIp', () => {
  it('uses the IP already resolved by the trusted Express proxy chain', () => {
    expect(resolveTrustedClientIp({ ip: '203.0.113.25' })).toBe('203.0.113.25');
    expect(resolveTrustedClientIp({ ip: '2001:db8::25' })).toBe('2001:db8::25');
  });

  it('rejects missing or malformed resolved addresses', () => {
    expect(resolveTrustedClientIp(undefined)).toBeUndefined();
    expect(resolveTrustedClientIp({ ip: null })).toBeUndefined();
    expect(resolveTrustedClientIp({ ip: '203.0.113.25, 10.0.0.8' })).toBeUndefined();
    expect(resolveTrustedClientIp({ ip: 'not-an-ip' })).toBeUndefined();
  });
});

describe('configureProductionTrustedProxy', () => {
  it('trusts exactly the adjacent Nginx hop in production', () => {
    const app = { set: vi.fn() };
    configureProductionTrustedProxy(app, 'production');
    expect(app.set).toHaveBeenCalledWith('trust proxy', 1);
  });

  it('keeps direct socket IP handling outside production', () => {
    const app = { set: vi.fn() };
    configureProductionTrustedProxy(app, 'development');
    configureProductionTrustedProxy(app, 'test');
    expect(app.set).not.toHaveBeenCalled();
  });
});
