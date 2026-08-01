import type { V2OrderEntryCustomer } from '@/v2/types/orders';

interface CustomerContact {
  label: string;
  value: string | null;
  matches: (value: string, keyword: string) => boolean;
}

function normalizeText(value: string) {
  return value.trim().toLocaleLowerCase();
}

function normalizeContact(value: string) {
  return normalizeText(value).replace(/[\s()+\-*]/g, '');
}

function textMatches(value: string, keyword: string) {
  return normalizeText(value).includes(normalizeText(keyword));
}

function maskedContactMatches(value: string, keyword: string) {
  const normalizedValue = normalizeContact(value);
  const normalizedKeyword = normalizeContact(keyword);
  if (!normalizedValue || !normalizedKeyword) return false;
  if (normalizedValue.includes(normalizedKeyword)) return true;

  const valueDigits = normalizedValue.replace(/\D/g, '');
  const keywordDigits = normalizedKeyword.replace(/\D/g, '');
  if (valueDigits.length < 6 || keywordDigits.length < 8) return false;
  const prefixLength = valueDigits.length >= 7 ? 3 : 2;
  return (
    valueDigits.startsWith(keywordDigits.slice(0, prefixLength)) &&
    valueDigits.endsWith(keywordDigits.slice(-4))
  );
}

export function formatV2CustomerSearchLabel(customer: V2OrderEntryCustomer, keywordValue = '') {
  const keyword = keywordValue.trim();
  const contacts: CustomerContact[] = [
    { label: '微信', value: customer.wechat, matches: textMatches },
    { label: 'QQ', value: customer.qq, matches: textMatches },
    { label: '手机', value: customer.maskedPhone, matches: maskedContactMatches },
    { label: 'WhatsApp', value: customer.maskedWhatsapp, matches: maskedContactMatches }
  ];
  const matchedContact = keyword
    ? contacts.find((contact) => contact.value && contact.matches(contact.value, keyword))
    : undefined;
  if (matchedContact?.value) {
    return `${customer.name} / ${matchedContact.label} ${matchedContact.value}`;
  }

  if (/\d{4}/.test(keyword)) {
    const maskedContacts = contacts.filter(
      (contact) => (contact.label === '手机' || contact.label === 'WhatsApp') && contact.value
    );
    if (maskedContacts.length) {
      return `${customer.name} / ${maskedContacts
        .map((contact) => `${contact.label} ${contact.value}`)
        .join(' · ')}`;
    }
  }

  const fallback = contacts.find((contact) => contact.value);
  return fallback?.value ? `${customer.name} / ${fallback.label} ${fallback.value}` : customer.name;
}
