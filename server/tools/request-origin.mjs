export function parseToolPublicOrigin(value) {
  if (value === undefined) return undefined;
  const url = typeof value === 'string' && URL.parse(value);
  if (!url || url.protocol !== 'https:' || !/^(?:[a-z\d-]+\.)+[a-z][a-z\d-]*$/i.test(url.hostname) ||
      ![url.origin, url.origin + '/'].includes(value))
    throw new Error('工具公网地址须为 HTTPS 域名，且不得包含路径');
  return url;
}

export function toolRequestOrigin(headers, publicOrigin) {
  if (!publicOrigin) return 'http://' + headers.host;
  // The deployment proxy preserves the canonical Host. Forwarding headers are not trusted.
  return headers.host === publicOrigin.host ? publicOrigin.origin : undefined;
}
