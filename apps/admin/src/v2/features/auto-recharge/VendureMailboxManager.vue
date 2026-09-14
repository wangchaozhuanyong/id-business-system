<template>
  <section class="v2-records-page vendure-mailbox-page" aria-label="邮件验证码查询管理">
    <V2PageContext description="与另一个管理站点共用同一套主邮箱、虚拟邮箱、查询码和收件记录。">
      <template #meta
        ><span>自动充值</span><span aria-hidden="true">/</span><span>邮件验证码查询</span></template
      >
      <template #status>
        <span>{{ connectionLabel }}</span>
        <span>主邮箱 {{ primaryQuery.data.value?.total ?? 0 }}</span>
        <span>虚拟邮箱 {{ aliasQuery.data.value?.total ?? 0 }}</span>
      </template>
    </V2PageContext>

    <p v-if="operationMessage" class="vendure-mailbox-message" role="status">
      {{ operationMessage }}
    </p>
    <p v-if="operationError" class="vendure-mailbox-error" role="alert">{{ operationError }}</p>

    <V2AsyncRegion
      skeleton="settings"
      :phase="statusQuery.phase.value"
      :error="statusQuery.error.value ? getApiErrorMessage(statusQuery.error.value) : ''"
      loading-title="正在检查邮箱互通配置"
      error-title="邮箱互通配置检查失败"
      @retry="statusQuery.refresh"
    >
      <section
        v-if="statusQuery.data.value && !statusQuery.data.value.configured"
        class="vendure-mailbox-unconfigured"
      >
        <strong>邮箱互通尚未配置</strong>
        <span>请管理员在服务器完成邮件互通授权配置。</span>
      </section>

      <template v-else>
        <el-tabs v-model="activeTab" class="vendure-mailbox-tabs">
          <el-tab-pane label="主邮箱管理" name="primary" />
          <el-tab-pane label="虚拟邮箱管理" name="aliases" />
          <el-tab-pane label="收件记录" name="mails" />
        </el-tabs>

        <section class="vendure-mailbox-toolbar" aria-label="邮件验证码查询筛选">
          <el-input
            v-model="keywordInput"
            clearable
            aria-label="搜索邮箱或邮件"
            :placeholder="activeTab === 'mails' ? '搜索发件人、主题或验证码' : '搜索邮箱或备注'"
            @keyup.enter="applyFilters"
            @clear="applyFilters"
          />
          <el-select v-if="activeTab !== 'mails'" v-model="statusInput" aria-label="邮箱状态">
            <el-option label="全部状态" value="" />
            <el-option label="正常" value="ACTIVE" />
            <el-option label="已禁用" value="DISABLED" />
            <el-option v-if="activeTab === 'primary'" label="授权错误" value="AUTH_ERROR" />
            <el-option v-if="activeTab === 'primary'" label="同步中" value="SYNCING" />
          </el-select>
          <el-select
            v-if="activeTab !== 'primary'"
            v-model="primaryAccountId"
            clearable
            aria-label="所属主邮箱"
            placeholder="全部主邮箱"
            @change="resetPage"
          >
            <el-option
              v-for="item in primaryItems"
              :key="item.id"
              :label="item.email"
              :value="item.id"
            />
          </el-select>
          <el-checkbox v-if="activeTab === 'mails'" v-model="unassignedOnly" @change="resetPage"
            >只看未分配</el-checkbox
          >
          <AppButton variant="soft" @click="applyFilters">查询</AppButton>
          <span class="vendure-mailbox-toolbar__spacer" />
          <AppButton v-if="activeTab === 'primary'" variant="primary" @click="openPrimaryCreate"
            >新增主邮箱</AppButton
          >
          <template v-else-if="activeTab === 'aliases'">
            <AppButton variant="soft" @click="openAliasBatch">批量导入</AppButton>
            <AppButton variant="primary" @click="openAliasCreate">新增虚拟邮箱</AppButton>
          </template>
          <AppButton v-else variant="soft" @click="mailQuery.refresh">刷新收件</AppButton>
        </section>

        <V2AsyncRegion
          skeleton="table"
          :phase="activeQuery.phase.value"
          :previous-data="activeQuery.isParameterTransition.value"
          :error="activeQuery.error.value ? getApiErrorMessage(activeQuery.error.value) : ''"
          loading-title="正在加载邮箱数据"
          refreshing-title="正在更新邮箱数据"
          error-title="邮箱数据加载失败"
          @retry="activeQuery.refresh"
        >
          <section v-if="activeTab === 'primary'" class="v2-records-list">
            <header>
              <V2SectionHeading title="主邮箱管理"
                ><template #actions
                  ><V2TableColumnSettings
                    inline
                    :schema="v2TableSchemas.vendureMailbox.primary"
                  /><span>共 {{ primaryQuery.data.value?.total ?? 0 }} 条</span></template
                ></V2SectionHeading
              >
            </header>
            <V2Table
              :schema="v2TableSchemas.vendureMailbox.primary"
              :show-column-settings="false"
              :data="primaryItems"
              :view-key="viewKey"
              class="v2-records-table"
            >
              <template #empty
                ><div class="v2-records-empty">
                  <strong>暂无主邮箱</strong><span>新增苹果主邮箱后即可同步验证码邮件</span>
                </div></template
              >
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.primary.columns[0]"
                prop="email"
              />
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.primary.columns[1]"
                prop="status"
                ><template #default="{ row }"
                  ><el-tag :type="statusTag(row.status)" effect="plain">{{
                    statusLabel(row.status)
                  }}</el-tag></template
                ></V2TableColumn
              >
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.primary.columns[2]"
                prop="masterQueryCode"
                ><template #default="{ row }"
                  ><button
                    class="vendure-mailbox-code"
                    type="button"
                    :disabled="!row.masterQueryCode"
                    @click="copyCode(row.masterQueryCode)"
                  >
                    {{ row.masterQueryCode || '—' }}
                  </button></template
                ></V2TableColumn
              >
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.primary.columns[3]"
                prop="remainingDays"
              />
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.primary.columns[4]"
                prop="virtualEmailCount"
              />
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.primary.columns[5]"
                prop="lastSyncedAt"
                ><template #default="{ row }">{{
                  showDate(row.lastSyncedAt)
                }}</template></V2TableColumn
              >
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.primary.columns[6]"
                prop="note"
              />
              <V2TableActionColumn :definition="v2TableSchemas.vendureMailbox.primary.columns[7]"
                ><template #default="{ row }">
                  <AppButton size="small" variant="ghost" @click="runPrimaryAction(row, 'test')"
                    >测试</AppButton
                  >
                  <AppButton size="small" variant="ghost" @click="runPrimaryAction(row, 'sync')"
                    >同步</AppButton
                  >
                  <el-dropdown trigger="click" @command="handlePrimaryCommand(row, $event)"
                    ><AppButton size="small" variant="ghost">更多操作</AppButton
                    ><template #dropdown
                      ><el-dropdown-menu
                        ><el-dropdown-item command="edit">编辑</el-dropdown-item
                        ><el-dropdown-item command="reconcile">检查历史邮件</el-dropdown-item
                        ><el-dropdown-item command="reconcile-apply"
                          >修复历史邮件归属</el-dropdown-item
                        ><el-dropdown-item command="reset">重置主查询码</el-dropdown-item
                        ><el-dropdown-item command="delete" divided
                          >删除</el-dropdown-item
                        ></el-dropdown-menu
                      ></template
                    ></el-dropdown
                  >
                </template></V2TableActionColumn
              >
            </V2Table>
          </section>

          <section v-else-if="activeTab === 'aliases'" class="v2-records-list">
            <header>
              <V2SectionHeading title="虚拟邮箱管理"
                ><template #actions
                  ><V2TableColumnSettings
                    inline
                    :schema="v2TableSchemas.vendureMailbox.aliases"
                  /><span>共 {{ aliasQuery.data.value?.total ?? 0 }} 条</span></template
                ></V2SectionHeading
              >
            </header>
            <V2Table
              :schema="v2TableSchemas.vendureMailbox.aliases"
              :show-column-settings="false"
              :data="aliasItems"
              :view-key="viewKey"
              class="v2-records-table"
            >
              <template #empty
                ><div class="v2-records-empty">
                  <strong>暂无虚拟邮箱</strong><span>选择主邮箱后新增或批量导入</span>
                </div></template
              >
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.aliases.columns[0]"
                prop="aliasEmail"
              />
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.aliases.columns[1]"
                prop="primaryAccountEmail"
              />
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.aliases.columns[2]"
                prop="status"
                ><template #default="{ row }"
                  ><el-tag :type="statusTag(row.status)" effect="plain">{{
                    statusLabel(row.status)
                  }}</el-tag></template
                ></V2TableColumn
              >
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.aliases.columns[3]"
                prop="buyerQueryCode"
                ><template #default="{ row }"
                  ><button
                    class="vendure-mailbox-code"
                    type="button"
                    @click="copyCode(row.buyerQueryCode)"
                  >
                    {{ row.buyerQueryCode }}
                  </button></template
                ></V2TableColumn
              >
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.aliases.columns[4]"
                prop="remainingDays"
              />
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.aliases.columns[5]"
                prop="mailCount"
              />
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.aliases.columns[6]"
                prop="lastMailReceivedAt"
                ><template #default="{ row }">{{
                  showDate(row.lastMailReceivedAt)
                }}</template></V2TableColumn
              >
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.aliases.columns[7]"
                prop="note"
              />
              <V2TableActionColumn :definition="v2TableSchemas.vendureMailbox.aliases.columns[8]"
                ><template #default="{ row }">
                  <AppButton size="small" variant="ghost" @click="showAliasMails(row)"
                    >查看邮件</AppButton
                  >
                  <AppButton size="small" variant="ghost" @click="openAliasEdit(row)"
                    >编辑</AppButton
                  >
                  <el-dropdown trigger="click" @command="handleAliasCommand(row, $event)"
                    ><AppButton size="small" variant="ghost">更多操作</AppButton
                    ><template #dropdown
                      ><el-dropdown-menu
                        ><el-dropdown-item command="reset">重置查询码</el-dropdown-item
                        ><el-dropdown-item command="delete" divided
                          >删除</el-dropdown-item
                        ></el-dropdown-menu
                      ></template
                    ></el-dropdown
                  >
                </template></V2TableActionColumn
              >
            </V2Table>
          </section>

          <section v-else class="v2-records-list">
            <header>
              <V2SectionHeading title="收件记录"
                ><template #actions
                  ><V2TableColumnSettings
                    inline
                    :schema="v2TableSchemas.vendureMailbox.mails"
                  /><span>共 {{ mailQuery.data.value?.total ?? 0 }} 条</span></template
                ></V2SectionHeading
              >
            </header>
            <V2Table
              :schema="v2TableSchemas.vendureMailbox.mails"
              :show-column-settings="false"
              :data="mailItems"
              :view-key="viewKey"
              class="v2-records-table"
            >
              <template #empty
                ><div class="v2-records-empty">
                  <strong>暂无收件记录</strong><span>可先同步主邮箱，或调整当前筛选条件</span>
                </div></template
              >
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.mails.columns[0]"
                prop="receivedAt"
                ><template #default="{ row }">{{
                  showDate(row.receivedAt)
                }}</template></V2TableColumn
              >
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.mails.columns[1]"
                prop="targetEmail"
                ><template #default="{ row }">{{ targetEmail(row) }}</template></V2TableColumn
              >
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.mails.columns[2]"
                prop="fromAddress"
              />
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.mails.columns[3]"
                prop="subject"
              />
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.mails.columns[4]"
                prop="extractedCode"
                ><template #default="{ row }"
                  ><button
                    v-if="row.extractedCode"
                    class="vendure-mailbox-code"
                    type="button"
                    @click="copyCode(row.extractedCode)"
                  >
                    {{ row.extractedCode }}</button
                  ><span v-else>—</span></template
                ></V2TableColumn
              >
              <V2TableActionColumn :definition="v2TableSchemas.vendureMailbox.mails.columns[5]"
                ><template #default="{ row }"
                  ><AppButton size="small" variant="ghost" @click="openMail(row)">查看</AppButton
                  ><el-dropdown trigger="click" @command="handleMailCommand(row, $event)"
                    ><AppButton size="small" variant="ghost">更多操作</AppButton
                    ><template #dropdown
                      ><el-dropdown-menu
                        ><el-dropdown-item command="reassign">重新分配</el-dropdown-item
                        ><el-dropdown-item command="delete" divided
                          >删除</el-dropdown-item
                        ></el-dropdown-menu
                      ></template
                    ></el-dropdown
                  ></template
                ></V2TableActionColumn
              >
            </V2Table>
          </section>

          <footer class="v2-records-pagination">
            <span>共 {{ activeTotal }} 条</span>
            <el-pagination
              v-pagination-label
              :current-page="page"
              :page-size="pageSize"
              :page-sizes="[20, 50, 100]"
              :total="activeTotal"
              background
              layout="sizes, prev, pager, next"
              @current-change="changePage"
              @size-change="changePageSize"
            />
          </footer>
        </V2AsyncRegion>
      </template>
    </V2AsyncRegion>

    <V2FormDrawer
      v-model="primaryDrawerOpen"
      :title="primaryForm.id ? '编辑主邮箱' : '新增主邮箱'"
      :confirm-loading="saving"
      :dirty="primaryDirty"
      @confirm="savePrimary"
    >
      <el-form
        label-position="left"
        label-width="118px"
        require-asterisk-position="right"
        @submit.prevent
      >
        <el-form-item label="主邮箱" required
          ><el-input v-model="primaryForm.email" autocomplete="off"
        /></el-form-item>
        <el-form-item
          :label="primaryForm.id ? '更新专用密码' : '专用密码'"
          :required="!primaryForm.id"
          ><el-input
            v-model="primaryForm.appPassword"
            type="password"
            show-password
            autocomplete="new-password"
            :placeholder="primaryForm.id ? '留空表示不修改' : '苹果邮箱专用密码'"
        /></el-form-item>
        <el-form-item label="备注"
          ><el-input v-model="primaryForm.note" maxlength="500"
        /></el-form-item>
        <el-form-item label="有效天数" required
          ><el-input-number v-model="primaryForm.codeResetIntervalDays" :min="1" :max="3650"
        /></el-form-item>
        <el-form-item v-if="primaryForm.id" label="状态" required
          ><el-select v-model="primaryForm.status"
            ><el-option label="正常" value="ACTIVE" /><el-option
              label="已禁用"
              value="DISABLED" /></el-select
        ></el-form-item>
      </el-form>
    </V2FormDrawer>

    <V2FormDrawer
      v-model="aliasDrawerOpen"
      :title="aliasForm.id ? '编辑虚拟邮箱' : '新增虚拟邮箱'"
      :confirm-loading="saving"
      :dirty="aliasDirty"
      @confirm="saveAlias"
    >
      <el-form
        label-position="left"
        label-width="118px"
        require-asterisk-position="right"
        @submit.prevent
      >
        <el-form-item v-if="!aliasForm.id" label="所属主邮箱" required
          ><el-select v-model="aliasForm.primaryAccountId" filterable
            ><el-option
              v-for="item in primaryItems"
              :key="item.id"
              :label="item.email"
              :value="item.id" /></el-select
        ></el-form-item>
        <el-form-item label="虚拟邮箱" required
          ><el-input v-model="aliasForm.aliasEmail"
        /></el-form-item>
        <el-form-item label="备注"
          ><el-input v-model="aliasForm.note" maxlength="500"
        /></el-form-item>
        <el-form-item label="有效天数" required
          ><el-input-number v-model="aliasForm.codeResetIntervalDays" :min="1" :max="3650"
        /></el-form-item>
        <el-form-item v-if="aliasForm.id" label="状态" required
          ><el-select v-model="aliasForm.status"
            ><el-option label="正常" value="ACTIVE" /><el-option
              label="已禁用"
              value="DISABLED" /></el-select
        ></el-form-item>
      </el-form>
    </V2FormDrawer>

    <V2FormDrawer
      v-model="batchDrawerOpen"
      title="批量导入虚拟邮箱"
      confirm-text="开始导入"
      :confirm-loading="saving"
      :dirty="Boolean(batchForm.rawInput)"
      @confirm="saveAliasBatch"
    >
      <el-form
        label-position="left"
        label-width="118px"
        require-asterisk-position="right"
        @submit.prevent
      >
        <el-form-item label="所属主邮箱" required
          ><el-select v-model="batchForm.primaryAccountId" filterable
            ><el-option
              v-for="item in primaryItems"
              :key="item.id"
              :label="item.email"
              :value="item.id" /></el-select
        ></el-form-item>
        <el-form-item label="虚拟邮箱" required
          ><el-input
            v-model="batchForm.rawInput"
            type="textarea"
            :rows="10"
            placeholder="每行一个邮箱，可在邮箱后用逗号填写备注"
        /></el-form-item>
        <el-form-item label="有效天数" required
          ><el-input-number v-model="batchForm.codeResetIntervalDays" :min="1" :max="3650"
        /></el-form-item>
      </el-form>
    </V2FormDrawer>

    <V2FormDrawer
      v-model="reassignDrawerOpen"
      title="重新分配邮件"
      confirm-text="保存分配"
      :confirm-loading="saving"
      :dirty="Boolean(reassignAliasId)"
      @confirm="saveReassignment"
    >
      <el-form
        label-position="left"
        label-width="118px"
        require-asterisk-position="right"
        @submit.prevent
      >
        <el-form-item label="虚拟邮箱" required
          ><el-select v-model="reassignAliasId" filterable
            ><el-option
              v-for="item in allAliases"
              :key="item.id"
              :label="item.aliasEmail"
              :value="item.id" /></el-select
        ></el-form-item>
      </el-form>
    </V2FormDrawer>

    <el-drawer v-model="mailDrawerOpen" title="邮件详情" size="min(620px, 94vw)">
      <dl v-if="selectedMail" class="vendure-mailbox-mail-detail">
        <dt>收件邮箱</dt>
        <dd>{{ targetEmail(selectedMail) }}</dd>
        <dt>发件人</dt>
        <dd>
          {{ selectedMail.fromName || selectedMail.fromAddress }} &lt;{{
            selectedMail.fromAddress
          }}&gt;
        </dd>
        <dt>收件时间</dt>
        <dd>{{ showDate(selectedMail.receivedAt) }}</dd>
        <dt>主题</dt>
        <dd>{{ selectedMail.subject }}</dd>
        <dt>验证码</dt>
        <dd>{{ selectedMail.extractedCode || '未识别' }}</dd>
        <dt>正文</dt>
        <dd>
          <pre>{{ selectedMail.bodyText || '无纯文本正文' }}</pre>
        </dd>
      </dl>
    </el-drawer>

    <V2ConfirmDialog
      v-model="confirmOpen"
      :title="confirmTitle"
      :message="confirmMessage"
      :danger="confirmDanger"
      :confirm-loading="saving"
      @confirm="confirmPendingAction"
    />
  </section>
</template>

<script setup lang="ts">
import type {
  V2VendureMailboxAlias,
  V2VendureMailboxMail,
  V2VendureMailboxPage,
  V2VendureMailboxPrimaryAccount,
  V2VendureMailboxStatus
} from '@apple-business/shared';
import { computed, nextTick, reactive, ref, watch } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2PageContext from '@/v2/components/V2PageContext.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import { formatV2DateTime } from '@/v2/utils/dateTime';
import { vendureMailboxApi } from './vendure-mailbox-api';
import '@/v2/styles/records.css';
import './vendure-mailbox.css';

type TabName = 'primary' | 'aliases' | 'mails';
type PendingAction = null | (() => Promise<void>);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const activeTab = ref<TabName>('primary');
const page = ref(1);
const pageSize = ref(20);
const keywordInput = ref('');
const keyword = ref('');
const statusInput = ref('');
const status = ref('');
const primaryAccountId = ref('');
const virtualEmailId = ref('');
const unassignedOnly = ref(false);
const saving = ref(false);
const operationMessage = ref('');
const operationError = ref('');

const statusQuery = useV2ModuleQuery<V2VendureMailboxStatus>({
  moduleKey: 'vendure-mailbox',
  scope: 'auto-recharge',
  key: 'vendure-mailbox-status',
  query: ({ signal }) => vendureMailboxApi.status({ signal })
});
const configured = computed(() => statusQuery.data.value?.configured === true);
const primaryQuery = useV2ModuleQuery<V2VendureMailboxPage<V2VendureMailboxPrimaryAccount>>({
  moduleKey: 'vendure-mailbox',
  scope: 'auto-recharge',
  key: () =>
    createV2QueryKey({
      resource: 'primary',
      page: activeTab.value === 'primary' ? page.value : 1,
      pageSize: activeTab.value === 'primary' ? pageSize.value : 1000,
      q: activeTab.value === 'primary' ? keyword.value : '',
      status: activeTab.value === 'primary' ? status.value : ''
    }),
  enabled: () => configured.value,
  trackRouteData: false,
  query: ({ signal }) =>
    vendureMailboxApi.primaryAccounts(
      {
        page: activeTab.value === 'primary' ? page.value : 1,
        pageSize: activeTab.value === 'primary' ? pageSize.value : 1000,
        q: activeTab.value === 'primary' ? keyword.value : '',
        status: activeTab.value === 'primary' ? status.value : ''
      },
      { signal }
    )
});
const aliasQuery = useV2ModuleQuery<V2VendureMailboxPage<V2VendureMailboxAlias>>({
  moduleKey: 'vendure-mailbox',
  scope: 'auto-recharge',
  key: () =>
    createV2QueryKey({
      resource: 'aliases',
      page: activeTab.value === 'aliases' ? page.value : 1,
      pageSize: activeTab.value === 'aliases' ? pageSize.value : 1000,
      q: activeTab.value === 'aliases' ? keyword.value : '',
      status: activeTab.value === 'aliases' ? status.value : '',
      primaryAccountId: primaryAccountId.value
    }),
  enabled: () => configured.value,
  trackRouteData: false,
  query: ({ signal }) =>
    vendureMailboxApi.aliases(
      {
        page: activeTab.value === 'aliases' ? page.value : 1,
        pageSize: activeTab.value === 'aliases' ? pageSize.value : 1000,
        q: activeTab.value === 'aliases' ? keyword.value : '',
        status: activeTab.value === 'aliases' ? status.value : '',
        primaryAccountId: primaryAccountId.value
      },
      { signal }
    )
});
const mailQuery = useV2ModuleQuery<V2VendureMailboxPage<V2VendureMailboxMail>>({
  moduleKey: 'vendure-mailbox',
  scope: 'auto-recharge',
  key: () =>
    createV2QueryKey({
      resource: 'mails',
      page: page.value,
      pageSize: pageSize.value,
      q: keyword.value,
      primaryAccountId: primaryAccountId.value,
      virtualEmailId: virtualEmailId.value,
      unassignedOnly: unassignedOnly.value
    }),
  enabled: () => configured.value && activeTab.value === 'mails',
  trackRouteData: false,
  query: ({ signal }) =>
    vendureMailboxApi.mails(
      {
        page: page.value,
        pageSize: pageSize.value,
        q: keyword.value,
        primaryAccountId: primaryAccountId.value,
        virtualEmailId: virtualEmailId.value,
        unassignedOnly: unassignedOnly.value
      },
      { signal }
    )
});

const activeQuery = computed(() =>
  activeTab.value === 'primary'
    ? primaryQuery
    : activeTab.value === 'aliases'
      ? aliasQuery
      : mailQuery
);
const primaryItems = computed(() => primaryQuery.data.value?.items ?? []);
const aliasItems = computed(() => aliasQuery.data.value?.items ?? []);
const allAliases = computed(() => aliasQuery.data.value?.items ?? []);
const mailItems = computed(() => mailQuery.data.value?.items ?? []);
const activeTotal = computed(() =>
  activeTab.value === 'primary'
    ? (primaryQuery.data.value?.total ?? 0)
    : activeTab.value === 'aliases'
      ? (aliasQuery.data.value?.total ?? 0)
      : (mailQuery.data.value?.total ?? 0)
);
const connectionLabel = computed(() =>
  statusQuery.data.value?.configured ? '互通服务已连接' : '互通服务未配置'
);
const viewKey = computed(
  () =>
    `${activeTab.value}:${page.value}:${pageSize.value}:${keyword.value}:${status.value}:${primaryAccountId.value}:${virtualEmailId.value}:${unassignedOnly.value}`
);

watch(activeTab, () => {
  page.value = 1;
  keywordInput.value = '';
  keyword.value = '';
  statusInput.value = '';
  status.value = '';
  virtualEmailId.value = '';
});
function applyFilters() {
  page.value = 1;
  keyword.value = keywordInput.value.trim();
  status.value = statusInput.value;
}
function resetPage() {
  page.value = 1;
}
function changePage(value: number) {
  page.value = value;
}
function changePageSize(value: number) {
  pageSize.value = value;
  page.value = 1;
}
function showDate(value: string | null | undefined) {
  return value ? formatV2DateTime(value) : '—';
}
function statusLabel(value: string) {
  return (
    { ACTIVE: '正常', DISABLED: '已禁用', AUTH_ERROR: '授权错误', SYNCING: '同步中' }[value] ??
    '未知'
  );
}
function statusTag(value: string): 'success' | 'info' | 'danger' | 'warning' {
  return value === 'ACTIVE'
    ? 'success'
    : value === 'AUTH_ERROR'
      ? 'danger'
      : value === 'SYNCING'
        ? 'warning'
        : 'info';
}
function targetEmail(mail: V2VendureMailboxMail) {
  return allAliases.value.find((item) => item.id === mail.virtualEmailId)?.aliasEmail ?? '未分配';
}
async function copyCode(value: string | null) {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    operationMessage.value = '查询码已复制';
  } catch {
    operationError.value = '复制失败，请手动选择查询码';
  }
}
function clearNotice() {
  operationMessage.value = '';
  operationError.value = '';
}
async function afterWrite(message: string) {
  operationMessage.value = message;
  await Promise.allSettled([
    primaryQuery.refresh(),
    aliasQuery.refresh(),
    ...(activeTab.value === 'mails' ? [mailQuery.refresh()] : [])
  ]);
}
async function run(task: () => Promise<void>) {
  if (saving.value) return;
  saving.value = true;
  clearNotice();
  try {
    await task();
  } catch (error) {
    operationError.value = `${getApiErrorMessage(error)} 若请求在返回前中断，请先刷新列表核对，避免重复提交。`;
  } finally {
    saving.value = false;
  }
}

const primaryDrawerOpen = ref(false);
const primaryForm = reactive({
  id: '',
  email: '',
  appPassword: '',
  note: '',
  codeResetIntervalDays: 30,
  status: 'ACTIVE'
});
const primaryDirty = computed(() =>
  Boolean(primaryForm.email || primaryForm.appPassword || primaryForm.note)
);
function openPrimaryCreate() {
  Object.assign(primaryForm, {
    id: '',
    email: '',
    appPassword: '',
    note: '',
    codeResetIntervalDays: 30,
    status: 'ACTIVE'
  });
  primaryDrawerOpen.value = true;
}
function openPrimaryEdit(row: V2VendureMailboxPrimaryAccount) {
  Object.assign(primaryForm, {
    id: row.id,
    email: row.email,
    appPassword: '',
    note: row.note ?? '',
    codeResetIntervalDays: row.codeResetIntervalDays,
    status: row.status
  });
  primaryDrawerOpen.value = true;
}
function savePrimary() {
  void run(async () => {
    if (
      !EMAIL_PATTERN.test(primaryForm.email.trim()) ||
      (!primaryForm.id && !primaryForm.appPassword.trim())
    )
      throw new Error('请填写有效主邮箱和苹果邮箱专用密码');
    if (primaryForm.id)
      await vendureMailboxApi.updatePrimary(primaryForm.id, {
        email: primaryForm.email,
        ...(primaryForm.appPassword ? { appPassword: primaryForm.appPassword } : {}),
        note: primaryForm.note,
        codeResetIntervalDays: primaryForm.codeResetIntervalDays,
        status: primaryForm.status as 'ACTIVE' | 'DISABLED'
      });
    else
      await vendureMailboxApi.createPrimary({
        email: primaryForm.email,
        appPassword: primaryForm.appPassword,
        note: primaryForm.note,
        codeResetIntervalDays: primaryForm.codeResetIntervalDays
      });
    primaryDrawerOpen.value = false;
    await afterWrite(primaryForm.id ? '主邮箱已更新' : '主邮箱已新增');
  });
}
function runPrimaryAction(row: V2VendureMailboxPrimaryAccount, action: 'test' | 'sync') {
  void run(async () => {
    if (action === 'test') {
      const result = await vendureMailboxApi.testPrimary(row.id);
      operationMessage.value = result.message;
    } else {
      const result = await vendureMailboxApi.syncPrimary(row.id);
      await afterWrite(
        result.success ? `同步完成，新增 ${result.syncedCount} 封邮件` : result.error || '同步失败'
      );
    }
  });
}
function handlePrimaryCommand(row: V2VendureMailboxPrimaryAccount, command: string) {
  if (command === 'edit') return openPrimaryEdit(row);
  if (command === 'reconcile')
    return askConfirm(
      '检查历史邮件',
      `先预览“${row.email}”历史邮件的归属情况，不会修改数据。`,
      false,
      async () => {
        const result = await vendureMailboxApi.reconcile(row.id, true);
        operationMessage.value = `已扫描 ${result.scannedCount} 封，可匹配 ${result.matchedCount} 封，未识别 ${result.unresolvedCount} 封`;
      }
    );
  if (command === 'reconcile-apply')
    return askConfirm(
      '修复历史邮件归属',
      `确认按当前虚拟邮箱规则修复“${row.email}”的历史邮件归属？请先执行“检查历史邮件”。`,
      true,
      async () => {
        const result = await vendureMailboxApi.reconcile(row.id, false);
        await afterWrite(`修复完成，已关联 ${result.updatedCount} 封历史邮件`);
      }
    );
  if (command === 'reset')
    return askConfirm(
      '重置主查询码',
      `重置“${row.email}”的主查询码后，旧查询码立即失效。`,
      true,
      async () => {
        await vendureMailboxApi.resetPrimaryCode(row.id);
        await afterWrite('主查询码已重置');
      }
    );
  if (command === 'delete')
    askConfirm(
      '删除主邮箱',
      `确认删除“${row.email}”？请先确认其虚拟邮箱和邮件归属。`,
      true,
      async () => {
        await vendureMailboxApi.deletePrimary(row.id);
        await afterWrite('主邮箱已删除');
      }
    );
}

const aliasDrawerOpen = ref(false);
const aliasForm = reactive({
  id: '',
  primaryAccountId: '',
  aliasEmail: '',
  note: '',
  codeResetIntervalDays: 30,
  status: 'ACTIVE'
});
const aliasDirty = computed(() => Boolean(aliasForm.aliasEmail || aliasForm.note));
function openAliasCreate() {
  Object.assign(aliasForm, {
    id: '',
    primaryAccountId: primaryAccountId.value || primaryItems.value[0]?.id || '',
    aliasEmail: '',
    note: '',
    codeResetIntervalDays: 30,
    status: 'ACTIVE'
  });
  aliasDrawerOpen.value = true;
}
function openAliasEdit(row: V2VendureMailboxAlias) {
  Object.assign(aliasForm, {
    id: row.id,
    primaryAccountId: row.primaryAccountId,
    aliasEmail: row.aliasEmail,
    note: row.note ?? '',
    codeResetIntervalDays: row.codeResetIntervalDays,
    status: row.status
  });
  aliasDrawerOpen.value = true;
}
function saveAlias() {
  void run(async () => {
    if (
      !EMAIL_PATTERN.test(aliasForm.aliasEmail.trim()) ||
      (!aliasForm.id && !aliasForm.primaryAccountId)
    )
      throw new Error('请选择主邮箱并填写有效虚拟邮箱');
    if (aliasForm.id)
      await vendureMailboxApi.updateAlias(aliasForm.id, {
        aliasEmail: aliasForm.aliasEmail,
        note: aliasForm.note,
        codeResetIntervalDays: aliasForm.codeResetIntervalDays,
        status: aliasForm.status as 'ACTIVE' | 'DISABLED'
      });
    else
      await vendureMailboxApi.createAlias({
        primaryAccountId: aliasForm.primaryAccountId,
        aliasEmail: aliasForm.aliasEmail,
        note: aliasForm.note,
        codeResetIntervalDays: aliasForm.codeResetIntervalDays
      });
    aliasDrawerOpen.value = false;
    await afterWrite(aliasForm.id ? '虚拟邮箱已更新' : '虚拟邮箱已新增');
  });
}
function showAliasMails(row: V2VendureMailboxAlias) {
  activeTab.value = 'mails';
  primaryAccountId.value = row.primaryAccountId;
  void nextTick(() => {
    virtualEmailId.value = row.id;
  });
}
function handleAliasCommand(row: V2VendureMailboxAlias, command: string) {
  if (command === 'reset')
    return askConfirm(
      '重置买家查询码',
      `重置“${row.aliasEmail}”的查询码后，旧查询码立即失效。`,
      true,
      async () => {
        await vendureMailboxApi.resetAliasCode(row.id);
        await afterWrite('买家查询码已重置');
      }
    );
  if (command === 'delete')
    askConfirm('删除虚拟邮箱', `确认删除“${row.aliasEmail}”？`, true, async () => {
      await vendureMailboxApi.deleteAlias(row.id);
      await afterWrite('虚拟邮箱已删除');
    });
}

const batchDrawerOpen = ref(false);
const batchForm = reactive({ primaryAccountId: '', rawInput: '', codeResetIntervalDays: 30 });
function openAliasBatch() {
  Object.assign(batchForm, {
    primaryAccountId: primaryAccountId.value || primaryItems.value[0]?.id || '',
    rawInput: '',
    codeResetIntervalDays: 30
  });
  batchDrawerOpen.value = true;
}
function saveAliasBatch() {
  void run(async () => {
    if (!batchForm.primaryAccountId || !batchForm.rawInput.trim())
      throw new Error('请选择主邮箱并填写要导入的虚拟邮箱');
    const result = await vendureMailboxApi.batchCreateAliases(batchForm);
    batchDrawerOpen.value = false;
    await afterWrite(
      `批量导入完成：新增 ${result.createdCount} 个，跳过 ${result.skippedCount} 个${result.errors.length ? `，失败 ${result.errors.length} 个` : ''}`
    );
  });
}

const selectedMail = ref<V2VendureMailboxMail>();
const mailDrawerOpen = ref(false);
function openMail(row: V2VendureMailboxMail) {
  selectedMail.value = row;
  mailDrawerOpen.value = true;
}
const reassignDrawerOpen = ref(false);
const reassignAliasId = ref('');
function handleMailCommand(row: V2VendureMailboxMail, command: string) {
  selectedMail.value = row;
  if (command === 'reassign') {
    reassignAliasId.value = row.virtualEmailId ?? '';
    reassignDrawerOpen.value = true;
    return;
  }
  if (command === 'delete')
    askConfirm('删除邮件', `确认删除“${row.subject}”这封邮件？`, true, async () => {
      await vendureMailboxApi.deleteMail(row.id);
      await afterWrite('邮件已删除');
    });
}
function saveReassignment() {
  void run(async () => {
    if (!selectedMail.value || !reassignAliasId.value) throw new Error('请选择要分配的虚拟邮箱');
    await vendureMailboxApi.reassignMail(selectedMail.value.id, reassignAliasId.value);
    reassignDrawerOpen.value = false;
    await afterWrite('邮件归属已更新');
  });
}

const confirmOpen = ref(false);
const confirmTitle = ref('确认操作');
const confirmMessage = ref('');
const confirmDanger = ref(false);
let pendingAction: PendingAction = null;
function askConfirm(title: string, message: string, danger: boolean, action: () => Promise<void>) {
  confirmTitle.value = title;
  confirmMessage.value = message;
  confirmDanger.value = danger;
  pendingAction = action;
  confirmOpen.value = true;
}
function confirmPendingAction() {
  const action = pendingAction;
  if (!action) return;
  void run(async () => {
    await action();
    confirmOpen.value = false;
    pendingAction = null;
  });
}
</script>
