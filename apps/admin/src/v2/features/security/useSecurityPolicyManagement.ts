import 'element-plus/es/components/message-box/style/css.mjs';
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs';
import { computed, reactive, ref, watch } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import { getApiErrorMessage } from '@/api/client';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { validateV2Form } from '@/v2/utils/formValidation';
import { v2SecurityApi } from './api';
import type {
  V2IpWhitelistRecord,
  V2MfaSettings,
  V2MfaSetupResult,
  V2MfaUserRecord,
  V2SaveIpWhitelistInput,
  V2UpdateMfaSettingsInput
} from './contracts';

type PolicyFormModel = V2UpdateMfaSettingsInput;
type WhitelistFormModel = V2SaveIpWhitelistInput;

const EMPTY_POLICY_FORM: PolicyFormModel = {
  enabled: false,
  requiredForAdmins: false,
  issuer: '代充管理后台'
};

const EMPTY_WHITELIST_FORM: WhitelistFormModel = {
  ipOrCidr: '',
  scope: 'admin',
  enabled: true,
  remark: ''
};

export function useSecurityPolicyManagement(refresh: () => Promise<unknown>) {
  const policyDrawerVisible = ref(false);
  const policySaving = ref(false);
  const policyMutationError = ref('');
  const policyForm = reactive<PolicyFormModel>({ ...EMPTY_POLICY_FORM });
  const policyBaseline = ref(JSON.stringify(EMPTY_POLICY_FORM));

  const mfaSetupVisible = ref(false);
  const mfaSetupLoading = ref(false);
  const mfaEnabling = ref(false);
  const mfaMutationError = ref('');
  const mfaSetup = ref<V2MfaSetupResult | null>(null);
  const mfaCodeForm = reactive({ code: '' });
  const recoveryCodesVisible = ref(false);
  const recoveryCodes = ref<string[]>([]);
  const resettingMfaUserId = ref('');

  const whitelistDrawerVisible = ref(false);
  const editingWhitelist = ref<V2IpWhitelistRecord | null>(null);
  const whitelistSaving = ref(false);
  const whitelistMutationError = ref('');
  const whitelistForm = reactive<WhitelistFormModel>({ ...EMPTY_WHITELIST_FORM });
  const whitelistBaseline = ref(JSON.stringify(EMPTY_WHITELIST_FORM));
  const removingWhitelistId = ref('');

  const policyDirty = computed(() => JSON.stringify(policyForm) !== policyBaseline.value);
  const whitelistDirty = computed(() => JSON.stringify(whitelistForm) !== whitelistBaseline.value);
  const mfaCodeRules: FormRules<typeof mfaCodeForm> = {
    code: [
      { required: true, message: '请输入动态验证码', trigger: 'blur' },
      { pattern: /^\d{6}$/, message: '动态验证码必须为 6 位数字', trigger: 'blur' }
    ]
  };
  const policyRules: FormRules<PolicyFormModel> = {
    issuer: [
      { required: true, message: '请输入 MFA 签发方', trigger: 'blur' },
      { max: 80, message: 'MFA 签发方不能超过 80 个字符', trigger: 'blur' }
    ]
  };
  const whitelistRules: FormRules<WhitelistFormModel> = {
    ipOrCidr: [
      { required: true, message: '请输入 IP 或 CIDR', trigger: 'blur' },
      {
        pattern: /^[0-9a-fA-F:.]+(?:\/\d{1,3})?$/,
        message: '请输入 IPv4、IPv4 CIDR 或 IPv6 单地址',
        trigger: 'blur'
      },
      {
        validator: (_rule: unknown, value: unknown, callback: (error?: Error) => void) => {
          if (typeof value === 'string' && value.includes(':') && value.includes('/')) {
            callback(new Error('IPv6 暂不支持 CIDR，请填写单个 IPv6 地址'));
            return;
          }
          callback();
        },
        trigger: 'blur'
      },
      { max: 64, message: 'IP 或 CIDR 不能超过 64 个字符', trigger: 'blur' }
    ],
    scope: [{ required: true, message: '请选择应用范围', trigger: 'change' }],
    remark: [{ max: 200, message: '说明不能超过 200 个字符', trigger: 'blur' }]
  };

  function setPolicyForm(next: PolicyFormModel) {
    Object.assign(policyForm, next);
    policyBaseline.value = JSON.stringify(next);
  }

  function openPolicySettings(settings: V2MfaSettings | null) {
    policyMutationError.value = '';
    setPolicyForm({
      enabled: Boolean(settings?.value.enabled),
      requiredForAdmins: Boolean(settings?.value.requiredForAdmins),
      issuer: settings?.value.issuer?.trim() || EMPTY_POLICY_FORM.issuer
    });
    policyDrawerVisible.value = true;
  }

  function setPolicyEnabled(enabled: boolean) {
    policyForm.enabled = enabled;
    if (!enabled) policyForm.requiredForAdmins = false;
  }

  async function submitPolicy(formInstance?: FormInstance) {
    if (!(await validateV2Form(formInstance))) return;
    if (policyForm.requiredForAdmins) {
      try {
        await ElMessageBox.confirm(
          '启用后，所有启用管理员都必须通过 MFA 才能登录。系统会先检查是否仍有未绑定的管理员。',
          '确认启用管理员强制 MFA',
          {
            confirmButtonText: '检查并启用',
            cancelButtonText: '取消',
            type: 'warning'
          }
        );
      } catch {
        return;
      }
    }

    policySaving.value = true;
    policyMutationError.value = '';
    try {
      await v2SecurityApi.updateMfaSettings({
        enabled: policyForm.enabled,
        requiredForAdmins: policyForm.requiredForAdmins,
        issuer: policyForm.issuer.trim()
      });
      policyDrawerVisible.value = false;
      ElMessage.success('MFA 策略已更新，并写入操作审计。');
      await refresh();
    } catch (error) {
      policyMutationError.value = getApiErrorMessage(error);
    } finally {
      policySaving.value = false;
    }
  }

  async function openMfaSetup() {
    mfaSetupLoading.value = true;
    mfaMutationError.value = '';
    try {
      mfaSetup.value = await v2SecurityApi.setupMyMfa();
      mfaCodeForm.code = '';
      mfaSetupVisible.value = true;
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      mfaSetupLoading.value = false;
    }
  }

  async function enableMyMfa(formInstance?: FormInstance) {
    if (!(await validateV2Form(formInstance))) return;
    mfaEnabling.value = true;
    mfaMutationError.value = '';
    try {
      const result = await v2SecurityApi.enableMyMfa({ code: mfaCodeForm.code.trim() });
      mfaSetupVisible.value = false;
      showRecoveryCodes(result.recoveryCodes);
      ElMessage.success('当前账号 MFA 已绑定。');
      await refresh();
    } catch (error) {
      mfaMutationError.value = getApiErrorMessage(error);
    } finally {
      mfaEnabling.value = false;
    }
  }

  async function regenerateRecoveryCodes() {
    let code: string;
    try {
      const result = await ElMessageBox.prompt(
        '旧恢复码会立即失效。请输入当前验证器中的 6 位动态验证码。',
        '重新生成恢复码',
        {
          confirmButtonText: '验证并重新生成',
          cancelButtonText: '取消',
          inputPattern: /^\d{6}$/,
          inputErrorMessage: '请输入 6 位数字动态验证码',
          inputType: 'text'
        }
      );
      code = result.value.trim();
    } catch {
      return;
    }

    try {
      const result = await v2SecurityApi.regenerateMyMfaRecoveryCodes({ code });
      showRecoveryCodes(result.recoveryCodes);
      ElMessage.success('恢复码已重新生成，旧恢复码已失效。');
      await refresh();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    }
  }

  async function disableMyMfa() {
    let code: string;
    try {
      const result = await ElMessageBox.prompt(
        '停用后账号将失去 MFA 保护。若管理员强制策略已启用，系统会拒绝本次操作。',
        '确认停用当前账号 MFA',
        {
          confirmButtonText: '验证并停用',
          cancelButtonText: '取消',
          type: 'warning',
          inputPattern: /^\d{6}$/,
          inputErrorMessage: '请输入 6 位数字动态验证码',
          inputType: 'text'
        }
      );
      code = result.value.trim();
    } catch {
      return;
    }

    try {
      await v2SecurityApi.disableMyMfa({ code, reason: 'self_service' });
      ElMessage.success('当前账号 MFA 已停用，并写入操作审计。');
      await refresh();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    }
  }

  async function resetUserMfa(item: V2MfaUserRecord) {
    try {
      await ElMessageBox.confirm(
        `确认重置 ${item.displayName}（${item.username}）的 MFA 吗？该用户现有密钥和恢复码会立即失效。`,
        '确认重置用户 MFA',
        {
          confirmButtonText: '确认重置',
          cancelButtonText: '取消',
          type: 'warning'
        }
      );
    } catch {
      return;
    }

    resettingMfaUserId.value = item.id;
    try {
      await v2SecurityApi.resetUserMfa(item.id);
      ElMessage.success('用户 MFA 已重置，并写入操作审计。');
      await refresh();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      resettingMfaUserId.value = '';
    }
  }

  function showRecoveryCodes(codes: string[]) {
    recoveryCodes.value = [...codes];
    recoveryCodesVisible.value = true;
  }

  function closeRecoveryCodes() {
    recoveryCodesVisible.value = false;
    recoveryCodes.value = [];
  }

  function setWhitelistForm(next: WhitelistFormModel) {
    Object.assign(whitelistForm, next);
    whitelistBaseline.value = JSON.stringify(next);
  }

  function openCreateWhitelist() {
    editingWhitelist.value = null;
    whitelistMutationError.value = '';
    setWhitelistForm({ ...EMPTY_WHITELIST_FORM });
    whitelistDrawerVisible.value = true;
  }

  function openEditWhitelist(item: V2IpWhitelistRecord) {
    editingWhitelist.value = item;
    whitelistMutationError.value = '';
    setWhitelistForm({
      ipOrCidr: item.ipOrCidr,
      scope: item.scope,
      enabled: item.enabled,
      remark: item.remark ?? ''
    });
    whitelistDrawerVisible.value = true;
  }

  async function submitWhitelist(formInstance?: FormInstance) {
    if (!(await validateV2Form(formInstance))) return;
    if (whitelistForm.enabled) {
      try {
        await ElMessageBox.confirm(
          '系统会校验修改后的启用规则是否仍包含当前请求 IP；若可能导致当前管理员被锁在系统外，本次保存会被拒绝。',
          '确认保存启用白名单',
          {
            confirmButtonText: '校验并保存',
            cancelButtonText: '取消',
            type: 'warning'
          }
        );
      } catch {
        return;
      }
    }

    whitelistSaving.value = true;
    whitelistMutationError.value = '';
    const input: V2SaveIpWhitelistInput = {
      ipOrCidr: whitelistForm.ipOrCidr.trim(),
      scope: whitelistForm.scope,
      enabled: whitelistForm.enabled,
      remark: whitelistForm.remark?.trim() || undefined
    };
    try {
      if (editingWhitelist.value) {
        await v2SecurityApi.updateIpWhitelist(editingWhitelist.value.id, input);
      } else {
        await v2SecurityApi.createIpWhitelist(input);
      }
      whitelistDrawerVisible.value = false;
      ElMessage.success('IP 白名单已保存，并写入操作审计。');
      await refresh();
    } catch (error) {
      whitelistMutationError.value = getApiErrorMessage(error);
    } finally {
      whitelistSaving.value = false;
    }
  }

  async function removeWhitelist(item: V2IpWhitelistRecord) {
    try {
      await ElMessageBox.confirm(
        `确认删除 ${item.ipOrCidr} 吗？系统会先确认剩余规则仍包含当前请求 IP。`,
        '确认删除 IP 白名单',
        {
          confirmButtonText: '校验并删除',
          cancelButtonText: '取消',
          type: 'warning'
        }
      );
    } catch {
      return;
    }

    removingWhitelistId.value = item.id;
    try {
      await v2SecurityApi.removeIpWhitelist(item.id);
      ElMessage.success('IP 白名单已删除，并写入操作审计。');
      await refresh();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      removingWhitelistId.value = '';
    }
  }

  watch(mfaSetupVisible, (visible) => {
    if (visible) return;
    mfaSetup.value = null;
    mfaCodeForm.code = '';
    mfaMutationError.value = '';
  });

  return {
    policyDrawerVisible,
    policySaving,
    policyMutationError,
    policyForm,
    policyDirty,
    policyRules,
    openPolicySettings,
    setPolicyEnabled,
    submitPolicy,
    mfaSetupVisible,
    mfaSetupLoading,
    mfaEnabling,
    mfaMutationError,
    mfaSetup,
    mfaCodeForm,
    mfaCodeRules,
    recoveryCodesVisible,
    recoveryCodes,
    resettingMfaUserId,
    openMfaSetup,
    enableMyMfa,
    regenerateRecoveryCodes,
    disableMyMfa,
    resetUserMfa,
    closeRecoveryCodes,
    whitelistDrawerVisible,
    editingWhitelist,
    whitelistSaving,
    whitelistMutationError,
    whitelistForm,
    whitelistDirty,
    whitelistRules,
    removingWhitelistId,
    openCreateWhitelist,
    openEditWhitelist,
    submitWhitelist,
    removeWhitelist
  };
}
