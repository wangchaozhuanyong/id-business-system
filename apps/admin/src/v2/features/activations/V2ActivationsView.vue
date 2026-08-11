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
          <dl>
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
              <dd>{{ page.detail.account.appleIdMasked }}</dd>
            </div>
            <div>
              <dt>国家</dt>
              <dd>{{ page.detail.account.country.name }}</dd>
            </div>
            <div>
              <dt>网站账号</dt>
              <dd>{{ page.detail.maskedWebsiteAccount || '—' }}</dd>
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
              <dd>{{ page.formatNullableDecimal(page.detail.order.profitAmount) }}</dd>
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
        </div>
      </V2AsyncRegion>
    </el-drawer>
  </section>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import { operatorUsername } from '@/v2/utils/operator';
import V2ActivationsList from './components/V2ActivationsList.vue';
import V2ActivationsOverview from './components/V2ActivationsOverview.vue';
import V2ActivationsToolbar from './components/V2ActivationsToolbar.vue';
import { useActivationsPage } from './useActivationsPage';
import '@/v2/styles/records.css';
import '@/v2/styles/activations.css';

const page = reactive(useActivationsPage());
</script>
