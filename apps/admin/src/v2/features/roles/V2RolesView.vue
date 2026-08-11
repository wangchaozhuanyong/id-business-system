<template>
  <section class="v2-records-page v2-roles-page">
    <V2RolesOverview :page="page" />
    <V2RolesToolbar :page="page" />
    <V2RolesList :page="page" />
    <V2RoleDrawer :page="page" />
  </section>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import V2RoleDrawer from './components/V2RoleDrawer.vue';
import V2RolesList from './components/V2RolesList.vue';
import V2RolesOverview from './components/V2RolesOverview.vue';
import V2RolesToolbar from './components/V2RolesToolbar.vue';
import { useRolesPage } from './useRolesPage';
import '@/v2/styles/records.css';
import '@/v2/styles/roles.css';

const page = reactive(useRolesPage());
</script>
