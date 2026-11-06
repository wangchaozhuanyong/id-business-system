import { DirectBrowserError } from './bitbrowser-direct-api';

export type DirectLoginCredential =
  | { login: { email: string; password: string }; sessionJson?: never }
  | { sessionJson: string; login?: never };

export function parseDirectCredential(credential: DirectLoginCredential) {
  if (credential.login)
    return { email: credential.login.email.toLowerCase(), userId: '', accountId: '', token: '' };
  try {
    const data = JSON.parse(credential.sessionJson);
    const token = data.sessionToken ?? data.session_token;
    if (data.sessionToken && data.session_token && data.sessionToken !== data.session_token)
      throw new Error();
    if (
      typeof token !== 'string' ||
      !/^[!#$%&'()*+\-./0-9:<=>?@A-Z[\]^_`a-z{|}~]{1,16384}$/.test(token)
    )
      throw new Error();
    const access = data.accessToken ?? data.access_token;
    const claims = access
      ? JSON.parse(atob(access.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
      : null;
    const accountId =
      claims?.['https://api.openai.com/auth']?.chatgpt_account_id ?? data.account?.id;
    if (data.account?.id && data.account.id !== accountId) throw new Error();
    if (
      typeof data.user?.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(data.user.id) ||
      typeof accountId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(accountId) ||
      typeof data.user.email !== 'string' ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.user.email)
    )
      throw new Error();
    return {
      token,
      email: data.user.email.toLowerCase() as string,
      userId: data.user.id as string,
      accountId
    };
  } catch {
    throw new DirectBrowserError('invalid_session_json');
  }
}
