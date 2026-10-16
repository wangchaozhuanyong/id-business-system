import '@/v2/styles/base.css';
import '@/v2/styles/v2.css';
import '@/v2/styles/records.css';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { v2PaginationLabel } from '@/v2/directives/paginationLabel';
import { v2TableColumnVisibility } from '@/v2/directives/tableColumnVisibility';
import V2VendureMailboxDesignFixture from './V2VendureMailboxDesignFixture.vue';

const app = createApp(V2VendureMailboxDesignFixture);
app.use(createPinia());
const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/:pathMatch(.*)*', component: V2VendureMailboxDesignFixture }]
});
app.use(router);
app.directive('pagination-label', v2PaginationLabel);
app.directive('v2-column-visibility', v2TableColumnVisibility);
void router.push(window.location.pathname + window.location.search).then(() => app.mount('#app'));
