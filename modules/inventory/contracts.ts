export type {
  V2ExtractableInventoryKind,
  V2ClaudeAccountInput,
  V2ClaudeAccount,
  V2ClaudeAccountQuery,
  V2ClaudeInventoryPolicy,
  V2ClaudeProxyKind,
  V2ClaudeProxyProtocol,
  V2ClaudeKycStatus,
  V2ClaudeExtractionItem,
  V2ClaudeExtractionDetail,
  V2AppleAccountInput,
  V2AppleAccount,
  V2AppleAccountQuery,
  V2AppleExtractionItem,
  V2AppleExtractionDetail,
  V2GptAccount,
  V2GptExtractionDetail,
  V2GptExtractionItem,
  V2InventoryExtractInput,
  V2ExtractionBatch,
  V2ExtractionDetail,
  V2ExtractionItem,
  V2ExtractionState,
  V2GoogleMailbox,
  V2GoogleMailboxInput,
  V2GoogleMailboxQuery,
  V2InventoryActor,
  V2InventoryCommandResult,
  V2InventoryEvent,
  V2InventoryHealth,
  V2InventoryImportBatch,
  V2InventoryOption,
  V2InventoryPage,
  V2InventoryPreflight,
  V2InventoryState
} from '../contracts/inventory.ts';

export interface InventorySelection {
  id: string;
  expectedVersion: number;
}
export interface InventoryPageQuery {
  page: number;
  pageSize: number;
  keyword?: string;
}
export interface InventoryExtractionQuery extends InventoryPageQuery {
  mine?: boolean;
  kind?: import('../contracts/inventory.ts').V2ExtractableInventoryKind;
}
export type GoogleOptionKind = 'country' | 'source';
