<template>
  <el-drawer
    class="v2-totp-drawer"
    :model-value="modelValue"
    title="2FA 动态验证码"
    size="min(640px, 100%)"
    append-to-body
    close-on-click-modal
    close-on-press-escape
    @close="$emit('update:modelValue', false)"
  >
    <template #header>
      <div class="v2-totp-drawer__header">
        <h2>2FA 动态验证码</h2>
        <span
          class="v2-totp-time-status"
          :class="{ 'is-warning': timeState === 'local' }"
          role="status"
        >
          <el-icon><Timer /></el-icon>
          {{ timeStatusLabel }}
        </span>
      </div>
    </template>

    <div class="v2-totp-drawer__body">
      <el-radio-group v-model="inputMode" class="v2-totp-mode" aria-label="验证码查询方式">
        <el-radio-button value="single">单个查询</el-radio-button>
        <el-radio-button value="batch">批量查询</el-radio-button>
      </el-radio-group>

      <el-form
        label-position="left"
        label-width="86px"
        require-asterisk-position="right"
        class="v2-horizontal-form v2-totp-form"
        @submit.prevent="generateCodes"
      >
        <el-form-item :label="inputMode === 'single' ? '2FA 密钥' : '批量密钥'" required>
          <div v-if="inputMode === 'single'" class="v2-totp-quick-query">
            <el-input
              v-model="secretInput"
              class="v2-totp-quick-query__input"
              :type="inputVisible ? 'text' : 'password'"
              :maxlength="V2_TOTP_INPUT_LIMITS.length"
              autocomplete="new-password"
              autocapitalize="off"
              autocorrect="off"
              data-1p-ignore="true"
              data-lpignore="true"
              :spellcheck="false"
              placeholder="粘贴 Base32 密钥或 otpauth URI"
              clearable
              @paste="handleSinglePaste"
              @keyup.enter="generateCodes"
            />
            <AppButton
              variant="soft"
              class="v2-totp-paste-button"
              :aria-label="inputVisible ? '隐藏密钥' : '显示密钥'"
              :title="inputVisible ? '隐藏密钥' : '显示密钥'"
              @click="inputVisible = !inputVisible"
            >
              <el-icon><Hide v-if="inputVisible" /><View v-else /></el-icon>
            </AppButton>
            <AppButton variant="soft" class="v2-totp-paste-button" @click="pasteInput">
              <el-icon><CopyDocument /></el-icon>
              一键粘贴
            </AppButton>
          </div>

          <div v-else class="v2-totp-batch-input">
            <div class="v2-totp-batch-input__toolbar">
              <span>{{ inputLineCount }} / {{ V2_TOTP_INPUT_LIMITS.lines }} 行</span>
              <div>
                <AppButton variant="ghost" size="small" @click="pasteInput">
                  <el-icon><CopyDocument /></el-icon>
                  粘贴
                </AppButton>
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
            </div>
            <el-input
              v-model="secretInput"
              class="v2-totp-batch-input__field"
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
          </div>

          <p class="v2-totp-input-note">
            <el-icon><InfoFilled /></el-icon>
            <span v-if="inputMode === 'single'">
              粘贴后自动生成；支持 Base32 密钥和标准 otpauth TOTP 链接。
            </span>
            <span v-else>支持每行一个密钥；无效行会单独提示，不影响其他有效结果。</span>
          </p>
        </el-form-item>
      </el-form>

      <div v-if="inputMode === 'batch'" class="v2-totp-actions">
        <AppButton variant="ghost" @click="clearAll">
          <el-icon><Delete /></el-icon>
          清空
        </AppButton>
        <AppButton variant="primary" @click="generateCodes">
          <el-icon><Key /></el-icon>
          查询验证码
        </AppButton>
      </div>

      <section v-if="parseErrors.length" class="v2-totp-error-panel" role="alert">
        <strong>
          {{
            accounts.length
              ? `已生成 ${accounts.length} 个结果，另有以下输入无效`
              : '无法生成验证码'
          }}
        </strong>
        <ul>
          <li v-for="error in parseErrors" :key="`${error.lineNumber}-${error.message}`">
            {{ error.lineNumber ? `第 ${error.lineNumber} 行：` : '' }}{{ error.message }}
          </li>
        </ul>
      </section>

      <section v-if="accounts.length" class="v2-totp-results" aria-live="polite">
        <header>
          <div>
            <strong>临时查询验证码</strong>
            <p>仅当前页面使用，验证码会按服务设置的周期自动刷新</p>
          </div>
          <span>{{ accounts.length }} 个有效结果</span>
        </header>
        <ul>
          <li v-for="account in accounts" :key="account.id" class="v2-totp-result-card">
            <div class="v2-totp-result-card__head">
              <div>
                <strong>{{ resultLabel(account) }}</strong>
                <span>{{ resultMeta(account) }}</span>
              </div>
              <span
                class="v2-totp-result__countdown"
                :class="{ 'is-expiring': codeFor(account.id).remainingSeconds <= 5 }"
              >
                {{ codeFor(account.id).remainingSeconds }} 秒后刷新
              </span>
            </div>

            <div class="v2-totp-result-card__value">
              <output
                class="v2-totp-result__token"
                :aria-label="`${resultLabel(account)}，当前验证码`"
              >
                {{ formatToken(codeFor(account.id).token) }}
              </output>
              <AppButton
                class="v2-totp-result__copy"
                variant="primary"
                size="large"
                :aria-label="`复制${resultLabel(account)}的当前验证码`"
                @click="copyCode(account.id, codeFor(account.id).token)"
              >
                <el-icon><CopyDocument /></el-icon>
                <span>{{ copiedAccountId === account.id ? '已复制' : '复制验证码' }}</span>
              </AppButton>
            </div>

            <div
              class="v2-totp-result__progress"
              :class="{ 'is-expiring': codeFor(account.id).remainingSeconds <= 5 }"
              role="progressbar"
              aria-label="验证码剩余有效时间"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-valuenow="Math.round(codeFor(account.id).progress)"
            >
              <span :style="{ width: `${codeFor(account.id).progress}%` }" />
            </div>
          </li>
        </ul>
      </section>

      <V2SavedTotpAccounts v-if="syncServerTime" ref="savedAccountsRef" :active="modelValue" />
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { CopyDocument, Delete, Hide, InfoFilled, Key, Timer, View } from '@element-plus/icons-vue';
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
import V2SavedTotpAccounts from './V2SavedTotpAccounts.vue';

type TotpInputMode = 'single' | 'batch';

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

const inputMode = ref<TotpInputMode>('single');
const secretInput = ref('');
const inputVisible = ref(false);
const accounts = ref<V2TotpAccount[]>([]);
const parseErrors = ref<V2TotpInputError[]>([]);
const codes = ref<V2TotpCodeResult[]>([]);
const copiedAccountId = ref('');
const savedAccountsRef = ref<InstanceType<typeof V2SavedTotpAccounts>>();
const timeState = ref<'checking' | 'calibrated' | 'local'>('checking');
const inputLineCount = computed(() =>
  secretInput.value ? secretInput.value.split(/\r?\n/).length : 0
);
const timeStatusLabel = computed(() => {
  if (timeState.value === 'checking') return '正在校准时间';
  if (timeState.value === 'calibrated') return '时间已校准';
  return '使用本机时间';
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

watch([secretInput, inputMode], clearResults, { flush: 'sync' });

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
  const normalizedInput = secretInput.value.trim();
  if (!normalizedInput) {
    clearResults();
    parseErrors.value = [{ lineNumber: 0, message: '请输入 2FA 密钥' }];
    return;
  }

  if (inputMode.value === 'single' && normalizedInput.split(/\r?\n/).filter(Boolean).length > 1) {
    clearResults();
    parseErrors.value = [{ lineNumber: 0, message: '单个查询一次只能处理一行，请切换到批量查询' }];
    return;
  }

  const result = parseV2TotpInput(normalizedInput);
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

function resultLabel(account: V2TotpAccount) {
  if (account.label !== `第 ${account.lineNumber} 行`) return account.label;
  return inputMode.value === 'single' ? '动态验证码' : account.label;
}

function resultMeta(account: V2TotpAccount) {
  const configuration = `${account.algorithm} · ${account.digits} 位 · ${account.period} 秒周期`;
  return account.issuer ? `${account.issuer} · ${configuration}` : configuration;
}

function formatToken(token: string) {
  const splitAt = Math.ceil(token.length / 2);
  return `${token.slice(0, splitAt)} ${token.slice(splitAt)}`;
}

function applyPastedInput(clipboardText: string) {
  const normalizedInput = clipboardText.trim();
  if (!normalizedInput) {
    ElMessage.warning('剪贴板中没有可用内容');
    return;
  }
  if (clipboardText.length > V2_TOTP_INPUT_LIMITS.length) {
    ElMessage.error(`剪贴板内容不能超过 ${V2_TOTP_INPUT_LIMITS.length} 个字符`);
    return;
  }
  secretInput.value = normalizedInput;
  generateCodes();
}

function handleSinglePaste(event: ClipboardEvent) {
  const clipboardText = event.clipboardData?.getData('text') ?? '';
  if (!clipboardText) return;
  event.preventDefault();
  applyPastedInput(clipboardText);
}

async function pasteInput() {
  try {
    const clipboardText = await navigator.clipboard.readText();
    applyPastedInput(clipboardText);
  } catch {
    ElMessage.warning('浏览器未允许读取剪贴板，请手动粘贴');
  }
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

function clearResults() {
  accounts.value = [];
  parseErrors.value = [];
  codes.value = [];
  copiedAccountId.value = '';
}

function clearAll() {
  secretInput.value = '';
  clearResults();
  if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
  inputVisible.value = false;
  inputMode.value = 'single';
  savedAccountsRef.value?.clearAll();
}
</script>

<style>
.v2-totp-drawer .el-drawer__body {
  padding: 0;
}

.v2-totp-drawer__header {
  display: flex;
  min-width: 0;
  width: 100%;
  align-items: center;
  gap: 12px;
}

.v2-totp-drawer__header h2 {
  min-width: 0;
  margin: 0;
  color: var(--v2-text);
  font-size: 16px;
  font-weight: var(--v3-font-weight-semibold);
  line-height: 24px;
}

.v2-totp-drawer__body {
  display: grid;
  min-width: 0;
  gap: 18px;
  padding: 20px;
}

.v2-totp-time-status {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 5px;
  margin-left: auto;
  color: var(--v2-success);
  font-size: 12px;
  white-space: nowrap;
}

.v2-totp-time-status.is-warning {
  color: var(--v3-warning);
}

.v2-totp-mode {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  width: 100%;
}

.v2-totp-mode .el-radio-button {
  width: 100%;
}

.v2-totp-mode .el-radio-button__inner {
  width: 100%;
  min-height: 38px;
}

.v2-totp-form .el-form-item {
  display: grid;
  grid-template-columns: 86px minmax(0, 1fr);
  align-items: start;
  gap: 8px 0;
  margin-bottom: 0;
}

.v2-totp-form .el-form-item__label {
  grid-column: 1;
  width: 86px !important;
  height: 40px;
  align-items: center;
  padding-right: 8px;
  line-height: 20px;
}

.v2-totp-form .el-form-item__content {
  display: contents;
  margin-left: 0 !important;
}

.v2-totp-quick-query,
.v2-totp-batch-input {
  grid-column: 2;
  min-width: 0;
}

.v2-totp-quick-query {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 8px;
}

.v2-totp-quick-query__input {
  min-width: 0;
}

.v2-totp-paste-button.app-button.el-button {
  min-height: 40px;
}

.v2-totp-batch-input {
  display: grid;
  gap: 6px;
}

.v2-totp-batch-input__toolbar {
  display: flex;
  min-width: 0;
  min-height: 32px;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--v2-text-soft);
  font-size: 12px;
}

.v2-totp-batch-input__toolbar > div {
  display: flex;
  align-items: center;
  gap: 2px;
}

.v2-totp-batch-input__field {
  min-width: 0;
  width: 100%;
}

.v2-totp-batch-input .is-secret-masked textarea {
  -webkit-text-security: disc;
}

.v2-totp-batch-input textarea {
  min-height: 168px !important;
  font-family: var(--v3-font-mono);
  line-height: 22px;
}

.v2-totp-input-note {
  display: flex;
  grid-column: 2;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 18px;
}

.v2-totp-input-note .el-icon {
  flex: 0 0 auto;
  margin-top: 1px;
}

.v2-totp-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.v2-totp-error-panel {
  display: grid;
  gap: 6px;
  padding: 11px 12px;
  border: 1px solid var(--v3-danger-border-soft);
  border-radius: 8px;
  background: var(--v3-danger-soft);
  color: var(--v2-danger);
  font-size: 13px;
}

.v2-totp-error-panel strong {
  line-height: 20px;
}

.v2-totp-error-panel ul {
  display: grid;
  gap: 3px;
  margin: 0;
  padding-left: 20px;
}

.v2-totp-results {
  display: grid;
  min-width: 0;
  gap: 12px;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--v2-accent) 34%, var(--v2-border));
  border-left: 3px solid var(--v2-accent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--v2-accent) 5%, var(--v2-surface));
}

.v2-totp-results > header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
}

.v2-totp-results > header strong {
  color: var(--v2-accent);
  font-size: 15px;
  line-height: 22px;
}

.v2-totp-results > header p,
.v2-totp-results > header > span {
  margin: 1px 0 0;
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 18px;
}

.v2-totp-results > header > span {
  flex: 0 0 auto;
}

.v2-totp-results > ul {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.v2-totp-result-card {
  display: grid;
  min-width: 0;
  gap: 14px;
  padding: 15px;
  border: 1px solid color-mix(in srgb, var(--v2-accent) 28%, var(--v2-border));
  border-radius: 9px;
  background: color-mix(in srgb, var(--v2-accent) 6%, var(--v2-surface));
  box-shadow: var(--v3-shadow-sm);
}

.v2-totp-result-card__head {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.v2-totp-result-card__head > div {
  display: grid;
  min-width: 0;
  gap: 1px;
}

.v2-totp-result-card__head strong {
  overflow: hidden;
  color: var(--v2-text);
  font-size: 14px;
  font-weight: var(--v3-font-weight-semibold);
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.v2-totp-result-card__head span {
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 18px;
}

.v2-totp-result__countdown {
  flex: 0 0 auto;
  font-family: var(--v3-font-mono);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.v2-totp-result__countdown.is-expiring {
  color: var(--v3-warning);
  font-weight: var(--v3-font-weight-semibold);
}

.v2-totp-result-card__value {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 16px;
}

.v2-totp-result__token {
  display: block;
  min-width: 0;
  color: var(--v2-accent);
  font-family: var(--v3-font-mono);
  font-size: 38px;
  font-weight: var(--v3-font-weight-bold);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
  line-height: 46px;
  white-space: nowrap;
}

.v2-totp-result__copy.app-button.el-button {
  min-width: 124px;
  min-height: 44px;
}

.v2-totp-result__progress {
  width: 100%;
  height: 5px;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--v2-border) 75%, transparent);
}

.v2-totp-result__progress > span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--v2-accent);
  transition: width 220ms linear;
}

.v2-totp-result__progress.is-expiring > span {
  background: var(--v3-warning);
}

@media (max-width: 520px) {
  .v2-totp-drawer__body {
    gap: 16px;
    padding: 16px;
  }

  .v2-totp-form .el-form-item {
    grid-template-columns: 78px minmax(0, 1fr);
  }

  .v2-totp-form .el-form-item__label {
    width: 78px !important;
  }

  .v2-totp-quick-query {
    grid-template-columns: minmax(0, 1fr) 104px;
  }

  .v2-totp-paste-button.app-button.el-button {
    width: 100%;
  }

  .v2-totp-quick-query__input {
    grid-column: 1;
  }

  .v2-totp-quick-query .v2-totp-paste-button:first-of-type {
    grid-column: 2;
    width: 40px;
    justify-self: end;
  }

  .v2-totp-quick-query .v2-totp-paste-button:nth-of-type(2) {
    grid-column: 1 / -1;
  }

  .v2-totp-results > header {
    align-items: flex-start;
  }

  .v2-totp-result-card {
    gap: 12px;
    padding: 13px;
  }

  .v2-totp-result-card__value {
    grid-template-columns: minmax(0, 1fr) 104px;
    gap: 10px;
  }

  .v2-totp-result__token {
    font-size: 27px;
    line-height: 38px;
  }

  .v2-totp-result__copy.app-button.el-button {
    min-width: 104px;
    padding-right: 10px;
    padding-left: 10px;
  }
}
</style>
