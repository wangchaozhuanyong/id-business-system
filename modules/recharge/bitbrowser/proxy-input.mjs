const protocols = new Set(['http', 'https', 'socks5']);
const fail = () => { throw new Error('代理格式无法识别，请粘贴账号:密码@主机:端口、主机:端口:账号:密码，或完整代理链接。'); };
export function parseBitBrowserProxyInput(value, { protocol = 'auto', mode = 'auto' } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\x00-\x20\x7f]/.test(value.trim()) || !['auto', ...protocols].includes(protocol) || !['auto', 'static', 'dynamic'].includes(mode)) fail();
  let text = value.trim(), automaticProtocol = false;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    automaticProtocol = protocol === 'auto';
    const scheme = automaticProtocol ? 'socks5' : protocol;
    const raw = /^(\[[\da-f:]+\]|[^:@\/?#]+):(\d{1,5})(?::([^:]+):(.+))?$/i.exec(text);
    if (raw) {
      text = `${scheme}://${raw[3] ? `${encodeURIComponent(raw[3])}:${encodeURIComponent(raw[4])}@` : ''}${raw[1]}:${raw[2]}`;
    } else if (text.includes('@')) {
      const at = text.lastIndexOf('@'), credentials = text.slice(0, at), colon = credentials.indexOf(':');
      if (colon < 1 || colon === credentials.length - 1) fail();
      text = `${scheme}://${encodeURIComponent(credentials.slice(0, colon))}:${encodeURIComponent(credentials.slice(colon + 1))}@${text.slice(at + 1)}`;
    } else fail();
  }
  let url;
  try { url = new URL(text); } catch { fail(); }
  const type = url.protocol.slice(0, -1);
  if (!protocols.has(type) || !url.hostname || url.hash) fail();
  const explicitPort = /^[a-z]+:\/\/(?:[^@/]*@)?(?:\[[^\]]+\]|[^:/?#]+):\d+/i.test(text);
  const extraction = mode === 'dynamic' || (mode === 'auto' && ['http', 'https'].includes(type) && !url.username && !url.password && (Boolean(url.search) || url.pathname !== '/' || (type === 'https' && !explicitPort)));
  if (extraction) {
    if (!['http', 'https'].includes(type) || url.username || url.password) fail();
    const hint = ['protocol', 'proxy_type', 'proxyType', 'type'].map(key => url.searchParams.get(key)?.toLowerCase()).find(value => protocols.has(value) || value === 'socks');
    return { mode: 'dynamic', protocol: protocol === 'auto' ? (hint === 'socks' ? 'socks5' : hint || 'http') : protocol, link: url.href, automaticProtocol: protocol === 'auto' && !hint };
  }
  if (url.search || (url.pathname && url.pathname !== '/') || Boolean(url.username) !== Boolean(url.password)) fail();
  const port = Number(url.port || (type === 'https' ? 443 : type === 'http' ? 80 : 0));
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail();
  let username, password;
  try { username = decodeURIComponent(url.username); password = decodeURIComponent(url.password); } catch { fail(); }
  if (/[\x00-\x1f\x7f]/.test(username + password)) fail();
  return { mode: 'static', protocol: type, link: url.href, automaticProtocol, host: url.hostname, port, username, password };
}
export function bitBrowserProxySettings(proxy) {
  const parsed = parseBitBrowserProxyInput(proxy.link, { mode: proxy.mode, protocol: proxy.protocol });
  return { proxyType: parsed.protocol, expectedCountryCode: proxy.countryCode || '', useSelectedProxy: true,
    dynamicProxyUrl: parsed.mode === 'dynamic' ? parsed.link : '',
    browserOptions: { proxyMode: parsed.mode, ...(parsed.mode === 'static' && { staticHost: parsed.host, staticPort: parsed.port }) },
    staticProxyCredentials: parsed.mode === 'static' ? { username: parsed.username, password: parsed.password } : undefined };
}
