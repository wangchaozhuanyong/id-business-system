<template>
  <V2FormDrawer
    v-model="page.drawerVisible"
    :title="page.editingItem ? '编辑 ID' : '新增 ID'"
    :confirm-text="page.editingItem ? '保存修改' : '确认新增'"
    :confirm-loading="page.saving"
    :confirm-disabled="page.formDisabled"
    size="min(620px, 96vw)"
    @confirm="page.submitForm"
  >
    <el-form
      class="v2-horizontal-form"
      label-position="left"
      label-width="112px"
      require-asterisk-position="right"
      autocomplete="off"
    >
      <el-form-item label="ID 账号" required>
        <el-input
          v-model="page.form.appleId"
          name="v2-apple-id-record"
          autocomplete="off"
          :placeholder="page.editingItem ? '留空表示不修改' : '输入 Apple ID'"
        />
      </el-form-item>
      <el-form-item label="ID 密码">
        <el-input
          v-model="page.form.password"
          type="password"
          name="v2-apple-id-record-password"
          autocomplete="new-password"
          show-password
          :placeholder="page.editingItem ? '留空表示不修改' : '输入密码'"
        />
      </el-form-item>
      <el-form-item label="手机号码">
        <el-input
          v-model="page.form.phone"
          name="v2-apple-id-record-phone"
          autocomplete="off"
          :placeholder="page.editingItem ? '留空表示不修改' : '输入手机号'"
        />
      </el-form-item>
      <el-form-item label="密保">
        <el-input
          v-model="page.form.securityInfo"
          name="v2-apple-id-record-security"
          autocomplete="off"
          type="textarea"
          :rows="3"
          :placeholder="page.editingItem ? '留空表示不修改' : '输入密保资料'"
        />
      </el-form-item>
      <div class="v2-record-form-grid">
        <el-form-item label="国家" required>
          <el-select v-model="page.form.countryOptionId" filterable placeholder="选择国家">
            <el-option
              v-for="option in page.countryOptions"
              :key="option.id"
              :label="option.name"
              :value="option.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="ID 状态" required>
          <el-select v-model="page.form.statusOptionId" filterable placeholder="选择 ID 状态">
            <el-option
              v-for="option in page.formStatusOptions"
              :key="option.id"
              :label="option.name"
              :value="option.id"
            />
          </el-select>
        </el-form-item>
      </div>
      <el-form-item label="ID 供应商">
        <el-select
          v-model="page.form.supplierOptionId"
          clearable
          filterable
          placeholder="选择供应商"
        >
          <el-option
            v-for="option in page.supplierOptions"
            :key="option.id"
            :label="option.name"
            :value="option.id"
          />
        </el-select>
      </el-form-item>
      <div class="v2-record-form-grid">
        <el-form-item label="余额" :error="page.balanceInputError">
          <el-input
            v-model="page.form.currentBalance"
            inputmode="decimal"
            placeholder="0"
            :disabled="!page.canAdjustBalance"
            @input="page.updateBalanceCostFromRate"
          />
        </el-form-item>
        <el-form-item label="汇率" :error="page.exchangeRateInputError">
          <el-input
            v-model="page.form.exchangeRate"
            inputmode="decimal"
            placeholder="例如 5.7"
            :disabled="!page.canAdjustBalance"
            @input="page.updateBalanceCostFromRate"
          />
        </el-form-item>
        <el-form-item label="人民币成本" :error="page.balanceCostInputError">
          <el-input
            v-model="page.form.balanceCostAmount"
            inputmode="decimal"
            placeholder="0"
            readonly
          />
        </el-form-item>
        <el-form-item label="ID购买成本">
          <el-input-number
            v-model="page.form.purchaseCost"
            :min="0"
            :max="99999999"
            :precision="4"
            :step="1"
            controls-position="right"
          />
        </el-form-item>
      </div>
      <el-form-item
        v-if="page.editingItem && page.balanceChanged"
        label="余额修正原因"
        required
        :error="
          page.form.balanceAdjustmentReason.trim().length > 0 &&
          page.form.balanceAdjustmentReason.trim().length < 2
            ? '至少输入 2 个字'
            : ''
        "
      >
        <el-input
          v-model="page.form.balanceAdjustmentReason"
          type="textarea"
          :rows="2"
          maxlength="200"
          show-word-limit
          placeholder="说明本次余额或人民币成本修正原因"
        />
      </el-form-item>
      <el-form-item label="资料状态">
        <el-switch v-model="page.form.active" active-text="启用" inactive-text="停用" />
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="page.form.remark" type="textarea" :rows="3" maxlength="500" />
      </el-form-item>
    </el-form>
  </V2FormDrawer>

  <el-dialog
    v-model="page.importDialogVisible"
    title="导入 ID 资料"
    width="min(680px, 94vw)"
    destroy-on-close
  >
    <div class="v2-account-import-summary">
      <strong>{{ page.importFilename }}</strong>
      <div>
        <el-tag effect="plain">共 {{ page.importSourceRowCount }} 行</el-tag>
        <el-tag type="success" effect="plain">可导入 {{ page.importRows.length }} 行</el-tag>
        <el-tag v-if="page.importFailures.length" type="danger" effect="plain">
          失败 {{ page.importFailures.length }} 行
        </el-tag>
      </div>
    </div>

    <el-alert
      v-if="page.importCompleted"
      type="success"
      :title="`导入完成：成功 ${page.importSuccessCount} 条`"
      :closable="false"
      show-icon
    />

    <el-table
      v-if="page.importFailures.length"
      show-overflow-tooltip
      :data="page.importFailures"
      max-height="300"
      size="small"
      class="v2-account-import-errors"
    >
      <el-table-column prop="rowNumber" label="行号" width="80" />
      <el-table-column prop="reason" label="未导入原因" min-width="300" />
    </el-table>

    <template #footer>
      <AppButton variant="ghost" @click="page.importDialogVisible = false">
        {{ page.importCompleted ? '关闭' : '取消' }}
      </AppButton>
      <AppButton
        v-if="!page.importCompleted"
        variant="primary"
        :loading="page.importing"
        :disabled="!page.importRows.length"
        @click="page.confirmImport"
      >
        导入 {{ page.importRows.length }} 条
      </AppButton>
    </template>
  </el-dialog>

  <el-dialog
    v-model="page.revealDialogVisible"
    :title="`查看敏感资料 · ${page.revealTarget?.appleIdMasked ?? ''}`"
    width="min(480px, 92vw)"
    destroy-on-close
  >
    <el-alert
      type="warning"
      title="完整资料仅供必要业务核对，系统会记录查看人、字段和原因。"
      :closable="false"
      show-icon
    />
    <el-form
      class="v2-account-reveal-form v2-horizontal-form"
      label-position="left"
      label-width="88px"
      require-asterisk-position="right"
    >
      <el-form-item label="查看字段" required>
        <el-select v-model="page.revealForm.field" @change="page.revealForm.value = ''">
          <el-option
            v-for="option in page.revealFieldOptions"
            :key="option.value"
            :label="option.label"
            :value="option.value"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="查看原因" required>
        <el-input
          v-model="page.revealForm.reason"
          type="textarea"
          :rows="3"
          maxlength="200"
          show-word-limit
          placeholder="例如：客户续费登录核对"
        />
      </el-form-item>
      <el-form-item label="审批编号">
        <el-input v-model="page.revealForm.approvalId" placeholder="可选" />
      </el-form-item>
      <el-form-item v-if="page.revealForm.value" label="完整资料">
        <el-input v-model="page.revealForm.value" type="textarea" :rows="3" readonly />
      </el-form-item>
    </el-form>
    <template #footer>
      <AppButton variant="ghost" @click="page.revealDialogVisible = false">关闭</AppButton>
      <AppButton
        variant="danger"
        :loading="page.revealing"
        :disabled="!page.revealForm.field || !page.revealForm.reason.trim()"
        @click="page.revealSecret"
      >
        查看完整资料
      </AppButton>
    </template>
  </el-dialog>

  <V2ConfirmDialog
    v-model="page.deleteDialogVisible"
    title="删除 ID"
    :message="`确认删除“${page.deletingItem?.appleIdMasked || ''}”？该操作会软删除资料。`"
    confirm-text="确认删除"
    danger
    :confirm-loading="page.deleting"
    @confirm="page.confirmDelete"
  />
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import type { useAccountsPage } from '../useAccountsPage';

type AccountsPage = UnwrapNestedRefs<ReturnType<typeof useAccountsPage>>;

defineProps<{
  page: AccountsPage;
}>();
</script>
