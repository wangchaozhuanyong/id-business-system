<template>
  <div>
    <V2AsyncRegion
      skeleton="table"
      loading-title="正在加载隐藏邮箱"
      :phase="page.query.phase.value"
      :previous-data="page.query.isParameterTransition.value"
      :error="page.query.error.value ? getApiErrorMessage(page.query.error.value) : ''"
      @retry="page.query.refresh"
    >
      <section ref="listRef" class="v2-records-list" :style="listFrameStyle">
        <header>
          <V2SectionHeading title="隐藏邮箱">
            <template #actions>
              <V2TableColumnSettings inline :schema="v2TableSchemas.registrationMailboxes.main" />
              <span>共 {{ page.query.data.value?.total ?? 0 }} 条</span>
            </template>
          </V2SectionHeading>
        </header>
        <V2Table
          :schema="v2TableSchemas.registrationMailboxes.main"
          :show-column-settings="false"
          :data="page.query.data.value?.items ?? []"
          class="v2-records-table"
        >
          <template #empty
            ><div class="v2-records-empty">
              <strong>暂无隐藏邮箱</strong><span>在邮件验证码查询添加隐藏邮箱后会显示在这里</span>
            </div></template
          >
          <V2TableColumn
            :definition="v2TableSchemas.registrationMailboxes.main.columns[0]"
            prop="email"
            show-overflow-tooltip
          />
          <V2TableColumn
            :definition="v2TableSchemas.registrationMailboxes.main.columns[1]"
            show-overflow-tooltip
          >
            <template #default="{ row }">{{ row.primaryEmail || '未设置' }}</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.registrationMailboxes.main.columns[2]">
            <template #default="{ row }">{{ row.status === 'ACTIVE' ? '启用' : '停用' }}</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.registrationMailboxes.main.columns[3]">
            <template #default="{ row }"
              ><el-tag :type="row.registered ? 'success' : 'info'">{{
                row.registered ? '已注册' : '未注册'
              }}</el-tag></template
            >
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.registrationMailboxes.main.columns[4]"
            prop="note"
            show-overflow-tooltip
          />
          <V2TableColumn :definition="v2TableSchemas.registrationMailboxes.main.columns[5]">
            <template #default="{ row }">{{ formatV2DateTime(row.updatedAt) }}</template>
          </V2TableColumn>
          <V2TableActionColumn :definition="v2TableSchemas.registrationMailboxes.main.columns[6]">
            <template #default="{ row }">
              <AppButton
                size="small"
                variant="ghost"
                :disabled="page.busy.value"
                @click="page.openMark(row)"
                >{{ row.registered ? '标记未注册' : '标记已注册' }}</AppButton
              >
            </template>
          </V2TableActionColumn>
        </V2Table>
        <footer class="v2-records-pagination">
          <span>共 {{ page.query.data.value?.total ?? 0 }} 条</span>
          <el-pagination
            v-pagination-label
            :current-page="page.filters.page"
            :page-size="page.filters.pageSize"
            :total="page.query.data.value?.total ?? 0"
            :page-sizes="[20, 50, 100]"
            layout="total, sizes, prev, pager, next"
            @current-change="page.changePage"
            @size-change="page.changePageSize"
          />
        </footer>
      </section>
    </V2AsyncRegion>
    <p v-if="page.message.value" role="status">{{ page.message.value }}</p>
    <V2ConfirmDialog
      :model-value="page.confirmOpen.value"
      :title="page.target.value?.registered ? '标记未注册' : '标记已注册'"
      message=""
      :confirm-text="page.target.value?.registered ? '确认未注册' : '确认已注册'"
      :confirm-loading="page.busy.value"
      @update:model-value="page.setConfirmOpen"
      @confirm="page.confirm"
    >
      <p>
        确认将 {{ page.target.value?.email }} 标记为{{
          page.target.value?.registered ? '未注册' : '已注册'
        }}？
      </p>
      <p v-if="page.target.value?.registered">
        已有账号、密码、安全资料、备注和关联记录会保留；此操作只修正注册状态。
      </p>
      <p v-else>确认后创建或复用 ChatGPT 账号，密码和双重验证资料可在账号页面补充。</p>
      <p v-if="page.error.value" role="alert">{{ page.error.value }}</p>
    </V2ConfirmDialog>
  </div>
</template>

<script setup lang="ts">
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import { getApiErrorMessage } from '@/api/client';
import { formatV2DateTime } from '@/v2/utils/dateTime';
import type { useRegistrationMailboxes } from './useRegistrationMailboxes';

const props = defineProps<{ page: ReturnType<typeof useRegistrationMailboxes> }>();
const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => props.page.query.data.value?.items ?? [],
  pageSize: () => props.page.filters.pageSize
});
</script>
