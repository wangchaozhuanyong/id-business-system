<template>
  <div class="v2-workspace-tools">
    <div v-show="view === 'personal'" class="v2-workspace-personal">
      <div class="v2-workspace-personal__scroll">
        <V2AsyncRegion
          :phase="shortcutsQuery.phase.value"
          :empty="shortcuts.length === 0"
          :error="shortcutError"
          variant="section"
          skeleton="inline"
          loading-title="正在读取个人工具"
          refreshing-title="正在更新个人工具"
          empty-title="还没有个人工具"
          empty-message="可在管理工具中添加网址。"
          error-title="个人工具加载失败"
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
      <footer class="v2-workspace-personal__footer">
        <AppButton variant="ghost" @click="openSettings">
          <el-icon><Setting /></el-icon>
          管理工具
        </AppButton>
      </footer>
    </div>
    <div v-show="view === 'tools'" class="v2-workspace-panel__tools">
      <button class="v2-workspace-panel__tool" type="button" @click="openTotpTool">
        <el-icon><Key /></el-icon>
        <span>
          <strong>计算 2FA 验证码</strong>
        </span>
        <el-icon><ArrowRight /></el-icon>
      </button>
      <button
        class="v2-workspace-panel__tool is-website-monitor"
        type="button"
        title="网站监控"
        @click="openWebsiteMonitor"
      >
        <el-icon><Monitor /></el-icon>
        <span>
          <strong>网站监控</strong>
        </span>
        <el-icon><ArrowRight /></el-icon>
      </button>
      <button
        class="v2-workspace-panel__tool is-media-resolver"
        type="button"
        title="抖音解析"
        @click="openMediaResolver"
      >
        <el-icon><VideoPlay /></el-icon>
        <span>
          <strong>抖音解析</strong>
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
        </span>
        <el-icon><ArrowRight /></el-icon>
      </button>
      <button
        v-if="isAdmin"
        class="v2-workspace-panel__tool is-google-sheets-sync"
        type="button"
        title="Google 表格同步"
        @click="openGoogleSheetsSync"
      >
        <el-icon><DataAnalysis /></el-icon>
        <span>
          <strong>Google 表格同步</strong>
        </span>
        <el-icon><ArrowRight /></el-icon>
      </button>
      <button
        v-if="isAdmin"
        class="v2-workspace-panel__tool is-relay-script"
        type="button"
        title="中转脚本"
        @click="openRelayScript"
      >
        <el-icon><Connection /></el-icon>
        <span>
          <strong>中转脚本</strong>
        </span>
        <el-icon><ArrowRight /></el-icon>
      </button>
    </div>
    <V2WorkspaceShortcutDrawer
      v-model="settingsOpen"
      :items="shortcuts"
      :phase="shortcutsQuery.phase.value"
      :error="shortcutError"
      :writes-allowed="authStore.writesAllowed"
      :refresh="shortcutsQuery.refresh"
    />
    <V2MailViewerDrawer v-model="mailViewerDrawerOpen" />
    <V2MediaResolverDrawer v-model="mediaResolverDrawerOpen" />
    <V2GoogleSheetsSyncDrawer v-model="googleSheetsSyncDrawerOpen" />
    <V2RelayScriptDrawer v-model="relayScriptDrawerOpen" />
    <V2TotpToolDrawer v-model="totpToolOpen" />
    <V2WebsiteMonitorDrawer v-model="websiteMonitorOpen" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { V2WorkspaceShortcut, V2WorkspaceShortcutList } from '@apple-business/shared';
import {
  ArrowRight,
  Connection,
  DataAnalysis,
  Key,
  Message,
  Monitor,
  Setting,
  TopRight,
  VideoPlay
} from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { useV2DrawerNavigation } from '@/v2/composables/useV2DrawerNavigation';
import { idBusinessV2WorkspaceApi } from '@/v2/api/workspace';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import V2MailViewerDrawer from './V2MailViewerDrawer.vue';
import V2GoogleSheetsSyncDrawer from './V2GoogleSheetsSyncDrawer.vue';
import V2MediaResolverDrawer from './V2MediaResolverDrawer.vue';
import V2RelayScriptDrawer from './V2RelayScriptDrawer.vue';
import V2TotpToolDrawer from './V2TotpToolDrawer.vue';
import V2WebsiteMonitorDrawer from './V2WebsiteMonitorDrawer.vue';
import V2WorkspaceShortcutDrawer from './V2WorkspaceShortcutDrawer.vue';

const props = defineProps<{ active: boolean; view: 'personal' | 'tools' }>();

const authStore = useAuthStore();
const settingsOpen = ref(false);
const totpToolOpen = ref(false);
const mailViewerDrawerOpen = ref(false);
const mediaResolverDrawerOpen = ref(false);
const relayScriptDrawerOpen = ref(false);
const googleSheetsSyncDrawerOpen = ref(false);
const websiteMonitorOpen = ref(false);
useV2DrawerNavigation(() => {
  settingsOpen.value = false;
  totpToolOpen.value = false;
  mailViewerDrawerOpen.value = false;
  mediaResolverDrawerOpen.value = false;
  relayScriptDrawerOpen.value = false;
  googleSheetsSyncDrawerOpen.value = false;
  websiteMonitorOpen.value = false;
});
const isAdmin = computed(() => authStore.user?.roles.includes('admin') === true);
const shortcutsQuery = useV2ModuleQuery<V2WorkspaceShortcutList>({
  moduleKey: 'profile',
  scope: 'workspace',
  key: 'current-user',
  enabled: () => props.active && props.view === 'personal',
  trackRouteData: false,
  query: ({ signal }) => idBusinessV2WorkspaceApi.list({ signal })
});
const shortcuts = computed(() => shortcutsQuery.data.value?.items ?? []);
const shortcutError = computed(() =>
  shortcutsQuery.error.value ? getApiErrorMessage(shortcutsQuery.error.value) : ''
);

function openSettings() {
  settingsOpen.value = true;
}

function openTotpTool() {
  totpToolOpen.value = true;
}

function openMailViewerTool() {
  mailViewerDrawerOpen.value = true;
}

function openWebsiteMonitor() {
  websiteMonitorOpen.value = true;
}

function openMediaResolver() {
  mediaResolverDrawerOpen.value = true;
}

function openRelayScript() {
  relayScriptDrawerOpen.value = true;
}

function openGoogleSheetsSync() {
  googleSheetsSyncDrawerOpen.value = true;
}

function openShortcut(item: V2WorkspaceShortcut) {
  const opened = window.open(item.url, '_blank', 'noopener,noreferrer');
  if (opened) opened.opener = null;
}
</script>
