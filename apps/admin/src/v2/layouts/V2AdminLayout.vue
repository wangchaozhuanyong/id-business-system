<template>
  <div class="v2-shell" :class="{ 'is-sidebar-collapsed': sidebarCollapsed }">
    <a class="v2-skip-link" href="#v2-main">跳到主要内容</a>

    <button
      v-if="mobileMenuOpen"
      class="v2-mobile-overlay"
      type="button"
      aria-label="关闭导航"
      @click="closeMobileMenu"
    />

    <aside
      id="v2-navigation-drawer"
      class="v2-sidebar"
      :class="{ 'is-mobile-open': mobileMenuOpen }"
    >
      <div class="v2-brand">
        <span class="v2-brand__mark">ID</span>
        <div class="v2-brand__copy">
          <strong>ID 业务管理</strong>
          <span>Apple ID 订阅运营</span>
        </div>
        <button
          class="v2-sidebar-toggle"
          type="button"
          :aria-label="sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'"
          :title="sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'"
          @click="toggleSidebar"
        >
          <el-icon>
            <Expand v-if="sidebarCollapsed" />
            <Fold v-else />
          </el-icon>
        </button>
      </div>

      <nav class="v2-navigation" aria-label="新版业务导航">
        <section
          v-for="section in visibleNavigationSections"
          :key="section.key"
          class="v2-navigation__section"
          :class="{
            'is-open': openSectionKey === section.key,
            'is-active': sectionContainsCurrentRoute(section)
          }"
        >
          <button
            class="v2-navigation__parent"
            type="button"
            :aria-expanded="openSectionKey === section.key"
            :aria-controls="`v2-navigation-section-${section.key}`"
            :title="sidebarCollapsed ? section.title : undefined"
            @click="toggleNavigationSection(section.key)"
          >
            <el-icon class="v2-navigation__parent-icon">
              <component :is="navigationSectionIcons[section.key] ?? Collection" />
            </el-icon>
            <span class="v2-navigation__parent-label">{{ section.title }}</span>
            <el-icon class="v2-navigation__chevron"><ArrowDown /></el-icon>
          </button>

          <div
            v-show="openSectionKey === section.key && !sidebarCollapsed"
            :id="`v2-navigation-section-${section.key}`"
            class="v2-navigation__children"
          >
            <RouterLink
              v-for="item in section.items"
              :key="item.key"
              class="v2-navigation__item"
              :to="item.route"
              @pointerenter="queueNavigationPrefetch(item.route, 'hover', $event)"
              @pointerleave="cancelNavigationPrefetch(item.route)"
              @focus="queueNavigationPrefetch(item.route, 'focus')"
              @blur="cancelNavigationPrefetch(item.route)"
              @pointerdown="beginNavigation(item.route, $event)"
              @click="closeMobileMenu"
            >
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">{{ item.title }}</span>
              <span v-if="item.status === 'planned'" class="v2-navigation__item-badge"> 规划 </span>
            </RouterLink>
          </div>
        </section>
      </nav>
    </aside>

    <div class="v2-workspace">
      <header class="v2-topbar">
        <div class="v2-topbar__identity">
          <AppButton
            class="v2-menu-button"
            variant="ghost"
            icon-only
            aria-controls="v2-navigation-drawer"
            :aria-expanded="mobileMenuOpen"
            title="打开导航"
            @click="mobileMenuOpen = true"
          >
            <el-icon><MenuIcon /></el-icon>
          </AppButton>
          <h1 ref="pageTitleElement" tabindex="-1">{{ currentPageTitle }}</h1>
        </div>

        <div class="v2-global-search" :class="{ 'is-open': globalSearchOpen }">
          <el-icon aria-hidden="true"><Search /></el-icon>
          <input
            v-model.trim="globalSearchQuery"
            type="search"
            placeholder="搜索页面、业务模块"
            aria-label="搜索页面和业务模块"
            :aria-expanded="globalSearchOpen"
            aria-controls="v2-global-search-results"
            @focus="globalSearchOpen = true"
            @blur="closeGlobalSearch"
            @keydown.enter.prevent="openFirstSearchResult"
            @keydown.esc="globalSearchOpen = false"
          />
          <kbd>⌘ K</kbd>
          <div
            v-if="globalSearchOpen && globalSearchQuery"
            id="v2-global-search-results"
            class="v2-global-search__results"
            role="listbox"
          >
            <button
              v-for="item in globalSearchResults"
              :key="item.key"
              type="button"
              role="option"
              @pointerenter="queueNavigationPrefetch(item.route, 'search', $event)"
              @pointerleave="cancelNavigationPrefetch(item.route)"
              @focus="queueNavigationPrefetch(item.route, 'focus')"
              @blur="cancelNavigationPrefetch(item.route)"
              @pointerdown="beginNavigation(item.route, $event)"
              @mousedown.prevent="openSearchResult(item.route)"
            >
              <span>{{ item.title }}</span>
              <small>{{ item.group }}</small>
            </button>
            <p v-if="!globalSearchResults.length">没有匹配的业务页面</p>
          </div>
        </div>

        <div class="v2-topbar__utilities">
          <span
            v-if="queryActivityLabel"
            class="v2-query-activity"
            :class="{ 'is-error': Boolean(v2QueryActivity.lastErrorAt) }"
          >
            {{ queryActivityLabel }}
          </span>
          <div class="v2-theme-switcher" role="group" aria-label="界面主题">
            <button
              type="button"
              :class="{ 'is-active': currentTheme === 'light' }"
              :aria-pressed="currentTheme === 'light'"
              title="切换为浅色主题"
              @click="setTheme('light')"
            >
              <el-icon><Sunny /></el-icon>
              <span>浅色</span>
            </button>
            <button
              type="button"
              :class="{ 'is-active': currentTheme === 'dark' }"
              :aria-pressed="currentTheme === 'dark'"
              title="切换为深色主题"
              @click="setTheme('dark')"
            >
              <el-icon><Moon /></el-icon>
              <span>深色</span>
            </button>
          </div>
          <div class="v2-notification">
            <button
              type="button"
              :aria-label="
                renewalWarningCount
                  ? `查看通知，当前 ${renewalWarningCount} 条续费提醒`
                  : '查看通知'
              "
              :aria-expanded="notificationOpen"
              @click="toggleNotification"
            >
              <el-icon><Bell /></el-icon>
              <span v-if="renewalWarningCount" class="v2-notification__badge">
                {{ renewalWarningCount > 99 ? '99+' : renewalWarningCount }}
              </span>
            </button>
            <div v-if="notificationOpen" class="v2-notification__panel">
              <header>
                <strong>续费到期提醒</strong>
                <small v-if="renewalWarningSummary">
                  提前 {{ renewalWarningSummary.warningDays }} 天
                </small>
              </header>
              <p v-if="!canViewRenewalWarnings">当前账号无权查看续费提醒。</p>
              <p v-else-if="renewalWarningInitialLoading && !renewalWarningSummary">
                正在读取提醒…
              </p>
              <template v-else-if="renewalWarningSummary">
                <div class="v2-notification__counts">
                  <span>
                    <small>即将到期</small>
                    <strong>{{ renewalWarningSummary.upcomingCount }}</strong>
                  </span>
                  <span>
                    <small>已到期</small>
                    <strong>{{ renewalWarningSummary.expiredCount }}</strong>
                  </span>
                </div>
                <ul v-if="renewalWarningSummary.items.length">
                  <li v-for="item in renewalWarningSummary.items" :key="item.id">
                    <div>
                      <strong>{{ item.customer.name }}</strong>
                      <span>{{ item.account.appleIdMasked }} · {{ item.service.name }}</span>
                    </div>
                    <small :class="`is-${item.warningState}`">
                      {{ item.warningState === 'expired' ? '已到期' : '即将到期' }}
                      · {{ formatWarningDueAt(item.dueAt) }}
                    </small>
                  </li>
                </ul>
                <p v-else>当前没有续费到期提醒。</p>
                <AppButton variant="primary" size="small" @click="openRenewalWarnings">
                  打开续费操作台
                </AppButton>
              </template>
              <p v-else>提醒暂时无法加载，请稍后重试。</p>
              <small v-if="renewalWarningError" class="v2-notification__error">
                刷新失败，已保留上次成功结果。
              </small>
            </div>
          </div>
          <div class="v2-topbar__account">
            <el-dropdown
              v-if="authStore.isAuthenticated"
              trigger="click"
              placement="bottom-end"
              @command="handleAccountCommand"
            >
              <button class="v2-topbar__profile-link" type="button" aria-label="打开账户菜单">
                <span class="v2-topbar__avatar" aria-hidden="true">{{ operatorInitial }}</span>
                <span class="v2-topbar__account-copy">
                  <strong>{{ authStore.displayName }}</strong>
                  <small>{{ operatorRole }}</small>
                </span>
                <el-icon class="v2-topbar__account-chevron" aria-hidden="true">
                  <ArrowDown />
                </el-icon>
              </button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="profile">我的账户</el-dropdown-item>
                  <el-dropdown-item command="change-password">修改密码</el-dropdown-item>
                  <el-dropdown-item command="logout" divided>退出登录</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </div>
      </header>

      <div
        class="v2-route-progress"
        :class="{ 'is-active': isRoutePending, 'is-error': isRouteError }"
        aria-hidden="true"
      >
        <span />
      </div>

      <main
        id="v2-main"
        ref="contentElement"
        class="v2-content"
        tabindex="-1"
        :aria-busy="isRoutePending"
      >
        <div class="v2-content__inner">
          <section v-if="isRouteError" class="v2-route-error" role="alert">
            <strong>页面资源加载失败</strong>
            <span>当前界面已保留。请检查网络后重新加载该页面。</span>
            <AppButton variant="primary" @click="retryCurrentRoute">重新加载</AppButton>
          </section>
          <RouterView v-slot="{ Component: ViewComponent, route: viewRoute }">
            <KeepAlive :max="V2_PAGE_CACHE_LIMIT">
              <component
                :is="ViewComponent"
                v-if="viewRoute.meta.keepAlive"
                :key="String(viewRoute.name ?? viewRoute.path)"
              />
            </KeepAlive>
            <component
              :is="ViewComponent"
              v-if="!viewRoute.meta.keepAlive"
              :key="String(viewRoute.name ?? viewRoute.path)"
            />
          </RouterView>
        </div>
      </main>
      <p class="v2-live-region" aria-live="polite" aria-atomic="true">{{ liveMessage }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ArrowDown,
  Bell,
  Collection,
  DataAnalysis,
  Expand,
  Files,
  Fold,
  Menu as MenuIcon,
  Monitor,
  Moon,
  Search,
  Setting,
  Sunny
} from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { V2RoutePrefetchIntent } from '@/runtime/performance';
import { useAuthStore } from '@/stores/auth';
import { hasUserFeatureAccess, hasUserPermission } from '@/utils/permissions';
import { idBusinessV2RenewalsApi } from '@/v2/api/renewals';
import type { V2RenewalWarningSummary } from '@/v2/types/renewals';
import { v2ModuleDefinitions, v2NavigationSections } from '@/v2/config/modules';
import { getPreferredV2Theme, persistV2Theme, type V2Theme } from '@/v2/theme';
import {
  prefetchV2Route,
  setV2RouteNavigationState,
  v2RouteNavigationState
} from '@/v2/router/routes';
import { clearV2QueryCache, useV2Query, v2QueryActivity } from '@/v2/composables/useV2Query';
import { createV2RoutePrefetchController } from '@/v2/runtime/routePrefetch';
import { startV2ChangeSync, stopV2ChangeSync } from '@/v2/runtime/changeSync';
import '@/v2/styles/v2.css';

const V2_PAGE_CACHE_LIMIT = Math.max(
  1,
  v2ModuleDefinitions.filter((module) => 'keepAlive' in module && module.keepAlive === true).length
);
const RENEWAL_WARNING_REFRESH_EVENT = 'v2:renewal-warning-refresh';
const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const routePrefetch = createV2RoutePrefetchController({
  currentPath: () => route.path,
  load: prefetchV2Route
});
const mobileMenuOpen = ref(false);
const sidebarCollapsed = ref(false);
const openSectionKey = ref<string | null>(null);
const currentTheme = ref<V2Theme>(getPreferredV2Theme());
const globalSearchQuery = ref('');
const globalSearchOpen = ref(false);
const notificationOpen = ref(false);
const contentElement = ref<HTMLElement | null>(null);
const pageTitleElement = ref<HTMLElement | null>(null);
const liveMessage = ref('');
const currentPageTitle = computed(() => String(route.meta.title ?? '工作台'));
const navigationSectionIcons: Record<string, Component> = {
  overview: Collection,
  workspace: Monitor,
  business: DataAnalysis,
  records: Files,
  data: DataAnalysis,
  monitoring: Monitor,
  system: Setting
};
const isRoutePending = computed(() => v2RouteNavigationState.state === 'pending');
const isRouteError = computed(() => v2RouteNavigationState.state === 'error');
const queryActivityLabel = computed(() => {
  if (v2QueryActivity.refreshingCount > 0 || v2QueryActivity.lastErrorAt) return '';
  if (!v2QueryActivity.refreshedAt) return '';
  return `更新于 ${new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(v2QueryActivity.refreshedAt)}`;
});
const scrollPositions = new Map<string, number>();
let keyboardNavigation = false;
const visibleNavigationSections = computed(() =>
  v2NavigationSections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => hasUserFeatureAccess(authStore.user, item))
    }))
    .filter((section) => section.items.length)
);
const navigationTitleByGroup = new Map(
  v2NavigationSections.flatMap((section) =>
    section.items.map((item) => [item.group, section.title] as const)
  )
);
const searchableModules = computed(() =>
  v2ModuleDefinitions
    .filter((item) => hasUserFeatureAccess(authStore.user, item))
    .map((item) => ({
      ...item,
      group: navigationTitleByGroup.get(item.group) ?? item.group
    }))
);
const globalSearchResults = computed(() => {
  const keyword = globalSearchQuery.value.toLocaleLowerCase('zh-CN');
  if (!keyword) return [];
  return searchableModules.value
    .filter(
      (item) =>
        item.title.toLocaleLowerCase('zh-CN').includes(keyword) ||
        item.group.toLocaleLowerCase('zh-CN').includes(keyword)
    )
    .slice(0, 6);
});
const operatorInitial = computed(() => authStore.displayName.trim().slice(0, 1) || '管');
const operatorRole = computed(() =>
  authStore.user?.roles?.includes('admin') ? '管理员' : '运营成员'
);
const canViewRenewalWarnings = computed(() =>
  hasUserPermission(authStore.user, 'apple.renewal_task.view')
);
const renewalWarningQuery = useV2Query<V2RenewalWarningSummary>({
  scope: 'renewal-warning-summary',
  key: 'global',
  freshnessPolicy: 'event-with-deadline',
  getRevalidateAt: (result) => result.revalidateAt,
  query: ({ signal }) => idBusinessV2RenewalsApi.getWarningSummary({ signal })
});
const renewalWarningSummary = computed(() => renewalWarningQuery.data.value);
const renewalWarningCount = computed(() => renewalWarningSummary.value?.totalCount ?? 0);
const renewalWarningInitialLoading = computed(() => renewalWarningQuery.isInitialLoading.value);
const renewalWarningError = computed(() => renewalWarningQuery.error.value);

watch(
  () => route.fullPath,
  async (currentPath, previousPath) => {
    if (previousPath) scrollPositions.set(previousPath, contentElement.value?.scrollTop ?? 0);
    closeMobileMenu();
    liveMessage.value = `正在打开${String(route.meta.title ?? '页面')}`;
    const targetScrollTop = scrollPositions.get(currentPath) ?? 0;
    if (contentElement.value) contentElement.value.scrollTop = targetScrollTop;
    await nextTick();
    if (contentElement.value) contentElement.value.scrollTop = targetScrollTop;
    if (keyboardNavigation) {
      pageTitleElement.value?.focus({ preventScroll: true });
    }
    keyboardNavigation = false;
    liveMessage.value = `${String(route.meta.title ?? '页面')}已就绪`;
  }
);

watch(
  () => route.path,
  (path) => {
    const activeSection = visibleNavigationSections.value.find((section) =>
      section.items.some((item) => item.route === path)
    );
    if (activeSection) openSectionKey.value = activeSection.key;
  },
  { immediate: true }
);

watch(
  () => v2QueryActivity.lastErrorAt,
  (failedAt) => {
    if (failedAt) liveMessage.value = '后台更新失败，页面继续显示上次成功的数据';
  }
);

function closeMobileMenu() {
  mobileMenuOpen.value = false;
}

function closeGlobalSearch() {
  window.setTimeout(() => {
    globalSearchOpen.value = false;
  }, 120);
}

async function openSearchResult(path: string) {
  globalSearchOpen.value = false;
  globalSearchQuery.value = '';
  if (route.path !== path) {
    beginNavigation(path);
    await router.push(path);
  }
}

function openFirstSearchResult() {
  const firstResult = globalSearchResults.value[0];
  if (firstResult) void openSearchResult(firstResult.route);
}

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value;
  if (!sidebarCollapsed.value && !openSectionKey.value) {
    openSectionKey.value =
      visibleNavigationSections.value.find((section) => sectionContainsCurrentRoute(section))
        ?.key ??
      visibleNavigationSections.value[0]?.key ??
      null;
  }
}

function toggleNavigationSection(sectionKey: string) {
  if (sidebarCollapsed.value) {
    sidebarCollapsed.value = false;
    openSectionKey.value = sectionKey;
    return;
  }
  openSectionKey.value = openSectionKey.value === sectionKey ? null : sectionKey;
}

function sectionContainsCurrentRoute(section: (typeof visibleNavigationSections.value)[number]) {
  return section.items.some((item) => item.route === route.path);
}

function setTheme(theme: V2Theme) {
  currentTheme.value = theme;
  persistV2Theme(theme);
}

function refreshRenewalWarnings(force = false) {
  if (!canViewRenewalWarnings.value) return;
  void (force ? renewalWarningQuery.refresh() : renewalWarningQuery.ensureFresh());
}

function handleWindowFocus() {
  refreshRenewalWarnings();
}

function handleRenewalWarningRefresh() {
  refreshRenewalWarnings(true);
}

function toggleNotification() {
  notificationOpen.value = !notificationOpen.value;
  if (notificationOpen.value) refreshRenewalWarnings(true);
}

async function openRenewalWarnings() {
  notificationOpen.value = false;
  const path = '/v2/workbench/renewals';
  if (route.path !== path) {
    beginNavigation(path);
    await router.push(path);
  }
}

function formatWarningDueAt(value: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

function handleKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    globalSearchOpen.value = true;
    document.querySelector<HTMLInputElement>('.v2-global-search input')?.focus();
    return;
  }
  if (event.key === 'Tab' || event.key === 'Enter' || event.key === ' ') {
    keyboardNavigation = true;
  }
  if (event.key === 'Escape') {
    closeMobileMenu();
    notificationOpen.value = false;
  }
}

function queueNavigationPrefetch(
  path: string,
  intent: V2RoutePrefetchIntent,
  event?: PointerEvent
) {
  routePrefetch.schedule(path, intent, event?.pointerType);
}

function cancelNavigationPrefetch(path: string) {
  routePrefetch.cancel(path);
}

function beginNavigation(path: string, event?: PointerEvent) {
  if (route.path !== path) setV2RouteNavigationState(path, 'pending');
  routePrefetch.schedule(path, 'pointerdown', event?.pointerType);
}

function retryCurrentRoute() {
  const attemptedPath = v2RouteNavigationState.path || route.fullPath;
  window.location.assign(attemptedPath);
}

function handleAccountCommand(command: string | number | object) {
  if (command === 'profile') {
    beginNavigation('/v2/profile');
    void router.push('/v2/profile');
    return;
  }
  if (command === 'change-password') {
    void router.push('/change-password');
    return;
  }
  if (command === 'logout') {
    void logout();
  }
}

async function logout() {
  stopV2ChangeSync();
  clearV2QueryCache();
  await authStore.logout();
  await router.replace('/login');
}

onMounted(() => {
  startV2ChangeSync();
  window.addEventListener('keydown', handleKeydown);
  window.addEventListener('focus', handleWindowFocus);
  window.addEventListener(RENEWAL_WARNING_REFRESH_EVENT, handleRenewalWarningRefresh);
  refreshRenewalWarnings();
});
onBeforeUnmount(() => {
  stopV2ChangeSync();
  routePrefetch.dispose();
  window.removeEventListener('keydown', handleKeydown);
  window.removeEventListener('focus', handleWindowFocus);
  window.removeEventListener(RENEWAL_WARNING_REFRESH_EVENT, handleRenewalWarningRefresh);
});
</script>
