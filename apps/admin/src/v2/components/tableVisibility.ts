import type { InjectionKey } from 'vue';

export interface V2TableVisibilityContext {
  isColumnVisible: (columnKey: string) => boolean;
}

export const V2_TABLE_VISIBILITY_CONTEXT: InjectionKey<V2TableVisibilityContext> = Symbol(
  'v2-table-visibility-context'
);
