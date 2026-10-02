<template>
  <section class="v2-theme-skin-sample" data-skin-sample>
    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-position="left"
      label-width="88px"
      require-asterisk-position="right"
    >
      <el-form-item label="业务名称" data-skin-input required>
        <el-input v-model="form.name" />
      </el-form-item>
      <el-form-item label="业务状态">
        <el-select v-model="form.status" data-skin-select>
          <el-option label="启用" value="enabled" />
          <el-option label="停用" value="disabled" />
        </el-select>
      </el-form-item>
      <el-form-item label="停用资料" data-skin-disabled>
        <el-input v-model="form.disabled" disabled />
      </el-form-item>
      <el-form-item label="必填资料" prop="invalid" data-skin-invalid>
        <el-input v-model="form.invalid" />
      </el-form-item>
    </el-form>
    <V2Table :schema="fixtureSchemas.skinSample" :data="rows" :show-column-settings="false" border>
      <V2TableColumn :definition="fixtureSchemas.skinSample.columns[0]" prop="label" />
      <V2TableColumn :definition="fixtureSchemas.skinSample.columns[1]">
        <template #default>
          <el-tag type="success" effect="plain">已完成</el-tag>
        </template>
      </V2TableColumn>
    </V2Table>
    <el-pagination background layout="prev, pager, next" :page-size="10" :total="20" />
  </section>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import { defineV2TableSchema } from '@/v2/components/tableSystem';

const form = reactive({
  name: '主题验收资料',
  status: 'enabled',
  disabled: '停用资料',
  invalid: ''
});
const formRef = ref<FormInstance>();
const rules: FormRules = {
  invalid: [{ required: true, message: '请输入必填资料', trigger: 'blur' }]
};
onMounted(() => {
  void formRef.value?.validateField('invalid').catch(() => undefined);
});
const rows = [{ id: 'skin-sample', label: '验收记录' }];
const fixtureSchemas = {
  skinSample: defineV2TableSchema({
    id: 'fixture.theme-skin-sample',
    feature: 'theme-components-fixture',
    role: 'embedded',
    mobileMode: 'scroll',
    rowKey: { kind: 'path', value: 'id' },
    columns: [
      { key: 'label', label: '业务资料', kind: 'text', widthPreset: 'compact' },
      { key: 'status', label: '状态', kind: 'status', widthPreset: 'compact' }
    ]
  })
};
</script>

<style scoped>
.v2-theme-skin-sample {
  display: grid;
  min-width: 0;
  gap: 18px;
}

.v2-theme-skin-sample :deep(.el-select) {
  width: 100%;
}

.v2-theme-skin-sample :deep(.el-form-item:last-child) {
  margin-bottom: 0;
}
</style>
