export const proxyTypeLabels = Object.freeze({
  dynamic_residential: '动态住宅',
  static_residential: '静态住宅',
  dedicated_static_residential: '独享静态住宅',
  mobile: '移动代理'
});

export function isProxyType(value) {
  return typeof value === 'string' && Object.hasOwn(proxyTypeLabels, value);
}
