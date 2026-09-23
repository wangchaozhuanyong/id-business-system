<template>
  <section class="v2-records-page bank-recharge-page">
    <V2PageContext
      description="保存自动充值使用的 ChatGPT 账号。密码与 2FA 加密存储，列表仅显示脱敏邮箱和配置状态。"
    >
      <template #actions
        ><AppButton variant="primary" @click="openCreate">新增账号</AppButton></template
      >
    </V2PageContext>

    <V2AsyncRegion
      skeleton="table"
      :phase="query.phase.value"
      :previous-data="query.isParameterTransition.value"
      :error="query.error.value ? getApiErrorMessage(query.error.value) : ''"
      loading-title="正在加载 ChatGPT 账号"
      @retry="query.refresh"
    >
      <section class="v2-records-list">
        <div>
          <V2SectionHeading title="账号清单">
            <template #actions>
              <V2TableColumnSettings inline :schema="v2TableSchemas.chatgptAccounts.main" />
              <span>共 {{ accounts.length }} 条</span>
            </template>
          </V2SectionHeading>
        </div>
        <V2Table
          :schema="v2TableSchemas.chatgptAccounts.main"
          :show-column-settings="false"
          :data="accounts"
          class="v2-records-table bank-recharge-nowrap"
        >
          <template #empty><div class="v2-records-empty">暂无 ChatGPT 账号</div></template>
          <V2TableColumn
            :definition="v2TableSchemas.chatgptAccounts.main.columns[0]"
            prop="emailMasked"
            show-overflow-tooltip
          />
          <V2TableColumn :definition="v2TableSchemas.chatgptAccounts.main.columns[1]">
            <template #default="{ row }"
              ><el-tag :type="row.status === 'active' ? 'success' : 'info'" effect="plain">{{
                row.status === 'active' ? '启用' : '停用'
              }}</el-tag></template
            >
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
            <template #default="{ row }"
              ><AppButton size="small" variant="ghost" @click="openEdit(row)"
                >修改</AppButton
              ></template
            >
          </V2TableActionColumn>
        </V2Table>
      </section>
    </V2AsyncRegion>

    <V2FormDrawer
      v-model="drawerOpen"
      :title="editing ? '修改 ChatGPT 账号' : '新增 ChatGPT 账号'"
      description="留空的密码或 2FA 表示保留现有值；账号列表不会回显明文。"
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
        <el-form-item v-else label="ChatGPT 邮箱"
          ><span>{{ editing.emailMasked }}</span></el-form-item
        >
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
import { computed, reactive, ref } from 'vue';
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
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { formatV2DateTime } from '@/v2/utils/dateTime';
import { validateV2Form } from '@/v2/utils/formValidation';
import { bankRechargeApi, type BankChatgptAccount } from './bank-recharge-api';
import '@/v2/styles/records.css';
import './bank-recharge.css';

const query = useV2ModuleQuery({
  moduleKey: 'chatgpt-accounts',
  scope: 'auto-recharge',
  key: 'bank-chatgpt-accounts',
  query: ({ signal }) => bankRechargeApi.listAccounts({ signal })
});
const accounts = computed(() => query.data.value?.items ?? []);
const drawerOpen = ref(false);
const editing = ref<BankChatgptAccount | null>(null);
const saving = ref(false);
const saveError = ref('');
const formRef = ref<FormInstance>();
const form = reactive({ email: '', password: '', totpSecret: '', remark: '', active: true });
const original = ref('');
const dirty = computed(() => JSON.stringify(form) !== original.value);
const rules: FormRules = {
  email: [{ required: true, type: 'email', message: '请输入有效的 ChatGPT 邮箱', trigger: 'blur' }]
};

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
function openEdit(account: BankChatgptAccount) {
  editing.value = account;
  reset();
  form.remark = account.remark ?? '';
  form.active = account.status === 'active';
  original.value = JSON.stringify(form);
  drawerOpen.value = true;
}
async function save() {
  if (!editing.value && !(await validateV2Form(formRef.value))) return;
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
</script>
