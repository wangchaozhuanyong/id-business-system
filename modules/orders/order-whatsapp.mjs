// Calling codes from https://github.com/google/libphonenumber/blob/master/resources/PhoneNumberMetadata.xml.
export const orderCallingCodes = Object.freeze(`
1 7 20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 56 57 58 60 61 62 63 64 65 66 81 82 84 86 90 91 92 93 94 95 98
211 212 213 216 218 220 221 222 223 224 225 226 227 228 229 230 231 232 233 234 235 236 237 238 239 240 241 242 243 244 245 246 247 248 249
250 251 252 253 254 255 256 257 258 260 261 262 263 264 265 266 267 268 269 290 291 297 298 299
350 351 352 353 354 355 356 357 358 359 370 371 372 373 374 375 376 377 378 380 381 382 383 385 386 387 389 420 421 423
500 501 502 503 504 505 506 507 508 509 590 591 592 593 594 595 596 597 598 599 670 672 673 674 675 676 677 678 679 680 681 682 683 685 686 687 688 689 690 691 692
800 808 850 852 853 855 856 870 878 880 881 882 883 886 888 960 961 962 963 964 965 966 967 968 970 971 972 973 974 975 976 977 979 992 993 994 995 996 998
`.trim().split(/\s+/));

const callingCodes = new Set(orderCallingCodes);
function callingCode(digits) {
  for (let size = 1; size <= 3 && size <= digits.length; size++) {
    const prefix = digits.slice(0, size);
    if (callingCodes.has(prefix)) return prefix;
  }
  return '';
}

function phoneText(value, allowWhatsAppLink = false) {
  const text = String(value ?? '').normalize('NFKC').trim();
  const link = allowWhatsAppLink && text.match(/^(?:https?:\/\/)?wa\.me\/(\d+)\/?(?:[?#].*)?$/i);
  if (link) return '+' + link[1];
  if (!/^\+?[\d\s().-]+$/.test(text)) return text;
  return text.replace(/[\s().-]/g, '').replace(/^00/, '+');
}

function splitPhoneText(text, defaultCode = '86') {
  if (text.startsWith('+')) {
    const digits = text.slice(1);
    const code = /^\d+$/.test(digits) && callingCode(digits);
    if (code) return { code, national: digits.slice(code.length) };
  }
  return { code: defaultCode, national: text };
}

function formatPhoneText(code, text) {
  if (!text || text.startsWith('+')) return text;
  return callingCodes.has(code) && /^\d+$/.test(text) ? '+' + code + text : text;
}

function validInternationalPhoneText(text) {
  const { national } = splitPhoneText(text);
  return /^\+[1-9]\d{6,14}$/.test(text) && /^\d+$/.test(national);
}

const chinaMobile = /^1[3-9]\d{9}$/;
const chinaLandline = /^0(?:10|2\d|[3-9]\d{2})[2-9]\d{6,7}$/;

function internationalLandline(text) {
  if (text.startsWith('+86') && chinaLandline.test(text.slice(3))) return '+86' + text.slice(4);
  return text;
}

export function splitOrderPhone(value, defaultCode = '86') {
  return splitPhoneText(phoneText(value), defaultCode);
}

export function formatOrderPhone(code, national) {
  return internationalLandline(formatPhoneText(code, phoneText(national)));
}

export function orderPhoneKey(value) {
  const text = phoneText(value);
  // Recognize historical Mainland numbers by their shape. Unqualified foreign
  // numbers have no reliable country code and must not be matched by a guess.
  if (chinaMobile.test(text) || chinaLandline.test(text)) return formatOrderPhone('86', text);
  return internationalLandline(text).toLowerCase();
}

export function validOrderPhone(value) {
  return validInternationalPhoneText(orderPhoneKey(value));
}

export function splitOrderWhatsApp(value, defaultCode = '86') {
  return splitPhoneText(phoneText(value, true), defaultCode);
}

export function formatOrderWhatsApp(code, national) {
  return formatPhoneText(code, phoneText(national, true));
}

export function validOrderWhatsApp(value) {
  return validInternationalPhoneText(phoneText(value, true));
}

export function orderWhatsAppKey(value) {
  const text = phoneText(value, true);
  if (chinaMobile.test(text)) return '+86' + text;
  if (/^\d+$/.test(text) && validInternationalPhoneText('+' + text)) return '+' + text;
  return text.toLowerCase();
}
