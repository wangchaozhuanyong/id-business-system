import type { ObjectDirective } from 'vue';

const PAGE_SIZE_LABEL = '每页条数';

function applyPaginationLabels(element: HTMLElement) {
  const sizes = element.querySelector<HTMLElement>('.el-pagination__sizes');
  const combobox = sizes?.querySelector<HTMLElement>('[role="combobox"]');
  const input = sizes?.querySelector<HTMLInputElement>('input');

  combobox?.setAttribute('aria-label', PAGE_SIZE_LABEL);
  input?.setAttribute('aria-label', PAGE_SIZE_LABEL);
}

export const v2PaginationLabel: ObjectDirective<HTMLElement> = {
  mounted: applyPaginationLabels,
  updated: applyPaginationLabels
};
