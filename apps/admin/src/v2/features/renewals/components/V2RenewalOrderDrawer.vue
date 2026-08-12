<template>
  <V2FormDrawer
    v-model="drawerVisible"
    title="录入续费订单"
    size="min(660px, 96vw)"
    confirm-text="核对并续费"
    :confirm-disabled-reason="submitDisabledReason"
    :confirm-loading="submitting"
    @confirm="confirm"
  >
    <div v-if="renewal" class="v2-renewal-open">
      <section class="v2-renewal-open__target">
        <div>
          <span>客户</span>
          <strong>{{ renewal.customer.name }}</strong>
        </div>
        <div>
          <span>客户 ID</span>
          <strong>{{ renewal.customer.id }}</strong>
        </div>
        <div>
          <span>Apple ID</span>
          <strong>{{ renewal.account.appleIdMasked }}</strong>
        </div>
        <div>
          <span>国家</span>
          <strong>{{ renewal.account.country.name }}</strong>
        </div>
        <div>
          <span>客户网站账号</span>
          <strong>{{ renewal.maskedWebsiteAccount || '-' }}</strong>
        </div>
        <div>
          <span>当前系统余额</span>
          <strong>{{ formatDecimal(renewal.account.currentBalance) }}</strong>
        </div>
        <div v-if="renewal.account.soldByOrder">
          <span>原销售订单</span>
          <strong>{{ renewal.account.soldByOrder.orderNo }}</strong>
        </div>
        <div v-if="renewal.account.soldByOrder">
          <span>归属客户</span>
          <strong>{{ renewal.account.soldByOrder.customer.name }}</strong>
        </div>
      </section>

      <el-alert
        v-if="renewal.account.saleState === 'sold'"
        type="info"
        title="本次续费按客户已购 ID 入账，ID 成本固定为 0"
        :closable="false"
        show-icon
      />

      <el-form
        ref="formRef"
        class="v2-renewal-open__form v2-horizontal-form"
        :model="formModel"
        :rules="formRules"
        label-position="left"
        label-width="132px"
        require-asterisk-position="right"
        status-icon
        scroll-to-error
        :scroll-into-view-options="{ behavior: 'smooth', block: 'center' }"
      >
        <el-form-item label="续费业务" prop="serviceOptionId">
          <el-select
            v-model="serviceOptionId"
            filterable
            aria-label="选择续费业务"
            placeholder="请选择本次续费业务"
            :loading="optionsLoading"
          >
            <el-option
              v-for="option in services"
              :key="option.id"
              :label="serviceLabel(option)"
              :value="option.id"
            />
          </el-select>
        </el-form-item>

        <div class="v2-renewal-open__grid">
          <el-form-item label="客户实收金额" prop="receivedAmount">
            <el-input
              v-model="receivedAmount"
              clearable
              inputmode="decimal"
              maxlength="19"
              aria-label="续费客户实收金额"
              placeholder="例如 100"
              @input="emit('manualPriceInput')"
            />
          </el-form-item>
          <el-form-item
            :label="
              selectedService?.currencyCode
                ? `扣减 ID 余额（${selectedService.currencyCode}）`
                : '扣减 ID 余额'
            "
            prop="balanceAmount"
          >
            <el-input
              v-model="balanceAmount"
              inputmode="decimal"
              maxlength="19"
              aria-label="续费扣减 ID 余额"
              placeholder="例如 10"
            />
          </el-form-item>
        </div>

        <div class="v2-renewal-open__grid">
          <el-form-item label="结算平台" prop="settlementPlatformOptionId">
            <el-select
              v-model="settlementPlatformOptionId"
              filterable
              aria-label="续费结算平台"
              placeholder="请选择收款方式"
              :loading="optionsLoading"
              @change="emit('settlementPlatformChange')"
            >
              <el-option
                v-for="option in settlementPlatforms"
                :key="option.id"
                :label="option.name"
                :value="option.id"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="平台订单号" prop="platformOrderNo">
            <el-input
              v-model="platformOrderNo"
              maxlength="160"
              :disabled="!settlementPlatformOptionId"
              aria-label="续费平台订单号"
              placeholder="选填"
            />
          </el-form-item>
        </div>

        <div class="v2-renewal-open__grid">
          <el-form-item label="目标利润率" prop="targetProfitRate">
            <el-input
              v-model="targetProfitRate"
              clearable
              inputmode="decimal"
              maxlength="8"
              placeholder="选填，例如 10"
            >
              <template #append>%</template>
            </el-input>
          </el-form-item>
          <el-form-item label="推荐价格">
            <div class="v2-renewal-price-recommendation">
              <div>
                <strong>
                  {{
                    suggestedReceived.amount ? `¥${formatDecimal(suggestedReceived.amount)}` : '—'
                  }}
                </strong>
                <small v-if="suggestedReceived.error">{{ suggestedReceived.error }}</small>
                <small v-else-if="suggestedReceived.estimatedProfit">
                  预计利润 ¥{{ formatDecimal(suggestedReceived.estimatedProfit) }}，利润率
                  {{ suggestedReceived.estimatedProfitRate }}%
                </small>
                <small v-else>填写目标利润率后按本次余额成本反推</small>
                <small
                  v-if="
                    recommendationApplied &&
                    appliedSuggestedCny &&
                    suggestedReceived.amount !== appliedSuggestedCny
                  "
                >
                  推荐价已更新，现有价格不会自动覆盖
                </small>
              </div>
              <div class="v2-renewal-price-recommendation__actions">
                <AppButton
                  v-if="recommendationApplied"
                  variant="ghost"
                  @click="emit('undoSuggested')"
                >
                  撤销采用
                </AppButton>
                <AppButton
                  variant="ghost"
                  :disabled="!suggestedReceived.amount"
                  @click="emit('applySuggested')"
                >
                  采用推荐价
                </AppButton>
              </div>
            </div>
          </el-form-item>
        </div>

        <div class="v2-renewal-open__grid">
          <el-form-item label="续费开始时间" prop="openedAt">
            <el-date-picker
              v-model="openedAt"
              type="datetime"
              format="YYYY-MM-DD HH:mm"
              aria-label="续费开始时间"
              placeholder="选择开始时间"
              @change="emit('openedAtChange', openedAt)"
            />
          </el-form-item>
          <el-form-item label="续费到期时间" prop="dueAt">
            <el-date-picker
              v-model="dueAt"
              type="datetime"
              format="YYYY-MM-DD HH:mm"
              aria-label="续费到期时间"
              placeholder="选择到期时间"
            />
          </el-form-item>
        </div>

        <el-form-item label="备注">
          <el-input
            v-model="remark"
            type="textarea"
            :rows="3"
            maxlength="2000"
            show-word-limit
            aria-label="续费备注"
            placeholder="选填"
          />
        </el-form-item>

        <el-alert
          v-if="optionsError"
          :title="optionsError"
          type="error"
          show-icon
          :closable="false"
        />

        <div class="v2-renewal-open__preview">
          <div>
            <span>预计平台手续费</span>
            <strong>¥{{ formatDecimal(platformFeePreview) }}</strong>
          </div>
          <div>
            <span>预计余额成本</span>
            <strong>¥{{ formatDecimal(estimatedBalanceCostPreview) }}</strong>
          </div>
          <div>
            <span>本次 ID 成本</span>
            <strong>¥0.00</strong>
          </div>
          <div>
            <span>预计利润</span>
            <strong>¥{{ formatDecimal(estimatedProfitPreview) }}</strong>
          </div>
          <div>
            <span>预计利润率</span>
            <strong>
              {{ estimatedProfitRatePreview === null ? '—' : `${estimatedProfitRatePreview}%` }}
            </strong>
          </div>
          <div>
            <span>续费后 ID 余额</span>
            <strong>{{ formatDecimal(balanceAfterPreview) }}</strong>
          </div>
        </div>
      </el-form>
    </div>
  </V2FormDrawer>

  <V2ConfirmDialog
    v-model="confirmationVisible"
    title="确认续费并扣减余额"
    :message="confirmationMessage"
    confirm-text="确认续费"
    :confirm-loading="submitting"
    :confirm-disabled-reason="submitDisabledReason"
    @confirm="emit('submit')"
  />
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import { V2_DECIMAL_PLACES, formatV2Decimal, isV2UnsignedDecimal } from '@/v2/utils/decimal';
import {
  validateTargetProfitRate,
  type SuggestedReceivedAmount
} from '@/v2/features/order-entry/order-pricing';
import { validateV2Form } from '@/v2/utils/formValidation';
import AppButton from '@/components/ui/AppButton.vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import type { V2ManualRenewalOptions, V2RenewalWorkbenchItem } from '../contracts';

type ManualService = V2ManualRenewalOptions['services'][number];

const props = defineProps<{
  renewal: V2RenewalWorkbenchItem | null;
  services: V2ManualRenewalOptions['services'];
  settlementPlatforms: V2ManualRenewalOptions['settlementPlatforms'];
  selectedService: ManualService | null;
  optionsLoading: boolean;
  optionsError: string;
  submitting: boolean;
  submitDisabledReason: string;
  platformFeePreview: string;
  estimatedBalanceCostPreview: string;
  estimatedProfitPreview: string;
  estimatedProfitRatePreview: string | null;
  suggestedReceived: SuggestedReceivedAmount;
  recommendationApplied: boolean;
  appliedSuggestedCny: string;
  balanceAfterPreview: string;
  confirmationMessage: string;
}>();

const emit = defineEmits<{
  openConfirmation: [];
  submit: [];
  settlementPlatformChange: [];
  applySuggested: [];
  undoSuggested: [];
  manualPriceInput: [];
  openedAtChange: [value: Date | null];
}>();

const drawerVisible = defineModel<boolean>({ required: true });
const confirmationVisible = defineModel<boolean>('confirmationVisible', { required: true });
const serviceOptionId = defineModel<string>('serviceOptionId', { required: true });
const settlementPlatformOptionId = defineModel<string>('settlementPlatformOptionId', {
  required: true
});
const platformOrderNo = defineModel<string>('platformOrderNo', { required: true });
const receivedAmount = defineModel<string>('receivedAmount', { required: true });
const targetProfitRate = defineModel<string>('targetProfitRate', { required: true });
const balanceAmount = defineModel<string>('balanceAmount', { required: true });
const openedAt = defineModel<Date | null>('openedAt', { required: true });
const dueAt = defineModel<Date | null>('dueAt', { required: true });
const remark = defineModel<string>('remark', { required: true });
const formRef = ref<FormInstance>();
const formModel = computed(() => ({
  serviceOptionId: serviceOptionId.value,
  settlementPlatformOptionId: settlementPlatformOptionId.value,
  platformOrderNo: platformOrderNo.value,
  receivedAmount: receivedAmount.value,
  targetProfitRate: targetProfitRate.value,
  balanceAmount: balanceAmount.value,
  openedAt: openedAt.value,
  dueAt: dueAt.value,
  remark: remark.value
}));
const formRules = computed<FormRules>(() => ({
  serviceOptionId: [
    { required: true, message: '请选择续费业务', trigger: 'change' },
    {
      validator: (_rule, value, callback) =>
        callback(
          props.services.some((service) => service.id === value)
            ? undefined
            : new Error('所选业务不适用于当前 ID 国家')
        ),
      trigger: 'change'
    }
  ],
  receivedAmount: [
    {
      required: true,
      validator: (_rule, value, callback) =>
        callback(
          isV2UnsignedDecimal(value)
            ? undefined
            : new Error(`请输入最多 ${V2_DECIMAL_PLACES} 位小数的非负金额`)
        ),
      trigger: 'blur'
    }
  ],
  settlementPlatformOptionId: [{ required: true, message: '请选择结算平台', trigger: 'change' }],
  targetProfitRate: [
    {
      validator: (_rule, value, callback) => {
        const normalized = String(value ?? '').trim();
        if (!normalized) {
          callback();
          return;
        }
        const selectedPlatform = props.settlementPlatforms.find(
          (platform) => platform.id === settlementPlatformOptionId.value
        );
        const error = validateTargetProfitRate(normalized, selectedPlatform?.percentageFee ?? '0');
        callback(error ? new Error(error) : undefined);
      },
      trigger: 'blur'
    }
  ],
  balanceAmount: [
    {
      required: true,
      validator: (_rule, value, callback) => {
        if (!isV2UnsignedDecimal(value, { allowZero: false })) {
          callback(new Error(`请输入最多 ${V2_DECIMAL_PLACES} 位小数的正数`));
          return;
        }
        const currentBalance = Number(props.renewal?.account.currentBalance);
        callback(
          Number(value) <= currentBalance ? undefined : new Error('扣减余额不能超过 ID 当前余额')
        );
      },
      trigger: 'blur'
    }
  ],
  platformOrderNo: [
    {
      validator: (_rule, value, callback) =>
        callback(
          String(value ?? '').trim() && !settlementPlatformOptionId.value
            ? new Error('填写平台订单号时必须选择结算平台')
            : undefined
        ),
      trigger: 'blur'
    }
  ],
  openedAt: [
    { required: true, message: '请选择续费开始时间', trigger: 'change' },
    {
      validator: (_rule, value, callback) => {
        const sourceDueAt = props.renewal?.dueAt ? new Date(props.renewal.dueAt) : null;
        callback(
          value instanceof Date && (!sourceDueAt || value.getTime() >= sourceDueAt.getTime())
            ? undefined
            : new Error('续费开始时间不能早于原到期时间')
        );
      },
      trigger: 'change'
    }
  ],
  dueAt: [
    {
      required: true,
      validator: (_rule, value, callback) => {
        if (!(value instanceof Date) || !(openedAt.value instanceof Date)) {
          callback(new Error('请选择有效的续费时间'));
          return;
        }
        if (value.getTime() <= openedAt.value.getTime()) {
          callback(new Error('续费到期时间必须晚于开始时间'));
          return;
        }
        callback(
          value.getTime() > Date.now() ? undefined : new Error('续费到期时间必须晚于当前时间')
        );
      },
      trigger: 'change'
    }
  ]
}));

async function confirm() {
  if (props.submitDisabledReason || !(await validateV2Form(formRef.value))) return;
  emit('openConfirmation');
}

function serviceLabel(service: ManualService) {
  const category = service.category ? `${service.category.name} / ` : '';
  return `${category}${service.name} / ${formatDecimal(service.businessAmount)} ${
    service.currencyCode ?? ''
  }`;
}

function formatDecimal(value: string | number | null | undefined) {
  return formatV2Decimal(value, { minimumFractionDigits: 2 });
}
</script>
