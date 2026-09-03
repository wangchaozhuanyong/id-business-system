<template>
  <el-drawer
    class="v2-website-monitor-drawer"
    :model-value="modelValue"
    title="网站监控"
    size="min(720px, 100vw)"
    append-to-body
    close-on-click-modal
    close-on-press-escape
    :before-close="handleBeforeClose"
    @closed="resetState"
    @close="$emit('update:modelValue', false)"
  >
    <div class="v2-website-monitor-drawer__body">
      <div class="v2-website-monitor-disclosure" role="note">
        <el-icon><Lock /></el-icon>
        <span>
          <strong>只检测可公开访问的网站</strong>
          <small>
            已保存 FLASH CAST 装修网站；检测 HTTP 状态、响应时间、跳转链和 HTTPS
            证书，不访问内网地址或保存检测历史。
          </small>
        </span>
      </div>

      <el-form
        label-position="left"
        label-width="82px"
        require-asterisk-position="right"
        class="v2-horizontal-form v2-website-monitor-form"
        @submit.prevent="checkWebsite"
      >
        <el-form-item label="网站地址" required>
          <div class="v2-website-monitor-input">
            <el-input
              v-model="websiteUrl"
              :maxlength="V2_WEBSITE_MONITOR_LIMITS.url"
              clearable
              inputmode="url"
              autocomplete="url"
              placeholder="例如 example.com 或 https://example.com/health"
              :disabled="checking"
              @keyup.enter="checkWebsite"
            />
            <small>默认检测 FLASH CAST 装修网站，也可临时改为其他公开网址。</small>
          </div>
        </el-form-item>

        <div class="v2-website-monitor-submit">
          <AppButton native-type="submit" variant="primary" :loading="checking">
            <el-icon v-if="!checking"><Search /></el-icon>
            {{ checking ? '正在检测' : '立即检测' }}
          </AppButton>
        </div>
      </el-form>

      <div v-if="errorMessage" class="v2-website-monitor-error" role="alert">
        <el-icon><WarningFilled /></el-icon>
        <span>{{ errorMessage }}</span>
        <AppButton size="small" variant="soft" :disabled="checking" @click="checkWebsite">
          重新检测
        </AppButton>
      </div>

      <section class="v2-website-monitor-result" aria-live="polite" :aria-busy="checking">
        <div v-if="checking" class="v2-website-monitor-state">
          <span class="v2-website-monitor-state__progress" aria-hidden="true" />
          <el-icon><Monitor /></el-icon>
          <strong>正在连接网站并读取运行状态</strong>
          <small>检测最多跟随 {{ V2_WEBSITE_MONITOR_LIMITS.redirects }} 次安全跳转。</small>
        </div>

        <article v-else-if="result" class="v2-website-monitor-card">
          <header>
            <span class="v2-website-monitor-status" :class="`is-${result.status}`">
              <i aria-hidden="true" />
              {{ statusLabel(result.status) }}
            </span>
            <small>检测于 {{ formatV2DateTime(result.checkedAt) }}</small>
          </header>

          <div class="v2-website-monitor-card__summary">
            <div>
              <strong>{{ result.message }}</strong>
              <span :title="result.finalUrl">{{ result.finalUrl }}</span>
            </div>
            <AppButton variant="ghost" size="small" :disabled="checking" @click="checkWebsite">
              <el-icon><Refresh /></el-icon>
              再次检测
            </AppButton>
          </div>

          <dl class="v2-website-monitor-metrics">
            <div>
              <dt>HTTP 状态</dt>
              <dd>{{ result.statusCode ?? '未响应' }}</dd>
            </div>
            <div>
              <dt>总响应时间</dt>
              <dd>{{ responseTimeLabel(result.responseTimeMs) }}</dd>
            </div>
            <div>
              <dt>跳转次数</dt>
              <dd>{{ Math.max(0, result.hops.length - 1) }}</dd>
            </div>
          </dl>

          <section class="v2-website-monitor-certificate" aria-label="HTTPS 证书状态">
            <el-icon><CircleCheck v-if="result.tls?.authorized" /><Lock v-else /></el-icon>
            <span>
              <strong>{{ certificateTitle(result.tls) }}</strong>
              <small>{{ certificateDescription(result.tls) }}</small>
            </span>
          </section>

          <ol v-if="result.hops.length > 1" class="v2-website-monitor-hops" aria-label="网站跳转链">
            <li v-for="(hop, index) in result.hops" :key="`${hop.url}-${index}`">
              <span>{{ index + 1 }}</span>
              <div>
                <strong>{{ hop.statusCode }} · {{ hop.durationMs }} 毫秒</strong>
                <small :title="hop.url">{{ hop.url }}</small>
              </div>
            </li>
          </ol>
        </article>

        <div v-else class="v2-website-monitor-state is-empty">
          <el-icon><Monitor /></el-icon>
          <strong>FLASH CAST 装修网站已保存</strong>
          <small>点击“立即检测”开始检查；结果在关闭抽屉后自动清空。</small>
        </div>
      </section>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import {
  CircleCheck,
  Lock,
  Monitor,
  Refresh,
  Search,
  WarningFilled
} from '@element-plus/icons-vue';
import {
  V2_WEBSITE_MONITOR_LIMITS,
  type V2WebsiteMonitorResult,
  type V2WebsiteMonitorStatus,
  type V2WebsiteMonitorTls
} from '@apple-business/shared';
import { ElMessageBox } from 'element-plus';
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage } from '@/api/client';
import { idBusinessV2WorkspaceApi } from '@/v2/api/workspace';
import { formatV2DateTime } from '@/v2/utils/dateTime';

defineProps<{ modelValue: boolean }>();
defineEmits<{ 'update:modelValue': [value: boolean] }>();

const DEFAULT_WEBSITE_MONITOR_URL = 'https://flashcast.com.my';
const websiteUrl = ref(DEFAULT_WEBSITE_MONITOR_URL);
const checking = ref(false);
const errorMessage = ref('');
const result = ref<V2WebsiteMonitorResult | null>(null);
let activeController: AbortController | null = null;

async function checkWebsite() {
  if (checking.value) return;
  const url = websiteUrl.value.trim();
  if (!url) {
    errorMessage.value = '请先输入要检测的网站地址';
    return;
  }
  errorMessage.value = '';
  checking.value = true;
  const controller = new AbortController();
  activeController = controller;
  try {
    result.value = await idBusinessV2WorkspaceApi.checkWebsite(
      { url },
      { signal: controller.signal }
    );
  } catch (cause) {
    if (!controller.signal.aborted) errorMessage.value = getApiErrorMessage(cause);
  } finally {
    checking.value = false;
    if (activeController === controller) activeController = null;
  }
}

async function handleBeforeClose(done: () => void) {
  if (!checking.value) return done();
  try {
    await ElMessageBox.confirm('网站检测仍在进行，关闭后将取消本次检测。', '确认关闭', {
      confirmButtonText: '取消检测并关闭',
      cancelButtonText: '继续等待',
      type: 'warning'
    });
    activeController?.abort();
    done();
  } catch {
    // Continue the current check.
  }
}

function resetState() {
  activeController?.abort();
  activeController = null;
  websiteUrl.value = DEFAULT_WEBSITE_MONITOR_URL;
  checking.value = false;
  errorMessage.value = '';
  result.value = null;
}

function statusLabel(status: V2WebsiteMonitorStatus) {
  const labels: Record<V2WebsiteMonitorStatus, string> = {
    down: '访问异常',
    healthy: '运行正常',
    warning: '需要关注'
  };
  return labels[status];
}

function responseTimeLabel(value: number | null) {
  return value === null ? '—' : `${value} 毫秒`;
}

function certificateTitle(tls: V2WebsiteMonitorTls | null) {
  if (!tls) return '当前地址未使用 HTTPS';
  return tls.authorized ? 'HTTPS 证书有效' : 'HTTPS 证书异常';
}

function certificateDescription(tls: V2WebsiteMonitorTls | null) {
  if (!tls) return '建议启用 HTTPS 保护传输内容';
  if (!tls.authorized) return '证书已过期、不受信任或与域名不匹配';
  const expiry = tls.expiresAt
    ? formatV2DateTime(tls.expiresAt, { hour: undefined, minute: undefined })
    : '未知日期';
  const remaining = tls.daysRemaining === null ? '剩余天数未知' : `剩余 ${tls.daysRemaining} 天`;
  return `${tls.protocol || 'TLS'} · ${expiry} 到期 · ${remaining}`;
}
</script>

<style>
.v2-website-monitor-drawer .el-drawer__body {
  padding: 0;
}

.v2-website-monitor-drawer .el-drawer__header {
  margin-bottom: 0;
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--v2-border);
}

.v2-website-monitor-drawer__body {
  display: grid;
  min-width: 0;
  gap: 16px;
  padding: 18px 20px 22px;
}

.v2-website-monitor-disclosure,
.v2-website-monitor-certificate {
  display: grid;
  min-width: 0;
  grid-template-columns: 20px minmax(0, 1fr);
  align-items: start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--v3-info-border-soft);
  border-radius: 7px;
  background: var(--v3-info-soft);
  color: var(--v3-info);
}

.v2-website-monitor-disclosure > span,
.v2-website-monitor-certificate > span {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.v2-website-monitor-disclosure strong,
.v2-website-monitor-disclosure small,
.v2-website-monitor-certificate strong,
.v2-website-monitor-certificate small {
  overflow-wrap: anywhere;
  line-height: 20px;
}

.v2-website-monitor-disclosure strong,
.v2-website-monitor-certificate strong {
  color: var(--v2-text);
  font-size: 13px;
}

.v2-website-monitor-disclosure small,
.v2-website-monitor-certificate small {
  color: var(--v2-text-soft);
  font-size: 12px;
}

.v2-website-monitor-form {
  padding: 14px 14px 12px;
  border: 1px solid var(--v2-border);
  border-radius: 8px;
  background: var(--v2-surface);
}

.v2-website-monitor-form .el-form-item {
  margin-bottom: 12px;
}

.v2-website-monitor-input {
  display: grid;
  width: 100%;
  min-width: 0;
  gap: 6px;
}

.v2-website-monitor-input > small {
  color: var(--v2-text-soft);
  font-size: 11px;
  line-height: 18px;
}

.v2-website-monitor-submit {
  display: flex;
  justify-content: flex-end;
  padding-left: 82px;
}

.v2-website-monitor-error {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--v3-danger-border-soft);
  border-radius: 7px;
  background: var(--v3-danger-soft);
  color: var(--v3-danger);
  font-size: 12px;
}

.v2-website-monitor-result {
  position: relative;
  min-height: 326px;
  overflow: hidden;
  border: 1px solid var(--v2-border);
  border-radius: 8px;
  background: var(--v2-surface-muted);
}

.v2-website-monitor-state {
  display: grid;
  min-height: 324px;
  place-content: center;
  justify-items: center;
  gap: 8px;
  padding: 28px;
  text-align: center;
}

.v2-website-monitor-state > .el-icon {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  border-radius: 8px;
  background: var(--v2-accent-soft);
  color: var(--v2-accent);
  font-size: 22px;
}

.v2-website-monitor-state strong {
  color: var(--v2-text);
  font-size: 14px;
  line-height: 22px;
}

.v2-website-monitor-state small {
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 19px;
}

.v2-website-monitor-state__progress {
  position: absolute;
  top: 0;
  left: 0;
  width: 42%;
  height: 2px;
  background: var(--v2-accent-solid);
  animation: v2-website-monitor-progress 1.2s ease-in-out infinite;
}

.v2-website-monitor-card {
  display: grid;
  min-width: 0;
}

.v2-website-monitor-card > header,
.v2-website-monitor-card__summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--v2-border-soft);
  background: var(--v2-surface);
}

.v2-website-monitor-card > header > small {
  color: var(--v2-text-soft);
  font-size: 11px;
}

.v2-website-monitor-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border: 1px solid var(--v2-border);
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
  line-height: 18px;
}

.v2-website-monitor-status > i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}

.v2-website-monitor-status.is-healthy {
  border-color: var(--v3-success-border-soft);
  background: var(--v3-success-soft);
  color: var(--v3-success);
}

.v2-website-monitor-status.is-warning {
  border-color: var(--v3-warning-border-soft);
  background: var(--v3-warning-soft);
  color: var(--v3-warning);
}

.v2-website-monitor-status.is-down {
  border-color: var(--v3-danger-border-soft);
  background: var(--v3-danger-soft);
  color: var(--v3-danger);
}

.v2-website-monitor-card__summary {
  padding-block: 14px;
  background: transparent;
}

.v2-website-monitor-card__summary > div {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.v2-website-monitor-card__summary strong {
  color: var(--v2-text);
  font-size: 14px;
  line-height: 22px;
}

.v2-website-monitor-card__summary span {
  overflow: hidden;
  color: var(--v2-text-soft);
  font-family: var(--v3-font-mono);
  font-size: 11px;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.v2-website-monitor-metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1px;
  margin: 0;
  border-bottom: 1px solid var(--v2-border-soft);
  background: var(--v2-border-soft);
}

.v2-website-monitor-metrics > div {
  display: grid;
  gap: 4px;
  padding: 13px 14px;
  background: var(--v2-surface);
}

.v2-website-monitor-metrics dt {
  color: var(--v2-text-soft);
  font-size: 11px;
  line-height: 18px;
}

.v2-website-monitor-metrics dd {
  margin: 0;
  color: var(--v2-text);
  font-size: 15px;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  line-height: 22px;
}

.v2-website-monitor-certificate {
  margin: 14px;
  border-color: var(--v2-border);
  background: var(--v2-surface);
}

.v2-website-monitor-hops {
  display: grid;
  gap: 0;
  margin: 0 14px 14px;
  padding: 0;
  list-style: none;
}

.v2-website-monitor-hops > li {
  display: grid;
  min-width: 0;
  grid-template-columns: 24px minmax(0, 1fr);
  align-items: start;
  gap: 8px;
  padding: 8px 0;
  border-top: 1px solid var(--v2-border-soft);
}

.v2-website-monitor-hops > li > span {
  display: grid;
  width: 20px;
  height: 20px;
  place-items: center;
  border-radius: 50%;
  background: var(--v2-accent-soft);
  color: var(--v2-accent);
  font-size: 10px;
  font-weight: 700;
}

.v2-website-monitor-hops > li > div {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.v2-website-monitor-hops strong {
  color: var(--v2-text);
  font-size: 12px;
  line-height: 18px;
}

.v2-website-monitor-hops small {
  overflow: hidden;
  color: var(--v2-text-soft);
  font-family: var(--v3-font-mono);
  font-size: 11px;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@keyframes v2-website-monitor-progress {
  0% {
    transform: translateX(-110%);
  }
  100% {
    transform: translateX(340%);
  }
}

@media (max-width: 560px) {
  .v2-website-monitor-drawer__body {
    gap: 12px;
    padding: 14px;
  }

  .v2-website-monitor-form {
    padding: 12px;
  }

  .v2-website-monitor-form .el-form-item__label {
    width: 72px !important;
    padding-right: 8px;
  }

  .v2-website-monitor-submit {
    padding-left: 72px;
  }

  .v2-website-monitor-error {
    grid-template-columns: 20px minmax(0, 1fr);
  }

  .v2-website-monitor-error .app-button {
    grid-column: 2;
    justify-self: start;
  }

  .v2-website-monitor-card__summary {
    align-items: start;
  }

  .v2-website-monitor-metrics {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .v2-website-monitor-state__progress {
    animation: none;
  }
}
</style>
