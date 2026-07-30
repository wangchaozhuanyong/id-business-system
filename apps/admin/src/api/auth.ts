import { http, request } from '@/api/client';
import type { CurrentUser } from '@/types/system';

interface LoginResponse {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  user: CurrentUser;
}

export const authApi = {
  login(username: string, password: string, mfaCode?: string) {
    return request<LoginResponse>(http.post('/auth/login', { username, password, mfaCode }));
  },
  me() {
    return request<CurrentUser>(http.get('/auth/me'));
  },
  logout() {
    return request<{ loggedOut: boolean }>(http.post('/auth/logout'));
  },
  changePassword(currentPassword: string, newPassword: string) {
    return request<{
      passwordChanged: boolean;
      signedOut: boolean;
      providerSignedOut?: boolean;
    }>(
      http.post('/auth/change-password', {
        currentPassword,
        newPassword
      })
    );
  }
};
