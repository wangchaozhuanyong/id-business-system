import { computed, ref, type Ref } from 'vue';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { getV2BusinessNowMs } from '@/v2/runtime/businessClock';
import { generateV2TotpCodes, parseV2TotpInput } from '@/v2/components/workspace/totp';
import { rechargeTotpApi } from './api';

export type TotpSource = 'secret' | 'saved' | 'manual';

export interface SavedAccountOption {
  id: string;
  name: string;
  issuer: string | null;
}

const CODE_MIN_REMAINING_MS = 8_000;

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export function useRechargeTotp(loginMethod: Ref<'json' | 'password'>) {
  const source = ref<TotpSource>('secret');
  const secretInput = ref('');
  const savedAccountId = ref('');
  const savedAccountsQuery = useV2ModuleQuery<{ items: SavedAccountOption[] }>({
    moduleKey: 'auto-recharge',
    scope: 'auto-recharge',
    key: 'auto-recharge-saved-totp-accounts',
    enabled: () => loginMethod.value === 'password' && source.value === 'saved',
    query: async ({ signal }) => {
      const result = await rechargeTotpApi.listSavedAccounts({ signal });
      return {
        items: result.items.map(({ id, name, issuer }) => ({ id, name, issuer }))
      };
    }
  });
  const savedAccounts = computed(() => savedAccountsQuery.data.value?.items ?? []);
  const parsed = computed(() => parseV2TotpInput(secretInput.value.trim()));
  const secretError = computed(() => {
    if (source.value !== 'secret') return '';
    if (!secretInput.value.trim()) return '请粘贴 2FA 密钥或 otpauth 链接';
    if (parsed.value.errors.length) return parsed.value.errors[0]!.message;
    if (parsed.value.accounts.length !== 1) return '一次只允许使用一个 2FA 密钥';
    return '';
  });
  const ready = computed(() => {
    if (source.value === 'manual') return true;
    if (source.value === 'secret') return !secretError.value;
    return Boolean(savedAccounts.value.some((item) => item.id === savedAccountId.value));
  });

  async function freshCode(): Promise<string> {
    if (source.value === 'secret') {
      const account = parsed.value.accounts[0];
      if (secretError.value || !account) throw new Error('当前 2FA 密钥无效');
      let code = generateV2TotpCodes([account], getV2BusinessNowMs() ?? Date.now())[0]!;
      if (code.remainingSeconds * 1000 <= CODE_MIN_REMAINING_MS) {
        await delay((code.remainingSeconds + 1) * 1000);
        code = generateV2TotpCodes([account], getV2BusinessNowMs() ?? Date.now())[0]!;
      }
      if (code.remainingSeconds * 1000 <= CODE_MIN_REMAINING_MS) {
        throw new Error('验证码有效时间不足，请重试');
      }
      return code.token;
    }
    if (source.value === 'saved') {
      if (!ready.value) throw new Error('请选择已保存的 2FA 账号');
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await rechargeTotpApi.listSavedAccounts();
        const account = result.items.find((item) => item.id === savedAccountId.value);
        if (!account) throw new Error('已保存的 2FA 账号不可用');
        const remaining = Date.parse(account.expiresAt) - (getV2BusinessNowMs() ?? Date.now());
        if (remaining > CODE_MIN_REMAINING_MS && /^[0-9]{6,8}$/.test(account.token)) {
          return account.token;
        }
        if (attempt === 0 && Number.isFinite(remaining)) {
          await delay(Math.max(1000, Math.min(remaining + 500, account.period * 1000 + 1000)));
        }
      }
      throw new Error('验证码即将过期，请重试');
    }
    throw new Error('本次未设置自动取码');
  }

  return {
    source,
    secretInput,
    savedAccountId,
    savedAccountsQuery,
    savedAccounts,
    secretError,
    ready,
    freshCode,
    clearSecret: () => {
      secretInput.value = '';
      void parsed.value;
    }
  };
}
