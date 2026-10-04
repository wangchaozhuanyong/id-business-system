<template>
  <section class="v2-page-layout v2-records-page bank-recharge-page">
    <V2PageContext
      description="管理未开通或订阅已取消的待用账号及回收站；软删除保留资料，恢复后保持停用。密码与 2FA 加密存储。"
    >
      <template #actions>
        <ChatgptAccountCopySettings />
        <AppButton @click="importOpen = true">批量导入</AppButton>
        <AppButton variant="primary" @click="openCreate">新增账号</AppButton>
      </template>
      <template #filters>
        <el-form
          inline
          label-position="left"
          require-asterisk-position="right"
          @submit.prevent="search"
        >
          <el-form-item label="账号搜索"
            ><el-input
              v-model="keywordInput"
              placeholder="邮箱或备注"
              clearable
              @keyup.enter="search"
          /></el-form-item>
          <el-form-item label="优惠状况">
            <ChatgptAccountOfferSelect v-model="offerStatus" all />
          </el-form-item>
          <el-form-item><AppButton @click="search">搜索</AppButton></el-form-item>
        </el-form>
      </template>
    </V2PageContext>

    <el-tabs v-model="deletedFilter" aria-label="账号清单分类">
      <el-tab-pane label="待用账号" name="active" />
      <el-tab-pane label="回收站" name="deleted" />
    </el-tabs>
    <p v-if="restoreNavigationError" class="bank-recharge-error" role="alert">
      {{ restoreNavigationError }}
    </p>
    <p v-if="operationError" class="bank-recharge-error" role="alert">{{ operationError }}</p>
    <V2AsyncRegion
      skeleton="table"
      :phase="query.phase.value"
      :previous-data="query.isParameterTransition.value"
      :error="query.error.value ? getApiErrorMessage(query.error.value) : ''"
      loading-title="正在加载 ChatGPT 账号"
      @retry="query.refresh"
    >
      <section ref="listRef" class="v2-records-list" :style="listFrameStyle">
        <header>
          <V2SectionHeading title="账号清单">
            <template #actions>
              <V2TableColumnSettings inline :schema="v2TableSchemas.chatgptAccounts.main" />
              <span>共 {{ query.data.value?.total ?? accounts.length }} 条</span>
            </template>
          </V2SectionHeading>
        </header>
        <V2Table
          :schema="v2TableSchemas.chatgptAccounts.main"
          :show-column-settings="false"
          :data="accounts"
          class="v2-records-table bank-recharge-nowrap"
        >
          <template #empty>
            <div class="v2-records-empty">
              <strong>暂无 ChatGPT 账号</strong>
              <span>新增账号后可关联到银充订单</span>
            </div>
          </template>
          <V2TableColumn
            :definition="v2TableSchemas.chatgptAccounts.main.columns[0]"
            prop="emailMasked"
            show-overflow-tooltip
          />
          <V2TableColumn
            :definition="v2TableSchemas.chatgptAccounts.main.columns[1]"
            show-overflow-tooltip
          >
            <template #default="{ row }">{{
              chatgptCountryLabel(row.registrationCountryCode)
            }}</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.chatgptAccounts.main.columns[2]">
            <template #default="{ row }">
              <el-tag :type="row.status === 'active' ? 'success' : 'info'" effect="plain">{{
                row.status === 'active' ? '启用' : '停用'
              }}</el-tag>
            </template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.chatgptAccounts.main.columns[3]">
            <template #default="{ row }">{{
              V2_ACCOUNT_OFFER_LABELS[(row.offerStatus ?? 'unknown') as V2AccountOffer]
            }}</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.chatgptAccounts.main.columns[4]">
            <template #default="{ row }">{{ row.hasPassword ? '已保存' : '未保存' }}</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.chatgptAccounts.main.columns[5]">
            <template #default="{ row }">{{ row.hasTotp ? '已保存' : '未保存' }}</template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.chatgptAccounts.main.columns[6]"
            show-overflow-tooltip
          >
            <template #default="{ row }">
              <span
                v-if="row.firstLoginNetwork"
                :title="formatV2DateTime(row.firstLoginNetwork.observedAt)"
              >
                {{ row.firstLoginNetwork.ip }} ·
                {{ proxyCountryLabel(row.firstLoginNetwork.countryCode) }}
              </span>
              <span v-else>未记录</span>
            </template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.chatgptAccounts.main.columns[7]"
            show-overflow-tooltip
          >
            <template #default="{ row }">
              <span
                v-if="row.lastLoginNetwork"
                :title="formatV2DateTime(row.lastLoginNetwork.observedAt)"
              >
                {{ row.lastLoginNetwork.ip }} ·
                {{ proxyCountryLabel(row.lastLoginNetwork.countryCode) }}
              </span>
              <span v-else>未记录</span>
            </template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.chatgptAccounts.main.columns[8]"
            prop="remark"
            show-overflow-tooltip
          />
          <V2TableColumn :definition="v2TableSchemas.chatgptAccounts.main.columns[9]">
            <template #default="{ row }">
              <span title="首次录入系统的时间">{{ formatV2DateTime(row.createdAt) }}</span>
            </template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.chatgptAccounts.main.columns[10]">
            <template #default="{ row }">
              <span title="从首次录入起，每满 24 小时增加 1 天；不足一天为 0 天">{{
                registeredDaysLabel(row.createdAt)
              }}</span>
            </template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.chatgptAccounts.main.columns[11]">
            <template #default="{ row }">{{ formatV2DateTime(row.updatedAt) }}</template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.chatgptAccounts.main.columns[12]"
            show-overflow-tooltip
          >
            <template #default="{ row }">{{ row.openingCard?.numberSummary || '未记录' }}</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.chatgptAccounts.main.columns[13]">
            <template #default="{ row }">{{
              row.openingCard?.deleted ? '已删除' : row.openingCard?.id ? '尚未删除' : '未记录'
            }}</template>
          </V2TableColumn>
          <V2TableActionColumn :definition="v2TableSchemas.chatgptAccounts.main.columns[14]">
            <template #default="{ row }">
              <AppButton
                v-if="row.deletedAt"
                size="small"
                variant="ghost"
                @click="requestRestore('chatgpt_account', row, row.emailMasked)"
                >申请恢复</AppButton
              >
              <template v-else>
                <ChatgptAccountCopyButton
                  :id="row.id"
                  :disabled="working"
                  @error="operationError = $event"
                />
                <AppButton size="small" variant="ghost" @click="openEdit(row)">编辑</AppButton>
                <ChatgptOpeningCardDeleteButton
                  :account="row"
                  :disabled="working"
                  @deleted="query.refresh"
                />
                <el-dropdown trigger="click">
                  <AppButton size="small" variant="ghost" :disabled="working">更多操作</AppButton>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item @click="changeStatus(row)">{{
                        row.status === 'active' ? '停用' : '启用'
                      }}</el-dropdown-item>
                      <el-dropdown-item
                        @click="
                          lifecycleTarget = { entity: 'account', id: row.id, action: 'delete' }
                        "
                        >移入回收站</el-dropdown-item
                      >
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </template>
            </template>
          </V2TableActionColumn>
        </V2Table>
        <footer class="v2-records-pagination">
          <span>共 {{ query.data.value?.total ?? accounts.length }} 条</span>
          <el-pagination
            v-pagination-label
            :current-page="query.data.value?.page ?? page"
            :page-size="query.data.value?.pageSize ?? pageSize"
            :page-sizes="[20, 50, 100]"
            :total="query.data.value?.total ?? accounts.length"
            background
            layout="sizes, prev, pager, next"
            @current-change="changePage"
            @size-change="changePageSize"
          />
        </footer>
      </section>
    </V2AsyncRegion>
    <ChatgptAccountImportDrawer v-model="importOpen" @imported="onAccountsImported" />

    <BankRechargeLifecycleDialog
      :target="lifecycleTarget"
      @close="lifecycleTarget = null"
      @completed="query.refresh"
    />

    <V2FormDrawer
      v-model="drawerOpen"
      retain-draft
      :title="editing ? '修改 ChatGPT 账号' : '新增 ChatGPT 账号'"
      :description="
        editing
          ? '留空的邮箱、密码或 2FA 表示保留现有值；账号列表不会回显明文。'
          : '邮箱必填，密码和 2FA 可稍后补充，存储后不会回显明文。'
      "
      size="min(620px, 96vw)"
      :confirm-loading="saving"
      @confirm="save"
    >
      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-position="left"
        label-width="112px"
        require-asterisk-position="right"
        autocomplete="off"
      >
        <ChatgptAccountEditorFields :form="form" :editing="editing" />
      </el-form>
      <p v-if="saveError" class="bank-recharge-error" role="alert">{{ saveError }}</p>
    </V2FormDrawer>
  </section>
</template>

<script setup lang="ts">
import { useBankRechargeRestoreNavigation } from './useBankRechargeRestoreNavigation';
const { requestRestore, restoreNavigationError } = useBankRechargeRestoreNavigation();
import BankRechargeLifecycleDialog from './BankRechargeLifecycleDialog.vue';
import type { BankLifecycleEntity, BankLifecycleAction } from './bank-recharge-api';
import ChatgptAccountOfferSelect from './ChatgptAccountOfferSelect.vue';
import ChatgptAccountEditorFields from './ChatgptAccountEditorFields.vue';
import { computed, ref, watch } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage } from '@/api/client';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2PageContext from '@/v2/components/V2PageContext.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { formatV2DateTime } from '@/v2/utils/dateTime';
import { useChatgptAccountAge } from './useChatgptAccountAge';
import { validateV2Form } from '@/v2/utils/formValidation';
import { useV2FormDraft, useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { bankRechargeApi, type BankChatgptAccount } from './bank-recharge-api';
import ChatgptAccountImportDrawer from './ChatgptAccountImportDrawer.vue';
import ChatgptOpeningCardDeleteButton from './ChatgptOpeningCardDeleteButton.vue';
import ChatgptAccountCopyButton from './ChatgptAccountCopyButton.vue';
import ChatgptAccountCopySettings from './ChatgptAccountCopySettings.vue';
import { proxyCountryLabel } from './recharge-proxy-options';
import { chatgptCountryLabel } from './chatgpt-country';
import { V2_ACCOUNT_OFFER_LABELS, type V2AccountOffer } from '@apple-business/shared';
import '@/v2/styles/records.css';
import './bank-recharge.css';

const { registeredDaysLabel } = useChatgptAccountAge();
const page = useV2SessionDraft('auto-recharge/V2ChatgptAccountsView:page', () => ref(1));
const pageSize = useV2SessionDraft('auto-recharge/V2ChatgptAccountsView:pageSize', () => ref(20));
const keyword = useV2SessionDraft('auto-recharge/V2ChatgptAccountsView:keyword', () => ref(''));
const keywordInput = useV2SessionDraft('auto-recharge/V2ChatgptAccountsView:keywordInput', () =>
  ref('')
);
const offerStatus = useV2SessionDraft('chatgpt-accounts:offer-filter', () =>
  ref<V2AccountOffer | 'all'>('all')
);
const deletedFilter = useV2SessionDraft('chatgpt-accounts:deleted', () =>
  ref<'active' | 'deleted'>('active')
);
const lifecycleTarget = ref<{
  entity: BankLifecycleEntity;
  id: string;
  action: BankLifecycleAction;
} | null>(null);
const query = useV2ModuleQuery({
  moduleKey: 'chatgpt-accounts',
  scope: 'auto-recharge',
  key: () =>
    createV2QueryKey({
      page: page.value,
      pageSize: pageSize.value,
      keyword: keyword.value,
      subscriptionState: deletedFilter.value === 'deleted' ? 'all' : 'never_subscribed',
      deleted: deletedFilter.value,
      offerStatus: offerStatus.value
    }),
  keepPreviousData: true,
  query: ({ signal }) =>
    bankRechargeApi.listAccounts(
      { signal },
      {
        page: page.value,
        pageSize: pageSize.value,
        keyword: keyword.value,
        subscriptionState: deletedFilter.value === 'deleted' ? 'all' : 'never_subscribed',
        deleted: deletedFilter.value,
        offerStatus: offerStatus.value
      }
    )
});
watch([page, pageSize, keyword, offerStatus, deletedFilter], () => {
  void query.ensureFresh();
});
watch([offerStatus, deletedFilter], () => {
  page.value = 1;
});
function search() {
  page.value = 1;
  keyword.value = keywordInput.value.trim();
}
function changePage(value: number) {
  page.value = value;
}
function changePageSize(value: number) {
  pageSize.value = value;
  page.value = 1;
}
const accounts = computed(() => query.data.value?.items ?? []);
const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => accounts.value,
  pageSize: () => pageSize.value
});
const importOpen = ref(false);
const operationError = ref('');
const working = ref(false);

const drawerOpen = ref(false);
const editing = ref<BankChatgptAccount | null>(null);
const saving = ref(false);
const saveError = ref('');
const formRef = ref<FormInstance>();
const editorDraft = useV2FormDraft('chatgpt-accounts-editor', () => ({
  email: '',
  registrationCountryCode: '',
  password: '',
  totpSecret: '',
  remark: '',
  active: true,
  offerStatus: 'unknown' as V2AccountOffer
}));
const { form } = editorDraft;
const rules = computed<FormRules>(() => ({
  email: [
    {
      required: !editing.value,
      type: 'email',
      message: '请输入有效的 ChatGPT 邮箱',
      trigger: 'blur'
    }
  ]
}));
function openCreate() {
  editing.value = null;
  editorDraft.open('create');
  drawerOpen.value = true;
}
function onAccountsImported() {
  page.value = 1;
  keyword.value = '';
  keywordInput.value = '';
  void query.refresh().catch((error) => {
    operationError.value = getApiErrorMessage(error);
  });
}
function openEdit(account: BankChatgptAccount) {
  editing.value = account;
  editorDraft.open(
    account.id,
    {
      registrationCountryCode: account.registrationCountryCode ?? '',
      remark: account.remark ?? '',
      active: account.status === 'active',
      offerStatus: account.offerStatus ?? 'unknown'
    },
    account.updatedAt
  );
  drawerOpen.value = true;
}
async function save() {
  if (!(await validateV2Form(formRef.value))) return;
  saving.value = true;
  const completeSave = editorDraft.beginSave();
  saveError.value = '';
  try {
    if (editing.value) {
      const payload: Record<string, unknown> = {
        remark: form.remark,
        status: form.active ? 'active' : 'disabled',
        expectedUpdatedAt: editorDraft.version.value
      };
      if (form.registrationCountryCode !== (editing.value.registrationCountryCode ?? ''))
        payload.registrationCountryCode = form.registrationCountryCode || null;
      if (form.offerStatus !== (editing.value.offerStatus ?? 'unknown'))
        payload.offerStatus = form.offerStatus;
      if (form.password) payload.password = form.password;
      if (form.totpSecret) payload.totpSecret = form.totpSecret;
      if (form.email.trim()) payload.email = form.email.trim();
      await bankRechargeApi.updateAccount(editing.value.id, payload);
    } else {
      await bankRechargeApi.createAccount({
        email: form.email.trim(),
        registrationCountryCode: form.registrationCountryCode || null,
        password: form.password,
        totpSecret: form.totpSecret,
        remark: form.remark
      });
    }
    completeSave();
    drawerOpen.value = false;
    form.password = '';
    form.totpSecret = '';
    ElMessage.success('ChatGPT 账号已保存');
    await query.refresh();
  } catch (error) {
    saveError.value = getApiErrorMessage(error);
  } finally {
    saving.value = false;
  }
}

async function changeStatus(account: BankChatgptAccount) {
  if (working.value) return;
  working.value = true;
  operationError.value = '';
  try {
    await bankRechargeApi.updateAccount(account.id, {
      status: account.status === 'active' ? 'disabled' : 'active'
    });
    ElMessage.success(account.status === 'active' ? '账号已停用' : '账号已启用');
    await query.refresh();
  } catch (error) {
    operationError.value = getApiErrorMessage(error);
  } finally {
    working.value = false;
  }
}
</script>
