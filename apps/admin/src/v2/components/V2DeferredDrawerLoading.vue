<template>
  <el-drawer
    :model-value="modelValue"
    title="正在打开操作面板"
    size="min(680px, 94vw)"
    destroy-on-close
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <V2AsyncRegion
      variant="section"
      skeleton="detail"
      phase="initial-loading"
      loading-title="正在准备操作面板"
    />
  </el-drawer>
</template>

<script setup lang="ts">
import V2AsyncRegion from './V2AsyncRegion.vue';
defineOptions({ inheritAttrs: false });
defineProps<{ modelValue: boolean }>();
defineEmits<{ 'update:modelValue': [value: boolean] }>();
</script>
