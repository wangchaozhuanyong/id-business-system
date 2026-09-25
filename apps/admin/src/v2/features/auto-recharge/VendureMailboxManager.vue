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

      <section
        v-else-if="statusQuery.data.value && !statusQuery.data.value.connected"
        class="vendure-mailbox-unconfigured"
      >
        <strong>邮箱互通连接异常</strong>
        <span>{{
          statusQuery.data.value.message || '请管理员检查 Vendure 服务和专用 API Key。'
        }}</span>
        <AppButton size="small" variant="soft" @click="statusQuery.refresh">重新检查</AppButton>
      </section>

      <template v-else>
        <el-tabs v-model="activeTab" class="vendure-mailbox-tabs">
          <el-tab-pane label="主邮箱管理" name="primary" />
          <el-tab-pane label="虚拟邮箱管理" name="aliases" />
          <el-tab-pane label="收件记录" name="mails" />
          <el-tab-pane label="邮箱中继查询" name="relay-query" />
        </el-tabs>

        <section
          v-if="activeTab !== 'relay-query'"
          class="vendure-mailbox-toolbar"
          aria-label="邮件验证码查询筛选"
        >
          <div class="vendure-mailbox-toolbar__filters">
            <el-input
              v-model="keywordInput"
              clearable
              aria-label="搜索邮箱或邮件"
              :placeholder="activeTab === 'mails' ? '搜索发件人、主题或验证码' : '搜索邮箱或备注'"
              @keyup.enter="applyFilters"
              @clear="applyFilters"
            />
            <el-select
              v-if="activeTab !== 'mails'"
              v-model="statusInput"
              aria-label="邮箱状态"
              placeholder="全部状态"
            >
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
              @change="handlePrimaryFilterChange"
            >
              <el-option
                v-for="item in primaryItems"
                :key="item.id"
                :label="item.email"
                :value="item.id"
              />
            </el-select>
            <el-select
              v-if="activeTab === 'mails'"
              v-model="virtualEmailId"
              clearable
              filterable
              aria-label="指定虚拟邮箱"
              placeholder="全部虚拟邮箱"
              @change="handleVirtualEmailFilterChange"
            >
              <el-option
                v-for="item in allAliases"
                :key="item.id"
                :label="item.aliasEmail"
                :value="item.id"
              />
            </el-select>
            <el-checkbox
              v-if="activeTab === 'mails'"
              v-model="unassignedOnly"
              @change="handleUnassignedFilterChange"
              >只看未分配</el-checkbox
            >
            <AppButton variant="soft" @click="applyFilters">查询</AppButton>
          </div>
          <div class="vendure-mailbox-toolbar__actions">
            <AppButton v-if="activeTab === 'primary'" variant="primary" @click="openPrimaryCreate"
              >新增主邮箱</AppButton
            >
            <template v-else-if="activeTab === 'aliases'">
              <AppButton variant="soft" @click="openAliasBatch">批量导入</AppButton>
              <AppButton variant="primary" @click="openAliasCreate">新增虚拟邮箱</AppButton>
            </template>
            <AppButton v-else variant="soft" @click="mailQuery.refresh">刷新收件</AppButton>
          </div>
        </section>

        <div
          v-if="activeTab === 'mails' && (virtualEmailId || unassignedOnly)"
          class="vendure-mailbox-scope"
          role="status"
        >
          <span>
            <strong>当前收件范围</strong>
            {{
              unassignedOnly
                ? '仅显示尚未分配到虚拟邮箱的邮件'
                : `仅显示 ${selectedAliasEmail} 的邮件`
            }}
          </span>
          <AppButton size="small" variant="ghost" @click="clearMailScope">查看全部邮件</AppButton>
        </div>

        <V2AsyncRegion
          v-if="activeTab !== 'relay-query'"
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
              <V2SectionHeading
                title="主邮箱管理"
                help="与官网同步验证码邮件的来源邮箱，包含授权密钥与主查询码。"
              >
                <template #actions>
                  <V2TableColumnSettings inline :schema="v2TableSchemas.vendureMailbox.primary" />
                  <span>本页 {{ primaryItems.length }} 条</span>
                  <span aria-hidden="true">·</span>
                  <strong>共 {{ primaryQuery.data.value?.total ?? 0 }} 条</strong>
                </template>
              </V2SectionHeading>
            </header>
            <V2Table
              :schema="v2TableSchemas.vendureMailbox.primary"
              :show-column-settings="false"
              :data="primaryItems"
              :view-key="viewKey"
              class="v2-records-table"
            >
              <template #empty>
                <div class="v2-records-empty">
                  <strong>暂无主邮箱</strong><span>新增苹果主邮箱后即可同步验证码邮件</span>
                </div>
              </template>
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.primary.columns[0]"
                prop="email"
                show-overflow-tooltip
              >
                <template #default="{ row }">
                  <strong class="v2-table-cell vendure-mailbox-email">{{ row.email }}</strong>
                </template>
              </V2TableColumn>
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.primary.columns[1]"
                prop="status"
              >
                <template #default="{ row }">
                  <el-tag :type="statusTag(row.status)" effect="plain">{{
                    statusLabel(row.status)
                  }}</el-tag>
                </template>
              </V2TableColumn>
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.primary.columns[2]"
                prop="masterQueryCode"
              >
                <template #default="{ row }">
                  <div v-if="row.masterQueryCode" class="vendure-code-cell">
                    <span class="vendure-code-badge" :title="row.masterQueryCode">{{
                      row.masterQueryCode
                    }}</span>
                    <button
                      type="button"
                      class="vendure-copy-btn"
                      :class="{ 'is-copied': copiedCode === row.masterQueryCode }"
                      title="点击一键复制主查询码"
                      @click="copyCodeWithFeedback(row.masterQueryCode)"
                    >
                      <el-icon v-if="copiedCode !== row.masterQueryCode"><CopyDocument /></el-icon>
                      <el-icon v-else><Check /></el-icon>
                      <span>{{ copiedCode === row.masterQueryCode ? '已复制' : '复制' }}</span>
                    </button>
                  </div>
                  <span v-else>—</span>
                </template>
              </V2TableColumn>
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
              >
                <template #default="{ row }">{{ showDate(row.lastSyncedAt) }}</template>
              </V2TableColumn>
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.primary.columns[6]"
                prop="note"
                show-overflow-tooltip
              />
              <V2TableActionColumn :definition="v2TableSchemas.vendureMailbox.primary.columns[7]">
                <template #default="{ row }">
                  <div class="vendure-mailbox-row-actions">
                    <div class="vendure-mailbox-row-actions__buttons">
                      <AppButton
                        size="small"
                        variant="ghost"
                        :loading="isPrimaryActionRunning(row.id, 'test')"
                        :disabled="saving && !isPrimaryActionRunning(row.id, 'test')"
                        @click="runPrimaryAction(row, 'test')"
                        >测试</AppButton
                      >
                      <AppButton
                        size="small"
                        variant="ghost"
                        :loading="isPrimaryActionRunning(row.id, 'sync')"
                        :disabled="saving && !isPrimaryActionRunning(row.id, 'sync')"
                        @click="runPrimaryAction(row, 'sync')"
                        >同步</AppButton
                      >
                      <el-dropdown trigger="click" @command="handlePrimaryCommand(row, $event)">
                        <AppButton size="small" variant="ghost" :disabled="saving"
                          >更多操作</AppButton
                        >
                        <template #dropdown>
                          <el-dropdown-menu>
                            <el-dropdown-item command="quick-query">查验证码</el-dropdown-item>
                            <el-dropdown-item command="edit">编辑</el-dropdown-item>
                            <el-dropdown-item command="reconcile">检查历史邮件</el-dropdown-item>
                            <el-dropdown-item command="reconcile-apply"
                              >修复历史邮件归属</el-dropdown-item
                            >
                            <el-dropdown-item command="reset">重置主查询码</el-dropdown-item>
                            <el-dropdown-item command="delete" divided>删除</el-dropdown-item>
                          </el-dropdown-menu>
                        </template>
                      </el-dropdown>
                    </div>
                    <small
                      v-if="primaryActionFeedbackMessage(row.id)"
                      class="vendure-mailbox-row-feedback"
                      :class="{ 'is-error': primaryActionFeedbackIsError(row.id) }"
                      role="status"
                      >{{ primaryActionFeedbackMessage(row.id) }}</small
                    >
                  </div>
                </template>
              </V2TableActionColumn>
            </V2Table>
            <div
              class="v2-records-mobile-list"
              :data-mobile-for="v2TableSchemas.vendureMailbox.primary.id"
            >
              <article v-for="item in primaryItems" :key="item.id" class="v2-records-mobile-item">
                <header>
                  <div>
                    <strong
                      v-v2-column-visibility="[v2TableSchemas.vendureMailbox.primary.id, 'email']"
                      >{{ item.email }}</strong
                    >
                    <span
                      v-v2-column-visibility="[v2TableSchemas.vendureMailbox.primary.id, 'note']"
                      >{{ item.note || '暂无备注' }}</span
                    >
                  </div>
                  <el-tag
                    v-v2-column-visibility="[v2TableSchemas.vendureMailbox.primary.id, 'status']"
                    :type="statusTag(item.status)"
                    effect="plain"
                    >{{ statusLabel(item.status) }}</el-tag
                  >
                </header>
                <dl>
                  <div
                    v-v2-column-visibility="[
                      v2TableSchemas.vendureMailbox.primary.id,
                      'masterQueryCode'
                    ]"
                  >
                    <dt>主查询码</dt>
                    <dd>
                      <div
                        v-if="item.masterQueryCode"
                        class="vendure-code-cell vendure-code-cell--mobile"
                      >
                        <span class="vendure-code-badge">{{ item.masterQueryCode }}</span>
                        <button
                          type="button"
                          class="vendure-copy-btn"
                          :class="{ 'is-copied': copiedCode === item.masterQueryCode }"
                          title="点击一键复制主查询码"
                          @click="copyCodeWithFeedback(item.masterQueryCode)"
                        >
                          <el-icon v-if="copiedCode !== item.masterQueryCode"
                            ><CopyDocument
                          /></el-icon>
                          <el-icon v-else><Check /></el-icon>
                          <span>{{ copiedCode === item.masterQueryCode ? '已复制' : '复制' }}</span>
                        </button>
                      </div>
                      <span v-else>—</span>
                    </dd>
                  </div>
                  <div
                    v-v2-column-visibility="[
                      v2TableSchemas.vendureMailbox.primary.id,
                      'remainingDays'
                    ]"
                  >
                    <dt>剩余天数</dt>
                    <dd>{{ item.remainingDays ?? '—' }}</dd>
                  </div>
                  <div
                    v-v2-column-visibility="[
                      v2TableSchemas.vendureMailbox.primary.id,
                      'virtualEmailCount'
                    ]"
                  >
                    <dt>虚拟邮箱</dt>
                    <dd>{{ item.virtualEmailCount }}</dd>
                  </div>
                  <div
                    v-v2-column-visibility="[
                      v2TableSchemas.vendureMailbox.primary.id,
                      'lastSyncedAt'
                    ]"
                  >
                    <dt>最近同步</dt>
                    <dd>{{ showDate(item.lastSyncedAt) }}</dd>
                  </div>
                </dl>
                <footer
                  v-v2-column-visibility="[v2TableSchemas.vendureMailbox.primary.id, 'actions']"
                  class="vendure-mailbox-mobile-actions"
                >
                  <AppButton
                    size="small"
                    variant="ghost"
                    :loading="isPrimaryActionRunning(item.id, 'test')"
                    :disabled="saving && !isPrimaryActionRunning(item.id, 'test')"
                    @click="runPrimaryAction(item, 'test')"
                    >测试</AppButton
                  >
                  <AppButton
                    size="small"
                    variant="ghost"
                    :loading="isPrimaryActionRunning(item.id, 'sync')"
                    :disabled="saving && !isPrimaryActionRunning(item.id, 'sync')"
                    @click="runPrimaryAction(item, 'sync')"
                    >同步</AppButton
                  >
                  <el-dropdown trigger="click" @command="handlePrimaryCommand(item, $event)">
                    <AppButton size="small" variant="ghost">更多操作</AppButton>
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item command="quick-query">查验证码</el-dropdown-item>
                        <el-dropdown-item command="edit">编辑</el-dropdown-item>
                        <el-dropdown-item command="reconcile">检查历史邮件</el-dropdown-item>
                        <el-dropdown-item command="reconcile-apply"
                          >修复历史邮件归属</el-dropdown-item
                        >
                        <el-dropdown-item command="reset">重置主查询码</el-dropdown-item>
                        <el-dropdown-item command="delete" divided>删除</el-dropdown-item>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                  <small
                    v-if="primaryActionFeedbackMessage(item.id)"
                    class="vendure-mailbox-mobile-feedback"
                    :class="{ 'is-error': primaryActionFeedbackIsError(item.id) }"
                    role="status"
                    >{{ primaryActionFeedbackMessage(item.id) }}</small
                  >
                </footer>
              </article>
              <div v-if="!primaryItems.length" class="v2-records-empty">
                <strong>暂无主邮箱</strong><span>新增苹果主邮箱后即可同步验证码邮件</span>
              </div>
            </div>
          </section>

          <section v-else-if="activeTab === 'aliases'" class="v2-records-list">
            <header>
              <V2SectionHeading
                title="虚拟邮箱管理"
                help="买家分配使用的独立邮箱别名，包含独立买家查询码。"
              >
                <template #actions>
                  <V2TableColumnSettings inline :schema="v2TableSchemas.vendureMailbox.aliases" />
                  <span>本页 {{ aliasItems.length }} 条</span>
                  <span aria-hidden="true">·</span>
                  <strong>共 {{ aliasQuery.data.value?.total ?? 0 }} 条</strong>
                </template>
              </V2SectionHeading>
            </header>
            <V2Table
              :schema="v2TableSchemas.vendureMailbox.aliases"
              :show-column-settings="false"
              :data="aliasItems"
              :view-key="viewKey"
              class="v2-records-table"
            >
              <template #empty>
                <div class="v2-records-empty">
                  <strong>暂无虚拟邮箱</strong><span>选择主邮箱后新增或批量导入</span>
                </div>
              </template>
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.aliases.columns[0]"
                prop="aliasEmail"
                show-overflow-tooltip
              >
                <template #default="{ row }">
                  <strong class="v2-table-cell vendure-mailbox-email">{{ row.aliasEmail }}</strong>
                </template>
              </V2TableColumn>
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.aliases.columns[1]"
                prop="primaryAccountEmail"
                show-overflow-tooltip
              />
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.aliases.columns[2]"
                prop="status"
              >
                <template #default="{ row }">
                  <el-tag :type="statusTag(row.status)" effect="plain">{{
                    statusLabel(row.status)
                  }}</el-tag>
                </template>
              </V2TableColumn>
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.aliases.columns[3]"
                prop="buyerQueryCode"
              >
                <template #default="{ row }">
                  <div v-if="row.buyerQueryCode" class="vendure-code-cell">
                    <span class="vendure-code-badge" :title="row.buyerQueryCode">{{
                      row.buyerQueryCode
                    }}</span>
                    <button
                      type="button"
                      class="vendure-copy-btn"
                      :class="{ 'is-copied': copiedCode === row.buyerQueryCode }"
                      title="点击一键复制买家查询码"
                      @click="copyCodeWithFeedback(row.buyerQueryCode)"
                    >
                      <el-icon v-if="copiedCode !== row.buyerQueryCode"><CopyDocument /></el-icon>
                      <el-icon v-else><Check /></el-icon>
                      <span>{{ copiedCode === row.buyerQueryCode ? '已复制' : '复制' }}</span>
                    </button>
                  </div>
                  <span v-else>—</span>
                </template>
              </V2TableColumn>
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
              >
                <template #default="{ row }">{{ showDate(row.lastMailReceivedAt) }}</template>
              </V2TableColumn>
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.aliases.columns[7]"
                prop="note"
                show-overflow-tooltip
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
                        ><el-dropdown-item command="quick-query">查验证码</el-dropdown-item
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
            <div
              class="v2-records-mobile-list"
              :data-mobile-for="v2TableSchemas.vendureMailbox.aliases.id"
            >
              <article v-for="item in aliasItems" :key="item.id" class="v2-records-mobile-item">
                <header>
                  <div>
                    <strong
                      v-v2-column-visibility="[
                        v2TableSchemas.vendureMailbox.aliases.id,
                        'aliasEmail'
                      ]"
                      >{{ item.aliasEmail }}</strong
                    >
                    <span
                      v-v2-column-visibility="[
                        v2TableSchemas.vendureMailbox.aliases.id,
                        'primaryAccountEmail'
                      ]"
                      >{{ item.primaryAccountEmail || '所属主邮箱未知' }}</span
                    >
                  </div>
                  <el-tag
                    v-v2-column-visibility="[v2TableSchemas.vendureMailbox.aliases.id, 'status']"
                    :type="statusTag(item.status)"
                    effect="plain"
                    >{{ statusLabel(item.status) }}</el-tag
                  >
                </header>
                <dl>
                  <div
                    v-v2-column-visibility="[
                      v2TableSchemas.vendureMailbox.aliases.id,
                      'buyerQueryCode'
                    ]"
                  >
                    <dt>买家查询码</dt>
                    <dd>
                      <div
                        v-if="item.buyerQueryCode"
                        class="vendure-code-cell vendure-code-cell--mobile"
                      >
                        <span class="vendure-code-badge">{{ item.buyerQueryCode }}</span>
                        <button
                          type="button"
                          class="vendure-copy-btn"
                          :class="{ 'is-copied': copiedCode === item.buyerQueryCode }"
                          title="点击一键复制买家查询码"
                          @click="copyCodeWithFeedback(item.buyerQueryCode)"
                        >
                          <el-icon v-if="copiedCode !== item.buyerQueryCode"
                            ><CopyDocument
                          /></el-icon>
                          <el-icon v-else><Check /></el-icon>
                          <span>{{ copiedCode === item.buyerQueryCode ? '已复制' : '复制' }}</span>
                        </button>
                      </div>
                      <span v-else>—</span>
                    </dd>
                  </div>
                  <div
                    v-v2-column-visibility="[
                      v2TableSchemas.vendureMailbox.aliases.id,
                      'remainingDays'
                    ]"
                  >
                    <dt>剩余天数</dt>
                    <dd>{{ item.remainingDays ?? '—' }}</dd>
                  </div>
                  <div
                    v-v2-column-visibility="[v2TableSchemas.vendureMailbox.aliases.id, 'mailCount']"
                  >
                    <dt>邮件数</dt>
                    <dd>{{ item.mailCount }}</dd>
                  </div>
                  <div
                    v-v2-column-visibility="[
                      v2TableSchemas.vendureMailbox.aliases.id,
                      'lastMailReceivedAt'
                    ]"
                  >
                    <dt>最近收件</dt>
                    <dd>{{ showDate(item.lastMailReceivedAt) }}</dd>
                  </div>
                  <div
                    v-v2-column-visibility="[v2TableSchemas.vendureMailbox.aliases.id, 'note']"
                    class="vendure-mailbox-mobile-wide"
                  >
                    <dt>备注</dt>
                    <dd>{{ item.note || '—' }}</dd>
                  </div>
                </dl>
                <footer
                  v-v2-column-visibility="[v2TableSchemas.vendureMailbox.aliases.id, 'actions']"
                  class="vendure-mailbox-mobile-actions"
                >
                  <AppButton size="small" variant="primary" @click="showAliasMails(item)"
                    >查看邮件</AppButton
                  >
                  <AppButton size="small" variant="ghost" @click="openAliasEdit(item)"
                    >编辑</AppButton
                  >
                  <el-dropdown trigger="click" @command="handleAliasCommand(item, $event)">
                    <AppButton size="small" variant="ghost">更多操作</AppButton>
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item command="quick-query">查验证码</el-dropdown-item>
                        <el-dropdown-item command="reset">重置查询码</el-dropdown-item>
                        <el-dropdown-item command="delete" divided>删除</el-dropdown-item>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                </footer>
              </article>
              <div v-if="!aliasItems.length" class="v2-records-empty">
                <strong>暂无虚拟邮箱</strong><span>选择主邮箱后新增或批量导入</span>
              </div>
            </div>
          </section>

          <section v-else class="v2-records-list">
            <header>
              <V2SectionHeading
                title="收件记录"
                help="由主邮箱拉取的验证码邮件历史记录与匹配状态。"
              >
                <template #actions>
                  <V2TableColumnSettings inline :schema="v2TableSchemas.vendureMailbox.mails" />
                  <span>本页 {{ mailItems.length }} 条</span>
                  <span aria-hidden="true">·</span>
                  <strong>共 {{ mailQuery.data.value?.total ?? 0 }} 条</strong>
                </template>
              </V2SectionHeading>
            </header>
            <V2Table
              :schema="v2TableSchemas.vendureMailbox.mails"
              :show-column-settings="false"
              :data="mailItems"
              :view-key="viewKey"
              class="v2-records-table"
            >
              <template #empty>
                <div class="v2-records-empty">
                  <strong>暂无收件记录</strong><span>可先同步主邮箱，或调整当前筛选条件</span>
                </div>
              </template>
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.mails.columns[0]"
                prop="receivedAt"
              >
                <template #default="{ row }">{{ showDate(row.receivedAt) }}</template>
              </V2TableColumn>
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.mails.columns[1]"
                prop="targetEmail"
                show-overflow-tooltip
              >
                <template #default="{ row }">{{ targetEmail(row) }}</template>
              </V2TableColumn>
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.mails.columns[2]"
                prop="fromAddress"
                show-overflow-tooltip
              />
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.mails.columns[3]"
                prop="subject"
                show-overflow-tooltip
              />
              <V2TableColumn
                :definition="v2TableSchemas.vendureMailbox.mails.columns[4]"
                prop="extractedCode"
              >
                <template #default="{ row }">
                  <div v-if="row.extractedCode" class="vendure-code-cell">
                    <span
                      class="vendure-code-badge vendure-code-badge--otp"
                      :title="row.extractedCode"
                      >{{ row.extractedCode }}</span
                    >
                    <button
                      type="button"
                      class="vendure-copy-btn"
                      :class="{ 'is-copied': copiedCode === row.extractedCode }"
                      title="点击一键复制验证码"
                      @click="copyCodeWithFeedback(row.extractedCode)"
                    >
                      <el-icon v-if="copiedCode !== row.extractedCode"><CopyDocument /></el-icon>
                      <el-icon v-else><Check /></el-icon>
                      <span>{{ copiedCode === row.extractedCode ? '已复制' : '复制' }}</span>
                    </button>
                  </div>
                  <span v-else>—</span>
                </template>
              </V2TableColumn>
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
            <div
              class="v2-records-mobile-list"
              :data-mobile-for="v2TableSchemas.vendureMailbox.mails.id"
            >
              <article v-for="item in mailItems" :key="item.id" class="v2-records-mobile-item">
                <header>
                  <div>
                    <strong
                      v-v2-column-visibility="[v2TableSchemas.vendureMailbox.mails.id, 'subject']"
                      >{{ item.subject || '无主题邮件' }}</strong
                    >
                    <span
                      v-v2-column-visibility="[
                        v2TableSchemas.vendureMailbox.mails.id,
                        'receivedAt'
                      ]"
                      >{{ showDate(item.receivedAt) }}</span
                    >
                  </div>
                  <button
                    v-if="item.extractedCode"
                    v-v2-column-visibility="[
                      v2TableSchemas.vendureMailbox.mails.id,
                      'extractedCode'
                    ]"
                    class="vendure-mailbox-code vendure-mailbox-code--badge"
                    type="button"
                    @click="copyCode(item.extractedCode)"
                  >
                    {{ item.extractedCode }}
                  </button>
                </header>
                <dl>
                  <div
                    v-v2-column-visibility="[v2TableSchemas.vendureMailbox.mails.id, 'targetEmail']"
                    class="vendure-mailbox-mobile-wide"
                  >
                    <dt>收件邮箱</dt>
                    <dd>{{ targetEmail(item) }}</dd>
                  </div>
                  <div
                    v-v2-column-visibility="[v2TableSchemas.vendureMailbox.mails.id, 'fromAddress']"
                    class="vendure-mailbox-mobile-wide"
                  >
                    <dt>发件人</dt>
                    <dd>{{ item.fromName || item.fromAddress }}</dd>
                  </div>
                </dl>
                <footer
                  v-v2-column-visibility="[v2TableSchemas.vendureMailbox.mails.id, 'actions']"
                  class="vendure-mailbox-mobile-actions"
                >
                  <AppButton size="small" variant="primary" @click="openMail(item)"
                    >查看邮件</AppButton
                  >
                  <el-dropdown trigger="click" @command="handleMailCommand(item, $event)">
                    <AppButton size="small" variant="ghost">更多操作</AppButton>
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item command="reassign">重新分配</el-dropdown-item>
                        <el-dropdown-item command="delete" divided>删除</el-dropdown-item>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                </footer>
              </article>
              <div v-if="!mailItems.length" class="v2-records-empty">
                <strong>暂无收件记录</strong><span>可先同步主邮箱，或调整当前筛选条件</span>
              </div>
            </div>
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

        <section
          v-if="activeTab === 'relay-query'"
          class="vendure-relay-workbench"
          aria-label="邮箱中继查询工作台"
        >
          <!-- 查询输入卡片 -->
          <div class="vendure-relay-card vendure-relay-query-card">
            <div class="vendure-relay-query-header">
              <div>
                <h2 class="vendure-relay-title">邮箱中继查询</h2>
                <p class="vendure-relay-subtitle">
                  支持输入买家查询码、主查询码、虚拟邮箱或直接选取，快速获取最新验证码与中继收件记录。
                </p>
              </div>
              <div class="vendure-relay-autorefresh-control">
                <el-switch v-model="relayAutoRefresh" active-text="10秒自动刷新" />
                <span v-if="relayAutoRefresh && relayCountdown > 0" class="vendure-relay-countdown">
                  ({{ relayCountdown }}秒后刷新)
                </span>
              </div>
            </div>

            <div class="vendure-relay-form">
              <div class="vendure-relay-quick-select">
                <span id="vendure-relay-alias-label" class="vendure-relay-field-label"
                  >快捷选取虚拟邮箱</span
                >
                <el-select
                  v-model="quickSelectedAliasEmail"
                  aria-labelledby="vendure-relay-alias-label"
                  filterable
                  clearable
                  placeholder="从已有虚拟邮箱中快速选择..."
                  class="vendure-relay-alias-select"
                  @change="handleQuickSelectAlias"
                >
                  <el-option
                    v-for="item in allAliases"
                    :key="item.id"
                    :label="item.aliasEmail + (item.note ? ` (${item.note})` : '')"
                    :value="item.aliasEmail"
                  >
                    <span class="vendure-relay-opt-email">{{ item.aliasEmail }}</span>
                    <span v-if="item.buyerQueryCode" class="vendure-relay-opt-code">{{
                      item.buyerQueryCode
                    }}</span>
                  </el-option>
                </el-select>
              </div>

              <div class="vendure-relay-input-group">
                <span id="vendure-relay-input-label" class="vendure-relay-field-label"
                  >查询邮箱或查询码</span
                >
                <div class="vendure-relay-input-wrapper">
                  <el-input
                    v-model="relayInput"
                    aria-labelledby="vendure-relay-input-label"
                    clearable
                    size="large"
                    placeholder="请输入虚拟邮箱、买家查询码或主查询码..."
                    class="vendure-relay-input"
                    @keyup.enter="handleRelayQuery"
                  >
                    <template #prefix>
                      <el-icon><Search /></el-icon>
                    </template>
                    <template #suffix>
                      <button
                        v-if="!relayInput"
                        type="button"
                        class="vendure-relay-paste-btn"
                        title="从剪贴板粘贴"
                        @click="pasteRelayInput"
                      >
                        <el-icon><CopyDocument /></el-icon>
                        <span>粘贴</span>
                      </button>
                    </template>
                  </el-input>
                  <AppButton
                    variant="primary"
                    size="large"
                    class="vendure-relay-search-btn"
                    :loading="relayLoading"
                    @click="handleRelayQuery"
                  >
                    <el-icon><Search /></el-icon>
                    <span>查询验证码</span>
                  </AppButton>
                </div>
              </div>
            </div>
          </div>

          <!-- 错误提示 -->
          <div v-if="relayError" class="vendure-relay-error-banner" role="alert">
            <strong>查询提示：</strong>
            <span>{{ relayError }}</span>
          </div>

          <!-- 首次查询加载态 -->
          <div v-if="relayLoading && !relayResult" class="vendure-relay-loading-box">
            <el-icon class="is-loading"><RefreshRight /></el-icon>
            <span>正在中继查询最新验证码...</span>
          </div>

          <!-- 查询结果区域 -->
          <div v-else-if="relayResult" class="vendure-relay-results">
            <!-- 结果概览栏 -->
            <div class="vendure-relay-summary-card">
              <div class="vendure-relay-summary-info">
                <div class="vendure-relay-summary-target">
                  <span class="vendure-relay-summary-email">{{ relayResult.email }}</span>
                  <span
                    class="vendure-relay-pill"
                    :class="
                      relayResult.targetType === 'BUYER'
                        ? 'pill-buyer'
                        : relayResult.targetType === 'MASTER'
                          ? 'pill-master'
                          : 'pill-email'
                    "
                  >
                    {{
                      relayResult.targetType === 'BUYER'
                        ? '买家查询码'
                        : relayResult.targetType === 'MASTER'
                          ? '主查询码'
                          : '邮箱查询'
                    }}
                  </span>
                  <span
                    v-if="
                      relayResult.remainingDays !== null && relayResult.remainingDays !== undefined
                    "
                    class="vendure-relay-days"
                  >
                    剩余有效 {{ relayResult.remainingDays }} 天
                  </span>
                </div>
                <div class="vendure-relay-summary-meta">
                  <span>共找到 {{ relayResult.items.length }} 封收件记录</span>
                  <span v-if="lastQueriedTime">· 最后刷新：{{ lastQueriedTime }}</span>
                </div>
              </div>
              <div class="vendure-relay-summary-actions">
                <AppButton
                  size="small"
                  variant="soft"
                  :loading="relayLoading"
                  @click="handleRelayQuery"
                >
                  <el-icon><RefreshRight /></el-icon>
                  <span>立即刷新</span>
                </AppButton>
              </div>
            </div>

            <!-- 最新验证码超大横幅 Hero Banner -->
            <div v-if="relayResult.latestOtp" class="vendure-relay-otp-banner">
              <div class="vendure-relay-otp-info">
                <div class="vendure-relay-otp-tag">最新收到验证码</div>
                <div class="vendure-relay-otp-code">{{ relayResult.latestOtp.code }}</div>
                <div class="vendure-relay-otp-meta">
                  <span>发件人：{{ relayResult.latestOtp.from }}</span>
                  <span>·</span>
                  <span>主题：{{ relayResult.latestOtp.subject }}</span>
                  <span>·</span>
                  <span>时间：{{ showDate(relayResult.latestOtp.receivedAt) }}</span>
                </div>
              </div>
              <button
                type="button"
                class="vendure-relay-big-copy-btn"
                :class="{ 'is-copied': copiedCode === relayResult.latestOtp.code }"
                title="一键复制最新验证码"
                @click="copyCodeWithFeedback(relayResult.latestOtp.code)"
              >
                <el-icon v-if="copiedCode !== relayResult.latestOtp.code"><CopyDocument /></el-icon>
                <el-icon v-else><Check /></el-icon>
                <span>{{
                  copiedCode === relayResult.latestOtp.code ? '已复制验证码' : '复制验证码'
                }}</span>
              </button>
            </div>

            <!-- 邮件列表卡片 -->
            <div v-if="relayResult.items.length" class="vendure-relay-mail-list">
              <h3 class="vendure-relay-list-title">
                中继收件明细 ({{ relayResult.items.length }})
              </h3>
              <div v-for="mail in relayResult.items" :key="mail.id" class="vendure-relay-mail-card">
                <div class="vendure-relay-mail-header">
                  <div class="vendure-relay-mail-from">
                    <strong>{{ mail.fromName || mail.fromAddress || '未知发件人' }}</strong>
                    <span v-if="mail.targetEmail" class="vendure-relay-mail-target"
                      >收件: {{ mail.targetEmail }}</span
                    >
                  </div>
                  <span class="vendure-relay-mail-time">{{ showDate(mail.receivedAt) }}</span>
                </div>

                <div class="vendure-relay-mail-subject-row">
                  <div class="vendure-relay-mail-subject">{{ mail.subject || '无主题邮件' }}</div>
                  <div v-if="mail.extractedCode" class="vendure-relay-cell-otp">
                    <span class="vendure-relay-otp-chip">{{ mail.extractedCode }}</span>
                    <button
                      type="button"
                      class="vendure-copy-btn"
                      :class="{ 'is-copied': copiedCode === mail.extractedCode }"
                      title="点击一键复制验证码"
                      @click="copyCodeWithFeedback(mail.extractedCode)"
                    >
                      <el-icon v-if="copiedCode !== mail.extractedCode"><CopyDocument /></el-icon>
                      <el-icon v-else><Check /></el-icon>
                      <span>{{ copiedCode === mail.extractedCode ? '已复制' : '复制' }}</span>
                    </button>
                  </div>
                </div>

                <div v-if="mail.bodyText" class="vendure-relay-mail-body-wrapper">
                  <button
                    type="button"
                    class="vendure-relay-toggle-body-btn"
                    @click="toggleMailExpand(mail.id)"
                  >
                    <span>{{ expandedMailIds.has(mail.id) ? '收起正文' : '展开正文' }}</span>
                  </button>
                  <div v-if="expandedMailIds.has(mail.id)" class="vendure-relay-mail-body">
                    <pre>{{ mail.bodyText }}</pre>
                  </div>
                </div>
              </div>
            </div>

            <!-- 空收件卡片 -->
            <div v-else class="vendure-relay-empty-card">
              <strong>暂无中继收件记录</strong>
              <p>
                当前查询的邮箱或查询码尚未收到验证码邮件。如果刚在官网或应用触发发送，请开启自动刷新或稍候数秒后点击刷新。
              </p>
              <AppButton
                size="small"
                variant="soft"
                :loading="relayLoading"
                @click="handleRelayQuery"
              >
                <el-icon><RefreshRight /></el-icon>
                <span>刷新重试</span>
              </AppButton>
            </div>
          </div>

          <!-- 初始待机状态提示 -->
          <div v-else-if="!relayLoading && !relayError" class="vendure-relay-idle-card">
            <div class="vendure-relay-idle-icon">
              <el-icon :size="48"><Search /></el-icon>
            </div>
            <strong>请输入或选择要查询的中继邮箱</strong>
            <p>输入买家查询码、主查询码或虚拟邮箱地址，一键检索最新验证码与历史邮件。</p>
          </div>
        </section>
      </template>
    </V2AsyncRegion>

    <V2FormDrawer
      v-model="primaryDrawerOpen"
      :title="primaryForm.id ? '编辑主邮箱' : '新增主邮箱'"
      :confirm-loading="saving"
      :dirty="primaryDirty"
      @confirm="savePrimary"
    >
      <p v-if="operationError" class="vendure-mailbox-error" role="alert">{{ operationError }}</p>
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
      <p v-if="operationError" class="vendure-mailbox-error" role="alert">{{ operationError }}</p>
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
      <p v-if="operationError" class="vendure-mailbox-error" role="alert">{{ operationError }}</p>
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
      :dirty="reassignDirty"
      @confirm="saveReassignment"
    >
      <p v-if="operationError" class="vendure-mailbox-error" role="alert">{{ operationError }}</p>
      <el-form
        label-position="left"
        label-width="118px"
        require-asterisk-position="right"
        @submit.prevent
      >
        <el-form-item label="虚拟邮箱" required
          ><el-select v-model="reassignAliasId" filterable
            ><el-option
              v-for="item in reassignAliases"
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
        <dd class="vendure-mailbox-detail-code">
          <strong>{{ selectedMail.extractedCode || '未识别' }}</strong>
          <AppButton
            v-if="selectedMail.extractedCode"
            size="small"
            variant="soft"
            @click="copyCode(selectedMail.extractedCode)"
            >一键复制</AppButton
          >
        </dd>
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
  V2VendureMailboxPublicQueryResult,
  V2VendureMailboxStatus
} from '@apple-business/shared';
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { Check, CopyDocument, RefreshRight, Search } from '@element-plus/icons-vue';
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

type TabName = 'primary' | 'aliases' | 'mails' | 'relay-query';
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
const activeOperationKey = ref('');
const saving = computed(() => Boolean(activeOperationKey.value));
const operationMessage = ref('');
const operationError = ref('');
const primaryActionFeedback = ref<{
  primaryId: string;
  tone: 'success' | 'error';
  message: string;
}>();
let preserveMailScopeOnNextTabChange = false;

const statusQuery = useV2ModuleQuery<V2VendureMailboxStatus>({
  moduleKey: 'vendure-mailbox',
  scope: 'auto-recharge',
  key: 'vendure-mailbox-status',
  query: ({ signal }) => vendureMailboxApi.status({ signal })
});
const configured = computed(() => statusQuery.data.value?.configured === true);
const connected = computed(() => statusQuery.data.value?.connected === true);
const ready = computed(() => configured.value && connected.value);
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
  enabled: () => ready.value,
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
  enabled: () => ready.value,
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
  enabled: () => ready.value && activeTab.value === 'mails',
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
const selectedAliasEmail = computed(
  () =>
    allAliases.value.find((item) => item.id === virtualEmailId.value)?.aliasEmail ?? '所选虚拟邮箱'
);
const activeTotal = computed(() =>
  activeTab.value === 'primary'
    ? (primaryQuery.data.value?.total ?? 0)
    : activeTab.value === 'aliases'
      ? (aliasQuery.data.value?.total ?? 0)
      : (mailQuery.data.value?.total ?? 0)
);
const connectionLabel = computed(() =>
  !configured.value ? '互通服务未配置' : connected.value ? '互通服务已连接' : '互通服务连接异常'
);
const viewKey = computed(
  () =>
    `${activeTab.value}:${page.value}:${pageSize.value}:${keyword.value}:${status.value}:${primaryAccountId.value}:${virtualEmailId.value}:${unassignedOnly.value}`
);

watch(activeTab, (tab) => {
  page.value = 1;
  keywordInput.value = '';
  keyword.value = '';
  statusInput.value = '';
  status.value = '';
  if (tab !== 'mails' || !preserveMailScopeOnNextTabChange) virtualEmailId.value = '';
  preserveMailScopeOnNextTabChange = false;
});
watch(
  viewKey,
  () => {
    void activeQuery.value.ensureFresh();
  },
  { flush: 'post' }
);
watch(
  [activeTab, primaryAccountId],
  ([tab]) => {
    if (tab === 'mails') void aliasQuery.ensureFresh();
    if (tab === 'relay-query') {
      void primaryQuery.ensureFresh();
      void aliasQuery.ensureFresh();
    }
  },
  { flush: 'post' }
);
function applyFilters() {
  page.value = 1;
  keyword.value = keywordInput.value.trim();
  status.value = statusInput.value;
}
function resetPage() {
  page.value = 1;
}
function handlePrimaryFilterChange() {
  if (activeTab.value === 'mails') {
    virtualEmailId.value = '';
    unassignedOnly.value = false;
  }
  resetPage();
}
function handleVirtualEmailFilterChange(value: string) {
  if (value) unassignedOnly.value = false;
  resetPage();
}
function handleUnassignedFilterChange(value: boolean) {
  if (value) virtualEmailId.value = '';
  resetPage();
}
function clearMailScope() {
  virtualEmailId.value = '';
  unassignedOnly.value = false;
  resetPage();
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
const copiedCode = ref('');
let copyTimer: ReturnType<typeof setTimeout> | null = null;

async function copyCodeWithFeedback(value: string | null | undefined) {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    copiedCode.value = value;
    operationMessage.value = '查询码已复制';
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copiedCode.value = '';
    }, 2000);
  } catch {
    operationError.value = '复制失败，请手动选择查询码';
  }
}

async function copyCode(value: string | null) {
  await copyCodeWithFeedback(value);
}

interface RelayQueryResult {
  email: string;
  targetType: 'BUYER' | 'MASTER' | 'EMAIL';
  remainingDays?: number | null;
  totalEmails: number;
  latestOtp?: {
    code: string;
    subject: string;
    receivedAt: string;
    from: string;
  };
  items: Array<{
    id: string;
    subject: string;
    fromAddress: string;
    fromName?: string;
    receivedAt: string;
    extractedCode?: string;
    bodyText?: string;
    targetEmail?: string;
  }>;
}

const relayInput = ref('');
const quickSelectedAliasEmail = ref('');
const relayLoading = ref(false);
const relayError = ref('');
const relayResult = ref<RelayQueryResult | null>(null);
const lastQueriedTime = ref('');
const relayAutoRefresh = ref(false);
const relayCountdown = ref(10);
const expandedMailIds = ref<Set<string>>(new Set());
let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
let relayRequestId = 0;

watch(
  relayInput,
  () => {
    relayRequestId += 1;
    if (quickSelectedAliasEmail.value !== relayInput.value) quickSelectedAliasEmail.value = '';
    relayResult.value = null;
    relayError.value = '';
    relayLoading.value = false;
    lastQueriedTime.value = '';
    expandedMailIds.value = new Set();
  },
  { flush: 'sync' }
);

watch(activeTab, (tab) => {
  if (tab === 'relay-query') return;
  relayRequestId += 1;
  relayResult.value = null;
  relayError.value = '';
  relayLoading.value = false;
  lastQueriedTime.value = '';
});

function toggleMailExpand(mailId: string) {
  const next = new Set(expandedMailIds.value);
  if (next.has(mailId)) {
    next.delete(mailId);
  } else {
    next.add(mailId);
  }
  expandedMailIds.value = next;
}

function handleQuickSelectAlias(value: string) {
  if (value) {
    relayInput.value = value;
    void handleRelayQuery();
  }
}

async function pasteRelayInput() {
  try {
    const text = await navigator.clipboard.readText();
    if (text && text.trim()) {
      relayInput.value = text.trim();
      void handleRelayQuery();
    }
  } catch {
    operationError.value = '无法直接读取剪贴板，请手动粘贴';
  }
}

function formatPublicQueryResult(
  res: V2VendureMailboxPublicQueryResult,
  queryInput: string
): RelayQueryResult {
  const items = [...(res.items || [])].sort(
    (left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt)
  );
  const latestOtpItem = items.find((m) => Boolean(m.extractedCode));
  return {
    email: res.aliasEmail || res.primaryEmail || queryInput,
    targetType: res.targetType === 'MASTER' ? 'MASTER' : 'BUYER',
    remainingDays: res.remainingDays ?? null,
    totalEmails: res.totalEmails ?? items.length,
    latestOtp:
      latestOtpItem && latestOtpItem.extractedCode
        ? {
            code: latestOtpItem.extractedCode,
            subject: latestOtpItem.subject || '无主题邮件',
            receivedAt: latestOtpItem.receivedAt,
            from: latestOtpItem.fromName || latestOtpItem.fromAddress || '未知发件人'
          }
        : undefined,
    items: items.map((m) => ({
      id: m.id,
      subject: m.subject || '无主题邮件',
      fromAddress: m.fromAddress,
      fromName: m.fromName,
      receivedAt: m.receivedAt,
      extractedCode: m.extractedCode ?? undefined,
      bodyText: m.bodyText ?? undefined,
      targetEmail: m.targetEmail || res.aliasEmail || undefined
    }))
  };
}

async function handleRelayQuery() {
  const query = relayInput.value.trim();
  if (!query) {
    relayResult.value = null;
    relayError.value = '请输入虚拟邮箱、买家查询码或主查询码';
    return;
  }
  const requestId = ++relayRequestId;
  relayError.value = '';
  relayResult.value = null;
  lastQueriedTime.value = '';
  expandedMailIds.value = new Set();
  relayLoading.value = true;
  try {
    let resultData: RelayQueryResult | null = null;
    const isEmail = query.includes('@');

    if (isEmail) {
      let matchedAlias = allAliases.value.find(
        (a) => a.aliasEmail.toLowerCase() === query.toLowerCase()
      );
      let matchedPrimary = primaryItems.value.find(
        (p) => p.email.toLowerCase() === query.toLowerCase()
      );
      if (!matchedAlias && !matchedPrimary) {
        const [aliasMatches, primaryMatches] = await Promise.all([
          vendureMailboxApi.aliases({ q: query, pageSize: 20 }),
          vendureMailboxApi.primaryAccounts({ q: query, pageSize: 20 })
        ]);
        if (requestId !== relayRequestId) return;
        matchedAlias = aliasMatches.items.find(
          (item) => item.aliasEmail.toLowerCase() === query.toLowerCase()
        );
        matchedPrimary = primaryMatches.items.find(
          (item) => item.email.toLowerCase() === query.toLowerCase()
        );
      }
      if (!matchedAlias && !matchedPrimary) {
        throw new Error('未找到该邮箱，请从已有虚拟邮箱中选择或输入查询码');
      }

      if (matchedAlias && matchedAlias.buyerQueryCode) {
        try {
          const res = await vendureMailboxApi.publicQuery(matchedAlias.buyerQueryCode);
          if (requestId !== relayRequestId) return;
          if (res?.success) {
            resultData = formatPublicQueryResult(res, query);
          }
        } catch {
          // fallback
        }
      } else if (matchedPrimary && matchedPrimary.masterQueryCode) {
        try {
          const res = await vendureMailboxApi.publicQuery(matchedPrimary.masterQueryCode);
          if (requestId !== relayRequestId) return;
          if (res?.success) {
            resultData = formatPublicQueryResult(res, query);
          }
        } catch {
          // fallback
        }
      }

      if (!resultData) {
        if (requestId !== relayRequestId) return;
        const mailRes = await vendureMailboxApi.mails({
          virtualEmailId: matchedAlias?.id,
          primaryAccountId: matchedPrimary?.id,
          pageSize: 20
        });
        const items = [...(mailRes.items || [])].sort(
          (left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt)
        );
        const latestOtpItem = items.find((m) => m.extractedCode);
        resultData = {
          email: query,
          targetType: matchedAlias ? 'BUYER' : matchedPrimary ? 'MASTER' : 'EMAIL',
          remainingDays: matchedAlias?.remainingDays ?? matchedPrimary?.remainingDays ?? null,
          totalEmails: mailRes.total || items.length,
          latestOtp:
            latestOtpItem && latestOtpItem.extractedCode
              ? {
                  code: latestOtpItem.extractedCode,
                  subject: latestOtpItem.subject || '无主题邮件',
                  receivedAt: latestOtpItem.receivedAt,
                  from: latestOtpItem.fromName || latestOtpItem.fromAddress || '未知发件人'
                }
              : undefined,
          items: items.map((m) => ({
            id: m.id,
            subject: m.subject || '无主题邮件',
            fromAddress: m.fromAddress,
            fromName: m.fromName ?? undefined,
            receivedAt: m.receivedAt,
            extractedCode: m.extractedCode ?? undefined,
            bodyText: m.bodyText ?? undefined,
            targetEmail: targetEmail(m)
          }))
        };
      }
    } else {
      const res = await vendureMailboxApi.publicQuery(query);
      if (!res?.success) {
        throw new Error(res?.message || '未找到该查询码对应的邮箱记录，请核对查询码');
      }
      resultData = formatPublicQueryResult(res, query);
    }

    if (requestId === relayRequestId) {
      relayResult.value = resultData;
      lastQueriedTime.value = formatV2DateTime(new Date().toISOString());
    }
  } catch (err: unknown) {
    if (requestId === relayRequestId) {
      relayResult.value = null;
      relayError.value = getApiErrorMessage(err) || '查询失败，请核对输入信息';
    }
  } finally {
    if (requestId === relayRequestId) relayLoading.value = false;
  }
}

function jumpToRelayQuery(identifier: string) {
  activeTab.value = 'relay-query';
  relayInput.value = identifier;
  quickSelectedAliasEmail.value = identifier;
  void handleRelayQuery();
}

watch([relayAutoRefresh, activeTab], ([enabled, tab]) => {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  if (enabled && tab === 'relay-query') {
    relayCountdown.value = 10;
    autoRefreshTimer = setInterval(() => {
      if (!relayAutoRefresh.value || activeTab.value !== 'relay-query' || !ready.value) return;
      if (relayCountdown.value > 1) {
        relayCountdown.value -= 1;
      } else {
        relayCountdown.value = 10;
        if (!relayLoading.value && relayInput.value.trim()) {
          void handleRelayQuery();
        }
      }
    }, 1000);
  }
});

onBeforeUnmount(() => {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  if (copyTimer) clearTimeout(copyTimer);
});
function clearNotice() {
  operationMessage.value = '';
  operationError.value = '';
}
async function afterWrite(message: string) {
  operationMessage.value = message;
  const queries = [primaryQuery, aliasQuery, ...(activeTab.value === 'mails' ? [mailQuery] : [])];
  await Promise.allSettled(queries.map((query) => query.refresh()));
  if (queries.some((query) => query.error.value)) {
    operationError.value = '操作已完成，但列表刷新失败；请手动刷新核对，无需再次提交。';
  }
}
async function run(
  task: () => Promise<void>,
  options: { key?: string; uncertainWrite?: boolean } = {}
) {
  if (saving.value) {
    operationError.value = '已有操作正在处理中，请等待当前操作完成。';
    return;
  }
  activeOperationKey.value = options.key ?? 'global';
  clearNotice();
  try {
    await task();
  } catch (error) {
    const message = getApiErrorMessage(error);
    operationError.value =
      options.uncertainWrite !== false && !message.includes('操作已完成')
        ? `${message} 若请求在返回前中断，请先刷新列表核对，避免重复提交。`
        : message;
  } finally {
    activeOperationKey.value = '';
  }
}
function isPrimaryActionRunning(primaryId: string, action: 'test' | 'sync') {
  return activeOperationKey.value === `primary:${primaryId}:${action}`;
}
function primaryActionFeedbackMessage(primaryId: string) {
  return primaryActionFeedback.value?.primaryId === primaryId
    ? primaryActionFeedback.value.message
    : '';
}
function primaryActionFeedbackIsError(primaryId: string) {
  return (
    primaryActionFeedback.value?.primaryId === primaryId &&
    primaryActionFeedback.value.tone === 'error'
  );
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
const primaryInitialState = ref('');
function primaryFormState() {
  return JSON.stringify(primaryForm);
}
const primaryDirty = computed(
  () => Boolean(primaryInitialState.value) && primaryFormState() !== primaryInitialState.value
);
function openPrimaryCreate() {
  clearNotice();
  Object.assign(primaryForm, {
    id: '',
    email: '',
    appPassword: '',
    note: '',
    codeResetIntervalDays: 30,
    status: 'ACTIVE'
  });
  primaryInitialState.value = primaryFormState();
  primaryDrawerOpen.value = true;
}
function openPrimaryEdit(row: V2VendureMailboxPrimaryAccount) {
  clearNotice();
  Object.assign(primaryForm, {
    id: row.id,
    email: row.email,
    appPassword: '',
    note: row.note ?? '',
    codeResetIntervalDays: row.codeResetIntervalDays,
    status: row.status
  });
  primaryInitialState.value = primaryFormState();
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
  primaryActionFeedback.value = undefined;
  void run(
    async () => {
      try {
        if (action === 'test') {
          const result = await vendureMailboxApi.testPrimary(row.id);
          if (!result.success) throw new Error(result.message || '邮箱连接测试失败');
          operationMessage.value = result.message || '邮箱连接测试成功';
        } else {
          const result = await vendureMailboxApi.syncPrimary(row.id);
          if (!result.success) throw new Error(result.error || '邮箱同步失败');
          await afterWrite(`同步完成，新增 ${result.syncedCount} 封邮件`);
        }
        primaryActionFeedback.value = {
          primaryId: row.id,
          tone: 'success',
          message: action === 'test' ? '连接正常' : '同步完成'
        };
      } catch (error) {
        primaryActionFeedback.value = {
          primaryId: row.id,
          tone: 'error',
          message: getApiErrorMessage(error)
        };
        throw error;
      }
    },
    { key: `primary:${row.id}:${action}`, uncertainWrite: action === 'sync' }
  );
}
function handlePrimaryCommand(row: V2VendureMailboxPrimaryAccount, command: string) {
  if (command === 'quick-query') {
    jumpToRelayQuery(row.email);
    return;
  }
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
const aliasInitialState = ref('');
function aliasFormState() {
  return JSON.stringify(aliasForm);
}
const aliasDirty = computed(
  () => Boolean(aliasInitialState.value) && aliasFormState() !== aliasInitialState.value
);
function openAliasCreate() {
  clearNotice();
  Object.assign(aliasForm, {
    id: '',
    primaryAccountId: primaryAccountId.value || primaryItems.value[0]?.id || '',
    aliasEmail: '',
    note: '',
    codeResetIntervalDays: 30,
    status: 'ACTIVE'
  });
  aliasInitialState.value = aliasFormState();
  aliasDrawerOpen.value = true;
}
function openAliasEdit(row: V2VendureMailboxAlias) {
  clearNotice();
  Object.assign(aliasForm, {
    id: row.id,
    primaryAccountId: row.primaryAccountId,
    aliasEmail: row.aliasEmail,
    note: row.note ?? '',
    codeResetIntervalDays: row.codeResetIntervalDays,
    status: row.status
  });
  aliasInitialState.value = aliasFormState();
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
  preserveMailScopeOnNextTabChange = true;
  primaryAccountId.value = row.primaryAccountId;
  virtualEmailId.value = row.id;
  unassignedOnly.value = false;
  activeTab.value = 'mails';
}
function handleAliasCommand(row: V2VendureMailboxAlias, command: string) {
  if (command === 'quick-query') {
    jumpToRelayQuery(row.aliasEmail);
    return;
  }
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
  clearNotice();
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
const reassignAliases = computed(() =>
  selectedMail.value
    ? allAliases.value.filter(
        (item) => item.primaryAccountId === selectedMail.value?.primaryAccountId
      )
    : []
);
const mailDrawerOpen = ref(false);
function openMail(row: V2VendureMailboxMail) {
  selectedMail.value = row;
  mailDrawerOpen.value = true;
}
const reassignDrawerOpen = ref(false);
const reassignAliasId = ref('');
const reassignInitialAliasId = ref('');
const reassignDirty = computed(() => reassignAliasId.value !== reassignInitialAliasId.value);
function handleMailCommand(row: V2VendureMailboxMail, command: string) {
  selectedMail.value = row;
  if (command === 'reassign') {
    reassignAliasId.value = row.virtualEmailId ?? '';
    reassignInitialAliasId.value = reassignAliasId.value;
    clearNotice();
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
