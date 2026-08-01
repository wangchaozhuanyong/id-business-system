<template>
  <section class="v2-records-page">
    <section class="v2-records-toolbar" aria-label="客户筛选">
      <el-input
        v-model="query.keyword"
        clearable
        placeholder="客户名称、手机、微信、QQ、WhatsApp"
        aria-label="搜索客户"
        @keyup.enter="handleSearch"
        @clear="handleSearch"
      />
      <el-select
        v-model="query.sourceOptionId"
        clearable
        placeholder="全部来源"
        aria-label="筛选客户来源"
        @change="handleFilterChange"
      >
        <el-option
          v-for="option in sourceOptions"
          :key="option.id"
          :label="option.name"
          :value="option.id"
        />
      </el-select>
      <V2FilterDisclosure>
        <el-select
          v-model="query.tagOptionId"
          clearable
          placeholder="全部标签"
          aria-label="筛选客户标签"
          @change="handleFilterChange"
        >
          <el-option
            v-for="option in tagOptions"
            :key="option.id"
            :label="option.name"
            :value="option.id"
          />
        </el-select>
        <el-select
          v-model="query.serviceOptionId"
          clearable
          filterable
          placeholder="全部历史业务"
          aria-label="筛选历史开通业务"
          @change="handleFilterChange"
        >
          <el-option
            v-for="option in serviceOptions"
            :key="option.id"
            :label="selectorLabel(option)"
            :value="option.id"
          />
        </el-select>
        <el-select
          v-model="query.recordStatus"
          clearable
          placeholder="全部状态"
          aria-label="筛选资料状态"
          @change="handleFilterChange"
        >
          <el-option label="启用" value="active" />
          <el-option label="停用" value="disabled" />
        </el-select>
      </V2FilterDisclosure>
      <div class="v2-records-toolbar__actions">
        <AppButton icon-only title="搜索" @click="handleSearch">
          <el-icon><Search /></el-icon>
        </AppButton>
        <AppButton icon-only title="刷新" :disabled="loading" @click="loadCustomers">
          <el-icon><Refresh /></el-icon>
        </AppButton>
        <AppButton v-if="canCreate" variant="primary" @click="openCreate">
          <el-icon><Plus /></el-icon>
          新增客户
        </AppButton>
      </div>
    </section>

    <V2AsyncRegion
      skeleton="table"
      :loading="loading || isInitialLoading"
      :resolved="hasLoadedOnce"
      :error="listError"
      loading-title="正在加载客户资料"
      refreshing-title="正在更新客户资料"
      error-title="客户资料加载失败"
      @retry="loadCustomers"
    >
      <section class="v2-records-list">
        <V2Table
          :schema="v2TableSchemas.customers.main"
          :aria-busy="loading"
          scrollbar-always-on
          show-overflow-tooltip
          class="v2-records-table"
          :data="items"
          @sort-change="handleSortChange"
        >
          <template #empty>
            <div class="v2-records-empty">
              <strong>暂无客户资料</strong>
              <span>当前筛选条件下没有数据</span>
              <AppButton v-if="canCreate" variant="primary" @click="openCreate">新增客户</AppButton>
            </div>
          </template>

          <V2TableColumn
            :definition="v2TableSchemas.customers.main.columns[0]"
            prop="name"
            sortable="custom"
          >
            <template #default="{ row }">
              <strong class="v2-table-cell">{{ row.name }}</strong>
            </template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.customers.main.columns[1]">
            <template #default="{ row }">
              <V2CustomerSensitiveContactCell
                :masked-value="row.maskedPhone"
                :has-value="row.hasPhone"
                :can-reveal="canRevealContact"
                reveal-title="查看完整手机号"
                @reveal="openRevealPhone(row)"
              />
            </template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.customers.main.columns[2]"
            prop="wechat"
            sortable="custom"
          >
            <template #default="{ row }">{{ row.wechat || '—' }}</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.customers.main.columns[3]" prop="qq">
            <template #default="{ row }">{{ row.qq || '—' }}</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.customers.main.columns[4]">
            <template #default="{ row }">
              <V2CustomerSensitiveContactCell
                :masked-value="row.maskedWhatsapp"
                :has-value="row.hasWhatsapp"
                :can-reveal="canRevealContact"
                reveal-title="查看完整 WhatsApp"
                @reveal="openRevealWhatsapp(row)"
              />
            </template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.customers.main.columns[5]">
            <template #default="{ row }">{{ row.source?.name || '—' }}</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.customers.main.columns[6]">
            <template #default="{ row }">
              <div v-if="row.tags.length" class="v2-record-tags" :title="optionNames(row.tags)">
                <el-tag v-for="tag in row.tags" :key="tag.id" effect="plain">{{ tag.name }}</el-tag>
              </div>
              <span v-else>—</span>
            </template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.customers.main.columns[7]">
            <template #default="{ row }">
              <V2CustomerHistoryServices :services="row.services" />
            </template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.customers.main.columns[8]"
            prop="recordStatus"
            sortable="custom"
          >
            <template #default="{ row }">
              <el-tag :type="row.recordStatus === 'active' ? 'success' : 'info'" effect="plain">
                {{ row.recordStatus === 'active' ? '启用' : '停用' }}
              </el-tag>
            </template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.customers.main.columns[9]"
            prop="updatedAt"
            sortable="custom"
          >
            <template #default="{ row }">{{ formatDate(row.updatedAt) }}</template>
          </V2TableColumn>
          <V2TableActionColumn :definition="v2TableSchemas.customers.main.columns[10]">
            <template #default="{ row }">
              <AppButton v-if="canUpdate" size="small" variant="ghost" @click="openEdit(row)">
                <el-icon><Edit /></el-icon>
                编辑
              </AppButton>
              <AppButton
                v-if="canUpdate"
                size="small"
                :variant="row.recordStatus === 'active' ? 'soft' : 'success'"
                @click="toggleStatus(row)"
              >
                <el-icon>
                  <VideoPause v-if="row.recordStatus === 'active'" />
                  <VideoPlay v-else />
                </el-icon>
                {{ row.recordStatus === 'active' ? '停用' : '启用' }}
              </AppButton>
              <AppButton v-if="canDelete" size="small" variant="danger" @click="openDelete(row)">
                <el-icon><Delete /></el-icon>
                删除
              </AppButton>
            </template>
          </V2TableActionColumn>
        </V2Table>

        <div class="v2-records-mobile-list" :data-mobile-for="v2TableSchemas.customers.main.id">
          <article v-for="item in items" :key="item.id" class="v2-records-mobile-item">
            <header>
              <div>
                <strong>{{ item.name }}</strong>
                <span>{{ item.source?.name || '未设置来源' }}</span>
              </div>
              <el-tag :type="item.recordStatus === 'active' ? 'success' : 'info'" effect="plain">
                {{ item.recordStatus === 'active' ? '启用' : '停用' }}
              </el-tag>
            </header>
            <V2CustomerMobileDetails :customer="item" />
            <footer>
              <AppButton
                v-if="item.hasPhone && canRevealContact"
                size="small"
                variant="ghost"
                @click="openRevealPhone(item)"
              >
                查看手机号
              </AppButton>
              <AppButton
                v-if="item.hasWhatsapp && canRevealContact"
                size="small"
                variant="ghost"
                @click="openRevealWhatsapp(item)"
              >
                查看 WhatsApp
              </AppButton>
              <div class="v2-record-actions">
                <AppButton v-if="canUpdate" size="small" variant="ghost" @click="openEdit(item)">
                  编辑
                </AppButton>
                <AppButton v-if="canUpdate" size="small" variant="soft" @click="toggleStatus(item)">
                  {{ item.recordStatus === 'active' ? '停用' : '启用' }}
                </AppButton>
                <AppButton v-if="canDelete" size="small" variant="danger" @click="openDelete(item)">
                  删除
                </AppButton>
              </div>
            </footer>
          </article>
          <div v-if="!items.length" class="v2-records-empty">
            <strong>暂无客户资料</strong>
            <span>当前筛选条件下没有数据</span>
            <AppButton v-if="canCreate" variant="primary" @click="openCreate">新增客户</AppButton>
          </div>
        </div>

        <footer class="v2-records-pagination">
          <span>共 {{ total }} 条</span>
          <el-pagination
            v-model:current-page="query.page"
            v-model:page-size="query.pageSize"
            v-pagination-label
            background
            :page-sizes="[10, 20, 50, 100]"
            layout="sizes, prev, pager, next"
            :total="total"
            @current-change="handlePageChange"
            @size-change="handlePageSizeChange"
          />
        </footer>
      </section>
    </V2AsyncRegion>

    <V2FormDrawer
      v-model="drawerVisible"
      :title="editingItem ? '编辑客户' : '新增客户'"
      :confirm-text="editingItem ? '保存修改' : '确认新增'"
      :confirm-loading="saving"
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
        <el-form-item label="客户来源">
          <el-select v-model="form.sourceOptionId" clearable filterable placeholder="选择客户来源">
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
        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" :rows="3" maxlength="500" />
        </el-form-item>
      </el-form>
    </V2FormDrawer>

    <el-dialog
      v-model="revealDialogVisible"
      :title="revealField === 'phone' ? '查看完整手机号' : '查看完整 WhatsApp'"
      width="min(440px, 92vw)"
    >
      <el-form
        ref="revealFormRef"
        class="v2-horizontal-form"
        :model="revealForm"
        :rules="revealRules"
        label-position="left"
        label-width="88px"
        require-asterisk-position="right"
        status-icon
        scroll-to-error
        :scroll-into-view-options="{ behavior: 'smooth', block: 'center' }"
      >
        <el-form-item label="查看原因" prop="reason">
          <el-input v-model="revealForm.reason" maxlength="200" />
        </el-form-item>
        <el-form-item label="审批编号">
          <el-input v-model="revealForm.approvalId" placeholder="可选" />
        </el-form-item>
        <el-form-item
          v-if="revealForm.value"
          :label="revealField === 'phone' ? '完整手机号' : '完整 WhatsApp'"
        >
          <el-input v-model="revealForm.value" readonly />
        </el-form-item>
      </el-form>
      <template #footer>
        <AppButton variant="ghost" @click="revealDialogVisible = false">关闭</AppButton>
        <AppButton variant="primary" :loading="revealing" @click="revealContact"> 查看 </AppButton>
      </template>
    </el-dialog>

    <V2ConfirmDialog
      v-model="deleteDialogVisible"
      title="删除客户"
      :message="`确认删除“${deletingItem?.name ?? ''}”？该操作会软删除资料。`"
      confirm-text="确认删除"
      danger
      :confirm-loading="deleting"
      @confirm="confirmDelete"
    />
  </section>
</template>

<script setup lang="ts">
import V2Table from '@/v2/components/V2Table.vue';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import {
  Delete,
  Edit,
  Plus,
  Refresh,
  Search,
  VideoPause,
  VideoPlay
} from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import V2FilterDisclosure from '@/v2/components/V2FilterDisclosure.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2CustomerHistoryServices from './components/V2CustomerHistoryServices.vue';
import V2CustomerMobileDetails from './components/V2CustomerMobileDetails.vue';
import V2CustomerSensitiveContactCell from './components/V2CustomerSensitiveContactCell.vue';
import { useCustomersPage } from './useCustomersPage';
import '@/v2/styles/records.css';

const {
  items,
  total,
  loading,
  listError,
  sourceOptions,
  tagOptions,
  serviceOptions,
  drawerVisible,
  saving,
  editingItem,
  deletingItem,
  deleteDialogVisible,
  deleting,
  revealField,
  revealDialogVisible,
  revealing,
  formRef,
  revealFormRef,
  query,
  form,
  revealForm,
  canCreate,
  canUpdate,
  canDelete,
  canRevealContact,
  formRules,
  revealRules,
  hasLoadedOnce,
  isInitialLoading,
  loadCustomers,
  handleSearch,
  handleFilterChange,
  handlePageSizeChange,
  handlePageChange,
  optionNames,
  handleSortChange,
  openCreate,
  openEdit,
  submitForm,
  toggleStatus,
  openRevealPhone,
  openRevealWhatsapp,
  revealContact,
  openDelete,
  confirmDelete,
  selectorLabel,
  formatDate
} = useCustomersPage();
</script>
