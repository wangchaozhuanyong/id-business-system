<template>
  <dl>
    <div v-v2-column-visibility="[v2TableSchemas.customers.main.id, '手机号']">
      <dt>手机号</dt>
      <dd>{{ customer.maskedPhone || '—' }}</dd>
    </div>
    <div v-v2-column-visibility="[v2TableSchemas.customers.main.id, 'wechat']">
      <dt>微信</dt>
      <dd>{{ customer.wechat || '—' }}</dd>
    </div>
    <div v-v2-column-visibility="[v2TableSchemas.customers.main.id, 'qq']">
      <dt>QQ</dt>
      <dd>{{ customer.qq || '—' }}</dd>
    </div>
    <div v-v2-column-visibility="[v2TableSchemas.customers.main.id, 'WhatsApp']">
      <dt>WhatsApp</dt>
      <dd>{{ customer.maskedWhatsapp || '—' }}</dd>
    </div>
    <div v-v2-column-visibility="[v2TableSchemas.customers.main.id, '标签']">
      <dt>标签</dt>
      <dd>{{ customer.tags.map((tag) => tag.name).join('、') || '—' }}</dd>
    </div>
    <div v-v2-column-visibility="[v2TableSchemas.customers.main.id, '历史开通业务']">
      <dt>历史开通业务</dt>
      <dd>
        <V2CustomerHistoryServices :services="customer.services" compact />
      </dd>
    </div>
    <div v-v2-column-visibility="[v2TableSchemas.customers.main.id, '操作人']">
      <dt>操作人</dt>
      <dd>{{ operatorUsername(customer.createdBy) }}</dd>
    </div>
  </dl>
</template>

<script setup lang="ts">
import { operatorUsername } from '@/v2/utils/operator';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import type { V2Customer } from '../contracts';
import V2CustomerHistoryServices from './V2CustomerHistoryServices.vue';

defineProps<{
  customer: V2Customer;
}>();
</script>
