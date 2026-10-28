import '@/v2/styles/base.css';
import '@/v2/styles/v2.css';
import '@/v2/styles/records.css';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { v2PaginationLabel } from '@/v2/directives/paginationLabel';
import { v2TableColumnVisibility } from '@/v2/directives/tableColumnVisibility';
import Fixture from './V2MailboxQueryCodeValidityFixture.vue';
const app = createApp(Fixture);
app.use(createPinia());
const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/', component: { render: () => null } }]
});
app.use(router);
app.directive('pagination-label', v2PaginationLabel);
app.directive('v2-column-visibility', v2TableColumnVisibility);
void router.isReady().then(() => app.mount('#app'));
