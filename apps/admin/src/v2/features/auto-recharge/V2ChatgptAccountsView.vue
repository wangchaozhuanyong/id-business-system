<template>
  <section class="v2-records-page bank-recharge-page">
    <V2PageContext
      description="保存自动充值使用的 ChatGPT 账号。密码与 2FA 加密存储，列表仅显示脱敏邮箱和配置状态。"
    >
      <template #actions>
        <AppButton @click="openImport">批量导入</AppButton>
        <AppButton variant="primary" @click="openCreate">新增账号</AppButton>
      </template>
    </V2PageContext>

    <el-form
      inline
      label-position="left"
      require-asterisk-position="right"
      @submit.prevent="search"
    >
      <el-form-item label="账号搜索"
        ><el-input v-model="keywordInput" placeholder="邮箱或备注" clearable @keyup.enter="search"
      /></el-form-item>
      <el-form-item label="会员状态">
        <el-select v-model="subscriptionState" aria-label="按会员状态筛选" style="min-width: 140px">
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
            prop="remark"
            show-overflow-tooltip
          />
          <V2TableColumn :definition="v2TableSchemas.chatgptAccounts.main.columns[5]">
            <template #default="{ row }">{{ formatV2DateTime(row.updatedAt) }}</template>
          </V2TableColumn>
          <V2TableActionColumn :definition="v2TableSchemas.chatgptAccounts.main.columns[6]">
            <template #default="{ row }">
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
    <V2FormDrawer
      v-model="importOpen"
      title="批量导入 ChatGPT 账号"
      description="每行一个账号；依次填写邮箱、密码、2FA 密钥、备注。整批校验通过后才会保存。"
      confirm-text="导入账号"
      size="min(680px, 96vw)"
      :confirm-loading="importing"
      :dirty="Boolean(importText.trim())"
      @confirm="importAccounts"
    >
      <el-form label-position="left" label-width="112px" require-asterisk-position="right">
        <el-form-item label="账号资料" required>
          <el-input
            v-model="importText"
            type="textarea"
            :rows="12"
            :maxlength="256000"
            autocomplete="off"
            aria-label="粘贴 ChatGPT 账号资料"
            placeholder="user@example.com 密码 - 备注"
          />
        </el-form-item>
      </el-form>
      <p class="bank-recharge-form-note">
        列之间可用 Tab 或空格；备注含空格时会合并为一列。没有 2FA 密钥时填写 -，备注可省略。每次最多
        200 行。
      </p>
      <p v-if="importError" class="bank-recharge-error" role="alert">{{ importError }}</p>
    </V2FormDrawer>

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
      :title="editing ? '修改 ChatGPT 账号' : '新增 ChatGPT 账号'"
      :description="
        editing
          ? '留空的邮箱、密码或 2FA 表示保留现有值；账号列表不会回显明文。'
          : '密码和 2FA 存储后不会回显明文。'
      "
      size="min(620px, 96vw)"
      :confirm-loading="saving"
      :dirty="dirty"
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
        <el-form-item label="登录密码" :required="!editing">
          <el-input
            v-model="form.password"
            type="password"
            show-password
            maxlength="1024"
            autocomplete="new-password"
            :placeholder="editing ? '留空表示保留原密码' : '输入登录密码'"
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
import { computed, reactive, ref, watch } from 'vue';
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
import { bankRechargeApi, type BankChatgptAccount } from './bank-recharge-api';
import { parseChatgptAccountImport } from './chatgpt-account-import';
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
const importText = ref('');
const importing = ref(false);
const importError = ref('');
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
const form = reactive({ email: '', password: '', totpSecret: '', remark: '', active: true });
const original = ref('');
const dirty = computed(() => JSON.stringify(form) !== original.value);
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

function reset() {
  Object.assign(form, { email: '', password: '', totpSecret: '', remark: '', active: true });
  saveError.value = '';
  original.value = JSON.stringify(form);
}
function openCreate() {
  editing.value = null;
  reset();
  drawerOpen.value = true;
}
function openImport() {
  importText.value = '';
  importError.value = '';
  importOpen.value = true;
}
async function importAccounts() {
  if (importing.value) return;
  try {
    const rows = parseChatgptAccountImport(importText.value);
    importing.value = true;
    importError.value = '';
    const result = await bankRechargeApi.importAccounts(rows);
    importText.value = '';
    importOpen.value = false;
    page.value = 1;
    keyword.value = '';
    keywordInput.value = '';
    ElMessage.success(`已导入 ${result.imported} 个 ChatGPT 账号`);
    await query.refresh();
  } catch (error) {
    importError.value = getApiErrorMessage(error);
  } finally {
    importing.value = false;
  }
}
function openEdit(account: BankChatgptAccount) {
  editing.value = account;
  reset();
  form.remark = account.remark ?? '';
  form.active = account.status === 'active';
  original.value = JSON.stringify(form);
  drawerOpen.value = true;
}
async function save() {
  if (!(await validateV2Form(formRef.value))) return;
  if (!editing.value && !form.password) {
    saveError.value = '请填写登录密码';
    return;
  }
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
