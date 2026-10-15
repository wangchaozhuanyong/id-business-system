<template><V2RechargeProxyDetailDrawer :id="id" @close="$emit('close')" /></template>
<script setup lang="ts">
import { V2RechargeProxyDetailDrawer } from '@/v2/features/proxy-pool/public-api';
defineProps<{ id: string }>();
defineEmits<{ close: [] }>();
</script>
