<template>
  <V2PanelSection heading-id="order-edit-period" title="履约与锁定" step="03">
    <div class="v2-order-edit-grid">
      <el-form-item label="开通时间" prop="openedAt">
        <el-date-picker
          v-model="form.openedAt"
          type="datetime"
          format="YYYY-MM-DD HH:mm"
          value-format="YYYY-MM-DDTHH:mm"
          placeholder="选择开通时间"
        />
      </el-form-item>

      <el-form-item label="到期时间" prop="dueAt">
        <el-date-picker
          v-model="form.dueAt"
          type="datetime"
          format="YYYY-MM-DD HH:mm"
          value-format="YYYY-MM-DDTHH:mm"
          placeholder="选择到期时间"
        />
      </el-form-item>

      <el-form-item
        v-if="order?.operations.canEditCore && form.accountSource === 'inventory'"
        label="ID 锁范围"
      >
        <el-radio-group v-model="form.lockScope" aria-label="ID 锁范围">
          <el-radio-button
            v-for="option in lockScopeOptions"
            :key="option.value"
            :value="option.value"
            :disabled="form.accountDisposition === 'sold' && option.value !== 'global'"
          >
            {{ option.label }}
          </el-radio-button>
        </el-radio-group>
      </el-form-item>
    </div>
  </V2PanelSection>

  <V2PanelSection heading-id="order-edit-supplement" title="补充资料" step="04">
    <el-form-item label="客户网站账号">
      <el-input
        v-model="form.websiteAccount"
        maxlength="255"
        autocomplete="off"
        :disabled="form.clearWebsiteAccount"
        :placeholder="
          order?.hasWebsiteAccount
            ? `留空保持 ${order.displayWebsiteAccount || '已保存账号'}`
            : '选填'
        "
      />
      <el-checkbox
        v-if="order?.hasWebsiteAccount"
        v-model="form.clearWebsiteAccount"
        class="v2-order-edit-clear"
      >
        清空已保存的网站账号
      </el-checkbox>
    </el-form-item>

    <el-form-item label="备注">
      <el-input v-model="form.remark" type="textarea" :rows="3" maxlength="2000" show-word-limit />
    </el-form-item>
  </V2PanelSection>
</template>

<script setup lang="ts">
import V2PanelSection from '@/v2/components/V2PanelSection.vue';
import type { V2Order } from '../contracts';
import type { OrderEditForm } from './order-edit-form';

defineProps<{
  form: OrderEditForm;
  order: V2Order | null;
}>();

const lockScopeOptions = [
  { label: '当前业务', value: 'by_service' },
  { label: '整个 ID', value: 'global' }
];
</script>
