<template>
  <dl>
    <div>
      <dt>手机号</dt>
      <dd>{{ customer.maskedPhone || '—' }}</dd>
    </div>
    <div>
      <dt>微信</dt>
      <dd>{{ customer.wechat || '—' }}</dd>
    </div>
    <div>
      <dt>QQ</dt>
      <dd>{{ customer.qq || '—' }}</dd>
    </div>
    <div>
      <dt>WhatsApp</dt>
      <dd>{{ customer.maskedWhatsapp || '—' }}</dd>
    </div>
    <div>
      <dt>标签</dt>
      <dd>{{ customer.tags.map((tag) => tag.name).join('、') || '—' }}</dd>
    </div>
    <div>
      <dt>历史开通业务</dt>
      <dd>
        <V2CustomerHistoryServices :services="customer.services" compact />
      </dd>
    </div>
    <div>
      <dt>操作人</dt>
      <dd>{{ operatorUsername(customer.createdBy) }}</dd>
    </div>
  </dl>
</template>

<script setup lang="ts">
import { operatorUsername } from '@/v2/utils/operator';
import type { V2Customer } from '../contracts';
import V2CustomerHistoryServices from './V2CustomerHistoryServices.vue';

defineProps<{
  customer: V2Customer;
}>();
</script>
