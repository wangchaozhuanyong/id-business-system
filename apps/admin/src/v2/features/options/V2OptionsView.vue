<template>
  <section class="v2-options-page">
    <V2AsyncRegion
      skeleton="settings"
      :loading="typesLoading || isInitialLoading"
      :resolved="Boolean(typeDefinitions.length)"
      :error="typesError"
      loading-title="正在加载选项类型"
      refreshing-title="正在更新选项类型"
      error-title="选项类型加载失败"
      @retry="loadInitialData"
    >
      <div class="v2-options-workspace">
        <aside class="v2-options-type-nav v2-options-type-strip" aria-label="选项类型">
          <button
            v-for="definition in typeDefinitions"
            :key="definition.type"
            type="button"
            :class="{ 'is-active': selectedType === definition.type }"
            :aria-pressed="selectedType === definition.type"
            @click="handleTypeChange(definition.type)"
          >
            <el-icon>
              <component :is="optionTypeIcons[definition.type]" />
            </el-icon>
            {{ definition.label }}
          </button>
        </aside>

        <div class="v2-options-content">
          <section class="v2-options-toolbar" aria-label="选项筛选">
            <el-input
              v-model="query.keyword"
              clearable
              :disabled="loading"
              placeholder="搜索选项名称或备注"
              aria-label="搜索选项"
              @keyup.enter="handleSearch"
              @clear="handleSearch"
            />

            <el-select
              v-model="query.status"
              clearable
              :disabled="loading"
              placeholder="全部状态"
              aria-label="筛选状态"
              @change="handleFilterChange"
            >
              <el-option label="启用" value="active" />
              <el-option label="停用" value="disabled" />
            </el-select>

            <div class="v2-options-toolbar__actions">
              <AppButton icon-only title="搜索" :disabled="loading" @click="handleSearch">
                <el-icon><Search /></el-icon>
              </AppButton>
              <AppButton icon-only title="刷新" :disabled="loading" @click="handleRefresh">
                <el-icon><Refresh /></el-icon>
              </AppButton>
              <AppButton variant="primary" :disabled="loading" @click="openCreate">
                <el-icon><Plus /></el-icon>
                新增{{ selectedTypeDefinition?.label ?? '选项' }}
              </AppButton>
            </div>
          </section>

          <div class="v2-options-context">
            <span>选项类型</span>
            <strong>{{ selectedTypeDefinition?.label ?? '选项' }}</strong>
            <FeatureHelp
              class="v2-options-context__help"
              :title="selectedTypeDefinition?.label ?? '选项'"
              text="系统固定属性只在对应记录中标识。"
              placement="right"
            />
          </div>

          <V2AsyncRegion
            skeleton="table"
            :loading="loading"
            :resolved="listResolved"
            :error="listError"
            :refreshing-title="`正在加载${selectedTypeDefinition?.label ?? '选项'}`"
            loading-title="正在加载选项"
            error-title="选项数据加载失败"
            @retry="handleRetry"
          >
            <section class="v2-options-list">
              <el-table
                :key="renderedType"
                :aria-busy="loading"
                scrollbar-always-on
                show-overflow-tooltip
                class="v2-options-table"
                :data="items"
                row-key="id"
                @sort-change="handleSortChange"
              >
                <template #empty>
                  <div class="v2-options-empty">
                    <strong>暂无{{ activeTypeDefinition?.label }}</strong>
                    <span>当前筛选条件下没有数据</span>
                    <AppButton variant="primary" @click="openCreate">
                      <el-icon><Plus /></el-icon>
                      新增{{ activeTypeDefinition?.label }}
                    </AppButton>
                  </div>
                </template>

                <el-table-column prop="name" label="选项名称" min-width="180" sortable="custom">
                  <template #default="{ row }">
                    <strong class="v2-table-cell">{{ row.name }}</strong>
                  </template>
                </el-table-column>
                <el-table-column prop="remark" label="备注" min-width="180" show-overflow-tooltip />

                <el-table-column
                  v-if="activeTypeDefinition?.parentType"
                  label="上级选项"
                  min-width="160"
                >
                  <template #default="{ row }">{{ row.parent?.name ?? '-' }}</template>
                </el-table-column>

                <el-table-column
                  v-if="activeTypeDefinition?.requiresCountry"
                  label="上级国家"
                  min-width="130"
                >
                  <template #default="{ row }">{{ row.country?.name ?? '-' }}</template>
                </el-table-column>

                <el-table-column
                  v-if="activeTypeDefinition?.supportsBusinessAmount"
                  label="业务金额"
                  min-width="130"
                >
                  <template #default="{ row }">
                    {{ formatDecimal(row.businessAmount ?? '0') }} {{ row.currencyCode ?? '-' }}
                  </template>
                </el-table-column>

                <el-table-column
                  v-if="activeTypeDefinition?.supportsCurrency"
                  label="默认货币"
                  min-width="110"
                >
                  <template #default="{ row }">{{ row.currencyCode ?? '-' }}</template>
                </el-table-column>

                <el-table-column
                  v-if="activeTypeDefinition?.supportsFees"
                  label="固定手续费"
                  min-width="130"
                >
                  <template #default="{ row }">¥{{ formatDecimal(row.fixedFee) }}</template>
                </el-table-column>

                <el-table-column
                  v-if="activeTypeDefinition?.supportsFees"
                  label="百分比手续费"
                  min-width="140"
                >
                  <template #default="{ row }">{{ formatDecimal(row.percentageFee) }}%</template>
                </el-table-column>

                <el-table-column prop="sortOrder" label="排序" width="90" sortable="custom" />

                <el-table-column label="属性" width="110">
                  <template #default="{ row }">
                    <el-tag v-if="row.isSystem" type="warning" effect="plain">系统固定</el-tag>
                    <span v-else>-</span>
                  </template>
                </el-table-column>

                <el-table-column prop="status" label="状态" width="100" sortable="custom">
                  <template #default="{ row }">
                    <el-tag :type="row.status === 'active' ? 'success' : 'info'" effect="plain">
                      {{ row.status === 'active' ? '启用' : '停用' }}
                    </el-tag>
                  </template>
                </el-table-column>

                <el-table-column
                  prop="updatedAt"
                  label="更新时间"
                  min-width="170"
                  sortable="custom"
                >
                  <template #default="{ row }">{{ formatDate(row.updatedAt) }}</template>
                </el-table-column>

                <V2TableActionColumn layout="double">
                  <template #default="{ row }">
                    <AppButton
                      size="small"
                      variant="ghost"
                      :disabled="row.isSystem"
                      :title="row.isSystem ? '系统固定选项不能编辑' : '编辑选项'"
                      @click="openEdit(row)"
                    >
                      <el-icon><Edit /></el-icon>
                      编辑
                    </AppButton>
                    <AppButton
                      size="small"
                      variant="danger"
                      :disabled="row.isSystem || row.childCount > 0"
                      :title="getDeleteTitle(row)"
                      @click="openDelete(row)"
                    >
                      <el-icon><Delete /></el-icon>
                      删除
                    </AppButton>
                  </template>
                </V2TableActionColumn>
              </el-table>

              <div class="v2-options-mobile-list">
                <article v-for="item in items" :key="item.id" class="v2-options-mobile-item">
                  <header>
                    <div class="v2-option-name">
                      <strong>{{ item.name }}</strong>
                      <span>{{ item.parent?.name || activeTypeDefinition?.label }}</span>
                    </div>
                    <el-tag :type="item.status === 'active' ? 'success' : 'info'" effect="plain">
                      {{ item.status === 'active' ? '启用' : '停用' }}
                    </el-tag>
                  </header>

                  <dl>
                    <div v-if="activeTypeDefinition?.requiresCountry">
                      <dt>上级国家</dt>
                      <dd>{{ item.country?.name ?? '-' }}</dd>
                    </div>
                    <div v-if="activeTypeDefinition?.supportsBusinessAmount">
                      <dt>业务金额</dt>
                      <dd>
                        {{ formatDecimal(item.businessAmount ?? '0') }}
                        {{ item.currencyCode ?? '-' }}
                      </dd>
                    </div>
                    <div v-if="activeTypeDefinition?.supportsCurrency">
                      <dt>默认货币</dt>
                      <dd>{{ item.currencyCode ?? '-' }}</dd>
                    </div>
                    <div v-if="activeTypeDefinition?.supportsFees">
                      <dt>固定手续费</dt>
                      <dd>¥{{ formatDecimal(item.fixedFee) }}</dd>
                    </div>
                    <div v-if="activeTypeDefinition?.supportsFees">
                      <dt>百分比手续费</dt>
                      <dd>{{ formatDecimal(item.percentageFee) }}%</dd>
                    </div>
                    <div>
                      <dt>排序</dt>
                      <dd>{{ item.sortOrder }}</dd>
                    </div>
                    <div>
                      <dt>更新时间</dt>
                      <dd>{{ formatDate(item.updatedAt) }}</dd>
                    </div>
                  </dl>

                  <footer>
                    <el-tag v-if="item.isSystem" type="warning" effect="plain">系统固定</el-tag>
                    <span v-else />
                    <div class="v2-options-actions">
                      <AppButton
                        size="small"
                        variant="ghost"
                        :disabled="item.isSystem"
                        @click="openEdit(item)"
                      >
                        编辑
                      </AppButton>
                      <AppButton
                        size="small"
                        variant="danger"
                        :disabled="item.isSystem || item.childCount > 0"
                        @click="openDelete(item)"
                      >
                        删除
                      </AppButton>
                    </div>
                  </footer>
                </article>

                <div v-if="!items.length" class="v2-options-empty">
                  <strong>暂无{{ activeTypeDefinition?.label }}</strong>
                  <span>当前筛选条件下没有数据</span>
                  <AppButton variant="primary" @click="openCreate">新增</AppButton>
                </div>
              </div>

              <footer class="v2-options-pagination">
                <span>共 {{ total }} 条</span>
                <el-pagination
                  v-model:current-page="query.page"
                  v-model:page-size="query.pageSize"
                  v-pagination-label
                  background
                  :disabled="loading"
                  :page-sizes="[10, 20, 50, 100]"
                  layout="sizes, prev, pager, next"
                  :total="total"
                  @current-change="handlePageChange"
                  @size-change="handlePageSizeChange"
                />
              </footer>
            </section>
          </V2AsyncRegion>
        </div>
      </div>
    </V2AsyncRegion>

    <V2OptionFormDrawer
      v-model="drawerVisible"
      v-model:type="form.type"
      v-model:name="form.name"
      v-model:parent-id="form.parentId"
      v-model:country-option-id="form.countryOptionId"
      v-model:business-amount="form.businessAmount"
      v-model:currency-code="form.currencyCode"
      v-model:fixed-fee="form.fixedFee"
      v-model:percentage-fee="form.percentageFee"
      v-model:sort-order="form.sortOrder"
      v-model:active="form.active"
      v-model:remark="form.remark"
      :editing-item="editingItem"
      :saving="saving"
      :submit-disabled="submitDisabled"
      :type-definitions="typeDefinitions"
      :form-type-definition="formTypeDefinition"
      :parent-type-label="parentTypeLabel"
      :parent-options="parentOptions"
      :parent-options-loading="parentOptionsLoading"
      :country-options="countryOptions"
      :country-options-loading="countryOptionsLoading"
      :currency-options="currencyOptions"
      :selected-service-currency="selectedServiceCurrency"
      :selector-label="getSelectorLabel"
      @type-change="handleFormTypeChange"
      @confirm="submitForm"
    />

    <V2ConfirmDialog
      v-model="deleteDialogVisible"
      title="删除选项"
      :message="`确认删除“${deletingItem?.name ?? ''}”？删除后不会出现在后续业务选择中。`"
      confirm-text="确认删除"
      danger
      :confirm-loading="deleting"
      @confirm="confirmDelete"
    />
  </section>
</template>

<script setup lang="ts">
import { Delete, Edit, Plus, Refresh, Search } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import FeatureHelp from '@/components/ui/FeatureHelp.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2OptionFormDrawer from './components/V2OptionFormDrawer.vue';
import { useOptionsPage } from './useOptionsPage';

const {
  typeDefinitions,
  optionTypeIcons,
  selectedType,
  renderedType,
  items,
  total,
  typesLoading,
  loading,
  typesError,
  listError,
  drawerVisible,
  saving,
  editingItem,
  parentOptions,
  parentOptionsLoading,
  countryOptions,
  countryOptionsLoading,
  deleteDialogVisible,
  deleting,
  deletingItem,
  query,
  listResolved,
  form,
  currencyOptions,
  activeTypeDefinition,
  selectedTypeDefinition,
  formTypeDefinition,
  parentTypeLabel,
  selectedServiceCurrency,
  submitDisabled,
  isInitialLoading,
  loadInitialData,
  handleTypeChange,
  handleSearch,
  handleFilterChange,
  handlePageSizeChange,
  handlePageChange,
  handleRefresh,
  handleRetry,
  handleSortChange,
  openCreate,
  openEdit,
  handleFormTypeChange,
  submitForm,
  openDelete,
  confirmDelete,
  getSelectorLabel,
  getDeleteTitle,
  formatDecimal,
  formatDate
} = useOptionsPage();
</script>

<style scoped src="./options.css"></style>
