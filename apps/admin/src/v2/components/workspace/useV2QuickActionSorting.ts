import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { V2QuickActionItem } from '@apple-business/shared';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { sortQuickActions } from './quickActionOrder';

export function useV2QuickActionSorting(options: {
  items: () => V2QuickActionItem[];
  enabled: () => boolean;
  reorder: (ids: string[]) => Promise<void>;
}) {
  const ordering = ref(false);
  const orderedIds = ref<string[]>([]);
  const tableScroll = ref<HTMLElement>();
  const cardsScroll = ref<HTMLElement>();
  const drag = ref<{ id: string; targetId: string; after: boolean }>();
  let handle: HTMLElement | undefined;
  let pointerId = -1;
  let startY = 0;
  let pointerX = 0;
  let pointerY = 0;
  let frame = 0;

  const customItems = computed(() => sortQuickActions(options.items(), orderedIds.value));
  watch(options.items, () => {
    cancelDrag();
    if (!ordering.value) orderedIds.value = [];
  });

  function rowClass({ row }: { row: V2QuickActionItem }) {
    if (drag.value?.id === row.id) return 'is-sorting';
    if (drag.value?.targetId === row.id) return drag.value.after ? 'sort-after' : 'sort-before';
    return '';
  }

  function cancelDrag() {
    cancelAnimationFrame(frame);
    const oldHandle = handle;
    const oldPointerId = pointerId;
    drag.value = undefined;
    handle = undefined;
    pointerId = -1;
    if (oldHandle?.hasPointerCapture(oldPointerId)) oldHandle.releasePointerCapture(oldPointerId);
  }

  function updateTarget() {
    if (!drag.value) return;
    const scroll = handle?.closest<HTMLElement>(
      '.v2-quick-actions-drawer__table-scroll, .v2-quick-actions-drawer__cards'
    );
    const bounds = scroll?.getBoundingClientRect();
    drag.value.targetId = '';
    if (
      scroll &&
      bounds &&
      Math.abs(pointerY - startY) >= 5 &&
      pointerX >= bounds.left &&
      pointerX <= bounds.right &&
      pointerY >= bounds.top &&
      pointerY <= bounds.bottom
    ) {
      if (pointerY < bounds.top + 36) scroll.scrollTop -= 10;
      else if (pointerY > bounds.bottom - 36) scroll.scrollTop += 10;
      for (const candidate of scroll.querySelectorAll<HTMLElement>('[data-sort-id]')) {
        const row = candidate.closest<HTMLElement>(
          '.el-table__row, .v2-quick-actions-drawer__card'
        );
        if (!row) continue;
        const rect = row.getBoundingClientRect();
        if (pointerY >= rect.top && pointerY <= rect.bottom) {
          drag.value.targetId = candidate.dataset.sortId ?? '';
          drag.value.after = pointerY > rect.top + rect.height / 2;
          break;
        }
      }
    }
  }

  function trackDrag() {
    if (!drag.value) return;
    updateTarget();
    frame = requestAnimationFrame(trackDrag);
  }

  function startDrag(event: PointerEvent, id: string) {
    if (!options.enabled() || !event.isPrimary || event.button !== 0) return;
    cancelDrag();
    handle = event.currentTarget as HTMLElement;
    pointerId = event.pointerId;
    startY = pointerY = event.clientY;
    pointerX = event.clientX;
    drag.value = { id, targetId: '', after: false };
    handle.setPointerCapture(pointerId);
    frame = requestAnimationFrame(trackDrag);
  }

  function moveDrag(event: PointerEvent) {
    if (!drag.value || event.pointerId !== pointerId) return;
    pointerX = event.clientX;
    pointerY = event.clientY;
  }

  async function saveOrder(ids: string[], focusId: string) {
    const previous = orderedIds.value;
    if (ids.every((id, index) => id === customItems.value[index]?.id)) return;
    orderedIds.value = ids;
    ordering.value = true;
    try {
      await options.reorder(ids);
      orderedIds.value = [];
      ElMessage.success('顺序已保存');
    } catch (error) {
      orderedIds.value = previous;
      ElMessage.error(error instanceof Error ? error.message : '顺序保存失败，请重新拖动重试');
    } finally {
      ordering.value = false;
      await nextTick();
      const handles = [tableScroll.value, cardsScroll.value].flatMap((root) => [
        ...(root?.querySelectorAll<HTMLElement>('[data-sort-id]') ?? [])
      ]);
      handles
        .find(
          (candidate) => candidate.dataset.sortId === focusId && candidate.getClientRects().length
        )
        ?.focus({ preventScroll: true });
    }
  }

  async function finishDrag(event: PointerEvent) {
    if (!drag.value || event.pointerId !== pointerId) return;
    pointerX = event.clientX;
    pointerY = event.clientY;
    updateTarget();
    const { id, targetId, after } = drag.value;
    cancelDrag();
    if (!options.enabled() || !targetId || id === targetId) return;
    const ids = customItems.value.map((item) => item.id).filter((itemId) => itemId !== id);
    const target = ids.indexOf(targetId);
    if (target < 0) return;
    ids.splice(target + Number(after), 0, id);
    await saveOrder(ids, id);
  }

  async function moveWithKeyboard(event: KeyboardEvent, id: string) {
    if (event.key === 'Escape') {
      if (drag.value) {
        event.preventDefault();
        event.stopPropagation();
        cancelDrag();
      }
      return;
    }
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!options.enabled()) return;
    const ids = customItems.value.map((item) => item.id);
    const index = ids.indexOf(id);
    const target = index + (event.key === 'ArrowUp' ? -1 : 1);
    if (index < 0 || target < 0 || target >= ids.length) return;
    ids.splice(index, 1);
    ids.splice(target, 0, id);
    await saveOrder(ids, id);
  }

  onBeforeUnmount(cancelDrag);
  return {
    ordering,
    customItems,
    tableScroll,
    cardsScroll,
    rowClass,
    startDrag,
    moveDrag,
    finishDrag,
    cancelDrag,
    moveWithKeyboard
  };
}
