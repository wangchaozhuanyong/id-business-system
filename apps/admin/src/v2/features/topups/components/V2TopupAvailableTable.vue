<template>
  <V2Table
    :schema="v2TableSchemas.topups.available"
    :show-column-settings="false"
    :aria-busy="page.loading"
    scrollbar-always-on
    show-overflow-tooltip
    class="v2-records-table v2-topup-table"
    :data="page.items"
    @sort-change="page.handleSortChange"
  >
    <template #empty>
      <V2TopupListEmpty :page="page" label="未售出 ID" />
    </template>

    <V2TableColumn
      :definition="v2TableSchemas.topups.available.columns[0]"
      prop="appleId"
      sortable="custom"
    >
      <template #default="{ row }">
        <strong class="v2-topup-account">{{ row.appleIdMasked }}</strong>
      </template>
    </V2TableColumn>
    <V2TableColumn :definition="v2TableSchemas.topups.available.columns[1]">
      <template #default="{ row }">{{ row.country.name }}</template>
    </V2TableColumn>
    <V2TableColumn
      :definition="v2TableSchemas.topups.available.columns[2]"
      prop="currentBalance"
      sortable="custom"
    >
      <template #default="{ row }">{{ page.formatDecimal(row.currentBalance) }}</template>
    </V2TableColumn>
    <V2TableColumn :definition="v2TableSchemas.topups.available.columns[3]">
      <template #default="{ row }">¥{{ page.formatDecimal(row.averageCost) }}</template>
    </V2TableColumn>
    <V2TableColumn :definition="v2TableSchemas.topups.available.columns[4]">
      <template #default="{ row }"><V2TopupRecordActions :page="page" :item="row" /></template>
    </V2TableColumn>
    <V2TableColumn :definition="v2TableSchemas.topups.available.columns[5]">
      <template #default="{ row }"><V2TopupLedgerAction :page="page" :item="row" /></template>
    </V2TableColumn>
    <V2TableColumn :definition="v2TableSchemas.topups.available.columns[6]">
      <template #default="{ row }">
        <span :title="row.lastTopupAt ? page.formatDate(row.lastTopupAt) : undefined">
          {{ page.formatElapsed(row.lastTopupAt) }}
        </span>
      </template>
    </V2TableColumn>
    <V2TableColumn
      :definition="v2TableSchemas.topups.available.columns[7]"
      prop="updatedAt"
      sortable="custom"
    >
      <template #default="{ row }">{{ page.formatElapsed(row.updatedAt) }}</template>
    </V2TableColumn>
    <V2TableColumn :definition="v2TableSchemas.topups.available.columns[8]">
      <template #default="{ row }"><V2TopupCurrentServices :page="page" :item="row" /></template>
    </V2TableColumn>
    <V2TableColumn :definition="v2TableSchemas.topups.available.columns[9]">
      <template #default="{ row }"><V2TopupStatusTag :item="row" /></template>
    </V2TableColumn>
    <V2TableActionColumn :definition="v2TableSchemas.topups.available.columns[10]">
      <template #default="{ row }"><V2TopupCreditAction :page="page" :item="row" /></template>
    </V2TableActionColumn>
  </V2Table>

  <div class="v2-records-mobile-list" :data-mobile-for="v2TableSchemas.topups.available.id">
    <article v-for="item in page.items" :key="item.id" class="v2-records-mobile-item">
      <header>
        <div>
          <strong v-v2-column-visibility="[v2TableSchemas.topups.available.id, 'appleId']">
            {{ item.appleIdMasked }}
          </strong>
          <span v-v2-column-visibility="[v2TableSchemas.topups.available.id, '国家']">
            {{ item.country.name }}
          </span>
        </div>
        <V2TopupStatusTag
          v-v2-column-visibility="[v2TableSchemas.topups.available.id, 'ID 状态']"
          :item="item"
        />
      </header>
      <V2TopupMobileDetails
        :page="page"
        :item="item"
        :schema-id="v2TableSchemas.topups.available.id"
      />
      <footer>
        <span
          v-v2-column-visibility="[v2TableSchemas.topups.available.id, 'updatedAt']"
          class="v2-topup-updated"
        >
          {{ page.formatDate(item.updatedAt) }}
        </span>
        <div class="v2-topup-mobile-actions">
          <V2TopupCreditAction :page="page" :item="item" />
        </div>
      </footer>
    </article>
    <V2TopupListEmpty v-if="!page.items.length" :page="page" label="未售出 ID" />
  </div>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import V2TopupCreditAction from './V2TopupCreditAction.vue';
import V2TopupCurrentServices from './V2TopupCurrentServices.vue';
import V2TopupLedgerAction from './V2TopupLedgerAction.vue';
import V2TopupListEmpty from './V2TopupListEmpty.vue';
import V2TopupMobileDetails from './V2TopupMobileDetails.vue';
import V2TopupRecordActions from './V2TopupRecordActions.vue';
import V2TopupStatusTag from './V2TopupStatusTag.vue';
import type { useTopupWorkbenchPage } from '../useTopupWorkbenchPage';

type TopupWorkbenchPage = UnwrapNestedRefs<ReturnType<typeof useTopupWorkbenchPage>>;

defineProps<{ page: TopupWorkbenchPage }>();
</script>
