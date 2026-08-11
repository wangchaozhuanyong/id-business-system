<template>
  <V2AsyncRegion
    skeleton="table"
    :phase="page.queryPhase"
    :previous-data="page.isParameterTransition"
    :error="page.listError"
    loading-title="正在加载客户资料"
    refreshing-title="正在更新客户资料"
    error-title="客户资料加载失败"
    @retry="page.loadCustomers"
  >
    <section ref="listRef" class="v2-records-list" :style="listFrameStyle">
      <header class="v2-customer-list__header">
        <V2SectionHeading
          title="客户资料列表"
          help="联系方式默认脱敏；固定操作列保留编辑、状态和软删除入口。"
        >
          <template #actions>
            <V2TableColumnSettings inline :schema="v2TableSchemas.customers.main" />
            <span>本页 {{ page.items.length }} 条</span>
            <span aria-hidden="true">·</span>
            <strong>共 {{ page.total }} 条</strong>
          </template>
        </V2SectionHeading>
      </header>

      <V2Table
        :schema="v2TableSchemas.customers.main"
        :show-column-settings="false"
        :aria-busy="page.loading"
        scrollbar-always-on
        show-overflow-tooltip
        class="v2-records-table"
        :data="page.items"
        @sort-change="page.handleSortChange"
      >
        <template #empty>
          <div class="v2-records-empty">
            <strong>暂无客户资料</strong>
            <span>当前筛选条件下没有数据</span>
            <AppButton v-if="page.canCreate" variant="primary" @click="page.openCreate">
              新增客户
            </AppButton>
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
              :can-reveal="page.canRevealContact && !page.isParameterTransition"
              reveal-title="查看完整手机号"
              @reveal="page.openRevealPhone(row)"
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
              :can-reveal="page.canRevealContact && !page.isParameterTransition"
              reveal-title="查看完整 WhatsApp"
              @reveal="page.openRevealWhatsapp(row)"
            />
          </template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.customers.main.columns[5]">
          <template #default="{ row }">{{ row.source?.name || '—' }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.customers.main.columns[6]">
          <template #default="{ row }">
            <div v-if="row.tags.length" class="v2-record-tags" :title="page.optionNames(row.tags)">
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
        <V2TableColumn :definition="v2TableSchemas.customers.main.columns[9]">
          <template #default="{ row }">{{ operatorUsername(row.createdBy) }}</template>
        </V2TableColumn>
        <V2TableColumn
          :definition="v2TableSchemas.customers.main.columns[10]"
          prop="updatedAt"
          sortable="custom"
        >
          <template #default="{ row }">{{ page.formatDate(row.updatedAt) }}</template>
        </V2TableColumn>
        <V2TableActionColumn :definition="v2TableSchemas.customers.main.columns[11]">
          <template #default="{ row }">
            <AppButton
              v-if="page.canUpdate"
              size="small"
              variant="ghost"
              :disabled="page.isParameterTransition"
              @click="page.openEdit(row)"
            >
              <el-icon><Edit /></el-icon>
              编辑
            </AppButton>
            <AppButton
              v-if="page.canUpdate"
              size="small"
              :variant="row.recordStatus === 'active' ? 'soft' : 'success'"
              :disabled="page.isParameterTransition"
              @click="page.toggleStatus(row)"
            >
              <el-icon>
                <VideoPause v-if="row.recordStatus === 'active'" />
                <VideoPlay v-else />
              </el-icon>
              {{ row.recordStatus === 'active' ? '停用' : '启用' }}
            </AppButton>
            <AppButton
              v-if="page.canDelete"
              size="small"
              variant="danger"
              :disabled="page.isParameterTransition"
              @click="page.openDelete(row)"
            >
              <el-icon><Delete /></el-icon>
              删除
            </AppButton>
          </template>
        </V2TableActionColumn>
      </V2Table>

      <div class="v2-records-mobile-list" :data-mobile-for="v2TableSchemas.customers.main.id">
        <article v-for="item in page.items" :key="item.id" class="v2-records-mobile-item">
          <header>
            <div>
              <strong v-v2-column-visibility="[v2TableSchemas.customers.main.id, 'name']">
                {{ item.name }}
              </strong>
              <span v-v2-column-visibility="[v2TableSchemas.customers.main.id, '来源']">
                {{ item.source?.name || '未设置来源' }}
              </span>
            </div>
            <el-tag
              v-v2-column-visibility="[v2TableSchemas.customers.main.id, 'recordStatus']"
              :type="item.recordStatus === 'active' ? 'success' : 'info'"
              effect="plain"
            >
              {{ item.recordStatus === 'active' ? '启用' : '停用' }}
            </el-tag>
          </header>
          <V2CustomerMobileDetails :customer="item" />
          <footer>
            <AppButton
              v-if="item.hasPhone && page.canRevealContact"
              v-v2-column-visibility="[v2TableSchemas.customers.main.id, '手机号']"
              size="small"
              variant="ghost"
              :disabled="page.isParameterTransition"
              @click="page.openRevealPhone(item)"
            >
              查看手机号
            </AppButton>
            <AppButton
              v-if="item.hasWhatsapp && page.canRevealContact"
              v-v2-column-visibility="[v2TableSchemas.customers.main.id, 'WhatsApp']"
              size="small"
              variant="ghost"
              :disabled="page.isParameterTransition"
              @click="page.openRevealWhatsapp(item)"
            >
              查看 WhatsApp
            </AppButton>
            <div class="v2-record-actions">
              <AppButton
                v-if="page.canUpdate"
                size="small"
                variant="ghost"
                :disabled="page.isParameterTransition"
                @click="page.openEdit(item)"
              >
                编辑
              </AppButton>
              <AppButton
                v-if="page.canUpdate"
                size="small"
                variant="soft"
                :disabled="page.isParameterTransition"
                @click="page.toggleStatus(item)"
              >
                {{ item.recordStatus === 'active' ? '停用' : '启用' }}
              </AppButton>
              <AppButton
                v-if="page.canDelete"
                size="small"
                variant="danger"
                :disabled="page.isParameterTransition"
                @click="page.openDelete(item)"
              >
                删除
              </AppButton>
            </div>
          </footer>
        </article>
        <div v-if="!page.items.length" class="v2-records-empty">
          <strong>暂无客户资料</strong>
          <span>当前筛选条件下没有数据</span>
          <AppButton v-if="page.canCreate" variant="primary" @click="page.openCreate">
            新增客户
          </AppButton>
        </div>
      </div>

      <footer class="v2-records-pagination">
        <span>共 {{ page.total }} 条</span>
        <el-pagination
          v-pagination-label
          :current-page="page.displayedPage"
          :page-size="page.displayedPageSize"
          background
          :disabled="page.queryPhase === 'transitioning'"
          :page-sizes="[10, 20, 50, 100]"
          layout="sizes, prev, pager, next"
          :total="page.total"
          @current-change="page.handlePageChange"
          @size-change="page.handlePageSizeChange"
        />
      </footer>
    </section>
  </V2AsyncRegion>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import { Delete, Edit, VideoPause, VideoPlay } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import { operatorUsername } from '@/v2/utils/operator';
import type { useCustomersPage } from '../useCustomersPage';
import V2CustomerHistoryServices from './V2CustomerHistoryServices.vue';
import V2CustomerMobileDetails from './V2CustomerMobileDetails.vue';
import V2CustomerSensitiveContactCell from './V2CustomerSensitiveContactCell.vue';

type CustomersPage = UnwrapNestedRefs<ReturnType<typeof useCustomersPage>>;

const props = defineProps<{
  page: CustomersPage;
}>();

const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => props.page.items,
  pageSize: () => props.page.displayedPageSize
});
</script>
