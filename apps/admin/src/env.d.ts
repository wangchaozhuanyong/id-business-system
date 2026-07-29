/// <reference types="vite/client" />

declare const __V2_BUILD_ID__: string;

interface Window {
  __V2_APP_MOUNTED__?: boolean;
}

declare module 'element-plus/es/components/*/index.mjs' {
  import type { Component, Plugin } from 'vue';

  export const ElAlert: Component;
  export const ElBadge: Component;
  export const ElButton: Component;
  export const ElCheckbox: Component;
  export const ElCheckboxGroup: Component;
  export const ElDatePicker: Component;
  export const ElDescriptions: Component;
  export const ElDescriptionsItem: Component;
  export const ElDialog: Component;
  export const ElDivider: Component;
  export const ElDrawer: Component;
  export const ElDropdown: Component;
  export const ElDropdownItem: Component;
  export const ElDropdownMenu: Component;
  export const ElEmpty: Component;
  export const ElForm: Component;
  export const ElFormItem: Component;
  export const ElInput: Component;
  export const ElInputNumber: Component;
  export const ElLoading: Plugin;
  export const ElOption: Component;
  export const ElPagination: Component;
  export const ElPopover: Component;
  export const ElRadioButton: Component;
  export const ElRadioGroup: Component;
  export const ElResult: Component;
  export const ElSelect: Component;
  export const ElSkeleton: Component;
  export const ElSwitch: Component;
  export const ElTabPane: Component;
  export const ElTable: Component;
  export const ElTableColumn: Component;
  export const ElTabs: Component;
  export const ElTag: Component;
  export const ElTree: Component;
}
