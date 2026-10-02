<template>
  <section class="v2-page-layout v2-records-page">
    <V2PageContext
      description="显示邮件验证码查询中的全部隐藏邮箱；确认已注册后加入 ChatGPT 账号，也可查看自动注册任务。"
    >
      <template #filters
        ><el-form
          inline
          label-position="left"
          require-asterisk-position="right"
          @submit.prevent="search"
        >
          <el-form-item label="邮箱搜索"
            ><el-input
              v-model="keyword"
              :placeholder="activeTab === 'mailboxes' ? '隐藏邮箱、主邮箱或备注' : '脱敏邮箱'"
              maxlength="120"
              clearable
              @keyup.enter="search"
          /></el-form-item>
          <el-form-item><AppButton @click="search">查询</AppButton></el-form-item>
        </el-form></template
      >
      <template #actions
        ><AppButton @click="page.browserSettings.setSettingsOpen(true)">本机设置</AppButton
        ><AppButton variant="primary" @click="page.openStart">开始注册</AppButton></template
      >
    </V2PageContext>
    <el-tabs v-model="activeTab" aria-label="注册资料分类">
      <el-tab-pane label="隐藏邮箱" name="mailboxes" />
      <el-tab-pane label="注册任务" name="jobs" />
    </el-tabs>
    <p v-if="page.error.value" role="alert">{{ page.error.value }}</p>
    <p v-if="page.message.value" role="status">{{ page.message.value }}</p>
    <V2AsyncRegion
      v-if="page.filters.activeJobId"
      skeleton="form"
      loading-title="正在读取当前任务"
      :phase="page.activeQuery.phase.value"
      :previous-data="page.activeQuery.isParameterTransition.value"
      :error="page.activeQuery.error.value ? getApiErrorMessage(page.activeQuery.error.value) : ''"
      @retry="page.activeQuery.refresh"
    >
      <section v-if="page.selected.value" class="v2-panel" aria-label="当前任务">
        <p>
          {{ page.selected.value.emailMasked }} · {{ stateLabels[page.selected.value.state] }} ·
          {{ stepLabels[page.selected.value.step] }}
        </p>
        <p v-if="page.selected.value.reason">
          {{ registrationReasons[page.selected.value.reason] ?? '请核对原浏览器窗口后继续。' }}
        </p>
        <p>
          注册：{{ page.selected.value.registered ? '已核实' : '待核实' }} · 密码：{{
            page.selected.value.passwordVerified ? '已核实' : '待核实'
          }}
          · 双重验证：{{ page.selected.value.mfaVerified ? '已核实' : '待核实' }}
        </p>
        <el-form
          v-if="page.selected.value.state === 'awaiting_email'"
          inline
          label-position="left"
          require-asterisk-position="right"
          @submit.prevent="page.manualSubmit"
        >
          <el-form-item label="邮件验证码"
            ><el-input
              v-model="page.loginCode.value"
              inputmode="numeric"
              maxlength="8"
              autocomplete="one-time-code"
              placeholder="自动读取失败时手动填写"
          /></el-form-item>
          <el-form-item
            ><AppButton :loading="page.busy.value" @click="page.manualSubmit"
              >提交验证码</AppButton
            ></el-form-item
          >
        </el-form>
      </section>
    </V2AsyncRegion>
    <RegistrationMailboxList v-show="activeTab === 'mailboxes'" :page="mailboxes" />
    <V2AsyncRegion
      v-if="activeTab === 'jobs'"
      skeleton="table"
      loading-title="正在加载列表"
      :phase="page.query.phase.value"
      :previous-data="page.query.isParameterTransition.value"
      :error="page.query.error.value ? getApiErrorMessage(page.query.error.value) : ''"
      @retry="page.query.refresh"
    >
      <section ref="listRef" class="v2-records-list" :style="listFrameStyle">
        <header>
          <V2SectionHeading title="注册任务"
            ><template #actions
              ><V2TableColumnSettings inline :schema="v2TableSchemas.registrationJobs.main" /><span
                >共 {{ page.query.data.value?.total ?? 0 }} 条</span
              ></template
            ></V2SectionHeading
          >
        </header>
        <V2Table
          :schema="v2TableSchemas.registrationJobs.main"
          :show-column-settings="false"
          :data="page.query.data.value?.items ?? []"
          class="v2-records-table"
        >
          <template #empty
            ><div class="v2-records-empty">
              <strong>暂无注册任务</strong><span>准备好邮箱和名字后，点击开始注册</span>
            </div></template
          >
          <V2TableColumn
            :definition="v2TableSchemas.registrationJobs.main.columns[0]"
            prop="emailMasked"
            show-overflow-tooltip
          />
          <V2TableColumn
            :definition="v2TableSchemas.registrationJobs.main.columns[1]"
            prop="displayName"
          />
          <V2TableColumn :definition="v2TableSchemas.registrationJobs.main.columns[2]"
            ><template #default="{ row }">{{
              stateLabels[row.state as V2RegistrationJob['state']]
            }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.registrationJobs.main.columns[3]"
            ><template #default="{ row }">{{
              stepLabels[row.step as V2RegistrationJob['step']]
            }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.registrationJobs.main.columns[4]"
            ><template #default="{ row }">{{
              V2_ACCOUNT_OFFER_LABELS[row.offerStatus as V2RegistrationJob['offerStatus']]
            }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.registrationJobs.main.columns[5]"
            ><template #default="{ row }">{{
              formatV2DateTime(row.updatedAt)
            }}</template></V2TableColumn
          >
          <V2TableActionColumn :definition="v2TableSchemas.registrationJobs.main.columns[6]"
            ><template #default="{ row }">
              <AppButton size="small" variant="ghost" @click="page.filters.activeJobId = row.id"
                >查看</AppButton
              >
              <AppButton
                v-if="['queued', 'partial', 'awaiting_user'].includes(row.state)"
                size="small"
                variant="ghost"
                :disabled="page.busy.value"
                @click="page.act(row, 'continue')"
                >继续</AppButton
              >
              <AppButton
                v-if="!['completed', 'cancelled'].includes(row.state)"
                size="small"
                variant="ghost"
                :disabled="page.busy.value"
                @click="page.act(row, 'cancel')"
                >取消</AppButton
              >
            </template></V2TableActionColumn
          >
        </V2Table>
        <footer class="v2-records-pagination">
          <span>共 {{ page.query.data.value?.total ?? 0 }} 条</span
          ><el-pagination
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
    <V2FormDrawer
      v-model="page.formOpen.value"
      title="自动注册 GPT"
      confirm-text="开始注册"
      :confirm-loading="page.busy.value"
      :confirm-disabled-reason="
        page.options.phase.value !== 'ready' ? '请先等待注册资料加载完成' : ''
      "
      @confirm="page.start"
    >
      <p v-if="page.error.value" role="alert">{{ page.error.value }}</p>
      <V2AsyncRegion
        skeleton="form"
        loading-title="正在加载注册资料"
        :phase="page.options.phase.value"
        :previous-data="page.options.isParameterTransition.value"
        :error="page.options.error.value ? getApiErrorMessage(page.options.error.value) : ''"
        @retry="page.options.refresh"
      >
        <el-form
          :ref="bindForm"
          :model="page.draft.form"
          :rules="page.rules"
          scroll-to-error
          label-position="left"
          label-width="110px"
          require-asterisk-position="right"
        >
          <el-form-item label="资料搜索"
            ><el-input
              v-model="page.filters.optionSearch"
              clearable
              placeholder="搜索邮箱、代理国家或名字"
              @keyup.enter="page.searchOptions"
          /></el-form-item>
          <el-form-item label="选项页码"
            ><el-input-number v-model="page.filters.optionPage" :min="1" :max="1000" /><span
              >每页最多 100 项</span
            ></el-form-item
          >
          <el-form-item label="注册邮箱" prop="mailboxAliasId"
            ><el-select
              v-model="page.draft.form.mailboxAliasId"
              filterable
              placeholder="选择已录入的授权邮箱"
              ><el-option
                v-for="item in page.options.data.value?.mailboxes ?? []"
                :key="item.id"
                :label="item.email"
                :value="item.id" /></el-select
          ></el-form-item>
          <el-form-item label="代理" prop="proxyId"
            ><el-select v-model="page.draft.form.proxyId" filterable placeholder="选择已启用的代理"
              ><el-option
                v-for="item in page.options.data.value?.proxies ?? []"
                :key="item.id"
                :label="item.label"
                :value="item.id" /></el-select
          ></el-form-item>
          <el-form-item label="名字" prop="nameId"
            ><el-select
              v-model="page.draft.form.nameId"
              clearable
              filterable
              placeholder="留空自动选择启用名字"
              ><el-option
                v-for="item in page.options.data.value?.names ?? []"
                :key="item.id"
                :label="item.displayName"
                :value="item.id" /></el-select
          ></el-form-item>
          <el-form-item label="真实出生日期" prop="birthDate"
            ><el-date-picker
              v-model="page.draft.form.birthDate"
              type="date"
              value-format="YYYY-MM-DD"
              placeholder="实际年龄为 20 至 45 岁"
          /></el-form-item>
          <el-form-item label="资料确认" prop="confirmIdentity"
            ><el-checkbox v-model="page.draft.form.confirmIdentity"
              >邮箱已授权，出生日期为真实资料</el-checkbox
            ></el-form-item
          >
          <p>
            密码由系统生成并加密保存。本人验证需要在原浏览器窗口完成；本功能只检查优惠，不领取或付款。
          </p>
        </el-form>
      </V2AsyncRegion>
    </V2FormDrawer>
    <RechargeBrowserSettings :settings="page.browserSettings" />
  </section>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue';
import '@/v2/styles/records.css';
import AppButton from '@/components/ui/AppButton.vue';
import V2PageContext from '@/v2/components/V2PageContext.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import { getApiErrorMessage } from '@/api/client';
import { formatV2DateTime } from '@/v2/utils/dateTime';
import { RechargeBrowserSettings } from '../auto-recharge/public-api';
import { V2_ACCOUNT_OFFER_LABELS, type V2RegistrationJob } from './contracts';
import { stateLabels, stepLabels, registrationReasons } from './presentation';
import { useRegistrationPage } from './useRegistrationPage';
import { useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { useRegistrationMailboxes } from './useRegistrationMailboxes';
import RegistrationMailboxList from './RegistrationMailboxList.vue';
const activeTab = useV2SessionDraft('auto-registration:tab', () =>
  ref<'mailboxes' | 'jobs'>('mailboxes')
);
const page = useRegistrationPage({
  moduleKey: 'auto-registration',
  enabled: () => activeTab.value === 'jobs'
});
const mailboxes = useRegistrationMailboxes(() => activeTab.value === 'mailboxes');
const keyword = computed({
  get: () => (activeTab.value === 'mailboxes' ? mailboxes.filters.keyword : page.filters.keyword),
  set: (value: string) => {
    if (activeTab.value === 'mailboxes') mailboxes.filters.keyword = value;
    else page.filters.keyword = value;
  }
});
function search() {
  if (activeTab.value === 'mailboxes') mailboxes.search();
  else page.search();
}
const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => page.query.data.value?.items ?? [],
  pageSize: () => page.filters.pageSize
});
const bindForm = page.bindForm;
</script>
