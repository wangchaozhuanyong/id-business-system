export function getSafeV2Redirect(value: unknown): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (
    typeof candidate !== 'string' ||
    Array.from(candidate).some((character) => character === '\\' || character.charCodeAt(0) <= 0x1f)
  ) {
    return '/v2';
  }

  if (
    candidate === '/v2' ||
    candidate.startsWith('/v2/') ||
    candidate.startsWith('/v2?') ||
    candidate.startsWith('/v2#')
  ) {
    return candidate;
  }

  return '/v2';
}

export function requiresPasswordResetRedirect(
  mustResetPassword: boolean | undefined,
  allowDuringPasswordReset: unknown
) {
  return mustResetPassword === true && allowDuringPasswordReset !== true;
}
