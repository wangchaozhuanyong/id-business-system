export interface LoginDto {
  username: string;
  password: string;
  mfaCode?: string | null;
}
