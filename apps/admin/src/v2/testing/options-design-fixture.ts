import '@/v2/styles/base.css';
import '@/v2/styles/v2.css';
import '@/v2/styles/records.css';
import '@/v2/features/options/options.css';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { v2PaginationLabel } from '@/v2/directives/paginationLabel';
import { applyV2Theme, type V2Theme } from '@/v2/theme';
import V2OptionsDesignFixture from './V2OptionsDesignFixture.vue';

const requestedTheme = new URLSearchParams(window.location.search).get('theme');
const theme: V2Theme = requestedTheme === 'dark' ? 'dark' : 'light';

applyV2Theme(theme);
const app = createApp(V2OptionsDesignFixture);
app.use(createPinia());
app.directive('pagination-label', v2PaginationLabel);
app.mount('#app');
