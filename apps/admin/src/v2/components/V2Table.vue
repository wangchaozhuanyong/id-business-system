<script lang="ts">
import {
  defineComponent,
  h,
  nextTick,
  onBeforeUnmount,
  onMounted,
  provide,
  ref,
  watch,
  type PropType
} from 'vue';
import { ElTable } from 'element-plus/es/components/table/index.mjs';
import 'element-plus/es/components/table/style/css';
import { useAuthStore } from '@/stores/auth';
import {
  clearV2TablePreferences,
  ensureV2TablePreferences,
  isV2TableColumnVisible
} from '@/v2/composables/useV2TablePreferences';
import V2TableColumnSettings from './V2TableColumnSettings.vue';
import type { V2TableSchema } from './tableSystem';
import { V2_TABLE_VISIBILITY_CONTEXT } from './tableVisibility';

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
    },
    showColumnSettings: {
      type: Boolean,
      default: true
    },
    applyDefaultColumnVisibility: {
      type: Boolean,
      default: true
    }
  },
  setup(props, { attrs, expose, slots }) {
    const authStore = useAuthStore();
    const tableRef = ref<ElementTableExpose>();
    const shellRef = ref<HTMLElement>();
    const toolbarHeight = ref(0);
    let toolbarObserver: ResizeObserver | undefined;
    onMounted(() => {
      const toolbar = shellRef.value?.querySelector<HTMLElement>(
        ':scope > .v2-table-preference-toolbar'
      );
      if (!toolbar) return;
      const measure = () => {
        toolbarHeight.value = Math.ceil(toolbar.getBoundingClientRect().height);
      };
      measure();
      toolbarObserver = new ResizeObserver(measure);
      toolbarObserver.observe(toolbar);
    });
    onBeforeUnmount(() => toolbarObserver?.disconnect());
    const mobileColumns = window.matchMedia('(max-width: 900px)');
    const isMobile = ref(mobileColumns.matches);
    const syncViewport = () => {
      isMobile.value = mobileColumns.matches;
    };
    onMounted(() => mobileColumns.addEventListener('change', syncViewport));
    onBeforeUnmount(() => mobileColumns.removeEventListener('change', syncViewport));

    provide(V2_TABLE_VISIBILITY_CONTEXT, {
      fixedColumnsEnabled: () => !isMobile.value,
      isColumnVisible: (columnKey) =>
        isV2TableColumnVisible(
          props.schema.id,
          columnKey,
          props.applyDefaultColumnVisibility ? props.schema.defaultHiddenColumnKeys : []
        )
    });

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
      () => authStore.user?.id ?? '',
      (userId) => {
        if (userId) void ensureV2TablePreferences(userId).catch(() => undefined);
        else clearV2TablePreferences();
      },
      { immediate: true }
    );
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
        'div',
        {
          class: 'v2-unified-table-shell',
          ref: shellRef,
          style: { '--v2-table-toolbar-height': `${toolbarHeight.value}px` }
        },
        [
          props.showColumnSettings ? h(V2TableColumnSettings, { schema: props.schema }) : null,
          h(
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
          )
        ]
      );
    };
  }
});
</script>
