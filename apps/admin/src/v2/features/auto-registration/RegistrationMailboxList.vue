<template>
  <div>
    <V2AsyncRegion
      skeleton="table"
      loading-title="正在加载邮箱"
      :phase="page.query.phase.value"
      :previous-data="page.query.isParameterTransition.value"
      :error="page.query.error.value ? getApiErrorMessage(page.query.error.value) : ''"
      @retry="page.query.refresh"
    >
      <section ref="listRef" class="v2-records-list" :style="listFrameStyle">
        <header>
          <V2SectionHeading :title="title">
            <template #actions>
              <V2TableColumnSettings inline :schema="v2TableSchemas.registrationMailboxes.main" />
              <span>共 {{ page.query.data.value?.total ?? 0 }} 条</span>
            </template>
          </V2SectionHeading>
        </header>
        <V2Table
          :schema="v2TableSchemas.registrationMailboxes.main"
          :show-column-settings="false"
          :view-key="title"
          :data="page.query.data.value?.items ?? []"
          class="v2-records-table"
        >
          <template #empty
            ><div class="v2-records-empty">
              <strong>暂无{{ title }}</strong
              ><span>可调整搜索条件，或在邮件验证码查询中管理邮箱</span>
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
            <template #default="{ row }">
              <el-select
                :model-value="row.registered"
                :aria-label="`${row.email}注册状态`"
                :disabled="page.busy.value || row.startBlockedReason === 'unfinished_task'"
                :title="
                  row.startBlockedReason === 'unfinished_task'
                    ? mailboxBlockedReasons.unfinished_task
                    : ''
                "
                @change="(value: unknown) => page.openMark(row, value)"
              >
                <el-option label="未注册" :value="false" />
                <el-option label="已注册" :value="true" />
              </el-select>
            </template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.registrationMailboxes.main.columns[4]">
            <template #default="{ row }">{{
              chatgptCountryLabel(row.registrationCountryCode)
            }}</template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.registrationMailboxes.main.columns[5]"
            prop="note"
            show-overflow-tooltip
          />
          <V2TableColumn :definition="v2TableSchemas.registrationMailboxes.main.columns[6]">
            <template #default="{ row }">{{ formatV2DateTime(row.updatedAt) }}</template>
          </V2TableColumn>
          <V2TableActionColumn :definition="v2TableSchemas.registrationMailboxes.main.columns[7]">
            <template #default="{ row }">
              <AppButton
                v-if="row.pendingJobId"
                size="small"
                variant="ghost"
                @click="$emit('view-job', row.pendingJobId)"
                >查看任务</AppButton
              >
              <AppButton
                v-else
                size="small"
                variant="ghost"
                :disabled="page.busy.value || !row.canStart"
                :title="blockedReason(row)"
                @click="page.select(row)"
                >{{
                  page.selected.value?.id === row.id
                    ? '已选择'
                    : row.registered
                      ? '已注册'
                      : row.canStart
                        ? '选择注册'
                        : '不可注册'
                }}</AppButton
              >
              <AppButton
                v-if="row.registered && row.accountId"
                size="small"
                variant="ghost"
                :disabled="page.busy.value || !row.accountUpdatedAt"
                @click="page.openCountry(row)"
                >修改国家</AppButton
              >
            </template>
          </V2TableActionColumn>
        </V2Table>
        <footer class="v2-records-pagination">
          <span>共 {{ page.query.data.value?.total ?? 0 }} 条</span>
          <el-pagination
            v-pagination-label
            :current-page="page.query.data.value?.page ?? page.filters.page"
            :page-size="page.query.data.value?.pageSize ?? page.filters.pageSize"
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
    <V2FormDrawer
      :model-value="page.countryOpen.value"
      title="修改国家"
      description="记录此 ChatGPT 账号的注册国家；未知时可留空。"
      :confirm-loading="page.busy.value"
      @update:model-value="page.setCountryOpen"
      @confirm="page.saveCountry"
    >
      <p>{{ page.countryTarget.value?.email }}</p>
      <el-form
        label-position="left"
        label-width="80px"
        require-asterisk-position="right"
        @submit.prevent="page.saveCountry"
      >
        <el-form-item label="国家">
          <el-select
            :model-value="page.countryDraft.form.registrationCountryCode"
            aria-label="注册国家"
            placeholder="选择国家；未知可留空"
            filterable
            clearable
            :disabled="page.busy.value"
            @update:model-value="page.setCountry"
          >
            <el-option
              v-for="[code, label] in chatgptCountries"
              :key="code"
              :label="label"
              :value="code"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <p v-if="page.countryError.value" role="alert">{{ page.countryError.value }}</p>
    </V2FormDrawer>
    <V2ConfirmDialog
      :model-value="page.confirmOpen.value"
      :title="page.desiredRegistered.value ? '标记已注册' : '标记未注册'"
      message=""
      :confirm-text="page.desiredRegistered.value ? '确认已注册' : '确认未注册'"
      :confirm-loading="page.busy.value"
      @update:model-value="page.setConfirmOpen"
      @confirm="page.confirm"
    >
      <p>
        确认将 {{ page.target.value?.email }} 标记为{{
          page.desiredRegistered.value ? '已注册' : '未注册'
        }}？
      </p>
      <p v-if="!page.desiredRegistered.value">
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
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import { chatgptCountries, chatgptCountryLabel } from '@/v2/features/auto-recharge/public-api';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import { getApiErrorMessage } from '@/api/client';
import { formatV2DateTime } from '@/v2/utils/dateTime';
import type { V2RegistrationMailbox } from './contracts';
import type { useRegistrationMailboxes } from './useRegistrationMailboxes';
import { mailboxBlockedReasons } from './presentation';

const props = defineProps<{ page: ReturnType<typeof useRegistrationMailboxes>; title: string }>();
defineEmits<{ 'view-job': [id: string] }>();
function blockedReason(row: V2RegistrationMailbox) {
  return row.startBlockedReason ? mailboxBlockedReasons[row.startBlockedReason] : '';
}
const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => props.page.query.data.value?.items ?? [],
  pageSize: () => props.page.filters.pageSize
});
</script>
