import { inject, onBeforeUnmount, onMounted, onUpdated, provide, ref, watch } from 'vue';
import { V2_ASYNC_REGION_PREVIOUS_DATA } from '@/v2/components/asyncRegionContext';
import {
  allocateV2TableContentWidths,
  getV2TableColumnKeyClass,
  getV2TableContentBaseWidth,
  type V2TableContentMeasurement
} from '@/v2/components/tableContentWidth';
import { isV2TableDataColumn, type V2TableSchema } from '@/v2/components/tableSystem';
import { V2_TABLE_CONTENT_WIDTH_CONTEXT } from '@/v2/components/tableVisibility';

export function useV2TableContentWidths(
  schema: () => V2TableSchema,
  viewKey: () => string | number | undefined,
  shell: () => HTMLElement | undefined,
  layout: () => void
) {
  const widths = ref<Record<string, number>>({});
  const tableWidth = ref(0);
  const previousData = inject(V2_ASYNC_REGION_PREVIOUS_DATA, undefined);
  let pendingReset = true;
  let baseWidths: Record<string, number> = {};
  let actionViewport: boolean | undefined;
  let actionPadding: Record<string, number> = {};
  let frame = 0;
  let containerWidth = 0;
  let mounted = false;
  let disposed = false;
  let resizeObserver: ResizeObserver | undefined;
  let contentObserver: MutationObserver | undefined;
  let themeObserver: MutationObserver | undefined;

  provide(V2_TABLE_CONTENT_WIDTH_CONTEXT, {
    columnWidth: (definition) =>
      widths.value[definition.key] ?? getV2TableContentBaseWidth(definition)
  });

  function schedule() {
    if (!mounted || disposed || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      measure();
    });
  }

  function measure() {
    const root = shell();
    const table = root?.querySelector<HTMLElement>(':scope > .v2-unified-table');
    if (!root || !table || !table.getBoundingClientRect().width) return;
    if (pendingReset && previousData?.value !== true) {
      baseWidths = {};
      actionViewport = undefined;
      actionPadding = {};
      pendingReset = false;
    }
    const mobile = window.matchMedia('(max-width: 900px)').matches;
    if (mobile !== actionViewport) {
      // Touch buttons are larger; do not retain their reserved width on desktop.
      for (const column of schema().columns) {
        if (column.kind === 'actions') {
          delete baseWidths[column.key];
          delete actionPadding[column.key];
        }
      }
      actionViewport = mobile;
    }
    containerWidth = root.clientWidth;
    const measurements = measureContent(table, schema());
    const columns = schema().columns.filter(
      (column) => !isV2TableDataColumn(column) || measurements.has(column.key)
    );
    for (const column of columns) {
      if (column.kind === 'actions' && !measurements.has(column.key)) continue;
      const measurement = measurements.get(column.key);
      let previous = baseWidths[column.key];
      if (column.kind === 'actions' && measurement) {
        const padding = measurement.padding ?? 0;
        // Cache content, not the old container's padding, when a table contracts.
        previous = previous ? previous - (actionPadding[column.key] ?? padding) + padding : 0;
        actionPadding[column.key] = padding;
      }
      baseWidths[column.key] = getV2TableContentBaseWidth(column, measurement, previous);
    }
    const allocation = allocateV2TableContentWidths(columns, baseWidths, containerWidth);
    if (
      tableWidth.value === allocation.tableWidth &&
      Object.keys(widths.value).length === columns.length &&
      columns.every((column) => widths.value[column.key] === allocation.widths[column.key])
    )
      return;
    widths.value = allocation.widths;
    tableWidth.value = allocation.tableWidth;
    layout();
  }

  watch(
    () => [schema().id, viewKey()] as const,
    () => {
      // Keep the old view visible while its replacement is pending or failed.
      pendingReset = true;
      schedule();
    }
  );
  watch(() => previousData?.value, schedule, { flush: 'post' });
  onUpdated(schedule);
  onMounted(() => {
    mounted = true;
    const root = shell();
    if (!root) return;
    resizeObserver = new ResizeObserver(() => {
      // ResizeObserver runs before paint. Update the allocation in this delivery
      // so the new shell width and column widths appear in the same frame.
      if (root.clientWidth !== containerWidth) measure();
    });
    resizeObserver.observe(root);
    contentObserver = new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            record.type === 'characterData' ||
            [...record.addedNodes, ...record.removedNodes].some(
              (node) =>
                !(
                  node instanceof HTMLElement &&
                  node.hasAttribute('data-v2-table-width-measurement')
                )
            )
        )
      )
        schedule();
    });
    contentObserver.observe(root, { subtree: true, childList: true, characterData: true });
    themeObserver = new MutationObserver(schedule);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-v2-theme']
    });
    void document.fonts?.ready.then(schedule);
    document.fonts?.addEventListener('loadingdone', schedule);
    schedule();
  });
  onBeforeUnmount(() => {
    disposed = true;
    cancelAnimationFrame(frame);
    resizeObserver?.disconnect();
    contentObserver?.disconnect();
    themeObserver?.disconnect();
    document.fonts?.removeEventListener('loadingdone', schedule);
  });
  return { tableWidth };
}

function measureContent(table: HTMLElement, schema: V2TableSchema) {
  const measurements = new Map<string, V2TableContentMeasurement>();
  const host = document.createElement('div');
  host.setAttribute('data-v2-table-width-measurement', '');
  host.style.cssText =
    'position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none;display:flex';
  const samples: { key: string; header: boolean; clone: HTMLElement; padding: number }[] = [];
  for (const definition of schema.columns) {
    if (definition.kind === 'control') continue;
    const keyClass = getV2TableColumnKeyClass(definition.key);
    const cells = table.querySelectorAll<HTMLElement>(
      `th.${keyClass} > .cell, td.${keyClass} > .cell`
    );
    for (const cell of cells) {
      if (cell.closest('.v2-unified-table') !== table) continue;
      const wrapper = document.createElement('div');
      wrapper.className = cell.parentElement?.className ?? '';
      wrapper.style.cssText =
        'position:static!important;flex:none;width:max-content;min-width:0;max-width:none';
      const clone = cell.cloneNode(true) as HTMLElement;
      const style = getComputedStyle(cell);
      clone.style.width = 'max-content';
      clone.style.minWidth = '0';
      clone.style.maxWidth = 'none';
      clone.style.overflow = 'visible';
      clone.style.font = style.font;
      clone.style.fontVariantNumeric = style.fontVariantNumeric;
      clone.style.letterSpacing = style.letterSpacing;
      clone.style.paddingLeft = style.paddingLeft;
      clone.style.paddingRight = style.paddingRight;
      for (const group of clone.querySelectorAll<HTMLElement>('.v2-table-actions')) {
        group.style.width = 'max-content';
        group.style.maxWidth = 'none';
      }
      wrapper.append(clone);
      host.append(wrapper);
      samples.push({
        key: definition.key,
        header: cell.parentElement?.tagName === 'TH',
        clone,
        padding: Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight)
      });
    }
  }
  table.append(host);
  try {
    for (const { key, header, clone, padding } of samples) {
      const measurement = measurements.get(key) ?? { header: 0, content: 0 };
      const kind = header ? 'header' : 'content';
      measurement[kind] = Math.max(measurement[kind], clone.getBoundingClientRect().width);
      measurement.padding = Math.max(measurement.padding ?? 0, padding);
      measurements.set(key, measurement);
    }
  } finally {
    host.remove();
  }
  return measurements;
}
