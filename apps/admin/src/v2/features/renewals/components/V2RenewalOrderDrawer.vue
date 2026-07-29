<template>
  <V2FormDrawer
    v-model="drawerVisible"
    title="录入续费订单"
    size="min(660px, 96vw)"
    confirm-text="核对并续费"
    :confirm-disabled="!canSubmit"
    :confirm-loading="submitting"
    @confirm="emit('openConfirmation')"
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
      </section>

      <section class="v2-renewal-open__form">
        <label>
          <span>续费业务</span>
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
        </label>

        <div class="v2-renewal-open__grid">
          <label>
            <span>客户实收金额</span>
            <el-input
              v-model="receivedAmount"
              inputmode="decimal"
              maxlength="19"
              aria-label="续费客户实收金额"
              placeholder="例如 100"
            />
          </label>
          <label>
            <span>
              {{
                selectedService?.currencyCode
                  ? `扣减 ID 余额（${selectedService.currencyCode}）`
                  : '扣减 ID 余额'
              }}
            </span>
            <el-input
              v-model="balanceAmount"
              inputmode="decimal"
              maxlength="19"
              aria-label="续费扣减 ID 余额"
              placeholder="例如 10"
            />
          </label>
        </div>

        <div class="v2-renewal-open__grid">
          <label>
            <span>结算平台</span>
            <el-select
              v-model="settlementPlatformOptionId"
              clearable
              filterable
              aria-label="续费结算平台"
              placeholder="无"
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
          </label>
          <label>
            <span>平台订单号</span>
            <el-input
              v-model="platformOrderNo"
              maxlength="160"
              :disabled="!settlementPlatformOptionId"
              aria-label="续费平台订单号"
              placeholder="选填"
            />
          </label>
        </div>

        <div class="v2-renewal-open__grid">
          <label>
            <span>续费开始时间</span>
            <el-date-picker
              v-model="openedAt"
              type="datetime"
              format="YYYY-MM-DD HH:mm"
              aria-label="续费开始时间"
              placeholder="选择开始时间"
              @change="emit('openedAtChange', openedAt)"
            />
          </label>
          <label>
            <span>续费到期时间</span>
            <el-date-picker
              v-model="dueAt"
              type="datetime"
              format="YYYY-MM-DD HH:mm"
              aria-label="续费到期时间"
              placeholder="选择到期时间"
            />
          </label>
        </div>

        <label>
          <span>备注</span>
          <el-input
            v-model="remark"
            type="textarea"
            :rows="3"
            maxlength="2000"
            show-word-limit
            aria-label="续费备注"
            placeholder="选填"
          />
        </label>

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
            <span>续费后 ID 余额</span>
            <strong>{{ formatDecimal(balanceAfterPreview) }}</strong>
          </div>
        </div>
      </section>
    </div>
  </V2FormDrawer>

  <V2ConfirmDialog
    v-model="confirmationVisible"
    title="确认续费并扣减余额"
    :message="confirmationMessage"
    confirm-text="确认续费"
    :confirm-loading="submitting"
    @confirm="emit('submit')"
  />
</template>

<script setup lang="ts">
import { formatV2Decimal } from '@/v2/utils/decimal';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import type { V2ManualRenewalOptions, V2RenewalWorkbenchItem } from '../contracts';

type ManualService = V2ManualRenewalOptions['services'][number];

defineProps<{
  renewal: V2RenewalWorkbenchItem | null;
  services: V2ManualRenewalOptions['services'];
  settlementPlatforms: V2ManualRenewalOptions['settlementPlatforms'];
  selectedService: ManualService | null;
  optionsLoading: boolean;
  optionsError: string;
  submitting: boolean;
  canSubmit: boolean;
  platformFeePreview: string;
  balanceAfterPreview: string;
  confirmationMessage: string;
}>();

const emit = defineEmits<{
  openConfirmation: [];
  submit: [];
  settlementPlatformChange: [];
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
const balanceAmount = defineModel<string>('balanceAmount', { required: true });
const openedAt = defineModel<Date | null>('openedAt', { required: true });
const dueAt = defineModel<Date | null>('dueAt', { required: true });
const remark = defineModel<string>('remark', { required: true });

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
