<template>
  <el-drawer
    class="v2-totp-drawer"
    :model-value="modelValue"
    title="在线计算 2FA 验证码"
    size="min(620px, 100%)"
    append-to-body
    destroy-on-close
    :before-close="handleBeforeClose"
    @close="$emit('update:modelValue', false)"
    @closed="clearAll"
  >
    <div class="v2-totp-drawer__body">
      <div class="v2-totp-security-status" role="status">
        <el-icon><Lock /></el-icon>
        <span>密钥仅在当前浏览器内存中计算</span>
        <small :class="{ 'is-warning': timeState === 'local' }">{{ timeStatusLabel }}</small>
      </div>

      <el-form
        label-position="left"
        label-width="86px"
        require-asterisk-position="right"
        class="v2-horizontal-form v2-totp-form"
        @submit.prevent
      >
        <el-form-item label="2FA 密钥" required>
          <div class="v2-totp-input">
            <div class="v2-totp-input__toolbar">
              <span>{{ inputLineCount }} / {{ V2_TOTP_INPUT_LIMITS.lines }} 行</span>
              <AppButton
                variant="ghost"
                icon-only
                size="small"
                :title="inputVisible ? '隐藏密钥' : '显示密钥'"
                @click="inputVisible = !inputVisible"
              >
                <el-icon><Hide v-if="inputVisible" /><View v-else /></el-icon>
              </AppButton>
            </div>
            <el-input
              v-model="secretInput"
              class="v2-totp-input__field"
              type="textarea"
              :rows="7"
              :maxlength="V2_TOTP_INPUT_LIMITS.length"
              resize="vertical"
              autocomplete="off"
              autocapitalize="off"
              autocorrect="off"
              :spellcheck="false"
              placeholder="每行一个 Base32 密钥、otpauth URI 或 UID|密码|2FA|邮箱..."
              :class="{ 'is-secret-masked': !inputVisible }"
            />
            <p class="v2-totp-input__note">
              <el-icon><InfoFilled /></el-icon>
              <span>仅校验密钥格式；计算结果不代表密钥已绑定账号。</span>
            </p>
          </div>
        </el-form-item>
      </el-form>

      <div class="v2-totp-actions">
        <AppButton variant="ghost" @click="clearAll">清空</AppButton>
        <AppButton variant="primary" @click="generateCodes">
          <el-icon><Key /></el-icon>
          计算验证码
        </AppButton>
      </div>

      <ul v-if="parseErrors.length" class="v2-totp-errors" role="alert">
        <li v-for="error in parseErrors" :key="`${error.lineNumber}-${error.message}`">
          {{ error.lineNumber ? `第 ${error.lineNumber} 行：` : '' }}{{ error.message }}
        </li>
      </ul>

      <section v-if="accounts.length" class="v2-totp-results" aria-live="polite">
        <header>
          <strong>当前验证码</strong>
          <span>{{ accounts.length }} 个有效密钥</span>
        </header>
        <ul>
          <li v-for="account in accounts" :key="account.id">
            <span class="v2-totp-result__line">第 {{ account.lineNumber }} 行</span>
            <span
              class="v2-totp-result__countdown"
              :class="{ 'is-expiring': codeFor(account.id).remainingSeconds <= 5 }"
            >
              {{ codeFor(account.id).remainingSeconds }} 秒
            </span>
            <output class="v2-totp-result__token" :aria-label="`第 ${account.lineNumber} 行验证码`">
              {{ formatToken(codeFor(account.id).token) }}
            </output>
            <AppButton
              class="v2-totp-result__copy"
              variant="primary"
              size="large"
              :aria-label="`复制第 ${account.lineNumber} 行验证码`"
              @click="copyCode(account.id, codeFor(account.id).token)"
            >
              <el-icon><CopyDocument /></el-icon>
              <span>{{ copiedAccountId === account.id ? '已复制' : '复制' }}</span>
            </AppButton>
          </li>
        </ul>
      </section>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import 'element-plus/es/components/message-box/style/css.mjs';
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { CopyDocument, Hide, InfoFilled, Key, Lock, View } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { getV2BusinessNowMs, synchronizeV2BusinessClock } from '@/v2/runtime/businessClock';
import {
  V2_TOTP_INPUT_LIMITS,
  generateV2TotpCodes,
  parseV2TotpInput,
  type V2TotpAccount,
  type V2TotpCodeResult,
  type V2TotpInputError
} from './totp';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    syncServerTime?: boolean;
  }>(),
  {
    syncServerTime: true
  }
);
defineEmits<{ 'update:modelValue': [value: boolean] }>();

const secretInput = ref('');
const inputVisible = ref(false);
const accounts = ref<V2TotpAccount[]>([]);
const parseErrors = ref<V2TotpInputError[]>([]);
const codes = ref<V2TotpCodeResult[]>([]);
const copiedAccountId = ref('');
const timeState = ref<'checking' | 'calibrated' | 'local'>('checking');
const inputLineCount = computed(() =>
  secretInput.value ? secretInput.value.split(/\r?\n/).length : 0
);
const timeStatusLabel = computed(() => {
  if (timeState.value === 'checking') return '正在校准时间';
  if (timeState.value === 'calibrated') return '时间已校准';
  return '使用本机时间，验证码可能不准确';
});
let timer: ReturnType<typeof setInterval> | undefined;
let copyFeedbackTimer: ReturnType<typeof setTimeout> | undefined;

watch(
  () => props.modelValue,
  (visible) => {
    if (!visible) return;
    void calibrateTime();
  }
);

watch(secretInput, () => {
  if (!accounts.value.length && !parseErrors.value.length) return;
  accounts.value = [];
  parseErrors.value = [];
  codes.value = [];
});

onMounted(() => {
  timer = setInterval(refreshCodes, 250);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
});

async function calibrateTime() {
  timeState.value = 'checking';
  if (!props.syncServerTime) {
    timeState.value = getV2BusinessNowMs() === null ? 'local' : 'calibrated';
    refreshCodes();
    return;
  }
  try {
    await synchronizeV2BusinessClock();
  } catch {
    // 仍可使用上一次成功校准的时间。
  }
  timeState.value = getV2BusinessNowMs() === null ? 'local' : 'calibrated';
  refreshCodes();
}

function generateCodes() {
  if (!secretInput.value.trim()) {
    accounts.value = [];
    codes.value = [];
    parseErrors.value = [{ lineNumber: 0, message: '请输入 2FA 密钥' }];
    return;
  }
  const result = parseV2TotpInput(secretInput.value);
  accounts.value = result.accounts;
  parseErrors.value = result.errors;
  refreshCodes();
}

function refreshCodes() {
  if (!accounts.value.length) return;
  codes.value = generateV2TotpCodes(accounts.value, getV2BusinessNowMs() ?? Date.now());
}

function codeFor(id: string): V2TotpCodeResult {
  return (
    codes.value.find((item) => item.id === id) ?? {
      id,
      token: '------',
      remainingSeconds: 0,
      progress: 0
    }
  );
}

function formatToken(token: string) {
  const splitAt = Math.ceil(token.length / 2);
  return `${token.slice(0, splitAt)} ${token.slice(splitAt)}`;
}

async function copyCode(accountId: string, token: string) {
  if (!/^\d{6,8}$/.test(token)) return;
  try {
    await navigator.clipboard.writeText(token);
    copiedAccountId.value = accountId;
    if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
    copyFeedbackTimer = setTimeout(() => {
      copiedAccountId.value = '';
    }, 1200);
    ElMessage.success('验证码已复制');
  } catch {
    ElMessage.error('无法复制验证码，请手动选择复制');
  }
}

function clearAll() {
  secretInput.value = '';
  accounts.value = [];
  parseErrors.value = [];
  codes.value = [];
  copiedAccountId.value = '';
  if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
  inputVisible.value = false;
}

async function handleBeforeClose(done: () => void) {
  if (!secretInput.value) {
    done();
    return;
  }
  try {
    await ElMessageBox.confirm('关闭后会立即清空已输入的 2FA 密钥和验证码。', '清空并关闭', {
      confirmButtonText: '清空并关闭',
      cancelButtonText: '继续使用',
      type: 'warning'
    });
    done();
  } catch {
    // 用户选择继续使用。
  }
}
</script>

<style>
.v2-totp-drawer .el-drawer__body {
  padding: 0;
}

.v2-totp-drawer__body {
  display: grid;
  min-width: 0;
  gap: 18px;
  padding: 20px;
}

.v2-totp-security-status {
  display: grid;
  min-width: 0;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--v3-success-border-soft);
  border-radius: 6px;
  background: var(--v3-success-soft);
  color: var(--v2-text);
  font-size: 13px;
}

.v2-totp-security-status small {
  color: var(--v2-success);
  white-space: nowrap;
}

.v2-totp-security-status small.is-warning {
  color: var(--v3-warning);
}

.v2-totp-form .el-form-item {
  display: grid;
  grid-template-columns: 86px minmax(0, 1fr);
  align-items: center;
  gap: 6px 0;
  margin-bottom: 0;
}

.v2-totp-form .el-form-item__label {
  grid-column: 1;
  grid-row: 1;
  width: 86px !important;
  height: 36px;
  align-items: center;
  padding-right: 8px;
  line-height: 20px;
}

.v2-totp-form .el-form-item__content {
  display: contents;
  margin-left: 0 !important;
}

.v2-totp-input {
  display: contents;
}

.v2-totp-input__toolbar {
  display: flex;
  grid-column: 2;
  grid-row: 1;
  min-width: 0;
  height: 36px;
  align-items: center;
  justify-content: space-between;
  color: var(--v2-text-soft);
  font-size: 12px;
}

.v2-totp-input__field {
  grid-column: 1 / -1;
  grid-row: 2;
  min-width: 0;
  width: 100%;
}

.v2-totp-input__note {
  display: flex;
  grid-column: 1 / -1;
  grid-row: 3;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 18px;
}

.v2-totp-input__note .el-icon {
  flex: 0 0 auto;
  margin-top: 1px;
}

.v2-totp-input .is-secret-masked textarea {
  -webkit-text-security: disc;
}

.v2-totp-input textarea {
  min-height: 168px !important;
  font-family: var(--v3-font-mono);
  line-height: 22px;
}

.v2-totp-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.v2-totp-errors {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 10px 12px 10px 32px;
  border: 1px solid var(--v3-danger-border-soft);
  border-radius: 6px;
  background: var(--v3-danger-soft);
  color: var(--v2-danger);
  font-size: 13px;
}

.v2-totp-results {
  display: grid;
  min-width: 0;
  gap: 10px;
  padding-top: 4px;
}

.v2-totp-results > header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.v2-totp-results > header strong {
  color: var(--v2-text);
  font-size: 15px;
}

.v2-totp-results > header span {
  color: var(--v2-text-soft);
  font-size: 12px;
}

.v2-totp-results > ul {
  display: grid;
  gap: 0;
  overflow: hidden;
  margin: 0;
  padding: 0;
  border: 1px solid var(--v2-border);
  border-radius: 7px;
  background: var(--v2-surface);
  list-style: none;
}

.v2-totp-results > ul > li {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(70px, 1fr) 62px minmax(116px, auto) 94px;
  align-items: center;
  gap: 12px;
  min-height: 62px;
  padding: 9px 12px;
  background: var(--v2-surface);
}

.v2-totp-results > ul > li + li {
  border-top: 1px solid var(--v2-border);
}

.v2-totp-result__line {
  overflow: hidden;
  color: var(--v2-text);
  font-size: 14px;
  font-weight: var(--v3-font-weight-semibold);
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.v2-totp-result__countdown {
  color: var(--v2-text-soft);
  font-family: var(--v3-font-mono);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  line-height: 20px;
  text-align: right;
  white-space: nowrap;
}

.v2-totp-result__countdown.is-expiring {
  color: var(--v3-warning);
  font-weight: var(--v3-font-weight-semibold);
}

.v2-totp-result__token {
  display: block;
  min-width: 0;
  color: var(--v2-text);
  font-family: var(--v3-font-mono);
  font-size: 26px;
  font-weight: var(--v3-font-weight-bold);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0;
  line-height: 34px;
  text-align: right;
  white-space: nowrap;
}

.v2-totp-result__copy.app-button.el-button {
  width: 94px;
  min-height: 44px;
  justify-self: end;
}

@media (max-width: 520px) {
  .v2-totp-drawer__body {
    padding: 16px;
  }

  .v2-totp-security-status {
    grid-template-columns: 20px minmax(0, 1fr);
  }

  .v2-totp-security-status small {
    grid-column: 2;
    white-space: normal;
  }

  .v2-totp-results > ul > li {
    grid-template-columns: minmax(54px, 1fr) 46px minmax(88px, auto) 76px;
    gap: 6px;
    min-height: 62px;
    padding: 9px 10px;
  }

  .v2-totp-result__line,
  .v2-totp-result__countdown {
    font-size: 12px;
  }

  .v2-totp-result__token {
    font-size: 21px;
    line-height: 30px;
  }

  .v2-totp-result__copy.app-button.el-button {
    width: 76px;
    padding-right: 8px;
    padding-left: 8px;
  }
}
</style>
