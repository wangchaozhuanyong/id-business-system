<template>
  <V2FormDrawer
    v-model="drawerVisible"
    title="录入续费订单"
    eyebrow="手工续费"
    description="核对续费对象、收款信息与续费周期后提交订单"
    size="min(760px, 100vw)"
    confirm-text="核对并续费"
    :dirty="formDirty"
    :confirm-disabled-reason="submitDisabledReason"
    :confirm-loading="submitting"
    @confirm="confirm"
  >
    <div v-if="renewal" class="v2-renewal-open">
      <section class="v2-renewal-open__target" aria-labelledby="renewal-target-heading">
        <header class="v2-renewal-open__target-heading">
          <div>
            <span>续费对象</span>
            <h3 id="renewal-target-heading">{{ renewal.customer.name }}</h3>
            <p>{{ renewal.account.appleIdMasked }}</p>
          </div>
          <div class="v2-renewal-open__balance">
            <span>当前系统余额</span>
            <strong>{{ formatDecimal(renewal.account.currentBalance) }}</strong>
          </div>
        </header>

        <dl class="v2-renewal-open__facts">
          <div>
            <dt>国家</dt>
            <dd>{{ renewal.account.country.name }}</dd>
          </div>
          <div>
            <dt>客户网站账号</dt>
            <dd>{{ renewal.maskedWebsiteAccount || '未填写' }}</dd>
          </div>
          <div>
            <dt>客户编号</dt>
            <dd>{{ renewal.customer.id }}</dd>
          </div>
          <div v-if="renewal.account.soldByOrder">
            <dt>原销售订单</dt>
            <dd>{{ renewal.account.soldByOrder.orderNo }}</dd>
          </div>
          <div v-if="renewal.account.soldByOrder">
            <dt>归属客户</dt>
            <dd>{{ renewal.account.soldByOrder.customer.name }}</dd>
          </div>
        </dl>
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
        <section class="v2-renewal-open__section" aria-labelledby="renewal-service-heading">
          <header class="v2-renewal-open__section-heading">
            <span>01</span>
            <h3 id="renewal-service-heading">续费业务</h3>
          </header>
          <div class="v2-renewal-open__grid">
            <el-form-item label="业务分类" prop="categoryOptionId">
              <el-select
                v-model="categoryOptionId"
                filterable
                aria-label="选择续费业务分类"
                placeholder="请选择业务分类"
                :loading="optionsLoading"
                @change="emit('categoryChange')"
              >
                <el-option
                  v-for="category in categories"
                  :key="category.id"
                  :label="category.name"
                  :value="category.id"
                />
              </el-select>
            </el-form-item>
            <el-form-item label="续费业务" prop="serviceOptionId">
              <el-select
                v-model="serviceOptionId"
                filterable
                aria-label="选择续费业务"
                :disabled="!categoryOptionId"
                :placeholder="categoryOptionId ? '请选择续费业务' : '请先选择业务分类'"
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
          </div>
        </section>

        <section class="v2-renewal-open__section" aria-labelledby="renewal-pricing-heading">
          <header class="v2-renewal-open__section-heading">
            <span>02</span>
            <h3 id="renewal-pricing-heading">收款与余额</h3>
          </header>
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
              >
                <template #prepend>¥</template>
              </el-input>
            </el-form-item>
            <el-form-item label="扣减 ID 余额" prop="balanceAmount">
              <el-input
                v-model="balanceAmount"
                inputmode="decimal"
                maxlength="19"
                aria-label="续费扣减 ID 余额"
                placeholder="例如 10"
              >
                <template v-if="selectedService?.currencyCode" #append>
                  {{ selectedService.currencyCode }}
                </template>
              </el-input>
            </el-form-item>
          </div>

          <div class="v2-renewal-open__grid v2-renewal-open__grid--pricing">
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
                  <span>建议实收</span>
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
                  <small v-else>填写目标利润率后生成建议实收金额</small>
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
                    撤销
                  </AppButton>
                  <AppButton
                    variant="soft"
                    :disabled="!suggestedReceived.amount"
                    @click="emit('applySuggested')"
                  >
                    采用推荐价
                  </AppButton>
                </div>
              </div>
            </el-form-item>
          </div>
        </section>

        <section class="v2-renewal-open__section" aria-labelledby="renewal-settlement-heading">
          <header class="v2-renewal-open__section-heading">
            <span>03</span>
            <h3 id="renewal-settlement-heading">结算信息</h3>
          </header>
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
        </section>

        <section class="v2-renewal-open__section" aria-labelledby="renewal-period-heading">
          <header class="v2-renewal-open__section-heading">
            <span>04</span>
            <h3 id="renewal-period-heading">续费周期</h3>
          </header>
          <div class="v2-renewal-open__grid">
            <el-form-item label="开始时间" prop="openedAt">
              <el-date-picker
                v-model="openedAt"
                type="datetime"
                value-format="YYYY-MM-DDTHH:mm"
                format="YYYY-MM-DD HH:mm"
                aria-label="续费开始时间"
                placeholder="选择开始时间"
                @change="emit('openedAtChange', openedAt)"
              />
            </el-form-item>
            <el-form-item label="到期时间" prop="dueAt">
              <el-date-picker
                v-model="dueAt"
                type="datetime"
                value-format="YYYY-MM-DDTHH:mm"
                format="YYYY-MM-DD HH:mm"
                aria-label="续费到期时间"
                placeholder="选择到期时间"
              />
            </el-form-item>
          </div>
        </section>

        <section class="v2-renewal-open__section" aria-labelledby="renewal-remark-heading">
          <header class="v2-renewal-open__section-heading">
            <span>05</span>
            <h3 id="renewal-remark-heading">补充说明</h3>
          </header>
          <el-form-item label="备注">
            <el-input
              v-model="remark"
              type="textarea"
              :rows="3"
              maxlength="2000"
              show-word-limit
              aria-label="续费备注"
              placeholder="选填"
            >
            </el-input>
          </el-form-item>
        </section>

        <el-alert
          v-if="optionsError"
          :title="optionsError"
          type="error"
          show-icon
          :closable="false"
        />

        <section class="v2-renewal-open__summary" aria-labelledby="renewal-summary-heading">
          <header>
            <span>提交预览</span>
            <h3 id="renewal-summary-heading">费用与利润</h3>
          </header>
          <div class="v2-renewal-open__preview">
            <div>
              <span>平台手续费</span>
              <strong>¥{{ formatDecimal(platformFeePreview) }}</strong>
            </div>
            <div>
              <span>余额成本</span>
              <strong>¥{{ formatDecimal(estimatedBalanceCostPreview) }}</strong>
            </div>
            <div>
              <span>本次 ID 成本</span>
              <strong>¥0.00</strong>
            </div>
            <div class="v2-renewal-open__preview-profit">
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
        </section>
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
import { computed, ref, watch } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import { V2_DECIMAL_PLACES, formatV2Decimal, isV2UnsignedDecimal } from '@/v2/utils/decimal';
import {
  validateTargetProfitRate,
  type SuggestedReceivedAmount
} from '@/v2/features/order-entry/order-pricing';
import { validateV2Form } from '@/v2/utils/formValidation';
import { parseV2DateTimeInput } from '@/v2/utils/dateTime';
import { getV2BusinessNowMs } from '@/v2/runtime/businessClock';
import AppButton from '@/components/ui/AppButton.vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import type { V2ManualRenewalOptions, V2RenewalWorkbenchItem } from '../contracts';

type ManualService = V2ManualRenewalOptions['services'][number];

const props = defineProps<{
  renewal: V2RenewalWorkbenchItem | null;
  categories: Array<{ id: string; name: string }>;
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
  categoryChange: [];
  settlementPlatformChange: [];
  applySuggested: [];
  undoSuggested: [];
  manualPriceInput: [];
  openedAtChange: [value: string | null];
}>();

const drawerVisible = defineModel<boolean>({ required: true });
const confirmationVisible = defineModel<boolean>('confirmationVisible', { required: true });
const categoryOptionId = defineModel<string>('categoryOptionId', { required: true });
const serviceOptionId = defineModel<string>('serviceOptionId', { required: true });
const settlementPlatformOptionId = defineModel<string>('settlementPlatformOptionId', {
  required: true
});
const platformOrderNo = defineModel<string>('platformOrderNo', { required: true });
const receivedAmount = defineModel<string>('receivedAmount', { required: true });
const targetProfitRate = defineModel<string>('targetProfitRate', { required: true });
const balanceAmount = defineModel<string>('balanceAmount', { required: true });
const openedAt = defineModel<string | null>('openedAt', { required: true });
const dueAt = defineModel<string | null>('dueAt', { required: true });
const remark = defineModel<string>('remark', { required: true });
const formRef = ref<FormInstance>();
const formModel = computed(() => ({
  categoryOptionId: categoryOptionId.value,
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
const initialFormSnapshot = ref('');
const baselinePendingOptions = ref(false);
const currentFormSnapshot = computed(() => JSON.stringify(formModel.value));
const formDirty = computed(
  () =>
    drawerVisible.value &&
    Boolean(initialFormSnapshot.value) &&
    currentFormSnapshot.value !== initialFormSnapshot.value
);

watch(
  drawerVisible,
  (visible) => {
    if (!visible) {
      initialFormSnapshot.value = '';
      baselinePendingOptions.value = false;
      return;
    }
    initialFormSnapshot.value = currentFormSnapshot.value;
    baselinePendingOptions.value = props.optionsLoading;
  },
  { immediate: true }
);

watch(
  () => props.optionsLoading,
  (loading) => {
    if (!drawerVisible.value) return;
    if (loading) {
      baselinePendingOptions.value = true;
      return;
    }
    if (baselinePendingOptions.value) {
      initialFormSnapshot.value = currentFormSnapshot.value;
      baselinePendingOptions.value = false;
    }
  }
);

const formRules = computed<FormRules>(() => ({
  categoryOptionId: [{ required: true, message: '请选择业务分类', trigger: 'change' }],
  serviceOptionId: [
    { required: true, message: '请选择续费业务', trigger: 'change' },
    {
      validator: (_rule, value, callback) =>
        callback(
          props.services.some((service) => service.id === value)
            ? undefined
            : new Error('所选业务不属于当前分类或不适用于当前 ID 国家')
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
        const candidate = parseV2DateTimeInput(value);
        callback(
          candidate && (!sourceDueAt || candidate.getTime() >= sourceDueAt.getTime())
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
        const candidate = parseV2DateTimeInput(value);
        const openedAtCandidate = parseV2DateTimeInput(openedAt.value);
        if (!candidate || !openedAtCandidate) {
          callback(new Error('请选择有效的续费时间'));
          return;
        }
        if (candidate.getTime() <= openedAtCandidate.getTime()) {
          callback(new Error('续费到期时间必须晚于开始时间'));
          return;
        }
        callback(
          candidate.getTime() > (getV2BusinessNowMs() ?? Number.NEGATIVE_INFINITY)
            ? undefined
            : new Error('续费到期时间必须晚于当前时间')
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
  return `${service.name} / ${formatDecimal(service.businessAmount)} ${service.currencyCode ?? ''}`;
}

function formatDecimal(value: string | number | null | undefined) {
  return formatV2Decimal(value, { minimumFractionDigits: 2 });
}
</script>
