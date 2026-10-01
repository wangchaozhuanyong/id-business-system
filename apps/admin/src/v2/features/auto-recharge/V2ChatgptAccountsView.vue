<template>
  <section class="v2-page-layout v2-records-page bank-recharge-page">
    <V2PageContext
      description="保存自动充值使用的 ChatGPT 账号。密码与 2FA 加密存储，列表仅显示脱敏邮箱和配置状态。"
    >
      <template #actions>
        <AppButton @click="openImport">批量导入</AppButton>
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
          <el-form-item label="会员状态">
            <el-select v-model="subscriptionState" aria-label="按会员状态筛选">
              <el-option label="全部" value="all" />
              <el-option label="未记录开通" value="never_subscribed" />
              <el-option label="使用中" value="active" />
              <el-option label="即将到期" value="due_soon" />
              <el-option label="已到期" value="expired" />
              <el-option label="到期待核实" value="unknown" />
            </el-select>
          </el-form-item>
          <el-form-item><AppButton @click="search">搜索</AppButton></el-form-item>
        </el-form>
      </template>
    </V2PageContext>

    <p v-if="operationError" class="bank-recharge-error" role="alert">{{ operationError }}</p>
    <V2AsyncRegion
      skeleton="table"
      :phase="query.phase.value"
      :previous-data="query.isParameterTransition.value"
      :error="query.error.value ? getApiErrorMessage(query.error.value) : ''"
      loading-title="正在加载 ChatGPT 账号"
      @retry="query.refresh"
    >
      <section class="v2-records-list">
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
          <V2TableColumn :definition="v2TableSchemas.chatgptAccounts.main.columns[1]">
            <template #default="{ row }">
              <el-tag :type="row.status === 'active' ? 'success' : 'info'" effect="plain">{{
                row.status === 'active' ? '启用' : '停用'
              }}</el-tag>
              <span> · {{ subscriptionLabel(row) }}</span>
              <span v-if="row.dueAt"> · {{ formatV2DateTime(row.dueAt) }}</span>
            </template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.chatgptAccounts.main.columns[2]">
            <template #default="{ row }">{{ row.hasPassword ? '已保存' : '未保存' }}</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.chatgptAccounts.main.columns[3]">
            <template #default="{ row }">{{ row.hasTotp ? '已保存' : '未保存' }}</template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.chatgptAccounts.main.columns[4]"
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
            :definition="v2TableSchemas.chatgptAccounts.main.columns[5]"
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
            :definition="v2TableSchemas.chatgptAccounts.main.columns[6]"
            prop="remark"
            show-overflow-tooltip
          />
          <V2TableColumn :definition="v2TableSchemas.chatgptAccounts.main.columns[7]">
            <template #default="{ row }">{{ formatV2DateTime(row.updatedAt) }}</template>
          </V2TableColumn>
          <V2TableActionColumn :definition="v2TableSchemas.chatgptAccounts.main.columns[8]">
            <template #default="{ row }">
              <ChatgptAccountCopyButton
                :id="row.id"
                :disabled="working"
                @error="operationError = $event"
              />
              <AppButton size="small" variant="ghost" @click="openEdit(row)">编辑</AppButton>
              <el-dropdown trigger="click">
                <AppButton size="small" variant="ghost" :disabled="working">更多操作</AppButton>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item @click="changeStatus(row)">{{
                      row.status === 'active' ? '停用' : '启用'
                    }}</el-dropdown-item>
                    <el-dropdown-item @click="openDelete(row)">删除</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
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

    <V2ConfirmDialog
      v-model="deleteOpen"
      title="删除 ChatGPT 账号"
      message=""
      confirm-text="删除账号"
      :confirm-loading="working"
      danger
      @confirm="confirmDelete"
    >
      <p>确认删除 {{ deleting?.emailMasked ?? '该账号' }}？有关联的账号不能删除，请停用。</p>
      <p v-if="deleteError" class="bank-recharge-error" role="alert">{{ deleteError }}</p>
    </V2ConfirmDialog>

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
        <el-form-item v-if="!editing" label="ChatGPT 邮箱" prop="email" required>
          <el-input
            v-model="form.email"
            type="email"
            maxlength="250"
            autocomplete="off"
            placeholder="输入 ChatGPT 登录邮箱"
          />
        </el-form-item>
        <el-form-item v-else label="新邮箱" prop="email">
          <el-input
            v-model="form.email"
            type="email"
            maxlength="250"
            autocomplete="off"
            :placeholder="`当前 ${editing.emailMasked}；留空保留`"
          />
        </el-form-item>
        <el-form-item label="登录密码">
          <el-input
            v-model="form.password"
            type="password"
            show-password
            maxlength="1024"
            autocomplete="new-password"
            :placeholder="editing ? '留空表示保留原密码' : '选填；未设置密码可留空'"
          />
        </el-form-item>
        <el-form-item label="2FA 密钥">
          <el-input
            v-model="form.totpSecret"
            type="password"
            show-password
            maxlength="2048"
            autocomplete="off"
            placeholder="Base32 密钥或 otpauth 链接；可稍后补充"
          />
        </el-form-item>
        <el-form-item v-if="editing" label="账号状态">
          <el-switch v-model="form.active" active-text="启用" inactive-text="停用" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" maxlength="500" placeholder="选填" />
        </el-form-item>
      </el-form>
      <p v-if="saveError" class="bank-recharge-error" role="alert">{{ saveError }}</p>
    </V2FormDrawer>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage } from '@/api/client';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2PageContext from '@/v2/components/V2PageContext.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { formatV2DateTime } from '@/v2/utils/dateTime';
import { validateV2Form } from '@/v2/utils/formValidation';
import { useV2FormDraft } from '@/v2/composables/useV2SessionDraft';
import { bankRechargeApi, type BankChatgptAccount } from './bank-recharge-api';
import ChatgptAccountImportDrawer from './ChatgptAccountImportDrawer.vue';
import ChatgptAccountCopyButton from './ChatgptAccountCopyButton.vue';
import { proxyCountryLabel } from './recharge-proxy-options';
import '@/v2/styles/records.css';
import './bank-recharge.css';

function subscriptionLabel(account: BankChatgptAccount) {
  const labels = {
    never_subscribed: '未记录开通',
    active: '使用中',
    due_soon: '即将到期',
    expired: '已到期',
    unknown: '到期待核实'
  } as const;
  return labels[account.subscriptionState];
}

const page = ref(1);
const pageSize = ref(20);
const keyword = ref('');
const keywordInput = ref('');
const subscriptionState = ref('all');
const query = useV2ModuleQuery({
  moduleKey: 'chatgpt-accounts',
  scope: 'auto-recharge',
  key: () =>
    createV2QueryKey({
      page: page.value,
      pageSize: pageSize.value,
      keyword: keyword.value,
      subscriptionState: subscriptionState.value
    }),
  keepPreviousData: true,
  query: ({ signal }) =>
    bankRechargeApi.listAccounts(
      { signal },
      {
        page: page.value,
        pageSize: pageSize.value,
        keyword: keyword.value,
        subscriptionState: subscriptionState.value
      }
    )
});
watch([page, pageSize, keyword, subscriptionState], () => {
  void query.ensureFresh();
});
watch(subscriptionState, () => {
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
const importOpen = ref(false);
const operationError = ref('');
const working = ref(false);
const deleteOpen = ref(false);
const deleting = ref<BankChatgptAccount | null>(null);
const deleteError = ref('');
const drawerOpen = ref(false);
const editing = ref<BankChatgptAccount | null>(null);
const saving = ref(false);
const saveError = ref('');
const formRef = ref<FormInstance>();
const editorDraft = useV2FormDraft('chatgpt-accounts-editor', () => ({
  email: '',
  password: '',
  totpSecret: '',
  remark: '',
  active: true
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
function openImport() {
  importOpen.value = true;
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
  editorDraft.open(account.id, {
    remark: account.remark ?? '',
    active: account.status === 'active'
  });
  drawerOpen.value = true;
}
async function save() {
  if (!(await validateV2Form(formRef.value))) return;
  saving.value = true;
  saveError.value = '';
  try {
    if (editing.value) {
      const payload: Record<string, unknown> = {
        remark: form.remark,
        status: form.active ? 'active' : 'disabled'
      };
      if (form.password) payload.password = form.password;
      if (form.totpSecret) payload.totpSecret = form.totpSecret;
      if (form.email.trim()) payload.email = form.email.trim();
      await bankRechargeApi.updateAccount(editing.value.id, payload);
    } else {
      await bankRechargeApi.createAccount({
        email: form.email.trim(),
        password: form.password,
        totpSecret: form.totpSecret,
        remark: form.remark
      });
    }
    editorDraft.complete();
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
function openDelete(account: BankChatgptAccount) {
  deleting.value = account;
  operationError.value = '';
  deleteError.value = '';
  deleteOpen.value = true;
}
async function confirmDelete() {
  if (!deleting.value || working.value) return;
  working.value = true;
  operationError.value = '';
  try {
    await bankRechargeApi.deleteAccount(deleting.value.id);
    deleteOpen.value = false;
    deleting.value = null;
    ElMessage.success('账号已删除');
    await query.refresh();
  } catch (error) {
    deleteError.value = getApiErrorMessage(error);
  } finally {
    working.value = false;
  }
}
</script>
