<template>
  <section class="v2-records-page">
    <V2AccountsOverview v-if="!showingLossRecords" :page="page" />

    <V2PageContext
      v-else
      description="查看报损冻结、余额损失和财务冲回记录；恢复操作会保留原报损快照和审计记录。"
      aria-label="ID 报损记录说明"
    >
      <template #meta>
        <span>ID 报损记录 · 不可修改快照</span>
      </template>
    </V2PageContext>

    <V2AccountsToolbar
      :page="page"
      :active-lifecycle="activeLifecycle"
      :showing-loss-records="showingLossRecords"
      @select="selectLifecycle"
    />

    <input
      v-if="!showingLossRecords"
      ref="importFileInput"
      class="v2-sr-only"
      type="file"
      accept=".csv,text/csv"
      @change="page.handleImportFile"
    />

    <V2AccountsList v-if="!showingLossRecords" :page="page" />
    <V2AccountDialogs v-if="!showingLossRecords" :page="page" />
    <V2AccountLossesView v-if="showingLossRecords" />
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import V2PageContext from '@/v2/components/V2PageContext.vue';
import V2AccountLossesView from '@/v2/features/account-losses/V2AccountLossesView.vue';
import V2AccountDialogs from './components/V2AccountDialogs.vue';
import V2AccountsList from './components/V2AccountsList.vue';
import V2AccountsOverview from './components/V2AccountsOverview.vue';
import V2AccountsToolbar from './components/V2AccountsToolbar.vue';
import { useAccountsPage } from './useAccountsPage';
import type { V2AccountLifecycle } from './contracts';
import '@/v2/styles/records.css';
import '@/v2/styles/accounts.css';

const accountPage = useAccountsPage();
const importFileInput = accountPage.importFileInput;
const page = reactive(accountPage);
const activeLifecycle = ref<V2AccountLifecycle>(page.query.lifecycle);
const showingLossRecords = computed(() => activeLifecycle.value === 'reported');

function selectLifecycle(lifecycle: V2AccountLifecycle) {
  if (lifecycle === 'reported') {
    if (!page.canViewLosses) return;
    activeLifecycle.value = lifecycle;
    return;
  }
  activeLifecycle.value = lifecycle;
  page.changeLifecycle(lifecycle);
}
</script>
