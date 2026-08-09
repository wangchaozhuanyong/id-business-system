<template>
  <V2FormDrawer
    v-model="page.drawerVisible"
    :title="page.editingItem ? '编辑 ID' : '新增 ID'"
    :confirm-text="page.editingItem ? '保存修改' : '确认新增'"
    :confirm-loading="page.saving"
    :confirm-disabled-reason="page.formDisabledReason"
    size="min(620px, 96vw)"
    @confirm="submitAccountForm"
  >
    <el-form
      ref="formRef"
      class="v2-horizontal-form"
      :model="page.form"
      :rules="formRules"
      label-position="left"
      label-width="112px"
      require-asterisk-position="right"
      status-icon
      scroll-to-error
      :scroll-into-view-options="{ behavior: 'smooth', block: 'center' }"
      autocomplete="off"
    >
      <el-form-item label="ID 账号" prop="appleId">
        <el-input
          v-model="page.form.appleId"
          name="v2-apple-id-record"
          autocomplete="off"
          :placeholder="page.editingItem ? '留空表示不修改' : '输入 Apple ID'"
        />
      </el-form-item>
      <el-form-item label="ID 密码">
        <el-input
          v-model="page.form.password"
          type="password"
          name="v2-apple-id-record-password"
          autocomplete="new-password"
          show-password
          :placeholder="page.editingItem ? '留空表示不修改' : '输入密码'"
        />
      </el-form-item>
      <el-form-item label="手机号码">
        <el-input
          v-model="page.form.phone"
          name="v2-apple-id-record-phone"
          autocomplete="off"
          :placeholder="page.editingItem ? '留空表示不修改' : '输入手机号'"
        />
      </el-form-item>
      <el-form-item label="密保">
        <el-input
          v-model="page.form.securityInfo"
          name="v2-apple-id-record-security"
          autocomplete="off"
          type="textarea"
          :rows="3"
          :placeholder="page.editingItem ? '留空表示不修改' : '输入密保资料'"
        />
      </el-form-item>
      <div class="v2-record-form-grid">
        <el-form-item label="国家" prop="countryOptionId">
          <el-select v-model="page.form.countryOptionId" filterable placeholder="选择国家">
            <el-option
              v-for="option in page.countryOptions"
              :key="option.id"
              :label="option.name"
              :value="option.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="ID 状态" prop="statusOptionId">
          <el-select v-model="page.form.statusOptionId" filterable placeholder="选择 ID 状态">
            <el-option
              v-for="option in page.formStatusOptions"
              :key="option.id"
              :label="option.name"
              :value="option.id"
            />
          </el-select>
        </el-form-item>
      </div>
      <el-form-item label="ID 供应商">
        <el-select
          v-model="page.form.supplierOptionId"
          clearable
          filterable
          placeholder="选择供应商"
        >
          <el-option
            v-for="option in page.supplierOptions"
            :key="option.id"
            :label="option.status === 'disabled' ? `${option.name}（已停用）` : option.name"
            :value="option.id"
            :disabled="option.status === 'disabled'"
          />
        </el-select>
      </el-form-item>
      <V2AccountPurchaseFields :page="page" />
      <el-alert
        v-if="page.editingItem?.saleState === 'sold'"
        type="warning"
        title="该 ID 已卖出，余额、人民币成本、加卡和续费均已锁定"
        :closable="false"
        show-icon
      />
      <div class="v2-record-form-grid">
        <el-form-item label="余额" prop="currentBalance">
          <el-input
            v-model="page.form.currentBalance"
            inputmode="decimal"
            placeholder="0"
            :disabled="!page.canAdjustBalance || page.editingItem?.saleState === 'sold'"
            @input="page.updateBalanceCostFromRate"
          />
        </el-form-item>
        <el-form-item label="汇率" prop="exchangeRate">
          <el-input
            v-model="page.form.exchangeRate"
            inputmode="decimal"
            placeholder="例如 5.7"
            :disabled="!page.canAdjustBalance || page.editingItem?.saleState === 'sold'"
            @input="page.updateBalanceCostFromRate"
          />
        </el-form-item>
        <el-form-item label="人民币成本" prop="balanceCostAmount">
          <el-input
            v-model="page.form.balanceCostAmount"
            inputmode="decimal"
            placeholder="0"
            readonly
          />
        </el-form-item>
        <el-form-item v-if="page.editingItem" label="ID购买成本">
          <el-input-number
            v-model="page.form.purchaseCost"
            :min="0"
            :max="99999999"
            :precision="V2_DECIMAL_PLACES"
            :step="Number(V2_DECIMAL_STEP)"
            controls-position="right"
            disabled
          />
        </el-form-item>
      </div>
      <el-form-item
        v-if="page.editingItem && page.balanceChanged"
        label="余额修正原因"
        prop="balanceAdjustmentReason"
      >
        <el-input
          v-model="page.form.balanceAdjustmentReason"
          type="textarea"
          :rows="2"
          maxlength="200"
          show-word-limit
          placeholder="说明本次余额或人民币成本修正原因"
        />
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="page.form.remark" type="textarea" :rows="3" maxlength="500" />
      </el-form-item>
    </el-form>
  </V2FormDrawer>

  <el-dialog
    v-model="page.importDialogVisible"
    title="导入 ID 资料"
    width="min(680px, 94vw)"
    destroy-on-close
  >
    <div class="v2-account-import-summary">
      <strong>{{ page.importFilename }}</strong>
      <div>
        <el-tag effect="plain">共 {{ page.importSourceRowCount }} 行</el-tag>
        <el-tag type="success" effect="plain">可导入 {{ page.importRows.length }} 行</el-tag>
        <el-tag v-if="page.importFailures.length" type="danger" effect="plain">
          失败 {{ page.importFailures.length }} 行
        </el-tag>
      </div>
    </div>

    <el-alert
      v-if="page.importCompleted"
      type="success"
      :title="`导入完成：成功 ${page.importSuccessCount} 条`"
      :closable="false"
      show-icon
    />

    <V2Table
      v-if="page.importFailures.length"
      :schema="v2TableSchemas.accounts.importErrors"
      show-overflow-tooltip
      :data="page.importFailures"
      max-height="300"
      size="small"
      class="v2-account-import-errors"
    >
      <V2TableColumn
        :definition="v2TableSchemas.accounts.importErrors.columns[0]"
        prop="rowNumber"
      />
      <V2TableColumn :definition="v2TableSchemas.accounts.importErrors.columns[1]" prop="reason" />
    </V2Table>

    <template #footer>
      <span v-if="importDisabledReason" class="v2-submit-disabled-reason" role="status">
        {{ importDisabledReason }}
      </span>
      <AppButton variant="ghost" @click="page.importDialogVisible = false">
        {{ page.importCompleted ? '关闭' : '取消' }}
      </AppButton>
      <AppButton
        v-if="!page.importCompleted"
        variant="primary"
        :loading="page.importing"
        :disabled="Boolean(importDisabledReason)"
        @click="page.confirmImport"
      >
        导入 {{ page.importRows.length }} 条
      </AppButton>
    </template>
  </el-dialog>

  <el-dialog
    v-model="page.revealDialogVisible"
    :title="`查看敏感资料 · ${page.revealTarget?.appleIdMasked ?? ''}`"
    width="min(480px, 92vw)"
    destroy-on-close
  >
    <el-alert
      :type="page.sensitiveAccessRequiresApproval ? 'warning' : 'info'"
      :title="
        page.sensitiveAccessRequiresApproval
          ? '该字段需要管理员批准后才能查看，批准结果会自动同步。'
          : '当前角色可以直接查看，系统仍会记录查看人和字段。'
      "
      :closable="false"
      show-icon
    />
    <el-form
      ref="revealFormRef"
      class="v2-account-reveal-form v2-horizontal-form"
      :model="page.revealForm"
      :rules="revealRules"
      label-position="left"
      label-width="88px"
      require-asterisk-position="right"
      status-icon
      scroll-to-error
      :scroll-into-view-options="{ behavior: 'smooth', block: 'center' }"
    >
      <el-form-item label="查看字段" prop="field">
        <el-select v-model="page.revealForm.field" @change="page.changeRevealField">
          <el-option
            v-for="option in page.revealFieldOptions"
            :key="option.value"
            :label="option.label"
            :value="option.value"
          />
        </el-select>
      </el-form-item>
      <el-form-item
        v-if="
          page.sensitiveAccessRequiresApproval &&
          !page.sensitiveAccessCanReveal &&
          page.sensitiveAccessRequest?.status !== 'pending'
        "
        label="申请原因"
        prop="reason"
      >
        <el-input
          v-model="page.revealForm.reason"
          type="textarea"
          :rows="3"
          maxlength="200"
          show-word-limit
          placeholder="例如：客户续费登录核对"
        />
      </el-form-item>
      <div class="v2-sensitive-access-status" role="status">
        <span>{{ page.sensitiveAccessStatusText }}</span>
        <AppButton
          v-if="page.sensitiveAccessError"
          size="small"
          variant="ghost"
          @click="page.refreshSensitiveAccess"
        >
          重试
        </AppButton>
      </div>
      <el-form-item v-if="page.revealForm.value" label="完整资料">
        <el-input v-model="page.revealForm.value" type="textarea" :rows="3" readonly />
      </el-form-item>
    </el-form>
    <template #footer>
      <AppButton variant="ghost" @click="page.revealDialogVisible = false">关闭</AppButton>
      <AppButton
        variant="danger"
        :loading="page.revealing || page.sensitiveAccessLoading || page.sensitiveAccessRequesting"
        :disabled="
          Boolean(page.sensitiveAccessError) ||
          page.sensitiveAccessPolicy?.mode === 'denied' ||
          (page.sensitiveAccessRequiresApproval &&
            page.sensitiveAccessRequest?.status === 'pending')
        "
        @click="revealSecret"
      >
        {{ page.sensitiveAccessActionText }}
      </AppButton>
    </template>
  </el-dialog>

  <V2AccountLossDialogs :page="page" />
  <V2AccountRecordStatusDialog :page="page" />
</template>

<script setup lang="ts">
import V2Table from '@/v2/components/V2Table.vue';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import { computed, ref, type UnwrapNestedRefs } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import AppButton from '@/components/ui/AppButton.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import { V2_DECIMAL_PLACES, V2_DECIMAL_STEP } from '@/v2/utils/decimal';
import { validateV2Form } from '@/v2/utils/formValidation';
import type { useAccountsPage } from '../useAccountsPage';
import V2AccountLossDialogs from './V2AccountLossDialogs.vue';
import V2AccountPurchaseFields from './V2AccountPurchaseFields.vue';
import V2AccountRecordStatusDialog from './V2AccountRecordStatusDialog.vue';

type AccountsPage = UnwrapNestedRefs<ReturnType<typeof useAccountsPage>>;

const props = defineProps<{
  page: AccountsPage;
}>();

const formRef = ref<FormInstance>();
const revealFormRef = ref<FormInstance>();
const formRules = computed<FormRules>(() => ({
  appleId: props.page.editingItem
    ? []
    : [
        {
          required: true,
          validator: (_rule, value, callback) =>
            callback(String(value ?? '').trim() ? undefined : new Error('请输入 ID 账号')),
          trigger: 'blur'
        }
      ],
  countryOptionId: [{ required: true, message: '请选择国家', trigger: 'change' }],
  statusOptionId: [{ required: true, message: '请选择 ID 状态', trigger: 'change' }],
  purchaseCurrency: props.page.editingItem
    ? []
    : [{ required: true, message: '请选择 ID采购币种', trigger: 'change' }],
  purchaseOriginalAmount: props.page.editingItem
    ? []
    : [
        {
          validator: (_rule, _value, callback) =>
            callback(
              props.page.purchaseEvidenceError &&
                props.page.purchaseEvidenceError.includes('ID采购金额')
                ? new Error(props.page.purchaseEvidenceError)
                : undefined
            ),
          trigger: ['blur', 'change']
        }
      ],
  purchaseSourceId: props.page.editingItem
    ? []
    : [{ required: true, message: '请选择付款账户', trigger: 'change' }],
  purchasedAt: props.page.editingItem
    ? []
    : [{ required: true, message: '请选择采购时间', trigger: 'change' }],
  purchaseManualRateReason:
    !props.page.editingItem && props.page.form.purchaseFxRateToCny
      ? [{ required: true, message: '请说明手工汇率来源', trigger: 'blur' }]
      : [],
  currentBalance: [
    {
      required: true,
      validator: (_rule, _value, callback) => {
        if (props.page.balanceInputError) {
          callback(new Error(props.page.balanceInputError));
          return;
        }
        if (
          !props.page.canAdjustBalance &&
          ((!props.page.editingItem &&
            (!isZero(props.page.form.currentBalance) ||
              !isZero(props.page.form.balanceCostAmount))) ||
            (Boolean(props.page.editingItem) && props.page.balanceChanged))
        ) {
          callback(new Error('当前账号无余额调整权限'));
          return;
        }
        callback();
      },
      trigger: ['blur', 'change']
    }
  ],
  exchangeRate: [
    {
      required: true,
      validator: (_rule, _value, callback) =>
        callback(
          props.page.exchangeRateInputError
            ? new Error(props.page.exchangeRateInputError)
            : undefined
        ),
      trigger: ['blur', 'change']
    }
  ],
  balanceCostAmount: [
    {
      required: true,
      validator: (_rule, _value, callback) =>
        callback(
          props.page.balanceCostInputError ? new Error(props.page.balanceCostInputError) : undefined
        ),
      trigger: ['blur', 'change']
    }
  ],
  balanceAdjustmentReason:
    props.page.editingItem && props.page.balanceChanged
      ? [
          {
            required: true,
            validator: (_rule, value, callback) => {
              const normalized = String(value ?? '').trim();
              callback(
                normalized.length >= 2 && normalized.length <= 200
                  ? undefined
                  : new Error('余额修正原因必须为 2 至 200 个字符')
              );
            },
            trigger: 'blur'
          }
        ]
      : []
}));
const revealRules = computed<FormRules>(() => ({
  field: [{ required: true, message: '请选择查看字段', trigger: 'change' }],
  reason:
    props.page.sensitiveAccessRequiresApproval && !props.page.sensitiveAccessCanReveal
      ? [
          {
            required: true,
            validator: (_rule, value, callback) => {
              const normalized = String(value ?? '').trim();
              callback(
                normalized.length >= 2 && normalized.length <= 200
                  ? undefined
                  : new Error('请输入 2 至 200 个字符的申请原因')
              );
            },
            trigger: 'blur'
          }
        ]
      : []
}));
const importDisabledReason = computed(() =>
  !props.page.importCompleted && !props.page.importRows.length ? '当前没有可导入的有效记录' : ''
);

async function submitAccountForm() {
  if (props.page.formDisabledReason || !(await validateV2Form(formRef.value))) return;
  await props.page.submitForm();
}

async function revealSecret() {
  if (!(await validateV2Form(revealFormRef.value))) return;
  await props.page.revealSecret();
}

function isZero(value: unknown) {
  return Number(String(value ?? '').trim() || '0') === 0;
}
</script>

<style scoped>
.v2-sensitive-access-status {
  display: flex;
  min-height: 40px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 12px 0 4px;
  padding: 8px 10px;
  border: 1px solid var(--v2-border);
  border-radius: var(--el-border-radius-small);
  background: var(--el-fill-color-extra-light);
  color: var(--v2-text-soft);
  font-size: 12px;
}
</style>
