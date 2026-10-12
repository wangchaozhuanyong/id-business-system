<script lang="ts">
import { defineComponent, h, inject, type PropType } from 'vue';
import { ElTableColumn } from 'element-plus/es/components/table/index.mjs';
import type { V2TableDataColumnDefinition } from './tableSystem';
import {
  getV2TableColumnClass,
  getV2TableColumnWidthProps,
  V2_TABLE_COLUMN_ALIGNMENT
} from './tableColumn';
import { getV2TableColumnKeyClass } from './tableContentWidth';
import { V2_TABLE_CONTENT_WIDTH_CONTEXT, V2_TABLE_VISIBILITY_CONTEXT } from './tableVisibility';

export default defineComponent({
  name: 'V2TableColumn',
  inheritAttrs: false,
  props: {
    definition: {
      type: Object as PropType<V2TableDataColumnDefinition>,
      required: true
    }
  },
  setup(props, { attrs, slots }) {
    const visibility = inject(V2_TABLE_VISIBILITY_CONTEXT, null);
    const contentWidths = inject(V2_TABLE_CONTENT_WIDTH_CONTEXT, null);

    return () => {
      if (
        visibility &&
        props.definition.hideable !== false &&
        !visibility.isColumnVisible(props.definition.key)
      ) {
        return null;
      }
      const columnAttrs = { ...attrs } as Record<string, unknown>;
      const existingClassName = columnAttrs.className ?? columnAttrs['class-name'];
      const existingLabelClassName = columnAttrs.labelClassName ?? columnAttrs['label-class-name'];
      const semanticClass = [
        getV2TableColumnClass(props.definition.kind),
        getV2TableColumnKeyClass(props.definition.key)
      ].join(' ');

      delete columnAttrs['class-name'];
      delete columnAttrs['label-class-name'];
      delete columnAttrs.width;
      delete columnAttrs.minWidth;
      delete columnAttrs['min-width'];
      delete columnAttrs.fixed;
      delete columnAttrs.label;
      delete columnAttrs.columnKey;
      delete columnAttrs['column-key'];

      return h(
        ElTableColumn,
        {
          ...columnAttrs,
          ...(contentWidths
            ? { width: contentWidths.columnWidth(props.definition) }
            : getV2TableColumnWidthProps(props.definition.widthPreset)),
          label: props.definition.label,
          columnKey: props.definition.key,
          fixed:
            visibility?.fixedColumnsEnabled() === false
              ? false
              : props.definition.pin === 'start'
                ? 'left'
                : props.definition.pin === 'end'
                  ? 'right'
                  : undefined,
          align: V2_TABLE_COLUMN_ALIGNMENT[props.definition.kind],
          headerAlign: V2_TABLE_COLUMN_ALIGNMENT[props.definition.kind],
          className: [existingClassName, semanticClass].filter(Boolean).join(' '),
          labelClassName: [existingLabelClassName, semanticClass].filter(Boolean).join(' ')
        },
        slots
      );
    };
  }
});
</script>
