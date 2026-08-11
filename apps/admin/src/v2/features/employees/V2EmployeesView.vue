<template>
  <section class="v2-records-page v2-employees-page">
    <V2EmployeesOverview :page="page" />
    <V2EmployeesToolbar :page="page" />
    <V2EmployeesList :page="page" />
    <V2EmployeeDrawer :page="page" />
  </section>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import V2EmployeeDrawer from './components/V2EmployeeDrawer.vue';
import V2EmployeesList from './components/V2EmployeesList.vue';
import V2EmployeesOverview from './components/V2EmployeesOverview.vue';
import V2EmployeesToolbar from './components/V2EmployeesToolbar.vue';
import { useEmployeesPage } from './useEmployeesPage';
import '@/v2/styles/records.css';
import '@/v2/styles/employees.css';

const page = reactive(useEmployeesPage());
</script>
