<template>
  <V2FormDrawer
    :model-value="modelValue"
    title="新增客户"
    confirm-text="保存并选中"
    :confirm-loading="saving"
    size="min(580px, 96vw)"
    @update:model-value="$emit('update:modelValue', $event)"
    @confirm="submit"
  >
    <div class="v2-quick-customer-context">
      <strong>快速建立客户资料</strong>
      <span>保存后将自动回填到当前订单，无需离开录入页面。</span>
    </div>

    <el-alert
      v-if="optionsError"
      class="v2-quick-customer-options-error"
      type="warning"
      title="客户来源或标签选项暂时加载失败"
      description="仍可先填写基本资料并保存，也可以重试加载选项。"
      :closable="false"
      show-icon
    >
      <template #default>
        <AppButton size="small" variant="ghost" @click="loadOptions">重试加载</AppButton>
      </template>
    </el-alert>

    <el-form
      ref="formRef"
      class="v2-horizontal-form v2-quick-customer-form"
      :model="form"
      :rules="rules"
      label-position="left"
      label-width="104px"
      require-asterisk-position="right"
      status-icon
      scroll-to-error
      :scroll-into-view-options="{ behavior: 'smooth', block: 'center' }"
      autocomplete="off"
    >
      <el-form-item label="客户名称" prop="name">
        <el-input v-model="form.name" maxlength="120" show-word-limit placeholder="输入客户名称" />
      </el-form-item>

      <el-form-item label="手机号">
        <el-input
          v-model="form.phone"
          maxlength="32"
          inputmode="tel"
          autocomplete="off"
          placeholder="输入手机号"
        />
      </el-form-item>

      <el-form-item label="微信">
        <el-input
          v-model="form.wechat"
          maxlength="120"
          autocomplete="off"
          placeholder="输入微信号"
        />
      </el-form-item>

      <el-form-item label="QQ">
        <el-input v-model="form.qq" maxlength="120" autocomplete="off" placeholder="输入 QQ 号" />
      </el-form-item>

      <el-form-item label="WhatsApp">
        <el-input
          v-model="form.whatsapp"
          maxlength="40"
          inputmode="tel"
          autocomplete="off"
          placeholder="输入 WhatsApp 号码"
        />
      </el-form-item>

      <el-form-item label="客户来源">
        <el-select
          v-model="form.sourceOptionId"
          clearable
          filterable
          :loading="optionsLoading"
          placeholder="选择客户来源"
        >
          <el-option
            v-for="option in sourceOptions"
            :key="option.id"
            :label="option.name"
            :value="option.id"
          />
        </el-select>
      </el-form-item>

      <el-form-item label="客户标签">
        <el-select
          v-model="form.tagOptionIds"
          multiple
          filterable
          collapse-tags
          collapse-tags-tooltip
          :loading="optionsLoading"
          placeholder="选择客户标签"
        >
          <el-option
            v-for="option in tagOptions"
            :key="option.id"
            :label="option.name"
            :value="option.id"
          />
        </el-select>
      </el-form-item>

      <el-form-item label="资料状态">
        <el-switch v-model="form.active" active-text="启用" inactive-text="停用" />
      </el-form-item>

      <el-form-item label="备注">
        <el-input
          v-model="form.remark"
          type="textarea"
          :rows="4"
          maxlength="500"
          show-word-limit
          placeholder="选填"
        />
      </el-form-item>
    </el-form>
  </V2FormDrawer>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage } from '@/api/client';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { validateV2Form } from '@/v2/utils/formValidation';
import { idBusinessV2CustomersApi } from '../api';
import type { V2OptionSelector, V2OrderEntryCustomer } from '../contracts';
import {
  createEmptyQuickCustomerForm,
  createQuickCustomerPayload,
  toOrderEntryCustomer
} from '../quick-customer';

const props = defineProps<{
  modelValue: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  created: [customer: V2OrderEntryCustomer];
}>();

const formRef = ref<FormInstance>();
const form = reactive(createEmptyQuickCustomerForm());
const saving = ref(false);
const optionsLoading = ref(false);
const optionsResolved = ref(false);
const optionsError = ref('');
const sourceOptions = ref<V2OptionSelector[]>([]);
const tagOptions = ref<V2OptionSelector[]>([]);

const rules: FormRules = {
  name: [
    {
      required: true,
      validator: (_rule, value, callback) => {
        const normalized = String(value ?? '').trim();
        callback(
          normalized.length >= 1 && normalized.length <= 120
            ? undefined
            : new Error('请输入 1 至 120 个字符的客户名称')
        );
      },
      trigger: 'blur'
    }
  ]
};

watch(
  () => props.modelValue,
  (visible) => {
    if (!visible) return;
    Object.assign(form, createEmptyQuickCustomerForm());
    formRef.value?.clearValidate();
    if (!optionsResolved.value) void loadOptions();
  },
  { immediate: true }
);

async function loadOptions() {
  optionsLoading.value = true;
  optionsError.value = '';
  try {
    const result = await idBusinessV2CustomersApi.bootstrap({
      page: 1,
      pageSize: 1,
      sortBy: 'updatedAt',
      sortOrder: 'desc'
    });
    sourceOptions.value = result.options.sources;
    tagOptions.value = result.options.tags;
    optionsResolved.value = true;
  } catch (error) {
    optionsError.value = getApiErrorMessage(error);
  } finally {
    optionsLoading.value = false;
  }
}

async function submit() {
  if (!(await validateV2Form(formRef.value))) return;
  saving.value = true;
  try {
    const customer = await idBusinessV2CustomersApi.create(createQuickCustomerPayload(form));
    emit('created', toOrderEntryCustomer(customer));
    emit('update:modelValue', false);
    ElMessage.success('客户已创建并选中');
  } catch (error) {
    ElMessage.error(getApiErrorMessage(error));
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.v2-quick-customer-context {
  display: grid;
  gap: 4px;
  margin-bottom: 18px;
  padding: 11px 12px;
  border-left: 3px solid var(--v2-accent);
  background: var(--v2-accent-soft);
}

.v2-quick-customer-context strong {
  color: var(--v2-text);
  font-size: 13px;
}

.v2-quick-customer-context span {
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 1.6;
}

.v2-quick-customer-options-error {
  margin-bottom: 16px;
}

.v2-quick-customer-form :deep(.el-select) {
  width: 100%;
}

@media (max-width: 620px) {
  .v2-quick-customer-context {
    margin-bottom: 14px;
  }
}
</style>
