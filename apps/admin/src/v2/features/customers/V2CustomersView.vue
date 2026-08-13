<template>
  <section class="v2-records-page">
    <V2CustomersOverview :page="page" />
    <V2CustomersToolbar :page="page" />
    <V2CustomersList :page="page" />

    <V2FormDrawer
      v-model="drawerVisible"
      :title="editingItem ? '编辑客户' : '新增客户'"
      eyebrow="客户资料"
      description="维护联系方式、客户分类和资料状态"
      :confirm-text="editingItem ? '保存修改' : '确认新增'"
      :confirm-loading="saving"
      :dirty="customerFormDirty"
      @confirm="submitForm"
    >
      <el-form
        ref="formRef"
        class="v2-horizontal-form"
        :model="form"
        :rules="formRules"
        label-position="left"
        label-width="96px"
        require-asterisk-position="right"
        status-icon
        scroll-to-error
        :scroll-into-view-options="{ behavior: 'smooth', block: 'center' }"
      >
        <V2PanelSection heading-id="customer-contact-section" title="身份与联系" step="01">
          <el-form-item label="客户名称" prop="name">
            <el-input v-model="form.name" maxlength="120" show-word-limit />
          </el-form-item>
          <el-form-item label="手机号">
            <el-input
              v-model="form.phone"
              :disabled="form.clearPhone"
              :placeholder="editingItem?.hasPhone ? '留空保持原手机号' : '请输入手机号'"
            />
            <el-checkbox v-if="editingItem?.hasPhone" v-model="form.clearPhone">
              清空已保存手机号
            </el-checkbox>
          </el-form-item>
          <el-form-item label="微信">
            <el-input v-model="form.wechat" maxlength="120" />
          </el-form-item>
          <el-form-item label="QQ">
            <el-input v-model="form.qq" maxlength="120" />
          </el-form-item>
          <el-form-item label="WhatsApp">
            <el-input
              v-model="form.whatsapp"
              :disabled="form.clearWhatsapp"
              :placeholder="editingItem?.hasWhatsapp ? '留空保持原 WhatsApp' : '请输入 WhatsApp'"
            />
            <el-checkbox v-if="editingItem?.hasWhatsapp" v-model="form.clearWhatsapp">
              清空已保存 WhatsApp
            </el-checkbox>
          </el-form-item>
        </V2PanelSection>
        <V2PanelSection heading-id="customer-classification-section" title="分类与状态" step="02">
          <el-form-item label="客户来源">
            <el-select
              v-model="form.sourceOptionId"
              clearable
              filterable
              placeholder="选择客户来源"
            >
              <el-option
                v-for="option in sourceOptions"
                :key="option.id"
                :label="option.name"
                :value="option.id"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="客户标签">
            <el-select
              v-model="form.tagOptionIds"
              multiple
              collapse-tags
              collapse-tags-tooltip
              filterable
              placeholder="选择客户标签"
            >
              <el-option
                v-for="option in tagOptions"
                :key="option.id"
                :label="option.name"
                :value="option.id"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="资料状态">
            <el-switch v-model="form.active" active-text="启用" inactive-text="停用" />
          </el-form-item>
        </V2PanelSection>
        <V2PanelSection heading-id="customer-remark-section" title="补充说明" step="03">
          <el-form-item label="备注">
            <el-input v-model="form.remark" type="textarea" :rows="3" maxlength="500" />
          </el-form-item>
        </V2PanelSection>
      </el-form>
    </V2FormDrawer>

    <V2CustomerSensitiveAccessDialog :page="page" />

    <V2ConfirmDialog
      v-model="deleteDialogVisible"
      title="删除客户"
      message=""
      confirm-text="确认删除"
      danger
      :confirm-loading="deleting"
      :confirm-disabled-reason="deleteConfirmDisabledReason"
      @confirm="confirmDelete"
    >
      <div class="v2-delete-preview" aria-live="polite">
        <p>确认删除“{{ deletingItem?.name ?? '' }}”？该操作会软删除资料。</p>
        <p v-if="deletePreviewLoading" class="v2-delete-preview__status">正在核对关联数据…</p>
        <dl v-else-if="deletePreview" class="v2-delete-preview__counts">
          <div v-for="item in deleteImpactRows" :key="item.label">
            <dt>{{ item.label }}</dt>
            <dd>{{ item.value }}</dd>
          </div>
        </dl>
        <p v-if="deletePreview?.blockingReasons.length" class="v2-delete-preview__blocking">
          {{ deletePreview.blockingReasons.join('；') }}
        </p>
      </div>
    </V2ConfirmDialog>
  </section>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2PanelSection from '@/v2/components/V2PanelSection.vue';
import { useV2FormSnapshot } from '@/v2/composables/useV2FormSnapshot';
import V2CustomerSensitiveAccessDialog from './components/V2CustomerSensitiveAccessDialog.vue';
import V2CustomersList from './components/V2CustomersList.vue';
import V2CustomersOverview from './components/V2CustomersOverview.vue';
import V2CustomersToolbar from './components/V2CustomersToolbar.vue';
import { useCustomersPage } from './useCustomersPage';
import '@/v2/styles/records.css';
import '@/v2/styles/customers.css';

const customersPage = useCustomersPage();
const page = reactive(customersPage);
const { dirty: customerFormDirty } = useV2FormSnapshot(
  () => customersPage.drawerVisible.value,
  () => customersPage.form
);
const {
  sourceOptions,
  tagOptions,
  drawerVisible,
  saving,
  editingItem,
  deletingItem,
  deleteDialogVisible,
  deleting,
  deletePreview,
  deletePreviewLoading,
  deleteConfirmDisabledReason,
  deleteImpactRows,
  formRef,
  form,
  formRules,
  submitForm,
  confirmDelete
} = customersPage;
</script>
