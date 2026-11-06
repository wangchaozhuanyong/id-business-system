import type {
  InventorySelection,
  V2ExtractionItem,
  V2GptExtractionItem,
  V2AppleExtractionItem,
  V2ClaudeExtractionItem
} from './contracts.ts';

export type InventoryExtractionRow =
  | V2ExtractionItem
  | V2GptExtractionItem
  | V2AppleExtractionItem
  | V2ClaudeExtractionItem;

function inventoryItemAsset(row: InventoryExtractionRow) {
  if ('appleAccount' in row) return row.appleAccount;
  if ('claudeAccount' in row) return row.claudeAccount;
  return 'account' in row ? row.account : row.mailbox;
}

export function inventoryItemEmail(row: InventoryExtractionRow) {
  const asset = inventoryItemAsset(row);
  return 'appleId' in asset ? asset.appleId : asset.email;
}

export function inventoryItemReturnBlocker(row: InventoryExtractionRow) {
  return (
    inventoryItemBlocker(row) ||
    ('returnBlockedReason' in row ? (row.returnBlockedReason ?? '') : '')
  );
}

export function inventoryItemBlocker(row: InventoryExtractionRow): string {
  const stock = inventoryItemAsset(row).stock;
  if (row.state === 'returned') return '已归还';
  if (row.state === 'used') return '已确认使用';
  if (stock.state !== 'extracted' || stock.currentExtractionItemId !== row.id) {
    return '库存占用已变化';
  }
  return '';
}

export function inventorySelectedItems(
  selected: Readonly<Record<string, number>>,
  items: readonly InventoryExtractionRow[]
) {
  const rows = new Map(items.map((row) => [row.id, row]));
  const requests: InventorySelection[] = [];
  let blocked = 0;
  for (const id of Object.keys(selected).sort()) {
    const row = rows.get(id);
    if (!row || inventoryItemBlocker(row) || row.version !== selected[id]) blocked++;
    else requests.push({ id, expectedVersion: selected[id] });
  }
  return { requests, blocked };
}
