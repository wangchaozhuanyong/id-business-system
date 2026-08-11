import '@/v2/styles/base.css';
import '@/v2/styles/v2.css';
import '@/v2/styles/records.css';
import '@/v2/features/options/options.css';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { v2PaginationLabel } from '@/v2/directives/paginationLabel';
import V2OptionsDesignFixture from './V2OptionsDesignFixture.vue';

const app = createApp(V2OptionsDesignFixture);
app.use(createPinia());
app.directive('pagination-label', v2PaginationLabel);
app.mount('#app');
