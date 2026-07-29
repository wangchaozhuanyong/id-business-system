<template>
  <section class="v2-records-page">
    <section class="v2-records-toolbar" aria-label="客户筛选">
      <el-input
        v-model="query.keyword"
        clearable
        placeholder="客户名称、手机号、微信"
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
        <el-table
          :aria-busy="loading"
          scrollbar-always-on
          show-overflow-tooltip
          class="v2-records-table"
          :data="items"
          row-key="id"
          @sort-change="handleSortChange"
        >
          <template #empty>
            <div class="v2-records-empty">
              <strong>暂无客户资料</strong>
              <span>当前筛选条件下没有数据</span>
              <AppButton v-if="canCreate" variant="primary" @click="openCreate">新增客户</AppButton>
            </div>
          </template>

          <el-table-column prop="name" label="客户" min-width="170" sortable="custom">
            <template #default="{ row }">
              <strong class="v2-table-cell">{{ row.name }}</strong>
            </template>
          </el-table-column>
          <el-table-column label="手机号" min-width="170">
            <template #default="{ row }">
              <span class="v2-sensitive-cell">
                <strong>{{ row.maskedPhone || '-' }}</strong>
                <AppButton
                  v-if="row.hasPhone && canRevealPhone"
                  icon-only
                  size="small"
                  variant="ghost"
                  title="查看完整手机号"
                  @click="openRevealPhone(row)"
                >
                  <el-icon><View /></el-icon>
                </AppButton>
              </span>
            </template>
          </el-table-column>
          <el-table-column prop="wechat" label="微信" min-width="145" sortable="custom">
            <template #default="{ row }">{{ row.wechat || '-' }}</template>
          </el-table-column>
          <el-table-column label="来源" min-width="120">
            <template #default="{ row }">{{ row.source?.name || '-' }}</template>
          </el-table-column>
          <el-table-column label="标签" min-width="170">
            <template #default="{ row }">
              <div v-if="row.tags.length" class="v2-record-tags" :title="optionNames(row.tags)">
                <el-tag v-for="tag in row.tags" :key="tag.id" effect="plain">{{ tag.name }}</el-tag>
              </div>
              <span v-else>-</span>
            </template>
          </el-table-column>
          <el-table-column label="常开业务" min-width="190">
            <template #default="{ row }">
              <div
                v-if="row.services.length"
                class="v2-record-tags"
                :title="optionNames(row.services)"
              >
                <el-tag
                  v-for="service in row.services"
                  :key="service.id"
                  type="info"
                  effect="plain"
                >
                  {{ service.name }}
                </el-tag>
              </div>
              <span v-else>-</span>
            </template>
          </el-table-column>
          <el-table-column prop="recordStatus" label="状态" width="100" sortable="custom">
            <template #default="{ row }">
              <el-tag :type="row.recordStatus === 'active' ? 'success' : 'info'" effect="plain">
                {{ row.recordStatus === 'active' ? '启用' : '停用' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="updatedAt" label="更新时间" min-width="165" sortable="custom">
            <template #default="{ row }">{{ formatDate(row.updatedAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="230" fixed="right">
            <template #default="{ row }">
              <div class="v2-record-actions">
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
              </div>
            </template>
          </el-table-column>
        </el-table>

        <div class="v2-records-mobile-list">
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
            <dl>
              <div>
                <dt>手机号</dt>
                <dd>{{ item.maskedPhone || '-' }}</dd>
              </div>
              <div>
                <dt>微信</dt>
                <dd>{{ item.wechat || '-' }}</dd>
              </div>
              <div>
                <dt>标签</dt>
                <dd>{{ item.tags.map((tag) => tag.name).join('、') || '-' }}</dd>
              </div>
              <div>
                <dt>常开业务</dt>
                <dd>{{ item.services.map((service) => service.name).join('、') || '-' }}</dd>
              </div>
            </dl>
            <footer>
              <AppButton
                v-if="item.hasPhone && canRevealPhone"
                size="small"
                variant="ghost"
                @click="openRevealPhone(item)"
              >
                查看手机号
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
      :confirm-disabled="!form.name.trim()"
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
        <el-form-item label="常开业务">
          <el-select
            v-model="form.serviceOptionIds"
            multiple
            collapse-tags
            collapse-tags-tooltip
            filterable
            placeholder="选择常开业务"
          >
            <el-option
              v-for="option in serviceOptions"
              :key="option.id"
              :label="selectorLabel(option)"
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

    <el-dialog v-model="revealDialogVisible" title="查看完整手机号" width="min(440px, 92vw)">
      <el-form
        class="v2-horizontal-form"
        label-position="left"
        label-width="88px"
        require-asterisk-position="right"
      >
        <el-form-item label="查看原因" required>
          <el-input v-model="revealForm.reason" maxlength="200" />
        </el-form-item>
        <el-form-item label="审批编号">
          <el-input v-model="revealForm.approvalId" placeholder="可选" />
        </el-form-item>
        <el-form-item v-if="revealForm.phone" label="完整手机号">
          <el-input v-model="revealForm.phone" readonly />
        </el-form-item>
      </el-form>
      <template #footer>
        <AppButton variant="ghost" @click="revealDialogVisible = false">关闭</AppButton>
        <AppButton
          variant="primary"
          :loading="revealing"
          :disabled="!revealForm.reason.trim()"
          @click="revealPhone"
        >
          查看
        </AppButton>
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
import {
  Delete,
  Edit,
  Plus,
  Refresh,
  Search,
  VideoPause,
  VideoPlay,
  View
} from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import V2FilterDisclosure from '@/v2/components/V2FilterDisclosure.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
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
  revealDialogVisible,
  revealing,
  formRef,
  query,
  form,
  revealForm,
  canCreate,
  canUpdate,
  canDelete,
  canRevealPhone,
  formRules,
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
  revealPhone,
  openDelete,
  confirmDelete,
  selectorLabel,
  formatDate
} = useCustomersPage();
</script>
