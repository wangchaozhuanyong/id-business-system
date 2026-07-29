<template>
  <V2FormDrawer
    v-model="drawerVisible"
    :title="editingItem ? '编辑选项' : '新增选项'"
    :confirm-text="editingItem ? '保存修改' : '确认新增'"
    :confirm-loading="saving"
    :confirm-disabled="submitDisabled"
    @confirm="confirm"
  >
    <el-form
      ref="formRef"
      class="v2-horizontal-form"
      :model="formModel"
      :rules="formRules"
      label-position="left"
      label-width="108px"
      require-asterisk-position="right"
    >
      <el-form-item label="选项类型" prop="type">
        <el-select
          v-model="type"
          :disabled="Boolean(editingItem)"
          @change="emit('typeChange', $event)"
        >
          <el-option
            v-for="definition in typeDefinitions"
            :key="definition.type"
            :label="definition.label"
            :value="definition.type"
          />
        </el-select>
      </el-form-item>

      <el-form-item label="选项名称" prop="name">
        <el-input v-model="name" maxlength="160" show-word-limit />
      </el-form-item>

      <el-form-item
        v-if="formTypeDefinition?.requiresCountry"
        label="上级国家"
        prop="countryOptionId"
        required
      >
        <el-select
          v-model="countryOptionId"
          filterable
          :loading="countryOptionsLoading"
          placeholder="选择国家"
        >
          <el-option
            v-for="option in countryOptions"
            :key="option.id"
            :label="`${option.name} / ${option.currencyCode ?? '未设置货币'}`"
            :value="option.id"
            :disabled="!option.currencyCode"
          />
        </el-select>
      </el-form-item>

      <el-form-item
        v-if="formTypeDefinition?.parentType"
        :label="`上级${parentTypeLabel}`"
        prop="parentId"
        required
      >
        <el-select
          v-model="parentId"
          filterable
          :loading="parentOptionsLoading"
          :placeholder="`选择${parentTypeLabel}`"
        >
          <el-option
            v-for="option in parentOptions"
            :key="option.id"
            :label="selectorLabel(option)"
            :value="option.id"
          />
        </el-select>
      </el-form-item>

      <el-form-item v-if="formTypeDefinition?.supportsCurrency" label="默认货币" required>
        <el-select
          v-model="currencyCode"
          filterable
          allow-create
          default-first-option
          placeholder="选择或输入 3 位货币代码"
        >
          <el-option
            v-for="currency in currencyOptions"
            :key="currency"
            :label="currency"
            :value="currency"
          />
        </el-select>
      </el-form-item>

      <div v-if="formTypeDefinition?.supportsBusinessAmount" class="v2-options-fee-grid">
        <el-form-item label="业务金额" required>
          <el-input-number
            v-model="businessAmount"
            :min="0.0001"
            :max="99999999999999"
            :precision="4"
            :step="1"
            controls-position="right"
          />
        </el-form-item>
        <el-form-item label="业务货币">
          <el-input :model-value="selectedServiceCurrency" disabled />
        </el-form-item>
      </div>

      <div v-if="formTypeDefinition?.supportsFees" class="v2-options-fee-grid">
        <el-form-item label="固定手续费">
          <el-input-number
            v-model="fixedFee"
            :min="0"
            :max="99999999"
            :precision="4"
            :step="0.1"
            controls-position="right"
          />
        </el-form-item>
        <el-form-item label="百分比手续费">
          <el-input-number
            v-model="percentageFee"
            :min="0"
            :max="100"
            :precision="4"
            :step="0.1"
            controls-position="right"
          />
        </el-form-item>
      </div>

      <el-form-item label="排序">
        <el-input-number
          v-model="sortOrder"
          :min="0"
          :max="99999"
          :step="10"
          controls-position="right"
        />
      </el-form-item>

      <el-form-item label="状态">
        <el-switch
          v-model="active"
          active-text="启用"
          inactive-text="停用"
          :disabled="Boolean(editingItem?.isSystem)"
        />
      </el-form-item>

      <el-form-item label="备注">
        <el-input v-model="remark" type="textarea" :rows="3" maxlength="500" />
      </el-form-item>
    </el-form>
  </V2FormDrawer>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import type {
  V2Option,
  V2OptionSelector,
  V2OptionType,
  V2OptionTypeDefinition
} from '../contracts';

const props = defineProps<{
  editingItem: V2Option | null;
  saving: boolean;
  submitDisabled: boolean;
  typeDefinitions: V2OptionTypeDefinition[];
  formTypeDefinition: V2OptionTypeDefinition | undefined;
  parentTypeLabel: string;
  parentOptions: V2OptionSelector[];
  parentOptionsLoading: boolean;
  countryOptions: V2OptionSelector[];
  countryOptionsLoading: boolean;
  currencyOptions: readonly string[];
  selectedServiceCurrency: string;
  selectorLabel: (option: V2OptionSelector) => string;
}>();

const emit = defineEmits<{
  confirm: [];
  typeChange: [value: string | number | boolean | undefined];
}>();

const drawerVisible = defineModel<boolean>({ required: true });
const type = defineModel<V2OptionType>('type', { required: true });
const name = defineModel<string>('name', { required: true });
const parentId = defineModel<string>('parentId', { required: true });
const countryOptionId = defineModel<string>('countryOptionId', { required: true });
const businessAmount = defineModel<number>('businessAmount', { required: true });
const currencyCode = defineModel<string>('currencyCode', { required: true });
const fixedFee = defineModel<number>('fixedFee', { required: true });
const percentageFee = defineModel<number>('percentageFee', { required: true });
const sortOrder = defineModel<number>('sortOrder', { required: true });
const active = defineModel<boolean>('active', { required: true });
const remark = defineModel<string>('remark', { required: true });

const formRef = ref<FormInstance>();
const formModel = computed(() => ({
  type: type.value,
  name: name.value,
  parentId: parentId.value,
  countryOptionId: countryOptionId.value
}));
const formRules: FormRules = {
  type: [{ required: true, message: '请选择选项类型', trigger: 'change' }],
  name: [{ required: true, message: '请输入选项名称', trigger: 'blur' }]
};

async function confirm() {
  if (props.submitDisabled) return;
  if (!(await formRef.value?.validate().catch(() => false))) return;
  emit('confirm');
}
</script>
