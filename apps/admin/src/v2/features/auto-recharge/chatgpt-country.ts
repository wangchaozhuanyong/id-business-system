import { proxyCountries } from './recharge-proxy-options';

const regionNames = new Intl.DisplayNames(['zh-Hans'], { type: 'region', fallback: 'none' });

export function chatgptCountryLabel(code?: string | null) {
  if (!code) return '未记录';
  if (!/^[A-Z]{2}$/.test(code)) return '未知国家';
  return (
    proxyCountries.find(([value]) => value === code)?.[1] ?? regionNames.of(code) ?? '未知国家'
  );
}

export const chatgptCountries = Array.from({ length: 26 * 26 }, (_, index) => {
  const code = String.fromCharCode(65 + Math.floor(index / 26), 65 + (index % 26));
  return [code, chatgptCountryLabel(code)] as const;
})
  .filter(
    ([code, label]) =>
      !['EU', 'UN', 'QO', 'XA', 'XB', 'ZZ'].includes(code) &&
      label !== '未知国家' &&
      new Intl.Locale(`und-${code}`).region === code
  )
  .sort((a, b) => a[1].localeCompare(b[1], 'zh-Hans'));
