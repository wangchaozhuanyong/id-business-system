// Self-contained so the same parser can be included in the pinned admin bundle.
export function normalizeRechargeProxyInput(input) {
  const fail = message => { throw new Error(message); };
  if (typeof input !== 'string' && !(Array.isArray(input) && input.every(value => typeof value === 'string')))
    fail('请粘贴代理资料，每行一条');
  const text = Array.isArray(input) ? input.join('\n') : input;
  if (text.length > 512 * 1024) fail('单次代理资料过大，请分批导入');
  const entries = text.split(/\r?\n/).map((value, index) => ({ value: value.trim(), line: index + 1 }))
    .filter(entry => entry.value);
  if (!entries.length || entries.length > 500) fail('每批请填写 1–500 条代理');
  const proxies = [], errors = [];
  let converted = 0, duplicates = 0;
  for (const { value, line } of entries) {
    try {
      if (value.length > 2048 || /[\x00-\x1f\x7f]/.test(value)) throw new Error();
      const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(value);
      const protocol = scheme ? scheme[1].toLowerCase() : 'socks5';
      if (!['http', 'https', 'socks5'].includes(protocol)) throw new Error();
      const body = scheme ? scheme[2] : value;
      // Match the host-first layout before interpreting @ inside a raw password.
      const hostPattern = /^(\[[^\]]+\]|[^:\s/?#@]+):(\d{1,5})(?::([^:]+):(.+))?$/;
      const hostFirst = hostPattern.exec(body) || (!body.includes('@') && hostPattern.exec(body.replace(/\/$/, '')));
      let host, port, username = '', password = '';
      if (hostFirst) {
        [, host, port] = hostFirst;
        if (hostFirst[3] !== undefined) { username = hostFirst[3]; password = hostFirst[4]; }
      } else {
        const at = body.lastIndexOf('@');
        const credentials = body.slice(0, at), colon = credentials.indexOf(':');
        const address = /^(\[[^\]]+\]|[^:\s/?#@]+):(\d{1,5})$/.exec(body.slice(at + 1).replace(/\/$/, ''));
        if (at < 1 || colon < 1 || colon === credentials.length - 1 || !address) throw new Error();
        [, host, port] = address;
        const decode = part => scheme ? decodeURIComponent(part) : part;
        username = decode(credentials.slice(0, colon));
        password = decode(credentials.slice(colon + 1));
      }
      if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535 ||
        /[\x00-\x1f\x7f]/.test(username + password)) throw new Error();
      const encodedUser = encodeURIComponent(username).replace(/%7Bsession%7D/gi, '{session}');
      const auth = username ? `${encodedUser}:${encodeURIComponent(password)}@` : '';
      const normalized = `${protocol}://${auth}${host.toLowerCase()}:${Number(port)}`;
      const url = new URL(normalized);
      if (!url.hostname || url.search || url.hash || (url.pathname && url.pathname !== '/') ||
        Boolean(username) !== Boolean(password)) throw new Error();
      if (normalized !== value) converted++;
      if (proxies.includes(normalized)) duplicates++;
      else proxies.push(normalized);
    } catch { errors.push(line); }
  }
  if (errors.length) fail(`第 ${errors.slice(0, 8).join('、')} 行代理格式无法识别，整批未保存。请填写代理地址；API 提取链接不能作为代理使用。`);
  return { proxies, converted, duplicates };
}
