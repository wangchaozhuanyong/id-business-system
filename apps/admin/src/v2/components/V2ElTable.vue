<script lang="ts">
import { defineComponent, h } from 'vue';
import { ElTable } from 'element-plus/es/components/table/index.mjs';

export default defineComponent({
  name: 'V2ElTable',
  inheritAttrs: false,
  setup(_, { attrs, slots }) {
    return () => {
      const tableAttrs = { ...attrs };
      return h(
        ElTable,
        {
          fit: true,
          tableLayout: 'auto',
          scrollbarAlwaysOn: true,
          ...tableAttrs,
          class: ['v2-adaptive-table', tableAttrs.class]
        },
        slots
      );
    };
  }
});
</script>
