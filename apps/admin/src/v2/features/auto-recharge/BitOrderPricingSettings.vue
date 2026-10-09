<template>
  <AppButton variant="ghost" @click="openSettings">收费与手续费设置</AppButton>
  <V2FormDrawer
    v-model="open"
    retain-draft
    title="比特订单收费设置"
    description="所有管理员共用。保存后用于待补全订单的计算参考；客户实收需按实际收款核对，历史账务保持原金额。"
    :confirm-loading="saving"
    :confirm-disabled="query.phase.value !== 'ready'"
    :dirty="dirty"
    @confirm="save"
  >
    <V2AsyncRegion
      skeleton="inline"
      :phase="query.phase.value"
      :error="query.error.value ? getApiErrorMessage(query.error.value) : ''"
      loading-title="正在加载收费设置"
      @retry="query.refresh"
    >
      <el-form
        label-position="left"
        label-width="140px"
        require-asterisk-position="right"
        autocomplete="off"
      >
        <el-form-item label="客户收款币种" required>
          <V2FinanceCurrencySelect
            v-model="draft.form.receivedCurrencyCode"
            aria-label="客户收款默认币种"
          />
        </el-form-item>
        <p class="bank-recharge-form-note">
          切换币种后请重新核对各套餐收费，金额数值不会自动换汇。
        </p>
        <el-form-item label="购物网手续费">
          <el-input
            v-model="draft.form.shoppingFeePercent"
            inputmode="decimal"
            placeholder="未设置；例如 0.1 或 0.01"
            ><template #append>%</template></el-input
          >
        </el-form-item>
        <p class="bank-recharge-form-note">
          购物网手续费＝客户实际收款金额 × 此比例，使用客户收款币种。
        </p>
        <el-form-item label="USDT 手续费">
          <el-input
            v-model="draft.form.usdtFeePercent"
            inputmode="decimal"
            placeholder="未设置；例如 2.5"
            ><template #append>%</template></el-input
          >
        </el-form-item>
        <p class="bank-recharge-form-note">
          USDT 手续费＝当次官网实际代付金额 × 此比例，再按有效缓存汇率换算成 USDT。没有费用请设置
          0。
        </p>
        <el-form-item
          v-for="plan in bankRechargePlanOptions"
          :key="plan.value"
          :label="`${bankRechargePlanLabel(plan.value)} 收费`"
        >
          <el-input
            v-model="draft.form.planPrices[plan.value]"
            inputmode="decimal"
            placeholder="未设置，填写客户收款参考金额"
            ><template #append>{{ draft.form.receivedCurrencyCode }}</template></el-input
          >
        </el-form-item>
        <p class="bank-recharge-form-note">
          套餐收费是客户收款参考价，不用于计算官网代付。升级订单始终记录官网本次补付金额。利润＝实收折人民币－当次代付折人民币－两项手续费折人民币；缺少有效汇率时显示待核对。
        </p>
      </el-form>
    </V2AsyncRegion>
    <p v-if="error" class="bank-recharge-error" role="alert">
      {{ error }}
      <AppButton size="small" variant="ghost" :disabled="saving" @click="reloadSaved"
        >重新载入已保存设置</AppButton
      >
    </p>
  </V2FormDrawer>
</template>
<script setup lang="ts">
import AppButton from '@/components/ui/AppButton.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2FinanceCurrencySelect from '@/v2/components/V2FinanceCurrencySelect.vue';
import { getApiErrorMessage } from '@/api/client';
import { bankRechargePlanOptions, bankRechargePlanLabel } from './recharge-plan-options';
import type { useBitOrderPricing } from './useBitOrderPricing';
const props = defineProps<{ state: ReturnType<typeof useBitOrderPricing> }>();
const { open, saving, dirty, error, query, draft, openSettings, save, reloadSaved } = props.state;
</script>
