import '@/v2/styles/base.css';
import '@/v2/styles/v2.css';
import '@/v2/styles/records.css';
import '@/v2/styles/security.css';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { v2PaginationLabel } from '@/v2/directives/paginationLabel';
import { v2TableColumnVisibility } from '@/v2/directives/tableColumnVisibility';
import V2SecurityDesignFixture from './V2SecurityDesignFixture.vue';

const app = createApp(V2SecurityDesignFixture);
app.use(createPinia());
app.directive('pagination-label', v2PaginationLabel);
app.directive('v2-column-visibility', v2TableColumnVisibility);
app.mount('#app');
