<template>
  <section class="v2-form-shell">
    <V2SectionHeading
      class="v2-form-shell__header"
      title="订单信息"
      help="选择国家后，系统会优先匹配同国家的可用 ID。"
    />

    <el-form
      class="v2-order-form v2-horizontal-form"
      label-position="left"
      label-width="104px"
      require-asterisk-position="right"
      aria-disabled="true"
    >
      <div class="v2-order-form__grid">
        <el-form-item label="国家">
          <el-select disabled placeholder="选择国家" />
        </el-form-item>
        <el-form-item label="客户">
          <el-select disabled placeholder="选择客户" />
        </el-form-item>
        <el-form-item label="业务名称">
          <el-select disabled placeholder="选择业务" />
        </el-form-item>
        <el-form-item label="使用ID">
          <el-select disabled placeholder="等待按国家匹配" />
        </el-form-item>
        <el-form-item label="客户网站账号">
          <el-input disabled placeholder="输入客户网站账号" />
        </el-form-item>
        <el-form-item label="结算平台">
          <el-select disabled placeholder="选择结算平台" />
        </el-form-item>
        <el-form-item label="平台订单号">
          <el-input disabled placeholder="输入平台订单号" />
        </el-form-item>
        <el-form-item label="实收金额">
          <el-input-number disabled controls-position="right" :min="0" />
        </el-form-item>
        <el-form-item label="消耗余额">
          <el-input-number disabled controls-position="right" :min="0" />
        </el-form-item>
        <el-form-item label="开通时间">
          <el-date-picker disabled type="datetime" placeholder="选择开通时间" />
        </el-form-item>
        <el-form-item label="到期时间">
          <el-date-picker disabled type="datetime" placeholder="选择到期时间" />
        </el-form-item>
        <el-form-item label="备注" class="v2-order-form__wide">
          <el-input disabled type="textarea" :rows="3" placeholder="输入备注" />
        </el-form-item>
      </div>
    </el-form>

    <footer class="v2-form-shell__footer">
      <AppButton variant="primary" disabled>提交订单</AppButton>
    </footer>
  </section>
</template>

<script setup lang="ts">
import AppButton from '@/components/ui/AppButton.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
</script>
