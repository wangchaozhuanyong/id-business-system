<template>
  <el-drawer
    class="v2-media-resolver-drawer"
    :model-value="modelValue"
    title="抖音解析"
    size="min(760px, 100vw)"
    append-to-body
    close-on-click-modal
    close-on-press-escape
    :before-close="handleBeforeClose"
    @closed="pauseTask"
    @close="$emit('update:modelValue', false)"
  >
    <div class="v2-media-resolver-drawer__body">
      <div class="v2-media-resolver-disclosure" role="note">
        <el-icon><Lock /></el-icon>
        <span>
          <strong>只解析可公开访问的单个作品</strong>
          <small>
            支持抖音、TikTok、YouTube、Instagram、X、B站等平台；不读取浏览器登录信息，
            不绕过私密、付费或平台访问限制。
          </small>
        </span>
      </div>

      <el-form
        label-position="left"
        label-width="82px"
        require-asterisk-position="right"
        class="v2-horizontal-form v2-media-resolver-form"
        @submit.prevent="resolveMedia"
      >
        <el-form-item label="作品链接" required>
          <div class="v2-media-resolver-input">
            <el-input
              v-model="mediaInput"
              type="textarea"
              :rows="4"
              :maxlength="V2_MEDIA_RESOLVER_LIMITS.inputLength"
              resize="vertical"
              clearable
              placeholder="粘贴作品链接或包含链接的分享文本"
              :disabled="busy"
              @keyup.ctrl.enter="resolveMedia"
              @keyup.meta.enter="resolveMedia"
            />
            <div class="v2-media-resolver-input__actions">
              <span>仅处理单个作品，最多下载 256 MB</span>
              <AppButton variant="ghost" size="small" :disabled="busy" @click="pasteInput">
                <el-icon><CopyDocument /></el-icon>
                一键粘贴
              </AppButton>
            </div>
          </div>
        </el-form-item>

        <div class="v2-media-resolver-submit">
          <AppButton
            native-type="submit"
            variant="primary"
            :loading="resolving"
            :disabled="downloading"
          >
            <el-icon v-if="!resolving"><Search /></el-icon>
            {{ resolving ? '正在解析' : '开始解析' }}
          </AppButton>
        </div>
      </el-form>

      <div v-if="displayedError" class="v2-media-resolver-error" role="alert">
        <el-icon><WarningFilled /></el-icon>
        <span>{{ displayedError }}</span>
        <div class="v2-media-resolver-error__actions">
          <AppButton
            v-if="failedDownloadOption && !ticketExpired"
            size="small"
            variant="soft"
            :disabled="busy"
            @click="downloadOption(failedDownloadOption)"
          >
            重试下载
          </AppButton>
          <AppButton size="small" variant="soft" :disabled="busy" @click="resolveMedia">
            重新解析
          </AppButton>
        </div>
      </div>

      <section class="v2-media-resolver-result" aria-live="polite" :aria-busy="resolving">
        <div v-if="resolving" class="v2-media-resolver-state">
          <span class="v2-media-resolver-state__progress" aria-hidden="true" />
          <el-icon><VideoPlay /></el-icon>
          <strong>正在识别作品中的视频、音乐和图集</strong>
          <small>国内抖音会优先使用专用解析引擎。</small>
        </div>

        <div v-else-if="result" class="v2-media-resolver-card">
          <header>
            <div>
              <span>{{ platformLabel(result.platform) }}</span>
              <span>{{ mediaTypeLabels[result.mediaType] }}</span>
              <span>{{ engineLabel(result.engine) }}</span>
            </div>
            <small>下载凭证 {{ expiryLabel }}</small>
          </header>

          <div class="v2-media-resolver-card__summary">
            <div class="v2-media-resolver-card__icon" aria-hidden="true">
              <el-icon><component :is="mediaTypeIcons[result.mediaType]" /></el-icon>
            </div>
            <div>
              <h3>{{ result.title }}</h3>
              <p>
                <span>{{ result.author || '作者未公开' }}</span>
                <span v-if="result.durationSeconds">{{
                  formatDuration(result.durationSeconds)
                }}</span>
              </p>
            </div>
          </div>

          <div class="v2-media-resolver-card__downloads">
            <section
              v-for="group in downloadGroups"
              :key="group.type"
              class="v2-media-resolver-download-group"
              :aria-label="group.label"
            >
              <header>
                <h4>
                  <el-icon><component :is="mediaTypeIcons[group.type]" /></el-icon>{{ group.label }}
                </h4>
                <small>{{ group.options.length }} {{ group.type === 'image' ? '张' : '项' }}</small>
              </header>
              <p v-if="!group.options.length" class="v2-media-resolver-download-group__empty">
                {{ group.emptyText }}
              </p>
              <div
                v-for="option in group.options"
                :key="option.downloadToken"
                class="v2-media-resolver-download-option"
              >
                <span>
                  <strong>{{ option.label }}</strong>
                  <small>{{ optionMeta(option) }}</small>
                </span>
                <AppButton
                  variant="success"
                  size="small"
                  :loading="downloadingToken === option.downloadToken"
                  :disabled="
                    ticketExpired || (downloading && downloadingToken !== option.downloadToken)
                  "
                  @click="downloadOption(option)"
                >
                  <el-icon v-if="downloadingToken !== option.downloadToken"><Download /></el-icon>
                  {{
                    downloadingToken === option.downloadToken
                      ? downloadProgressLabel
                      : group.downloadLabel
                  }}
                </AppButton>
              </div>
            </section>
          </div>
        </div>

        <div v-else class="v2-media-resolver-state is-empty">
          <el-icon><Link /></el-icon>
          <strong>粘贴作品链接后开始解析</strong>
          <small>解析结果只保留在当前页面，关闭抽屉后自动清空。</small>
        </div>
      </section>

      <p class="v2-media-resolver-rights">
        请只下载你拥有或已获授权的内容，并遵守来源平台规则与适用法律。
      </p>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import {
  CopyDocument,
  Download,
  Link,
  Lock,
  Headset,
  Picture,
  Search,
  VideoPlay,
  WarningFilled
} from '@element-plus/icons-vue';
import {
  V2_MEDIA_RESOLVER_LIMITS,
  type V2MediaDownloadOption,
  type V2MediaPlatform,
  type V2MediaType,
  type V2MediaResolveResult
} from '@apple-business/shared';
import { ElMessage, ElMessageBox } from 'element-plus';
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage } from '@/api/client';
import { isApiError } from '@/api/apiError';
import { idBusinessV2WorkspaceApi } from '@/v2/api/workspace';

const props = defineProps<{ modelValue: boolean }>();
defineEmits<{ 'update:modelValue': [value: boolean] }>();

const mediaInput = ref('');
const result = ref<V2MediaResolveResult | null>(null);
const errorMessage = ref('');
const resolving = ref(false);
const downloadingToken = ref('');
const downloadProgress = ref<number | null>(null);
const failedDownloadToken = ref('');
const audioUnavailableMessage = ref('');
const now = ref(Date.now());
let expiryTimer: ReturnType<typeof setInterval> | undefined;
let activeController: AbortController | null = null;

const downloading = computed(() => Boolean(downloadingToken.value));
const busy = computed(() => resolving.value || downloading.value);
const mediaTypeLabels: Record<V2MediaType, string> = {
  video: '视频',
  audio: '音乐',
  image: '图册图集'
};
const mediaTypeIcons = { video: VideoPlay, audio: Headset, image: Picture };
const downloadGroups = computed(() =>
  [
    {
      type: 'video' as const,
      label: '视频',
      downloadLabel: '下载视频',
      emptyText: '此作品未提供可下载的视频'
    },
    {
      type: 'audio' as const,
      label: '音乐',
      downloadLabel: '下载音乐',
      emptyText: audioUnavailableMessage.value || '此作品未提供可下载的音乐'
    },
    {
      type: 'image' as const,
      label: '图册图集',
      downloadLabel: '下载图片',
      emptyText: '此作品未提供可下载的图集图片'
    }
  ].map((group) => ({
    ...group,
    options: result.value?.options.filter((option) => optionMediaType(option) === group.type) ?? []
  }))
);
const remainingSeconds = computed(() => {
  const expiresAt = Date.parse(result.value?.expiresAt ?? '');
  return Number.isFinite(expiresAt) ? Math.max(0, Math.ceil((expiresAt - now.value) / 1000)) : 0;
});
const ticketExpired = computed(() => Boolean(result.value) && remainingSeconds.value === 0);
const expiryLabel = computed(() =>
  ticketExpired.value
    ? '已过期'
    : `${Math.floor(remainingSeconds.value / 60)} 分 ${remainingSeconds.value % 60} 秒后过期`
);
const displayedError = computed(
  () => errorMessage.value || (ticketExpired.value ? '下载凭证已过期，请重新解析作品' : '')
);
const failedDownloadOption = computed(() =>
  result.value?.options.find((option) => option.downloadToken === failedDownloadToken.value)
);
const downloadProgressLabel = computed(() =>
  downloadProgress.value === null ? '准备文件' : `${downloadProgress.value}%`
);

watch(
  () => props.modelValue && result.value?.expiresAt,
  (expiresAt) => {
    clearInterval(expiryTimer);
    now.value = Date.now();
    if (expiresAt)
      expiryTimer = setInterval(() => {
        now.value = Date.now();
      }, 1000);
  },
  { immediate: true }
);
onBeforeUnmount(() => {
  clearInterval(expiryTimer);
  activeController?.abort();
  activeController = null;
});

async function resolveMedia() {
  if (busy.value) return;
  const input = mediaInput.value.trim();
  if (!input) {
    errorMessage.value = '请先粘贴作品链接或分享文本';
    return;
  }
  errorMessage.value = '';
  failedDownloadToken.value = '';
  audioUnavailableMessage.value = '';
  result.value = null;
  resolving.value = true;
  const controller = new AbortController();
  activeController = controller;
  try {
    const resolved = await idBusinessV2WorkspaceApi.resolveMedia(
      { url: input },
      { signal: controller.signal }
    );
    if (!controller.signal.aborted && activeController === controller) result.value = resolved;
  } catch (cause) {
    if (!controller.signal.aborted && activeController === controller)
      errorMessage.value = getApiErrorMessage(cause);
  } finally {
    if (activeController === controller) {
      resolving.value = false;
      activeController = null;
    }
  }
}

async function pasteInput() {
  try {
    mediaInput.value = await navigator.clipboard.readText();
    errorMessage.value = '';
  } catch {
    ElMessage.warning('无法读取剪贴板，请手动粘贴');
  }
}

async function downloadOption(option: V2MediaDownloadOption) {
  now.value = Date.now();
  if (ticketExpired.value) return;
  if (busy.value) return;
  errorMessage.value = '';
  failedDownloadToken.value = '';
  downloadingToken.value = option.downloadToken;
  downloadProgress.value = null;
  const controller = new AbortController();
  activeController = controller;
  try {
    const blob = await idBusinessV2WorkspaceApi.downloadMedia(option.downloadToken, {
      signal: controller.signal,
      onDownloadProgress: (loaded, total) => {
        if (controller.signal.aborted || activeController !== controller) return;
        downloadProgress.value = total ? Math.min(99, Math.round((loaded / total) * 100)) : null;
      }
    });
    if (controller.signal.aborted || activeController !== controller) return;
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = buildFilename(result.value?.title ?? '媒体文件', option, blob.type);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    ElMessage.success('文件已开始下载');
  } catch (cause) {
    if (!controller.signal.aborted && activeController === controller) {
      errorMessage.value = getApiErrorMessage(cause);
      failedDownloadToken.value = option.downloadToken;
      if (isApiError(cause) && cause.code === 'MEDIA_AUDIO_MISSING' && result.value) {
        audioUnavailableMessage.value = '此视频不含音轨，仍可下载视频';
        result.value = {
          ...result.value,
          options: result.value.options.filter(
            (item) => item.downloadToken !== option.downloadToken
          )
        };
        failedDownloadToken.value = '';
      } else if (isApiError(cause) && cause.code === 'MEDIA_TICKET_EXPIRED' && result.value) {
        result.value = { ...result.value, expiresAt: new Date(0).toISOString() };
      }
    }
  } finally {
    if (activeController === controller) {
      downloadingToken.value = '';
      downloadProgress.value = null;
      activeController = null;
    }
  }
}

async function handleBeforeClose(done: () => void) {
  if (!busy.value) return done();
  try {
    await ElMessageBox.confirm('当前任务仍在进行，关闭后将取消本次任务。', '确认关闭', {
      confirmButtonText: '取消任务并关闭',
      cancelButtonText: '继续等待',
      type: 'warning'
    });
    activeController?.abort();
    done();
  } catch {
    // Continue the current task.
  }
}

function pauseTask() {
  activeController?.abort();
}

function platformLabel(platform: V2MediaPlatform) {
  const labels: Record<V2MediaPlatform, string> = {
    bilibili: 'B站',
    dailymotion: 'Dailymotion',
    douyin: '抖音',
    facebook: 'Facebook',
    instagram: 'Instagram',
    pinterest: 'Pinterest',
    reddit: 'Reddit',
    soundcloud: 'SoundCloud',
    tiktok: 'TikTok',
    twitch: 'Twitch',
    vimeo: 'Vimeo',
    weibo: '微博',
    x: 'X',
    youtube: 'YouTube'
  };
  return labels[platform];
}

function engineLabel(engine: V2MediaResolveResult['engine']) {
  return engine === 'f2' ? '抖音专用引擎' : '多平台解析引擎';
}

function formatDuration(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

function optionMeta(option: V2MediaDownloadOption) {
  const parts = [option.extension.toUpperCase()];
  if (option.height) parts.push(`${option.height}P`);
  if (option.estimatedBytes) parts.push(formatBytes(option.estimatedBytes));
  return parts.join(' · ');
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function optionMediaType(option: V2MediaDownloadOption): V2MediaType {
  if (option.mediaType) return option.mediaType;
  if (/^(mp3|m4a|aac|wav|ogg|opus|flac)$/iu.test(option.extension)) return 'audio';
  if (/^(jpg|jpeg|png|webp|gif|avif)$/iu.test(option.extension)) return 'image';
  return result.value?.mediaType ?? 'video';
}

function buildFilename(title: string, option: V2MediaDownloadOption, contentType: string) {
  const type = optionMediaType(option);
  const group = downloadGroups.value.find((item) => item.type === type);
  const index =
    group?.options.findIndex((item) => item.downloadToken === option.downloadToken) ?? 0;
  const suffix =
    type === 'image' ? `图片-${String(index + 1).padStart(2, '0')}` : mediaTypeLabels[type];
  const safeTitle = title
    .normalize('NFKC')
    .split('')
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? '_' : character;
    })
    .join('')
    .replace(/[\\/:*?"<>|]/gu, '_')
    .replace(/[. ]+$/gu, '')
    .trim()
    .slice(0, 100);
  const extensions: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'video/mp4': 'mp4',
    'video/webm': 'webm'
  };
  const extension =
    extensions[contentType.split(';', 1)[0].trim().toLowerCase()] ?? option.extension;
  return `${safeTitle || '媒体文件'}-${suffix}.${extension}`;
}
</script>

<style>
.v2-media-resolver-drawer .el-drawer__body {
  padding: 0;
}

.v2-media-resolver-drawer .el-drawer__header {
  margin-bottom: 0;
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--v2-border);
}

.v2-media-resolver-drawer__body {
  display: grid;
  min-width: 0;
  gap: 16px;
  padding: 18px 20px 22px;
}

.v2-media-resolver-disclosure {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  align-items: start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--v3-info-border-soft);
  border-radius: 7px;
  background: var(--v3-info-soft);
  color: var(--v3-info);
}

.v2-media-resolver-disclosure > span {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.v2-media-resolver-disclosure strong,
.v2-media-resolver-disclosure small {
  overflow-wrap: anywhere;
  line-height: 20px;
}

.v2-media-resolver-disclosure strong {
  color: var(--v2-text);
  font-size: 13px;
}

.v2-media-resolver-disclosure small {
  color: var(--v2-text-soft);
  font-size: 12px;
}

.v2-media-resolver-form {
  padding: 14px 14px 12px;
  border: 1px solid var(--v2-border);
  border-radius: 8px;
  background: var(--v2-surface);
}

.v2-media-resolver-form .el-form-item {
  margin-bottom: 12px;
}

.v2-media-resolver-input {
  display: grid;
  width: 100%;
  min-width: 0;
  gap: 6px;
}

.v2-media-resolver-input__actions,
.v2-media-resolver-submit {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.v2-media-resolver-input__actions > span {
  color: var(--v2-text-soft);
  font-size: 11px;
  line-height: 18px;
}

.v2-media-resolver-submit {
  justify-content: flex-end;
  padding-left: 82px;
}

.v2-media-resolver-error {
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

.v2-media-resolver-error__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.v2-media-resolver-error__actions > .app-button + .app-button {
  margin-left: 0;
}

.v2-media-resolver-result {
  position: relative;
  min-height: 246px;
  overflow: hidden;
  border: 1px solid var(--v2-border);
  border-radius: 8px;
  background: var(--v2-surface-muted);
}

.v2-media-resolver-state {
  display: grid;
  min-height: 244px;
  place-content: center;
  justify-items: center;
  gap: 8px;
  padding: 28px;
  text-align: center;
}

.v2-media-resolver-state > .el-icon {
  width: 38px;
  height: 38px;
  border-radius: 8px;
  background: var(--v2-accent-soft);
  color: var(--v2-accent);
  font-size: 20px;
}

.v2-media-resolver-state strong {
  color: var(--v2-text);
  font-size: 14px;
  line-height: 22px;
}

.v2-media-resolver-state small {
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 19px;
}

.v2-media-resolver-state__progress {
  position: absolute;
  top: 0;
  left: 0;
  width: 42%;
  height: 2px;
  background: var(--v2-accent-solid);
  animation: v2-media-resolver-progress 1.2s ease-in-out infinite;
}

.v2-media-resolver-card {
  display: grid;
  min-width: 0;
  gap: 0;
}

.v2-media-resolver-card > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--v2-border-soft);
  background: var(--v2-surface);
}

.v2-media-resolver-card > header > div {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.v2-media-resolver-card > header span {
  padding: 2px 7px;
  border-radius: 4px;
  background: var(--v2-accent-soft);
  color: var(--v2-accent);
  font-size: 11px;
  line-height: 18px;
}

.v2-media-resolver-card > header small {
  color: var(--v2-text-soft);
  font-size: 11px;
}

.v2-media-resolver-card__summary {
  display: grid;
  min-width: 0;
  grid-template-columns: 52px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  padding: 16px;
}

.v2-media-resolver-card__icon {
  display: grid;
  width: 52px;
  height: 52px;
  place-items: center;
  border: 1px solid var(--v2-border);
  border-radius: 8px;
  background: var(--v2-surface);
  color: var(--v2-accent);
  font-size: 24px;
}

.v2-media-resolver-card__summary h3 {
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--v2-text);
  font-size: 15px;
  line-height: 23px;
}

.v2-media-resolver-card__summary p {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin: 4px 0 0;
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 19px;
}

.v2-media-resolver-card__downloads {
  display: grid;
  gap: 14px;
  padding: 0 12px 12px;
}

.v2-media-resolver-download-group {
  min-width: 0;
}

.v2-media-resolver-download-group > header,
.v2-media-resolver-download-group h4 {
  display: flex;
  align-items: center;
  gap: 8px;
}

.v2-media-resolver-download-group > header {
  justify-content: space-between;
  padding: 8px 4px;
}

.v2-media-resolver-download-group h4 {
  margin: 0;
  color: var(--v2-text);
  font-size: 13px;
  line-height: 20px;
}

.v2-media-resolver-download-group__empty {
  margin: 0;
  padding: 8px 4px;
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 20px;
}

.v2-media-resolver-download-option {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 10px 4px;
  border-top: 1px solid var(--v2-border-soft);
}

.v2-media-resolver-download-option > span {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.v2-media-resolver-card__downloads strong {
  overflow-wrap: anywhere;
  color: var(--v2-text);
  font-size: 13px;
  line-height: 20px;
}

.v2-media-resolver-card__downloads small,
.v2-media-resolver-rights {
  color: var(--v2-text-soft);
  font-size: 11px;
  line-height: 18px;
}

.v2-media-resolver-rights {
  margin: -4px 0 0;
  text-align: center;
}

@keyframes v2-media-resolver-progress {
  0% {
    transform: translateX(-110%);
  }
  100% {
    transform: translateX(340%);
  }
}

@media (max-width: 560px) {
  .v2-media-resolver-drawer__body {
    gap: 12px;
    padding: 14px;
  }

  .v2-media-resolver-form {
    padding: 12px;
  }

  .v2-media-resolver-form .el-form-item__label {
    width: 72px !important;
  }

  .v2-media-resolver-submit {
    padding-left: 72px;
  }

  .v2-media-resolver-error {
    grid-template-columns: 20px minmax(0, 1fr);
  }

  .v2-media-resolver-error__actions {
    grid-column: 2;
    justify-self: start;
  }
}

@media (prefers-reduced-motion: reduce) {
  .v2-media-resolver-state__progress {
    animation: none;
  }
}
</style>
