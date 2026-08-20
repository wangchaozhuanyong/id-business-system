<template>
  <div
    ref="launcherRoot"
    class="v2-workspace-launcher"
    :class="{ 'is-collapsed': sidebarCollapsed }"
  >
    <button
      ref="triggerButton"
      class="v2-workspace-launcher__trigger"
      type="button"
      :aria-expanded="panelOpen"
      aria-controls="v2-personal-workspace-panel"
      :title="sidebarCollapsed ? '个人工作区' : undefined"
      @click="togglePanel"
    >
      <el-icon><Briefcase /></el-icon>
      <span>个人工作区</span>
      <small>{{ shortcuts.length }}</small>
    </button>

    <section
      v-if="panelOpen"
      id="v2-personal-workspace-panel"
      class="v2-workspace-panel"
      role="dialog"
      aria-label="个人工作区"
    >
      <header class="v2-workspace-panel__header">
        <div>
          <strong>个人工作区</strong>
          <span>常用入口与在线工具</span>
        </div>
        <AppButton
          variant="ghost"
          icon-only
          size="small"
          title="管理快捷网址"
          @click="openSettings"
        >
          <el-icon><Setting /></el-icon>
        </AppButton>
      </header>

      <div class="v2-workspace-panel__section">
        <div class="v2-workspace-panel__section-title">
          <span>快捷网址</span>
          <AppButton
            v-if="shortcuts.length === 0 && authStore.writesAllowed"
            variant="ghost"
            icon-only
            size="small"
            title="添加快捷网址"
            @click="openSettings"
          >
            <el-icon><Plus /></el-icon>
          </AppButton>
        </div>
        <V2AsyncRegion
          :phase="shortcutsQuery.phase.value"
          :empty="shortcuts.length === 0"
          :error="shortcutError"
          variant="section"
          skeleton="inline"
          loading-title="正在读取快捷网址"
          refreshing-title="正在更新快捷网址"
          empty-title="还没有快捷网址"
          empty-message="可在设置中添加。"
          error-title="快捷网址加载失败"
          @retry="shortcutsQuery.refresh"
        >
          <ul class="v2-workspace-panel__links">
            <li v-for="item in shortcuts" :key="item.id">
              <button type="button" :title="`打开 ${item.name}`" @click="openShortcut(item)">
                <span aria-hidden="true">{{ item.name.slice(0, 1) }}</span>
                <strong>{{ item.name }}</strong>
                <el-icon><TopRight /></el-icon>
              </button>
            </li>
          </ul>
        </V2AsyncRegion>
      </div>

      <div class="v2-workspace-panel__section">
        <div class="v2-workspace-panel__section-title"><span>在线工具</span></div>
        <div class="v2-workspace-panel__tools">
          <button class="v2-workspace-panel__tool" type="button" @click="openTotpTool">
            <el-icon><Key /></el-icon>
            <span>
              <strong>计算 2FA 验证码</strong>
              <small>仅校验格式并在本地计算</small>
            </span>
            <el-icon><ArrowRight /></el-icon>
          </button>
          <button
            class="v2-workspace-panel__tool is-mail-viewer"
            type="button"
            title="邮箱查询与邮箱池"
            @click="openMailViewerTool"
          >
            <el-icon><Message /></el-icon>
            <span>
              <strong>邮箱查询与邮箱池</strong>
              <small>用于查询邮件和维护邮箱池</small>
            </span>
            <el-icon><ArrowRight /></el-icon>
          </button>
        </div>
      </div>
    </section>

    <V2WorkspaceShortcutDrawer
      v-model="settingsOpen"
      :items="shortcuts"
      :phase="shortcutsQuery.phase.value"
      :error="shortcutError"
      :writes-allowed="authStore.writesAllowed"
      :refresh="shortcutsQuery.refresh"
    />
    <V2MailViewerDrawer v-model="mailViewerDrawerOpen" />
    <V2TotpToolDrawer v-model="totpToolOpen" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { V2WorkspaceShortcut, V2WorkspaceShortcutList } from '@apple-business/shared';
import {
  ArrowRight,
  Briefcase,
  Key,
  Message,
  Plus,
  Setting,
  TopRight
} from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { idBusinessV2WorkspaceApi } from '@/v2/api/workspace';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import V2TotpToolDrawer from './V2TotpToolDrawer.vue';
import V2WorkspaceShortcutDrawer from './V2WorkspaceShortcutDrawer.vue';
import V2MailViewerDrawer from './V2MailViewerDrawer.vue';

defineProps<{ sidebarCollapsed: boolean }>();
const emit = defineEmits<{ requestCloseNavigation: [] }>();

const authStore = useAuthStore();
const launcherRoot = ref<HTMLElement>();
const triggerButton = ref<HTMLButtonElement>();
const panelOpen = ref(false);
const workspaceActivated = ref(false);
const settingsOpen = ref(false);
const totpToolOpen = ref(false);
const mailViewerDrawerOpen = ref(false);
const shortcutsQuery = useV2ModuleQuery<V2WorkspaceShortcutList>({
  moduleKey: 'profile',
  scope: 'workspace',
  key: 'current-user',
  enabled: () => workspaceActivated.value,
  trackRouteData: false,
  query: ({ signal }) => idBusinessV2WorkspaceApi.list({ signal })
});
const shortcuts = computed(() => shortcutsQuery.data.value?.items ?? []);
const shortcutError = computed(() =>
  shortcutsQuery.error.value ? getApiErrorMessage(shortcutsQuery.error.value) : ''
);

onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointerDown);
  document.addEventListener('keydown', handleDocumentKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown);
  document.removeEventListener('keydown', handleDocumentKeydown);
});

function togglePanel() {
  workspaceActivated.value = true;
  panelOpen.value = !panelOpen.value;
}

function openSettings() {
  panelOpen.value = false;
  settingsOpen.value = true;
  emit('requestCloseNavigation');
}

function openTotpTool() {
  panelOpen.value = false;
  totpToolOpen.value = true;
  emit('requestCloseNavigation');
}

function openMailViewerTool() {
  panelOpen.value = false;
  mailViewerDrawerOpen.value = true;
  emit('requestCloseNavigation');
}

function openShortcut(item: V2WorkspaceShortcut) {
  panelOpen.value = false;
  emit('requestCloseNavigation');
  const opened = window.open(item.url, '_blank', 'noopener,noreferrer');
  if (opened) opened.opener = null;
}

function handleDocumentPointerDown(event: PointerEvent) {
  if (!panelOpen.value || launcherRoot.value?.contains(event.target as Node)) return;
  panelOpen.value = false;
}

function handleDocumentKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !panelOpen.value) return;
  panelOpen.value = false;
  triggerButton.value?.focus();
}
</script>

<style scoped>
.v2-workspace-launcher {
  position: relative;
  min-width: 0;
  padding: 10px 8px;
  border-top: 1px solid var(--v2-sidebar-border);
}

.v2-workspace-launcher__trigger {
  display: grid;
  width: 100%;
  min-height: 42px;
  grid-template-columns: 22px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 0;
  border-radius: 7px;
  background: var(--v2-sidebar-surface);
  color: var(--v2-sidebar-text);
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.v2-workspace-launcher__trigger:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--v3-sidebar-text-strong);
}

.v2-workspace-launcher__trigger:focus-visible {
  outline: none;
  box-shadow: inset var(--v2-focus);
}

.v2-workspace-launcher__trigger > span {
  overflow: hidden;
  font-size: 13px;
  font-weight: var(--v3-font-weight-semibold);
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.v2-workspace-launcher__trigger > small {
  min-width: 20px;
  color: var(--v2-sidebar-muted);
  font-size: 11px;
  text-align: right;
}

.v2-workspace-launcher.is-collapsed .v2-workspace-launcher__trigger {
  grid-template-columns: 22px;
  justify-content: center;
  padding: 8px;
}

.v2-workspace-launcher.is-collapsed .v2-workspace-launcher__trigger > span,
.v2-workspace-launcher.is-collapsed .v2-workspace-launcher__trigger > small {
  display: none;
}

.v2-workspace-panel {
  position: absolute;
  z-index: 34;
  bottom: calc(100% + 8px);
  left: 8px;
  display: grid;
  width: min(320px, calc(100vw - 24px));
  max-height: min(620px, calc(100dvh - 92px));
  overflow: auto;
  border: 1px solid var(--v2-border);
  border-radius: 8px;
  background: var(--v2-surface);
  box-shadow: var(--v2-overview-shadow);
  color: var(--v2-text);
}

.v2-workspace-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 14px 12px;
  border-bottom: 1px solid var(--v2-border-soft);
}

.v2-workspace-panel__header > div {
  display: grid;
  min-width: 0;
  gap: 1px;
}

.v2-workspace-panel__header strong {
  font-size: 15px;
  line-height: 22px;
}

.v2-workspace-panel__header span {
  color: var(--v2-text-soft);
  font-size: 11px;
  line-height: 18px;
}

.v2-workspace-panel__section {
  display: grid;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--v2-border-soft);
}

.v2-workspace-panel__section:last-child {
  border-bottom: 0;
}

.v2-workspace-panel__section-title {
  display: flex;
  min-height: 28px;
  align-items: center;
  justify-content: space-between;
  color: var(--v2-text-soft);
  font-size: 11px;
  font-weight: var(--v3-font-weight-semibold);
}

.v2-workspace-panel__links {
  display: grid;
  gap: 3px;
  max-height: 240px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.v2-workspace-panel__tools {
  display: grid;
  gap: 3px;
}

.v2-workspace-panel__links button,
.v2-workspace-panel__tool {
  display: grid;
  width: 100%;
  min-width: 0;
  min-height: 42px;
  grid-template-columns: 30px minmax(0, 1fr) 18px;
  align-items: center;
  gap: 9px;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--v2-text);
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.v2-workspace-panel__links button:hover,
.v2-workspace-panel__tool:hover {
  background: var(--v2-surface-hover);
}

.v2-workspace-panel__tool:disabled {
  cursor: not-allowed;
}

.v2-workspace-panel__tool:disabled:hover {
  background: transparent;
}

.v2-workspace-panel__links button:focus-visible,
.v2-workspace-panel__tool:focus-visible {
  outline: none;
  box-shadow: var(--v2-focus);
}

.v2-workspace-panel__links button > span {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border-radius: 5px;
  background: var(--v2-accent-soft);
  color: var(--v2-accent);
  font-size: 12px;
  font-weight: var(--v3-font-weight-bold);
}

.v2-workspace-panel__links button > strong {
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.v2-workspace-panel__links button > .el-icon,
.v2-workspace-panel__tool > .el-icon:last-child {
  color: var(--v2-text-soft);
}

.v2-workspace-panel__tool > .el-icon:first-child {
  width: 30px;
  height: 30px;
  border-radius: 5px;
  background: var(--v3-success-soft);
  color: var(--v2-success);
}

.v2-workspace-panel__tool.is-mail-viewer > .el-icon:first-child {
  background: var(--v3-info-soft);
  color: var(--v3-info);
}

.v2-workspace-panel__tool.is-mail-viewer > .el-icon:last-child {
  color: var(--v2-text-soft);
}

.v2-workspace-panel__tool > span {
  display: grid;
  min-width: 0;
  gap: 1px;
}

.v2-workspace-panel__tool strong,
.v2-workspace-panel__tool small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.v2-workspace-panel__tool strong {
  font-size: 13px;
}

.v2-workspace-panel__tool small {
  color: var(--v2-text-soft);
  font-size: 11px;
}

@media (max-width: 720px) {
  .v2-workspace-launcher.is-collapsed .v2-workspace-launcher__trigger {
    grid-template-columns: 22px minmax(0, 1fr) auto;
    justify-content: initial;
    padding: 8px 12px;
  }

  .v2-workspace-launcher.is-collapsed .v2-workspace-launcher__trigger > span,
  .v2-workspace-launcher.is-collapsed .v2-workspace-launcher__trigger > small {
    display: initial;
  }
}
</style>
