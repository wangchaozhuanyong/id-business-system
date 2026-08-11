import { computed, type Ref } from 'vue';
import type { V2GovernanceJobList, V2GovernanceRecycleList } from './contracts';

interface PaginationModel {
  page: number;
  pageSize: number;
}

interface DataGovernancePaginationOptions {
  recycleData: Ref<V2GovernanceRecycleList | undefined>;
  jobsData: Ref<V2GovernanceJobList | undefined>;
  recycleQuery: PaginationModel;
  jobsQuery: PaginationModel;
  refreshRecycle: () => unknown;
  refreshJobs: () => unknown;
}

export function useDataGovernancePagination(options: DataGovernancePaginationOptions) {
  const recycleDisplayedPage = computed(
    () => options.recycleData.value?.page ?? options.recycleQuery.page
  );
  const recycleDisplayedPageSize = computed(
    () => options.recycleData.value?.pageSize ?? options.recycleQuery.pageSize
  );
  const jobsDisplayedPage = computed(() => options.jobsData.value?.page ?? options.jobsQuery.page);
  const jobsDisplayedPageSize = computed(
    () => options.jobsData.value?.pageSize ?? options.jobsQuery.pageSize
  );

  function handleRecyclePageChange(page: number) {
    options.recycleQuery.page = page;
    void options.refreshRecycle();
  }

  function handleRecyclePageSizeChange(pageSize: number) {
    options.recycleQuery.pageSize = pageSize;
    options.recycleQuery.page = 1;
    void options.refreshRecycle();
  }

  function handleJobPageChange(page: number) {
    options.jobsQuery.page = page;
    void options.refreshJobs();
  }

  function handleJobPageSizeChange(pageSize: number) {
    options.jobsQuery.pageSize = pageSize;
    options.jobsQuery.page = 1;
    void options.refreshJobs();
  }

  return {
    recycleDisplayedPage,
    recycleDisplayedPageSize,
    jobsDisplayedPage,
    jobsDisplayedPageSize,
    handleRecyclePageChange,
    handleRecyclePageSizeChange,
    handleJobPageChange,
    handleJobPageSizeChange
  };
}
