<template>
  <section class="v2-page-layout v2-auto-registration-page">
    <V2PageContext description="管理注册任务、账号、苹果隐藏邮箱、邮箱服务、订阅与系统设置。">
      <template #filters>
        <div class="v2-auto-registration-tabs" role="tablist" aria-label="自动注册功能">
          <AppButton
            v-for="page in parentPages"
            :id="`registration-tab-${page.path.slice(1) || 'console'}`"
            :key="page.path"
            role="tab"
            :variant="activePage === page.path ? 'primary' : 'soft'"
            :aria-selected="activePage === page.path"
            :aria-controls="
              page.path === appleMailboxPage.path
                ? 'registration-apple-mailboxes'
                : 'registration-workspace'
            "
            :disabled="!canAccess"
            @click="navigateWorkspace(page.path)"
          >
            {{ page.title }}
          </AppButton>
        </div>
      </template>
      <template #actions>
        <AppButton
          v-if="activePage !== appleMailboxPage.path"
          variant="soft"
          :disabled="!canAccess"
          @click="workspaceQuery.refresh"
        >
          刷新
        </AppButton>
      </template>
    </V2PageContext>

    <V2AppleMailboxes
      v-if="activePage === appleMailboxPage.path && canAccess"
      id="registration-apple-mailboxes"
      role="tabpanel"
    />
    <V2AsyncRegion
      v-else
      skeleton="form"
      :phase="queryPhase"
      :error="errorMessage"
      :forbidden="!canAccess"
      :empty="workspaceQuery.hasData.value && !workspaceQuery.data.value?.ready"
      loading-title="正在加载自动注册"
      refreshing-title="正在更新自动注册连接"
      error-title="自动注册加载失败"
      empty-title="自动注册服务尚未启动"
      empty-message="启动本地自动注册服务后，点击刷新重新连接。"
      forbidden-message="请使用已登录的管理员账号访问自动注册。"
      @retry="workspaceQuery.refresh"
    >
      <iframe
        v-if="workspaceUrl && canAccess"
        id="registration-workspace"
        ref="workspaceFrame"
        class="v2-auto-registration-frame"
        :src="workspaceUrl"
        :title="activePageTitle"
        @load="sendWorkspaceState"
      />
    </V2AsyncRegion>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import AppButton from '@/components/ui/AppButton.vue';
import { useAuthStore } from '@/stores/auth';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2PageContext from '@/v2/components/V2PageContext.vue';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { autoRegistrationApi } from './api';
import {
  autoRegistrationPages,
  appleMailboxPage,
  type AutoRegistrationDraft,
  type AutoRegistrationPage,
  type AutoRegistrationParentPage,
  type AutoRegistrationStatus
} from './contracts';
import {
  readRegistrationChildMessage,
  registrationThemeState,
  registrationWorkspaceUrl,
  sanitizeRegistrationDraft
} from './bridge';
import V2AppleMailboxes from './V2AppleMailboxes.vue';

const parentPages = [autoRegistrationPages[0], appleMailboxPage, ...autoRegistrationPages.slice(1)];

const auth = useAuthStore();
const identityChanged = ref(false);
const canAccess = computed(
  () => !identityChanged.value && auth.writesAllowed && !!auth.user?.roles.includes('admin')
);
const activePage = useV2SessionDraft('auto-registration:active-page', () =>
  ref<AutoRegistrationParentPage>('/')
);
// 只控制父页面发起的导航，子页面内部跳转不重设 iframe 地址。
const frameEntryPage = ref<AutoRegistrationPage>(
  activePage.value === appleMailboxPage.path ? '/' : activePage.value
);
const pageDrafts = useV2SessionDraft(
  'auto-registration:page-drafts',
  () => new Map<AutoRegistrationPage, AutoRegistrationDraft>()
);
const workspaceFrame = ref<HTMLIFrameElement>();
const unsubscribeIdentity = sessionCoordinator.subscribeIdentityChange(() => {
  identityChanged.value = true;
  workspaceFrame.value?.remove();
  workspaceFrame.value = undefined;
  pageDrafts.clear();
});
const workspaceQuery = useV2ModuleQuery<AutoRegistrationStatus & { expiresAt?: string }>({
  moduleKey: 'auto-registration',
  scope: 'auto-registration',
  key: 'workspace',
  enabled: () => canAccess.value && activePage.value !== appleMailboxPage.path,
  getRevalidateAt: (data) => {
    const expiresAt = data.expiresAt ? Date.parse(data.expiresAt) : NaN;
    return Number.isFinite(expiresAt) ? Math.max(Date.now() + 1_000, expiresAt - 30_000) : null;
  },
  query: async ({ signal }) => {
    const status = await autoRegistrationApi.status({ signal });
    if (!status.ready) return status;
    registrationWorkspaceUrl(status.workspacePath, '/');
    const session = await autoRegistrationApi.workspaceSession({ signal });
    return { ...status, expiresAt: session.expiresAt };
  }
});
const queryPhase = workspaceQuery.phase;
const errorMessage = computed(() =>
  workspaceQuery.error.value ? getApiErrorMessage(workspaceQuery.error.value) : ''
);
const workspaceUrl = computed(() => {
  const status = workspaceQuery.data.value;
  return canAccess.value && activePage.value !== appleMailboxPage.path && status?.ready
    ? registrationWorkspaceUrl(status.workspacePath, frameEntryPage.value)
    : '';
});
const activePageTitle = computed(
  () => parentPages.find((page) => page.path === activePage.value)?.title ?? '自动注册'
);
let themeObserver: MutationObserver | undefined;

function navigateWorkspace(page: AutoRegistrationParentPage) {
  if (!canAccess.value || activePage.value === page) return;
  activePage.value = page;
  if (page === appleMailboxPage.path) return;
  if (frameEntryPage.value === page && workspaceFrame.value) {
    const status = workspaceQuery.data.value;
    if (status?.ready) {
      workspaceFrame.value.src = registrationWorkspaceUrl(status.workspacePath, page);
    }
  } else {
    frameEntryPage.value = page;
  }
}

function sendWorkspaceState() {
  if (!canAccess.value || activePage.value === appleMailboxPage.path) return;
  const root = document.documentElement;
  workspaceFrame.value?.contentWindow?.postMessage(
    registrationThemeState(root, getComputedStyle(root), pageDrafts.get(activePage.value) ?? {}),
    window.location.origin
  );
}

function receiveWorkspaceMessage(event: MessageEvent) {
  if (!canAccess.value || activePage.value === appleMailboxPage.path) return;
  const message = readRegistrationChildMessage(
    event,
    workspaceFrame.value?.contentWindow ?? null,
    window.location.origin,
    activePage.value
  );
  if (message?.type === 'id-registration:ready') {
    activePage.value = message.page;
    sendWorkspaceState();
  }
  if (message?.type === 'id-registration:draft') {
    pageDrafts.set(message.page, sanitizeRegistrationDraft(message.values));
  }
}

onMounted(() => {
  window.addEventListener('message', receiveWorkspaceMessage);
  themeObserver = new MutationObserver(sendWorkspaceState);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-v2-theme', 'class']
  });
});
onBeforeUnmount(() => {
  window.removeEventListener('message', receiveWorkspaceMessage);
  themeObserver?.disconnect();
  unsubscribeIdentity();
});
</script>

<style scoped>
.v2-auto-registration-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--v2-layout-control-gap);
}

.v2-auto-registration-frame {
  display: block;
  width: 100%;
  min-height: 720px;
  border: 0;
}
</style>
