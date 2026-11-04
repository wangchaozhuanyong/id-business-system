import { inject, onBeforeUnmount, onMounted, provide, ref, toRaw, watch } from 'vue';
import { recordV2InteractionSample } from '@/v2/runtime/interactionDiagnostics';
import { V2_ASYNC_REGION_PREVIOUS_DATA } from '@/v2/components/asyncRegionContext';
import {
  allocateV2TableContentWidths,
  getV2TableColumnKeyClass,
  getV2TableContentBaseWidth,
  type V2TableContentMeasurement
} from '@/v2/components/tableContentWidth';
import { isV2TableDataColumn, type V2TableSchema } from '@/v2/components/tableSystem';
import { V2_TABLE_CONTENT_WIDTH_CONTEXT } from '@/v2/components/tableVisibility';

interface RememberedWidths {
  widths: Record<string, number>;
  tableWidth: number;
  baseWidths: Record<string, number>;
  actionPadding: Record<string, number>;
  actionViewport?: boolean;
  contentKey?: string;
}
// Only numeric layout metadata follows the existing query's array identity. No rows are retained.
const rememberedWidths = new WeakMap<
  object,
  Map<string, { fingerprint: string; value: RememberedWidths }>
>();
function fingerprint(value: unknown) {
  try {
    const text = JSON.stringify(value && typeof value === 'object' ? toRaw(value) : value);
    if (text === undefined) return '';
    let a = 2166136261,
      b = 5381;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      a = Math.imul(a ^ code, 16777619);
      b = Math.imul(b, 33) ^ code;
    }
    return `${text.length}:${a >>> 0}:${b >>> 0}`;
  } catch {
    return '';
  }
}
let fontRevision = 0;
export function rememberV2TableWidths(data: unknown, key: string, value: RememberedWidths) {
  if (!data || typeof data !== 'object') return;
  const stamp = fingerprint(data);
  if (!stamp) return;
  const entries = rememberedWidths.get(data) ?? new Map();
  entries.set(key, { fingerprint: stamp, value });
  while (entries.size > 4) entries.delete(entries.keys().next().value!);
  rememberedWidths.set(data, entries);
}
export function recallV2TableWidths(data: unknown, key: string, validateData = true) {
  if (!data || typeof data !== 'object') return undefined;
  const cached = rememberedWidths.get(data)?.get(key);
  if (!cached) return undefined;
  return !validateData || cached.fingerprint === fingerprint(data) ? cached.value : undefined;
}

// Read rendered content without serializing hidden fields or copying whole HTML trees.
// Numeric widths may be restored provisionally; only this DOM key can skip measurement.
export function getV2TableContentKey(table: HTMLElement) {
  let a = 2166136261,
    b = 5381,
    length = 0;
  const add = (value: string | null) => {
    const text = value ?? '';
    length += text.length;
    a = Math.imul(a ^ text.length, 16777619);
    b = Math.imul(b, 33) ^ text.length;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      a = Math.imul(a ^ code, 16777619);
      b = Math.imul(b, 33) ^ code;
    }
  };
  const element = (node: Element) => {
    add(node.tagName);
    add(node.getAttribute('class'));
    add(node.getAttribute('style'));
    add(node.getAttribute('width'));
    add(node.getAttribute('height'));
  };
  for (const cell of table.querySelectorAll<HTMLElement>(
    '.el-table__header-wrapper .cell, .el-table__body-wrapper .cell'
  )) {
    if (cell.closest('.v2-unified-table') !== table) continue;
    add(cell.textContent);
    element(cell);
    for (const child of cell.querySelectorAll('*')) element(child);
  }
  return `${length}:${a >>> 0}:${b >>> 0}`;
}

export function useV2TableContentWidths(
  schema: () => V2TableSchema,
  viewKey: () => string | number | undefined,
  shell: () => HTMLElement | undefined,
  layout: () => void,
  data: () => unknown = () => undefined,
  visibilityKey: () => string = () => ''
) {
  const cacheKey = () =>
    JSON.stringify([
      schema(),
      viewKey(),
      visibilityKey(),
      window.innerWidth,
      document.documentElement.getAttribute('data-v2-theme'),
      fontRevision
    ]);
  const restored = recallV2TableWidths(data(), cacheKey(), false);
  const widths = ref<Record<string, number>>({ ...restored?.widths });
  const tableWidth = ref(restored?.tableWidth ?? 0);
  const previousData = inject(V2_ASYNC_REGION_PREVIOUS_DATA, undefined);
  const measurementCache = new Map<string, number>();
  let pendingReset = !restored;
  let baseWidths: Record<string, number> = { ...restored?.baseWidths };
  let actionViewport: boolean | undefined = restored?.actionViewport;
  let actionPadding: Record<string, number> = { ...restored?.actionPadding };
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

  function invalidateMeasurements() {
    fontRevision++;
    measurementCache.clear();
    schedule();
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
    const startedAt = performance.now();
    containerWidth = root.clientWidth;
    const contentKey = getV2TableContentKey(table);
    const cached = recallV2TableWidths(data(), cacheKey(), false);
    if (
      cached?.tableWidth === containerWidth &&
      tableWidth.value === cached.tableWidth &&
      Object.keys(widths.value).length === Object.keys(cached.widths).length &&
      Object.keys(cached.widths).every((key) => widths.value[key] === cached.widths[key]) &&
      cached.actionViewport === mobile &&
      cached.contentKey === contentKey
    ) {
      recordV2InteractionSample('table-measure', performance.now() - startedAt);
      return;
    }
    const measurements = measureV2TableContent(table, schema(), measurementCache);
    recordV2InteractionSample('table-measure', performance.now() - startedAt);
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
    rememberV2TableWidths(data(), cacheKey(), {
      ...allocation,
      baseWidths: { ...baseWidths },
      actionPadding: { ...actionPadding },
      actionViewport,
      contentKey
    });
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
  onMounted(() => {
    mounted = true;
    const root = shell();
    if (!root) return;
    resizeObserver = new ResizeObserver(() => {
      if (root.clientWidth !== containerWidth) schedule();
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
    themeObserver = new MutationObserver(invalidateMeasurements);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-v2-theme']
    });
    if (document.fonts?.status === 'loading')
      void document.fonts.ready.then(invalidateMeasurements);
    document.fonts?.addEventListener('loadingdone', invalidateMeasurements);
    schedule();
  });
  onBeforeUnmount(() => {
    disposed = true;
    measurementCache.clear();
    cancelAnimationFrame(frame);
    resizeObserver?.disconnect();
    contentObserver?.disconnect();
    themeObserver?.disconnect();
    document.fonts?.removeEventListener('loadingdone', invalidateMeasurements);
  });
  return { tableWidth };
}

export function measureV2TableContent(
  table: HTMLElement,
  schema: V2TableSchema,
  cache: Map<string, number>
) {
  const measurements = new Map<string, V2TableContentMeasurement>();
  const host = document.createElement('div');
  host.setAttribute('data-v2-table-width-measurement', '');
  host.style.cssText =
    'position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none;display:flex';
  const samples: {
    cacheKey: string;
    key: string;
    header: boolean;
    clone: HTMLElement;
    padding: number;
  }[] = [];
  const pending = new Set<string>();
  for (const definition of schema.columns) {
    if (definition.kind === 'control') continue;
    const keyClass = getV2TableColumnKeyClass(definition.key);
    const cells = table.querySelectorAll<HTMLElement>(
      `th.${keyClass} > .cell, td.${keyClass} > .cell`
    );
    // These presets deliberately ignore content measurements in the allocator.
    // Keep their visibility signal without cloning cells that cannot affect width.
    if (
      isV2TableDataColumn(definition) &&
      (definition.pin ||
        definition.kind === 'index' ||
        ['dateTime', 'inlineContent'].includes(definition.widthPreset))
    ) {
      if ([...cells].some((cell) => cell.closest('.v2-unified-table') === table))
        measurements.set(definition.key, { header: 0, content: 0 });
      continue;
    }
    for (const cell of cells) {
      if (cell.closest('.v2-unified-table') !== table) continue;
      const style = getComputedStyle(cell);
      const header = cell.parentElement?.tagName === 'TH';
      const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      const cacheKey = JSON.stringify([
        definition.key,
        header,
        cell.innerHTML,
        cell.parentElement?.className,
        style.font,
        style.fontVariantNumeric,
        style.letterSpacing,
        style.paddingLeft,
        style.paddingRight,
        window.innerWidth
      ]);
      const cached = cache.get(cacheKey);
      if (cached !== undefined) {
        const measurement = measurements.get(definition.key) ?? { header: 0, content: 0 };
        const kind = header ? 'header' : 'content';
        measurement[kind] = Math.max(measurement[kind], cached);
        measurement.padding = Math.max(measurement.padding ?? 0, padding);
        measurements.set(definition.key, measurement);
        continue;
      }
      if (pending.has(cacheKey)) continue;
      pending.add(cacheKey);
      const wrapper = document.createElement('div');
      wrapper.className = cell.parentElement?.className ?? '';
      wrapper.style.cssText =
        'position:static!important;flex:none;width:max-content;min-width:0;max-width:none';
      const clone = cell.cloneNode(true) as HTMLElement;
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
        cacheKey,
        key: definition.key,
        header: cell.parentElement?.tagName === 'TH',
        clone,
        padding: Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight)
      });
    }
  }
  if (samples.length) table.append(host);
  try {
    for (const { cacheKey, key, header, clone, padding } of samples) {
      const measurement = measurements.get(key) ?? { header: 0, content: 0 };
      const kind = header ? 'header' : 'content';
      const width = clone.getBoundingClientRect().width;
      cache.set(cacheKey, width);
      measurement[kind] = Math.max(measurement[kind], width);
      measurement.padding = Math.max(measurement.padding ?? 0, padding);
      measurements.set(key, measurement);
    }
  } finally {
    host.remove();
    while (cache.size > 500) cache.delete(cache.keys().next().value!);
  }
  return measurements;
}
