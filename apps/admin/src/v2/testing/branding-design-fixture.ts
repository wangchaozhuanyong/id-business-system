import '@/v2/styles/base.css';
import '@/v2/styles/v2.css';
import '@/v2/styles/records.css';
import '@/v2/styles/branding.css';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import V2BrandingDesignFixture from './V2BrandingDesignFixture.vue';

const app = createApp(V2BrandingDesignFixture);
app.use(createPinia());
app.mount('#app');
