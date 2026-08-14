<template>
  <section class="v2-records-page">
    <V2ActivationsOverview :page="page" />
    <V2ActivationsToolbar :page="page" />
    <V2ActivationsList :page="page" />

    <el-drawer v-model="page.detailVisible" title="开通记录详情" size="min(620px, 94vw)">
      <V2AsyncRegion
        variant="section"
        skeleton="detail"
        :loading="page.detailLoading"
        :resolved="Boolean(page.detail)"
        :error="page.detailError"
        loading-title="正在加载开通记录"
        refreshing-title="正在更新开通记录"
        error-title="开通记录加载失败"
        @retry="page.retryDetail"
      >
        <div v-if="page.detail" class="v2-activation-detail">
          <V2DetailSummary
            heading-id="activation-detail-summary"
            eyebrow="开通对象"
            :title="page.detail.customer.name"
            :description="`${page.detail.service.name} · ${page.detail.account.displayAppleId || '—'}`"
            :metrics="[
              { label: '到期状态', value: page.detail.status.label },
              {
                label: '订单利润',
                value: detailProfitAmount
              }
            ]"
            :facts="[
              { label: '订单号', value: page.detail.order.orderNo },
              { label: '国家', value: page.detail.account.country.name },
              { label: '操作人', value: operatorUsername(page.detail.createdBy) }
            ]"
          />
          <V2PanelSection heading-id="activation-detail-business" title="业务资料" step="01">
            <dl class="v2-activation-detail__facts">
              <div>
                <dt>订单</dt>
                <dd>{{ page.detail.order.orderNo }}</dd>
              </div>
              <div>
                <dt>客户</dt>
                <dd>{{ page.detail.customer.name }}</dd>
              </div>
              <div>
                <dt>业务</dt>
                <dd>{{ page.detail.service.name }}</dd>
              </div>
              <div>
                <dt>苹果 ID</dt>
                <dd>{{ page.detail.account.displayAppleId || '—' }}</dd>
              </div>
              <div>
                <dt>国家</dt>
                <dd>{{ page.detail.account.country.name }}</dd>
              </div>
              <div>
                <dt>网站账号</dt>
                <dd>{{ page.detail.displayWebsiteAccount || '—' }}</dd>
              </div>
              <div>
                <dt>开通日期</dt>
                <dd>{{ page.formatDate(page.detail.openedAt) }}</dd>
              </div>
              <div>
                <dt>到期日期</dt>
                <dd>{{ page.formatDate(page.detail.dueAt) }}</dd>
              </div>
              <div>
                <dt>到期状态</dt>
                <dd>{{ page.detail.status.label }}</dd>
              </div>
              <div>
                <dt>订单利润</dt>
                <dd>{{ detailProfitAmount }}</dd>
              </div>
              <div>
                <dt>备注</dt>
                <dd>{{ page.detail.remark || '—' }}</dd>
              </div>
              <div>
                <dt>操作人</dt>
                <dd>{{ operatorUsername(page.detail.createdBy) }}</dd>
              </div>
              <div>
                <dt>记录生成时间</dt>
                <dd>{{ page.formatDate(page.detail.createdAt) }}</dd>
              </div>
            </dl>
          </V2PanelSection>
        </div>
      </V2AsyncRegion>
    </el-drawer>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive } from 'vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2DetailSummary from '@/v2/components/V2DetailSummary.vue';
import V2PanelSection from '@/v2/components/V2PanelSection.vue';
import { operatorUsername } from '@/v2/utils/operator';
import V2ActivationsList from './components/V2ActivationsList.vue';
import V2ActivationsOverview from './components/V2ActivationsOverview.vue';
import V2ActivationsToolbar from './components/V2ActivationsToolbar.vue';
import { useActivationsPage } from './useActivationsPage';
import '@/v2/styles/records.css';
import '@/v2/styles/activations.css';

const page = reactive(useActivationsPage());
const detailProfitAmount = computed(() =>
  page.detail ? page.formatNullableDecimal(page.detail.order.profitAmount) : '—'
);
</script>
