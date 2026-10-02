import { computed, reactive, type Ref } from 'vue';
import { useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import type {
  V2GovernanceJobList,
  V2GovernanceJobQuery,
  V2GovernanceJobStatus,
  V2GovernanceJobType,
  V2GovernanceRecycleEntity,
  V2GovernanceRecycleList,
  V2GovernanceRecycleQuery
} from './contracts';

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

export function useDataGovernanceFilters() {
  const recycleQueryModel = useV2SessionDraft(
    'data-governance/useDataGovernancePage:recycleQueryModel',
    () =>
      reactive({
        page: 1,
        pageSize: 20,
        entity: '' as V2GovernanceRecycleEntity | ''
      })
  );
  const jobQueryModel = useV2SessionDraft(
    'data-governance/useDataGovernancePage:jobQueryModel',
    () =>
      reactive({
        page: 1,
        pageSize: 20,
        type: '' as V2GovernanceJobType | '',
        status: '' as V2GovernanceJobStatus | ''
      })
  );
  function recycleListQuery(): V2GovernanceRecycleQuery {
    return {
      page: recycleQueryModel.page,
      pageSize: recycleQueryModel.pageSize,
      entity: recycleQueryModel.entity || undefined
    };
  }

  function jobListQuery(): V2GovernanceJobQuery {
    return {
      page: jobQueryModel.page,
      pageSize: jobQueryModel.pageSize,
      type: jobQueryModel.type || undefined,
      status: jobQueryModel.status || undefined
    };
  }

  return { recycleQueryModel, jobQueryModel, recycleListQuery, jobListQuery };
}
