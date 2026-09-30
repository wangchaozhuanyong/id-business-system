<template>
  <section class="v2-records-page bank-recharge-page">
    <V2PageContext
      description="管理银充银行卡，查看关联的充值账号与订单。卡号加密保存，安全码只在单笔充值时临时输入。"
    >
      <template #actions>
        <AppButton @click="openImport">批量导入</AppButton>
        <AppButton variant="primary" @click="openCreate">新增银行卡</AppButton>
      </template>
    </V2PageContext>

    <el-form
      inline
      label-position="left"
      require-asterisk-position="right"
      @submit.prevent="search"
    >
      <el-form-item label="银行卡搜索">
        <el-input
          v-model="keywordInput"
          placeholder="名称、卡尾号或备注"
          clearable
          @keyup.enter="search"
        />
      </el-form-item>
      <el-form-item label="状态">
        <el-select v-model="statusInput" aria-label="银行卡状态">
          <el-option label="全部状态" value="" />
          <el-option label="启用" value="active" />
          <el-option label="停用" value="disabled" />
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
      loading-title="正在加载银行卡"
      @retry="query.refresh"
    >
      <section class="v2-records-list">
        <header>
          <V2SectionHeading title="银行卡清单">
            <template #actions>
              <V2TableColumnSettings inline :schema="v2TableSchemas.bankRechargeCards.main" />
              <span>共 {{ query.data.value?.total ?? 0 }} 张</span>
            </template>
          </V2SectionHeading>
        </header>
        <V2Table
          :schema="v2TableSchemas.bankRechargeCards.main"
          :show-column-settings="false"
          :data="cards"
          class="v2-records-table bank-recharge-nowrap"
        >
          <template #empty>
            <div class="v2-records-empty">
              <strong>暂无银行卡</strong><span>新增或导入银行卡后可查看使用记录</span>
            </div>
          </template>
          <V2TableColumn
            :definition="v2TableSchemas.bankRechargeCards.main.columns[0]"
            prop="label"
            show-overflow-tooltip
          />
          <V2TableColumn :definition="v2TableSchemas.bankRechargeCards.main.columns[1]">
            <template #default="{ row }">····{{ row.last4 }}</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.bankRechargeCards.main.columns[2]">
            <template #default="{ row }">{{ row.expiry ?? '未录入' }}</template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.bankRechargeCards.main.columns[3]"
            prop="currencyCode"
          />
          <V2TableColumn :definition="v2TableSchemas.bankRechargeCards.main.columns[4]">
            <template #default="{ row }"
              ><el-tag :type="row.status === 'active' ? 'success' : 'info'" effect="plain">{{
                row.status === 'active' ? '启用' : '停用'
              }}</el-tag></template
            >
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.bankRechargeCards.main.columns[5]"
            prop="accountCount"
          />
          <V2TableColumn
            :definition="v2TableSchemas.bankRechargeCards.main.columns[6]"
            prop="remark1"
            show-overflow-tooltip
          />
          <V2TableColumn
            :definition="v2TableSchemas.bankRechargeCards.main.columns[7]"
            prop="remark2"
            show-overflow-tooltip
          />
          <V2TableColumn :definition="v2TableSchemas.bankRechargeCards.main.columns[8]">
            <template #default="{ row }">{{ formatV2DateTime(row.updatedAt) }}</template>
          </V2TableColumn>
          <V2TableActionColumn :definition="v2TableSchemas.bankRechargeCards.main.columns[9]">
            <template #default="{ row }">
              <AppButton size="small" variant="ghost" @click="detailId = row.id">详细</AppButton>
              <el-dropdown trigger="click">
                <AppButton size="small" variant="ghost" :disabled="working">更多操作</AppButton>
                <template #dropdown
                  ><el-dropdown-menu>
                    <el-dropdown-item @click="openEdit(row)">编辑</el-dropdown-item>
                    <el-dropdown-item @click="changeStatus(row)">{{
                      row.status === 'active' ? '停用' : '启用'
                    }}</el-dropdown-item>
                    <el-dropdown-item @click="openDelete(row)">删除</el-dropdown-item>
                  </el-dropdown-menu></template
                >
              </el-dropdown>
            </template>
          </V2TableActionColumn>
        </V2Table>
        <footer class="v2-records-pagination">
          <span>共 {{ query.data.value?.total ?? 0 }} 张</span>
          <el-pagination
            v-pagination-label
            :current-page="query.data.value?.page ?? page"
            :page-size="query.data.value?.pageSize ?? pageSize"
            :page-sizes="[20, 50, 100]"
            :total="query.data.value?.total ?? 0"
            background
            layout="sizes, prev, pager, next"
            @current-change="page = $event"
            @size-change="changePageSize"
          />
        </footer>
      </section>
    </V2AsyncRegion>

    <V2FormDrawer
      v-model="formOpen"
      :title="editing ? '编辑银行卡' : '新增银行卡'"
      description="卡号加密保存；已有订单的银行卡不能更换卡号或付款币种。安全码不保存。"
      size="min(680px, 96vw)"
      :confirm-loading="saving"
      :dirty="dirty"
      @confirm="save"
    >
      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-position="left"
        label-width="110px"
        require-asterisk-position="right"
        autocomplete="off"
      >
        <el-form-item label="银行卡名称" prop="label"
          ><el-input v-model="form.label" maxlength="80" placeholder="选填，默认使用卡尾号"
        /></el-form-item>
        <el-form-item label="银行卡卡号" prop="number" :required="!editing">
          <el-input
            v-model="form.number"
            type="text"
            inputmode="numeric"
            maxlength="25"
            autocomplete="off"
            :placeholder="editing ? `当前尾号 ${editing.last4}；留空保留` : '输入完整卡号'"
          />
        </el-form-item>
        <el-form-item label="有效期" prop="expiry" :required="!editing">
          <el-input v-model="form.expiry" maxlength="5" placeholder="MM/YY" />
        </el-form-item>
        <V2BankCardCurrencySelect
          v-model="form.currencyCode"
          prop="currencyCode"
          select-label="银行卡付款币种"
          :currencies="activeCurrencies"
          :loading="currencyQuery.phase.value === 'initial-loading'"
        />
        <el-form-item v-if="editing" label="状态"
          ><el-switch v-model="form.active" active-text="启用" inactive-text="停用"
        /></el-form-item>
        <el-form-item label="备注1"
          ><el-input v-model="form.remark1" maxlength="500"
        /></el-form-item>
        <el-form-item label="备注2"
          ><el-input v-model="form.remark2" maxlength="500"
        /></el-form-item>
      </el-form>
      <p v-if="currencyQuery.error.value" class="bank-recharge-error" role="alert">
        {{ getApiErrorMessage(currencyQuery.error.value) }}
        <AppButton size="small" @click="currencyQuery.refresh">重试</AppButton>
      </p>
      <p v-if="formError" class="bank-recharge-error" role="alert">{{ formError }}</p>
    </V2FormDrawer>

    <V2FormDrawer
      v-model="importOpen"
      title="批量导入银行卡"
      size="min(700px, 96vw)"
      description="每行卡号、有效期、备注1、备注2；安全码不能批量导入或保存。"
      confirm-text="导入银行卡"
      :confirm-loading="importing"
      :dirty="Boolean(importText.trim())"
      @confirm="importCards"
    >
      <el-form label-position="left" label-width="110px" require-asterisk-position="right">
        <V2BankCardCurrencySelect
          v-model="importCurrency"
          select-label="导入银行卡付款币种"
          :currencies="activeCurrencies"
          :loading="currencyQuery.phase.value === 'initial-loading'"
        />
        <el-form-item label="银行卡资料" required>
          <el-input
            v-model="importText"
            type="textarea"
            :rows="12"
            :maxlength="100000"
            autocomplete="off"
            aria-label="粘贴银行卡资料"
            placeholder="卡号    MM/YY    备注1    备注2"
          />
        </el-form-item>
      </el-form>
      <p v-if="currencyQuery.error.value" class="bank-recharge-error" role="alert">
        {{ getApiErrorMessage(currencyQuery.error.value) }}
        <AppButton size="small" @click="currencyQuery.refresh">重试</AppButton>
      </p>
      <p class="bank-recharge-form-note">
        列之间可用 Tab 或空格；备注含空格时请用 Tab 分列。每次最多 100
        张。安全码请在每笔充值时临时填写，不要放入备注。
      </p>
      <p v-if="importError" class="bank-recharge-error" role="alert">{{ importError }}</p>
    </V2FormDrawer>

    <V2ConfirmDialog
      v-model="deleteOpen"
      title="删除银行卡"
      message=""
      confirm-text="删除银行卡"
      :confirm-loading="working"
      danger
      @confirm="confirmDelete"
    >
      <p>确认删除尾号 {{ deleting?.last4 ?? '' }} 的银行卡？已有订单的银行卡不能删除，请停用。</p>
      <p v-if="deleteError" class="bank-recharge-error" role="alert">{{ deleteError }}</p>
    </V2ConfirmDialog>
    <V2BankCardDetailDrawer v-if="detailId" :id="detailId" @close="detailId = null" />
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
import { bankRechargeApi, type ManagedBankRechargeCard } from './bank-recharge-api';
import { parseBankCardImport } from './bank-card-import';
import V2BankCardDetailDrawer from './V2BankCardDetailDrawer.vue';
import V2BankCardCurrencySelect from './V2BankCardCurrencySelect.vue';
import '@/v2/styles/records.css';
import './bank-recharge.css';

const page = ref(1);
const pageSize = ref(20);
const keywordInput = ref('');
const statusInput = ref('');
const keyword = ref('');
const status = ref('');
const query = useV2ModuleQuery({
  moduleKey: 'bank-recharge-cards',
  scope: 'auto-recharge',
  key: () =>
    createV2QueryKey({
      page: page.value,
      pageSize: pageSize.value,
      keyword: keyword.value,
      status: status.value
    }),
  keepPreviousData: true,
  query: ({ signal }) =>
    bankRechargeApi.listManagedCards(
      { page: page.value, pageSize: pageSize.value, keyword: keyword.value, status: status.value },
      { signal }
    )
});
watch([page, pageSize, keyword, status], () => {
  void query.ensureFresh();
});
const currencyQuery = useV2ModuleQuery({
  moduleKey: 'bank-recharge-cards',
  scope: 'auto-recharge',
  key: 'bank-card-currencies',
  query: ({ signal }) => bankRechargeApi.listCurrencies({ signal })
});
const activeCurrencies = computed(() =>
  (currencyQuery.data.value?.items ?? []).filter((item) => item.active)
);
const cards = computed(() => query.data.value?.items ?? []);
const formOpen = ref(false);
const editing = ref<ManagedBankRechargeCard | null>(null);
const formRef = ref<FormInstance>();
const form = reactive({
  label: '',
  number: '',
  expiry: '',
  currencyCode: '',
  active: true,
  remark1: '',
  remark2: ''
});
const original = ref('');
const dirty = computed(() => JSON.stringify(form) !== original.value);
const rules = computed<FormRules>(() => ({
  number: [{ required: !editing.value, message: '请填写银行卡卡号', trigger: 'blur' }],
  expiry: [{ required: !editing.value, message: '请填写有效期', trigger: 'blur' }],
  currencyCode: [{ required: true, message: '请选择付款币种', trigger: 'change' }]
}));
const saving = ref(false);
const formError = ref('');
const importOpen = ref(false);
const importText = ref('');
const importCurrency = ref('');
const importing = ref(false);
const importError = ref('');
const operationError = ref('');
const working = ref(false);
const deleteOpen = ref(false);
const deleting = ref<ManagedBankRechargeCard | null>(null);
const deleteError = ref('');
const detailId = ref<string | null>(null);

watch(activeCurrencies, (items) => {
  if (!form.currencyCode) form.currencyCode = items[0]?.code ?? '';
  if (!importCurrency.value) importCurrency.value = items[0]?.code ?? '';
});
function search() {
  page.value = 1;
  keyword.value = keywordInput.value.trim();
  status.value = statusInput.value;
}
function changePageSize(value: number) {
  pageSize.value = value;
  page.value = 1;
}
function resetForm() {
  Object.assign(form, {
    label: '',
    number: '',
    expiry: '',
    currencyCode: activeCurrencies.value[0]?.code ?? '',
    active: true,
    remark1: '',
    remark2: ''
  });
  formError.value = '';
  original.value = JSON.stringify(form);
}
function openCreate() {
  editing.value = null;
  resetForm();
  formOpen.value = true;
}
function openEdit(card: ManagedBankRechargeCard) {
  editing.value = card;
  resetForm();
  Object.assign(form, {
    label: card.label,
    expiry: card.expiry ?? '',
    currencyCode: card.currencyCode,
    active: card.status === 'active',
    remark1: card.remark1 ?? '',
    remark2: card.remark2 ?? ''
  });
  original.value = JSON.stringify(form);
  formOpen.value = true;
}
async function save() {
  if (saving.value || !(await validateV2Form(formRef.value))) return;
  saving.value = true;
  formError.value = '';
  try {
    if (editing.value) {
      await bankRechargeApi.updateManagedCard(editing.value.id, {
        label: form.label.trim() || editing.value.label,
        ...(form.number ? { number: form.number } : {}),
        ...(form.expiry ? { expiry: form.expiry } : {}),
        currencyCode: form.currencyCode,
        status: form.active ? 'active' : 'disabled',
        remark1: form.remark1,
        remark2: form.remark2
      });
    } else {
      await bankRechargeApi.createManagedCard({
        label: form.label.trim(),
        number: form.number,
        expiry: form.expiry,
        currencyCode: form.currencyCode,
        remark1: form.remark1,
        remark2: form.remark2
      });
    }
    form.number = '';
    formOpen.value = false;
    ElMessage.success('银行卡已保存');
    await query.refresh();
  } catch (error) {
    formError.value = getApiErrorMessage(error);
  } finally {
    saving.value = false;
  }
}
function openImport() {
  importText.value = '';
  importError.value = '';
  importOpen.value = true;
}
async function importCards() {
  if (importing.value) return;
  try {
    if (!importCurrency.value) throw new Error('请选择付款币种');
    const rows = parseBankCardImport(importText.value);
    importing.value = true;
    importError.value = '';
    const result = await bankRechargeApi.importManagedCards(importCurrency.value, rows);
    importText.value = '';
    importOpen.value = false;
    page.value = 1;
    keyword.value = '';
    keywordInput.value = '';
    status.value = '';
    statusInput.value = '';
    ElMessage.success(`已导入 ${result.imported} 张银行卡`);
    await query.refresh();
  } catch (error) {
    importError.value = getApiErrorMessage(error);
  } finally {
    importing.value = false;
  }
}
async function changeStatus(card: ManagedBankRechargeCard) {
  if (working.value) return;
  working.value = true;
  operationError.value = '';
  try {
    await bankRechargeApi.updateManagedCard(card.id, {
      status: card.status === 'active' ? 'disabled' : 'active'
    });
    ElMessage.success(card.status === 'active' ? '银行卡已停用' : '银行卡已启用');
    await query.refresh();
  } catch (error) {
    operationError.value = getApiErrorMessage(error);
  } finally {
    working.value = false;
  }
}
function openDelete(card: ManagedBankRechargeCard) {
  deleting.value = card;
  deleteError.value = '';
  deleteOpen.value = true;
}
async function confirmDelete() {
  if (!deleting.value || working.value) return;
  working.value = true;
  deleteError.value = '';
  try {
    await bankRechargeApi.deleteManagedCard(deleting.value.id);
    deleteOpen.value = false;
    deleting.value = null;
    ElMessage.success('银行卡已删除');
    await query.refresh();
  } catch (error) {
    deleteError.value = getApiErrorMessage(error);
  } finally {
    working.value = false;
  }
}
</script>
