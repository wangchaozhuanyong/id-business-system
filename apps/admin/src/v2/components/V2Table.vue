<script lang="ts">
import { defineComponent, h, nextTick, onMounted, ref, watch, type PropType } from 'vue';
import { ElTable } from 'element-plus/es/components/table/index.mjs';
import 'element-plus/es/components/table/style/css';
import type { V2TableSchema } from './tableSystem';

type ElementTableExpose = {
  setScrollLeft?: (left: number) => void;
  scrollTo?: (
    options:
      | {
          behavior?: 'auto' | 'instant' | 'smooth';
          left?: number;
          top?: number;
        }
      | number,
    yCoord?: number
  ) => void;
};

export default defineComponent({
  name: 'V2Table',
  inheritAttrs: false,
  props: {
    schema: {
      type: Object as PropType<V2TableSchema>,
      required: true
    },
    viewKey: {
      type: [String, Number] as PropType<string | number>,
      default: undefined
    }
  },
  setup(props, { attrs, expose, slots }) {
    const tableRef = ref<ElementTableExpose>();

    function setScrollLeft(left: number) {
      tableRef.value?.setScrollLeft?.(Math.max(0, left));
    }

    function scrollToStart() {
      setScrollLeft(0);
    }

    async function resetViewScroll() {
      await nextTick();
      scrollToStart();
    }

    onMounted(resetViewScroll);
    watch(
      () => [props.schema.id, props.viewKey ?? props.schema.id] as const,
      (current, previous) => {
        if (!previous || current[0] !== previous[0] || current[1] !== previous[1]) {
          scrollToStart();
          void resetViewScroll();
        }
      }
    );

    expose({ setScrollLeft, scrollToStart });

    return () => {
      const tableAttrs = { ...attrs } as Record<string, unknown>;
      const inheritedClass = tableAttrs.class;
      delete tableAttrs.class;
      if (props.schema.rowKey?.kind === 'path') {
        delete tableAttrs['row-key'];
        tableAttrs.rowKey = props.schema.rowKey.value;
      }

      return h(
        ElTable,
        {
          ...tableAttrs,
          ref: tableRef,
          fit: true,
          flexible: true,
          tableLayout: 'fixed',
          scrollbarAlwaysOn: true,
          showOverflowTooltip: true,
          class: ['v2-unified-table', inheritedClass],
          'data-table-schema': props.schema.id,
          'data-mobile-mode': props.schema.mobileMode
        },
        slots
      );
    };
  }
});
</script>
