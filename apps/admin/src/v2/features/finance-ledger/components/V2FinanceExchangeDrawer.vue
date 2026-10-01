<template>
  <V2FormDrawer
    v-model="page.exchangeDrawerVisible"
    :title="state.editing ? '更正换汇' : '换汇录入'"
    description="本金不含另付手续费；到账金额填写实际收到的金额。"
    :confirm-text="state.editing ? '冲销并重记' : '确认入账'"
    :confirm-loading="state.submitting"
    :dirty="state.dirty"
    @confirm="state.save"
  >
    <el-alert v-if="state.accountQuery.error" type="warning" :closable="false" title="账户加载失败"
      ><AppButton variant="ghost" size="small" @click="state.accountQuery.refresh"
        >重试账户</AppButton
      ></el-alert
    >
    <el-form label-position="left" label-width="130px" require-asterisk-position="right">
      <el-form-item label="换汇时间" required
        ><el-input v-model="state.form.occurredAt" type="datetime-local"
      /></el-form-item>
      <template v-for="side in sides" :key="side.key">
        <el-form-item :label="side.currencyLabel" required
          ><V2FinanceCurrencySelect
            v-model="state.form[`${side.key}Currency`]"
            @change="state.changeCurrency(side.key)"
        /></el-form-item>
        <el-form-item :label="side.accountLabel" required>
          <el-select
            v-model="state.form[`${side.key}AccountId`]"
            filterable
            :aria-label="side.accountLabel"
          >
            <el-option
              v-for="account in state.accounts.filter(
                (a) => a.currency === state.form[`${side.key}Currency`]
              )"
              :key="account.id"
              :label="`${account.name} · 余额 ${account.currentBalance}`"
              :value="account.id"
            />
          </el-select>
          <AppButton
            v-if="page.canManage"
            size="small"
            variant="ghost"
            @click="state.quickAccount(side.key)"
            >新增账户</AppButton
          >
        </el-form-item>
        <el-form-item :label="side.amountLabel" required
          ><el-input v-model="state.form[`${side.key}Amount`]" inputmode="decimal"
        /></el-form-item>
      </template>
      <el-form-item label="手续费扣法" required
        ><el-select v-model="state.form.feeMode"
          ><el-option label="付出币种另付" value="source_extra" /><el-option
            label="买入币种扣除"
            value="target_deducted" /></el-select
      ></el-form-item>
      <el-form-item label="手续费金额" required
        ><el-input v-model="state.form.feeAmount" inputmode="decimal"
          ><template #append>{{ state.feeCurrency }}</template></el-input
        ></el-form-item
      >
      <el-form-item label="手续费百分比"
        ><span>{{
          state.calculation ? `${state.calculation.feePercent}%` : '待填写金额'
        }}</span></el-form-item
      >
      <template v-if="state.calculation">
        <el-form-item label="总扣款"
          ><span
            >{{ state.calculation.totalDebit }} {{ state.form.sourceCurrency }}</span
          ></el-form-item
        >
        <el-form-item label="成交汇率"
          ><span
            >1 {{ state.form.sourceCurrency }} = {{ state.calculation.exchangeRate }}
            {{ state.form.targetCurrency }}</span
          ></el-form-item
        >
        <el-form-item label="反向成交汇率"
          ><span
            >1 {{ state.form.targetCurrency }} = {{ state.calculation.reverseRate }}
            {{ state.form.sourceCurrency }}</span
          ></el-form-item
        >
        <el-form-item label="含费实际汇率"
          ><span
            >1 {{ state.form.sourceCurrency }} = {{ state.calculation.effectiveRate }}
            {{ state.form.targetCurrency }}</span
          ></el-form-item
        >
      </template>
      <template v-for="side in sides" :key="`${side.key}-rate`">
        <el-form-item
          v-if="state.form[`${side.key}Currency`] !== 'CNY'"
          :label="`${side.currencyLabel}估值汇率`"
          ><el-input
            v-model="state.form[`${side.key}FxRateToCny`]"
            inputmode="decimal"
            placeholder="1 原币折合人民币；留空采集市场汇率"
        /></el-form-item>
      </template>
      <el-form-item
        v-if="state.form.sourceFxRateToCny || state.form.targetFxRateToCny"
        label="人工汇率原因"
        required
        ><el-input v-model="state.form.manualRateReason" maxlength="500"
      /></el-form-item>
      <el-form-item label="换汇渠道"
        ><el-input v-model="state.form.channel" maxlength="200"
      /></el-form-item>
      <el-form-item label="备注"
        ><el-input v-model="state.form.remark" type="textarea" maxlength="2000"
      /></el-form-item>
      <el-form-item v-if="state.editing" label="更正原因" required
        ><el-input v-model="state.reason" maxlength="500"
      /></el-form-item>
    </el-form>
    <p v-if="state.error" role="alert" class="bank-recharge-error">{{ state.error }}</p>
  </V2FormDrawer>
  <V2FormDrawer
    v-model="state.reversalOpen"
    title="冲销换汇"
    description="使用原金额和原汇率恢复账户；已关账月份不能冲销。"
    :confirm-loading="state.submitting"
    :dirty="Boolean(state.reversalReason)"
    @confirm="state.reverse"
  >
    <el-form label-position="left" label-width="100px" require-asterisk-position="right"
      ><el-form-item label="冲销原因" required
        ><el-input v-model="state.reversalReason" maxlength="500" /></el-form-item
    ></el-form>
    <p v-if="state.error" role="alert">{{ state.error }}</p>
  </V2FormDrawer>
</template>
<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2FinanceCurrencySelect from '@/v2/components/V2FinanceCurrencySelect.vue';
import type { useFinanceExchanges } from '../useFinanceExchanges';
import type { useFinanceLedgerPage } from '../useFinanceLedgerPage';
defineProps<{
  state: UnwrapNestedRefs<ReturnType<typeof useFinanceExchanges>>;
  page: UnwrapNestedRefs<ReturnType<typeof useFinanceLedgerPage>>;
}>();
const sides = [
  { key: 'source', currencyLabel: '开支币种', accountLabel: '付款账户', amountLabel: '换汇本金' },
  {
    key: 'target',
    currencyLabel: '购买币种',
    accountLabel: '收款账户',
    amountLabel: '实际到账金额'
  }
] as const;
</script>
