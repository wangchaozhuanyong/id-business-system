export function maskUserPhone(value) {
  if (value === null || value === undefined || value === '') return null;
  const compact = value.replace(/\s+/g, '');
  return compact.length <= 4 ? '***' : `***${compact.slice(-4)}`;
}

export function isV1EncryptedField(value) {
  if (typeof value !== 'string') return false;
  const [version, iv, tag, ciphertext, extra] = value.split(':');
  const base64Url = /^[A-Za-z0-9_-]+$/;
  return (
    extra === undefined &&
    version === 'v1' &&
    iv?.length === 16 &&
    tag?.length === 22 &&
    Boolean(ciphertext) &&
    base64Url.test(iv) &&
    base64Url.test(tag) &&
    base64Url.test(ciphertext)
  );
}
