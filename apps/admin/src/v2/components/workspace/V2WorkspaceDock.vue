<template>
  <aside class="v2-workspace-dock" :class="{ 'is-collapsed': collapsed }" aria-label="右侧工作区">
    <div v-show="collapsed || isMobile" class="v2-workspace-dock__rail">
      <button
        type="button"
        class="v2-workspace-dock__toggle"
        aria-label="展开工作区"
        title="展开工作区"
        :aria-expanded="!collapsed"
        aria-controls="v2-workspace-dock-panel"
        @click="expand()"
      >
        <el-icon><ArrowLeft /></el-icon>
      </button>
      <button
        v-for="tab in tabs"
        :key="tab.key"
        type="button"
        class="v2-workspace-dock__rail-tab"
        :class="{ 'is-active': activeTab === tab.key }"
        :aria-label="`打开${tab.label}`"
        :title="tab.label"
        @click="expand(tab.key)"
      >
        <el-icon><component :is="tab.icon" /></el-icon>
        <span>{{ tab.shortLabel }}</span>
      </button>
    </div>

    <el-drawer
      :model-value="isMobile && !collapsed"
      class="v2-workspace-dock-drawer"
      aria-label="右侧工作区"
      :with-header="false"
      :show-close="false"
      :destroy-on-close="false"
      size="min(368px, 100%)"
      append-to-body
      @update:model-value="handleDrawerVisibility"
    >
      <div ref="mobileTarget" class="v2-workspace-dock__mobile-target" />
    </el-drawer>

    <Teleport :to="mobileTarget ?? 'body'" :disabled="!isMobile || !mobileTarget">
      <section v-show="!collapsed" id="v2-workspace-dock-panel" class="v2-workspace-dock__panel">
        <div class="v2-workspace-dock__header">
          <div class="v2-workspace-dock__tabs" role="tablist" aria-label="工作区导航">
            <button
              v-for="tab in tabs"
              :id="`v2-workspace-tab-${tab.key}`"
              :key="tab.key"
              type="button"
              role="tab"
              class="v2-workspace-dock__tab"
              :aria-selected="activeTab === tab.key"
              :aria-controls="
                tab.key === 'copy' ? 'v2-workspace-tabpanel-copy' : 'v2-workspace-tabpanel-tools'
              "
              :tabindex="activeTab === tab.key ? 0 : -1"
              @click="activeTab = tab.key"
              @keydown="navigateTabs($event, tab.key)"
            >
              {{ tab.label }}
            </button>
          </div>
          <button
            type="button"
            class="v2-workspace-dock__toggle"
            aria-label="收起工作区"
            title="收起工作区"
            aria-controls="v2-workspace-dock-panel"
            :aria-expanded="!collapsed"
            @click="collapse"
          >
            <el-icon><ArrowRight /></el-icon>
          </button>
        </div>

        <div
          v-show="activeTab !== 'copy'"
          id="v2-workspace-tabpanel-tools"
          class="v2-workspace-dock__content"
          role="tabpanel"
          :aria-labelledby="`v2-workspace-tab-${activeTab === 'tools' ? 'tools' : 'personal'}`"
        >
          <V2WorkspaceLauncher
            :active="!collapsed && activeTab !== 'copy'"
            :view="activeTab === 'tools' ? 'tools' : 'personal'"
          />
        </div>
        <div
          v-show="activeTab === 'copy'"
          id="v2-workspace-tabpanel-copy"
          class="v2-workspace-dock__content"
          role="tabpanel"
          aria-labelledby="v2-workspace-tab-copy"
        >
          <V2QuickActions :active="!collapsed && activeTab === 'copy'" />
        </div>
      </section>
    </Teleport>
  </aside>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { ArrowLeft, ArrowRight, Briefcase, DocumentCopy, Tools } from '@element-plus/icons-vue';
import { useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import V2WorkspaceLauncher from './V2WorkspaceLauncher.vue';
import V2QuickActions from './V2QuickActions.vue';

const emit = defineEmits<{ expand: [] }>();
const tabs = [
  { key: 'personal', label: '个人工具', shortLabel: '个人', icon: Briefcase },
  { key: 'tools', label: '在线工具', shortLabel: '工具', icon: Tools },
  { key: 'copy', label: '话术文案', shortLabel: '话术', icon: DocumentCopy }
] as const;
type WorkspaceTab = (typeof tabs)[number]['key'];

const { collapsed, activeTab } = useV2SessionDraft('global-workspace-dock', () => ({
  collapsed: ref(window.innerWidth < 1440),
  activeTab: ref<WorkspaceTab>('personal')
}));
const isMobile = ref(window.matchMedia('(max-width: 900px)').matches);
const mobileTarget = ref<HTMLElement>();
const media = window.matchMedia('(max-width: 900px)');

function expand(tab?: WorkspaceTab) {
  if (tab) activeTab.value = tab;
  collapsed.value = false;
  emit('expand');
  void nextTick(() => {
    document.getElementById(`v2-workspace-tab-${activeTab.value}`)?.focus();
  });
}

function collapse() {
  collapsed.value = true;
  void nextTick(() => {
    document.querySelector<HTMLButtonElement>('.v2-workspace-dock__rail > button')?.focus();
  });
}

function handleDrawerVisibility(visible: boolean) {
  if (isMobile.value && !visible) collapse();
}

function updateMobile(event: MediaQueryListEvent) {
  isMobile.value = event.matches;
  if (event.matches) collapsed.value = true;
}

function navigateTabs(event: KeyboardEvent, key: WorkspaceTab) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const index = tabs.findIndex((tab) => tab.key === key);
  const nextIndex =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  const next = tabs[nextIndex];
  activeTab.value = next.key;
  document.getElementById(`v2-workspace-tab-${next.key}`)?.focus();
}

onMounted(() => media.addEventListener('change', updateMobile));
onBeforeUnmount(() => media.removeEventListener('change', updateMobile));
</script>
