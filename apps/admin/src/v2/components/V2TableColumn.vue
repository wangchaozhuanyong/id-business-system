<script lang="ts">
import { defineComponent, h, type PropType } from 'vue';
import { ElTableColumn } from 'element-plus/es/components/table/index.mjs';
import type { V2TableDataColumnDefinition } from './tableSystem';
import {
  getV2TableColumnClass,
  getV2TableColumnWidthProps,
  V2_TABLE_COLUMN_ALIGNMENT
} from './tableColumn';

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
    return () => {
      const columnAttrs = { ...attrs } as Record<string, unknown>;
      const existingClassName = columnAttrs.className ?? columnAttrs['class-name'];
      const existingLabelClassName = columnAttrs.labelClassName ?? columnAttrs['label-class-name'];
      const semanticClass = getV2TableColumnClass(props.definition.kind);
      const pinned = props.definition.pin !== undefined;

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
          ...getV2TableColumnWidthProps(
            props.definition.kind,
            props.definition.widthPreset,
            pinned
          ),
          label: props.definition.label,
          columnKey: props.definition.key,
          fixed:
            props.definition.pin === 'start'
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
