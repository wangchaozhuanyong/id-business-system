import type { InjectionKey } from 'vue';
import type { V2TableColumnDefinition } from './tableSystem';

export interface V2TableVisibilityContext {
  isColumnVisible: (columnKey: string) => boolean;
  fixedColumnsEnabled: () => boolean;
}

export const V2_TABLE_VISIBILITY_CONTEXT: InjectionKey<V2TableVisibilityContext> = Symbol(
  'v2-table-visibility-context'
);

export const V2_TABLE_CONTENT_WIDTH_CONTEXT: InjectionKey<{
  columnWidth: (definition: V2TableColumnDefinition) => number;
}> = Symbol('v2-table-content-width-context');
