<template>
  <section class="v2-page-layout v2-records-page">
    <V2PageContext
      description="复用邮件验证码查询中的苹果隐藏邮箱。历史邮箱默认待确认，请先标记未注册；已注册邮箱不再执行注册。注册任务沿用系统设置中的代理，检测到的出口 IP 与人工补录分别标示。"
    >
      <template #filters>
        <el-form inline label-position="left" require-asterisk-position="right" @submit.prevent>
          <el-form-item label="邮箱">
            <el-input
              v-model="page.filters.q"
              clearable
              aria-label="搜索隐藏邮箱"
              placeholder="搜索隐藏邮箱或主邮箱"
            />
          </el-form-item>
          <el-form-item label="注册状态">
            <el-select
              v-model="page.filters.registrationStatus"
              aria-label="筛选注册状态"
              placeholder="全部注册状态"
            >
              <el-option label="全部注册状态" value="" />
              <el-option
                v-for="option in appleMailboxStatusOptions"
                :key="option.value"
                :label="option.label"
                :value="option.value"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="排序字段">
            <el-select v-model="page.filters.sortBy" aria-label="排序字段">
              <el-option label="按更新时间" value="updatedAt" />
              <el-option label="按邮箱地址" value="email" />
            </el-select>
          </el-form-item>
          <el-form-item label="方向">
            <el-select v-model="page.filters.sortOrder" aria-label="排序方向">
              <el-option label="降序" value="desc" />
              <el-option label="升序" value="asc" />
            </el-select>
          </el-form-item>
        </el-form>
      </template>
      <template #actions>
        <AppButton
          variant="soft"
          :disabled="!page.canWrite || !page.hasSelection || page.busy"
          @click="page.openMark(page.selected)"
          >批量标记{{ page.selected.length ? `（${page.selected.length}）` : '' }}</AppButton
        >
        <AppButton variant="soft" @click="page.refreshMailboxes">刷新</AppButton>
      </template>
    </V2PageContext>

    <p v-if="page.feedback" role="status">{{ page.feedback }}</p>
    <p v-if="page.actionError && !page.markOpen" role="alert">{{ page.actionError }}</p>
    <V2AsyncRegion
      skeleton="table"
      :phase="page.query.phase"
      :previous-data="page.query.isParameterTransition"
      :error="page.listError"
      loading-title="正在加载苹果隐藏邮箱"
      refreshing-title="正在更新隐藏邮箱"
      error-title="隐藏邮箱加载失败"
      @retry="page.refreshMailboxes"
    >
      <section ref="listRef" class="v2-records-list" :style="listFrameStyle">
        <V2Table
          :schema="v2TableSchemas.autoRegistration.appleMailboxes"
          :data="page.items"
          :view-key="page.query.displayedKey ?? 'apple-mailboxes'"
          class="v2-records-table"
          @selection-change="page.setSelection"
        >
          <template #empty
            ><div class="v2-records-empty">
              <strong>暂无符合条件的隐藏邮箱</strong
              ><span>可调整筛选，或先在邮件验证码查询中添加隐藏邮箱。</span>
            </div></template
          >
          <V2TableControlColumn
            :definition="v2TableSchemas.autoRegistration.appleMailboxes.columns[0]"
            :selection-disabled="!page.canWrite || page.busy"
          />
          <V2TableColumn
            :definition="v2TableSchemas.autoRegistration.appleMailboxes.columns[1]"
            prop="email"
            ><template #default="{ row }"
              ><strong>{{ row.email }}</strong></template
            ></V2TableColumn
          >
          <V2TableColumn
            :definition="v2TableSchemas.autoRegistration.appleMailboxes.columns[2]"
            prop="primaryEmail"
            ><template #default="{ row }">{{
              row.primaryEmail || '主邮箱未记录'
            }}</template></V2TableColumn
          >
          <V2TableColumn
            :definition="v2TableSchemas.autoRegistration.appleMailboxes.columns[3]"
            prop="registrationStatus"
            ><template #default="{ row }">{{
              appleMailboxStatusLabel(row.registrationStatus)
            }}</template></V2TableColumn
          >
          <V2TableColumn
            :definition="v2TableSchemas.autoRegistration.appleMailboxes.columns[4]"
            prop="registrationIp"
            ><template #default="{ row }"
              ><div class="v2-apple-cell">
                <span>{{ row.registrationIp || '未记录' }}</span
                ><small v-if="row.registrationIp">{{
                  appleMailboxIpSourceLabel(row.registrationIpSource)
                }}</small>
              </div></template
            ></V2TableColumn
          >
          <V2TableColumn
            :definition="v2TableSchemas.autoRegistration.appleMailboxes.columns[5]"
            prop="source"
            ><template #default="{ row }">{{
              appleMailboxSourceLabel(row.source)
            }}</template></V2TableColumn
          >
          <V2TableColumn
            :definition="v2TableSchemas.autoRegistration.appleMailboxes.columns[6]"
            prop="updatedAt"
            ><template #default="{ row }">{{ showDate(row.updatedAt) }}</template></V2TableColumn
          >
          <V2TableColumn
            :definition="v2TableSchemas.autoRegistration.appleMailboxes.columns[7]"
            prop="taskStatus"
            ><template #default="{ row }">{{
              appleMailboxTaskLabel(row.taskStatus)
            }}</template></V2TableColumn
          >
          <V2TableActionColumn
            :definition="v2TableSchemas.autoRegistration.appleMailboxes.columns[8]"
          >
            <template #default="{ row }">
              <AppButton
                size="small"
                variant="ghost"
                :disabled="!page.canWrite || page.busy || mailboxBusy(row)"
                @click="page.openMark([row])"
                >标记</AppButton
              >
              <AppButton
                size="small"
                variant="ghost"
                :disabled="!page.canWrite || page.busy || Boolean(appleMailboxRegisterReason(row))"
                :title="appleMailboxRegisterReason(row)"
                @click="page.start(row)"
                >注册</AppButton
              >
              <el-dropdown trigger="click" @command="command(row, $event)"
                ><AppButton size="small" variant="ghost">更多操作</AppButton
                ><template #dropdown
                  ><el-dropdown-menu
                    ><el-dropdown-item command="task" :disabled="!row.taskUuid"
                      >查看任务</el-dropdown-item
                    ><el-dropdown-item
                      command="recover"
                      :disabled="!page.canWrite || page.busy || row.taskStatus !== 'interrupted'"
                      >解除中断占用</el-dropdown-item
                    ></el-dropdown-menu
                  ></template
                ></el-dropdown
              >
            </template>
          </V2TableActionColumn>
        </V2Table>
        <div
          class="v2-records-mobile-list"
          :data-mobile-for="v2TableSchemas.autoRegistration.appleMailboxes.id"
        >
          <article v-for="row in page.items" :key="row.aliasId" class="v2-records-mobile-item">
            <header>
              <div>
                <strong
                  v-v2-column-visibility="[
                    v2TableSchemas.autoRegistration.appleMailboxes.id,
                    'email'
                  ]"
                  >{{ row.email }}</strong
                ><span
                  v-v2-column-visibility="[
                    v2TableSchemas.autoRegistration.appleMailboxes.id,
                    'primaryEmail'
                  ]"
                  >{{ row.primaryEmail || '主邮箱未记录' }}</span
                >
              </div>
              <el-checkbox
                :model-value="page.selectedIds.includes(row.aliasId)"
                :disabled="!page.canWrite || page.busy"
                :aria-label="`选择邮箱 ${row.email}`"
                @change="page.toggleSelection(row, Boolean($event))"
                >选择</el-checkbox
              >
            </header>
            <dl>
              <div
                v-v2-column-visibility="[
                  v2TableSchemas.autoRegistration.appleMailboxes.id,
                  'registrationStatus'
                ]"
              >
                <dt>注册状态</dt>
                <dd>{{ appleMailboxStatusLabel(row.registrationStatus) }}</dd>
              </div>
              <div
                v-v2-column-visibility="[
                  v2TableSchemas.autoRegistration.appleMailboxes.id,
                  'registrationIp'
                ]"
              >
                <dt>注册 IP</dt>
                <dd>
                  {{ row.registrationIp || '未记录'
                  }}<small v-if="row.registrationIp">
                    · {{ appleMailboxIpSourceLabel(row.registrationIpSource) }}</small
                  >
                </dd>
              </div>
              <div
                v-v2-column-visibility="[
                  v2TableSchemas.autoRegistration.appleMailboxes.id,
                  'source'
                ]"
              >
                <dt>标记来源</dt>
                <dd>{{ appleMailboxSourceLabel(row.source) }}</dd>
              </div>
              <div
                v-v2-column-visibility="[
                  v2TableSchemas.autoRegistration.appleMailboxes.id,
                  'updatedAt'
                ]"
              >
                <dt>更新时间</dt>
                <dd>{{ showDate(row.updatedAt) }}</dd>
              </div>
              <div
                v-v2-column-visibility="[
                  v2TableSchemas.autoRegistration.appleMailboxes.id,
                  'taskStatus'
                ]"
              >
                <dt>任务状态</dt>
                <dd>{{ appleMailboxTaskLabel(row.taskStatus) }}</dd>
              </div>
            </dl>
            <p v-if="appleMailboxRegisterReason(row)">{{ appleMailboxRegisterReason(row) }}</p>
            <footer>
              <AppButton
                size="small"
                variant="ghost"
                :disabled="!page.canWrite || page.busy || mailboxBusy(row)"
                @click="page.openMark([row])"
                >标记</AppButton
              ><AppButton
                size="small"
                variant="ghost"
                :disabled="!page.canWrite || page.busy || Boolean(appleMailboxRegisterReason(row))"
                @click="page.start(row)"
                >注册</AppButton
              ><el-dropdown trigger="click" @command="command(row, $event)"
                ><AppButton size="small" variant="ghost">更多操作</AppButton
                ><template #dropdown
                  ><el-dropdown-menu
                    ><el-dropdown-item command="task" :disabled="!row.taskUuid"
                      >查看任务</el-dropdown-item
                    ><el-dropdown-item
                      command="recover"
                      :disabled="!page.canWrite || page.busy || row.taskStatus !== 'interrupted'"
                      >解除中断占用</el-dropdown-item
                    ></el-dropdown-menu
                  ></template
                ></el-dropdown
              >
            </footer>
          </article>
          <div v-if="!page.items.length" class="v2-records-empty">
            <strong>暂无符合条件的隐藏邮箱</strong
            ><span>可调整筛选，或先在邮件验证码查询中添加隐藏邮箱。</span>
          </div>
        </div>
        <footer class="v2-records-pagination">
          <span>共 {{ page.query.data?.total ?? 0 }} 条</span
          ><el-pagination
            v-pagination-label
            :current-page="page.displayedPage"
            :page-size="page.displayedPageSize"
            :page-sizes="[10, 20, 50, 100]"
            :total="page.query.data?.total ?? 0"
            :disabled="page.paginationBusy"
            layout="sizes, prev, pager, next"
            background
            @current-change="page.changePage"
            @size-change="page.changePageSize"
          />
        </footer>
      </section>
    </V2AsyncRegion>

    <V2AsyncRegion
      v-if="page.taskUuid"
      skeleton="form"
      :phase="page.taskQuery.phase"
      :error="page.taskError"
      loading-title="正在加载注册任务"
      refreshing-title="正在更新注册进度"
      error-title="注册任务加载失败"
      @retry="page.taskQuery.refresh"
    >
      <section class="v2-records-list">
        <header>
          <strong
            >注册任务 · {{ appleMailboxTaskLabel(page.taskQuery.data?.status ?? null) }}</strong
          ><AppButton
            variant="soft"
            :disabled="page.busy || !appleMailboxTaskActive(page.taskQuery.data?.status ?? null)"
            @click="page.cancelTask"
            >取消任务</AppButton
          ><AppButton variant="soft" @click="page.taskQuery.refresh">刷新进度</AppButton>
        </header>
        <p v-if="page.taskQuery.data?.resultKind === 'existing_account'">
          官网返回已有账号，已标记为已注册；该结果没有确认历史注册 IP。
        </p>
        <p v-else-if="page.taskQuery.data?.resultKind === 'new_registration'">
          本次新注册完成，出口 IP 以任务检测记录为准。
        </p>
        <p v-else-if="page.taskQuery.data?.status === 'interrupted'">
          任务已中断，请先核对账号是否注册，再解除占用并修正标记。
        </p>
        <pre class="v2-apple-task-log">{{
          page.taskQuery.data?.logs.join('\n') || '暂无任务记录'
        }}</pre>
      </section>
    </V2AsyncRegion>

    <V2FormDrawer
      v-model="page.markOpen"
      :title="page.markTitle"
      description="登记已知的历史注册状态。IP 不清楚时留空；人工填写与任务检测会分别显示。"
      :confirm-loading="page.busy"
      @confirm="saveMark"
    >
      <el-form
        :model="page.markDraft.form"
        label-position="left"
        label-width="100px"
        require-asterisk-position="right"
        @submit.prevent="saveMark"
      >
        <el-form-item label="注册状态" required
          ><el-select v-model="page.markDraft.form.registrationStatus" aria-label="标记注册状态"
            ><el-option
              v-for="option in appleMailboxStatusOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value" /></el-select
        ></el-form-item>
        <el-form-item
          label="注册 IP"
          :error="page.markValidation.includes('IPv4') ? page.markValidation : undefined"
          ><div class="v2-apple-field">
            <el-input
              ref="ipInput"
              v-model="page.markDraft.form.registrationIp"
              :disabled="!page.registrationIpEditable"
              clearable
              placeholder="历史出口 IP，不清楚可留空"
              aria-label="历史注册出口 IP"
            /><small>仅已注册邮箱可补录 IPv4 或 IPv6；留空表示未记录，不使用当前 IP 推测。</small>
          </div></el-form-item
        >
        <el-form-item
          label="备注"
          :error="page.markValidation.includes('500') ? page.markValidation : undefined"
          ><el-input
            ref="noteInput"
            v-model="page.markDraft.form.note"
            type="textarea"
            :rows="3"
            maxlength="500"
            show-word-limit
            aria-label="注册标记备注"
        /></el-form-item>
        <p v-if="page.markDraft.form.items.length > 1">
          本次仅标记当前选中的
          {{ page.markDraft.form.items.length }} 个邮箱，所有邮箱使用同一状态、IP 和备注。
        </p>
        <p v-if="page.actionError" role="alert">{{ page.actionError }}</p>
        <AppButton variant="ghost" :disabled="page.busy" @click="page.resetMark"
          >恢复默认</AppButton
        >
      </el-form>
    </V2FormDrawer>
  </section>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2PageContext from '@/v2/components/V2PageContext.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableControlColumn from '@/v2/components/V2TableControlColumn.vue';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import { formatV2DateTime } from '@/v2/utils/dateTime';
import '@/v2/styles/records.css';
import {
  appleMailboxStatusOptions,
  appleMailboxStatusLabel,
  appleMailboxTaskLabel,
  appleMailboxSourceLabel,
  appleMailboxIpSourceLabel,
  appleMailboxRegisterReason,
  appleMailboxTaskActive
} from './apple-mailbox-presentation';
import type { AppleMailboxRow } from './contracts';
import { useAppleMailboxes } from './useAppleMailboxes';

const page = reactive(useAppleMailboxes());
const ipInput = ref<{ focus: () => void }>();
const noteInput = ref<{ focus: () => void }>();
async function saveMark() {
  await page.saveMark();
  if (page.markValidation.includes('IPv4')) ipInput.value?.focus();
  else if (page.markValidation.includes('500')) noteInput.value?.focus();
}
const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => page.items,
  pageSize: () => page.displayedPageSize
});
function showDate(value: string | null) {
  return value ? formatV2DateTime(value) : '未记录';
}
function mailboxBusy(row: AppleMailboxRow) {
  return appleMailboxTaskActive(row.taskStatus) || row.taskStatus === 'interrupted';
}
function command(row: AppleMailboxRow, value: string) {
  if (value === 'task') page.viewTask(row);
  if (value === 'recover') void page.recover(row);
}
</script>

<style scoped>
.v2-apple-cell,
.v2-apple-field {
  display: grid;
  gap: var(--v2-layout-control-gap);
  min-width: 0;
  width: 100%;
}
.v2-apple-task-log {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
