<script lang="ts">
import { defineComponent, h, type PropType } from 'vue';
import { ElTableColumn } from 'element-plus/es/components/table/index.mjs';
import {
  getV2TableColumnClass,
  V2_TABLE_COLUMN_ALIGNMENT,
  V2_TABLE_COLUMN_WIDTH,
  type V2TableColumnKind,
  type V2TableColumnWidthPreset
} from './tableColumn';

export default defineComponent({
  name: 'V2TableColumn',
  inheritAttrs: false,
  props: {
    kind: {
      type: String as PropType<V2TableColumnKind>,
      required: true
    },
    widthPreset: {
      type: String as PropType<V2TableColumnWidthPreset>,
      default: undefined
    }
  },
  setup(props, { attrs, slots }) {
    return () => {
      const columnAttrs = { ...attrs } as Record<string, unknown>;
      const existingClassName = columnAttrs.className ?? columnAttrs['class-name'];
      const existingLabelClassName = columnAttrs.labelClassName ?? columnAttrs['label-class-name'];
      const hasExplicitWidth =
        columnAttrs.width !== undefined ||
        columnAttrs.minWidth !== undefined ||
        columnAttrs['min-width'] !== undefined;
      const widthPreset = props.widthPreset ?? (props.kind === 'index' ? 'index' : undefined);
      const semanticClass = getV2TableColumnClass(props.kind);

      delete columnAttrs['class-name'];
      delete columnAttrs['label-class-name'];

      return h(
        ElTableColumn,
        {
          ...columnAttrs,
          ...(widthPreset && !hasExplicitWidth
            ? props.kind === 'index'
              ? { width: V2_TABLE_COLUMN_WIDTH[widthPreset] }
              : { minWidth: V2_TABLE_COLUMN_WIDTH[widthPreset] }
            : {}),
          align: V2_TABLE_COLUMN_ALIGNMENT[props.kind],
          headerAlign: V2_TABLE_COLUMN_ALIGNMENT[props.kind],
          className: [existingClassName, semanticClass].filter(Boolean).join(' '),
          labelClassName: [existingLabelClassName, semanticClass].filter(Boolean).join(' ')
        },
        slots
      );
    };
  }
});
</script>
