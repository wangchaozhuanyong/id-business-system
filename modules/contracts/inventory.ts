export type V2InventoryKind = 'google_mailbox' | 'apple_id' | 'gpt_account' | 'claude_account';
export type V2InventoryHealth = 'normal' | 'frozen' | 'restricted' | 'dead' | 'unsealing';
export type V2InventoryState = 'available' | 'extracted' | 'used';
export type V2ExtractionState = 'pending' | 'used' | 'returned';
export type V2InventoryOptionKind = 'country' | 'source' | 'city' | 'category';
export interface V2InventoryActor {
  id: string;
  username: string;
  displayName: string;
}
export interface V2InventoryOption {
  id: string;
  scope: V2InventoryKind | 'mail_category';
  kind: V2InventoryOptionKind;
  name: string;
  parentId: string | null;
  legacyCountryOptionId?: string;
  active: boolean;
  version: number;
}
export interface V2GoogleMailboxInput {
  email: string;
  password: string;
  totpSecret?: string;
  recoveryEmail?: string;
  phone?: string;
  phoneUnboundConfirmed: boolean;
  countryOptionId?: string | null;
  appPassword?: string;
  health: V2InventoryHealth;
  sourceOptionId: string;
  registeredAt?: string | null;
  loginDevice?: string;
  remark1?: string;
  remark2?: string;
}
export interface V2GoogleMailbox extends V2GoogleMailboxInput {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  canRevert?: boolean;
  createdBy: V2InventoryActor | null;
  updatedBy: V2InventoryActor | null;
  country: V2InventoryOption | null;
  source: V2InventoryOption;
  stock: {
    id: string;
    version: number;
    state: V2InventoryState;
    currentExtractionItemId: string | null;
  };
}
export interface V2GptAccountInput {
  email: string;
  password?: string;
  totpSecret?: string;
  registrationCountryCode?: string | null;
  registrationIp?: string;
  countryOptionId?: string | null;
  sourceOptionId: string;
  mailCategoryOptionId: string;
  health: V2InventoryHealth;
  registeredAt?: string | null;
  loginDevice?: string;
  remark1?: string;
  remark2?: string;
}
export interface V2GptAccount extends V2GptAccountInput {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: V2InventoryActor | null;
  updatedBy: V2InventoryActor | null;
  country: V2InventoryOption | null;
  source: V2InventoryOption;
  mailCategory: V2InventoryOption;
  stock: V2GoogleMailbox['stock'];
}
export interface V2GptAccountQuery extends V2GoogleMailboxQuery {
  mailCategoryOptionId?: string;
}
export interface V2AppleAccountInput {
  appleId: string;
  password: string;
  phone?: string;
  phoneUnboundConfirmed: boolean;
  countryOptionId: string;
  sourceOptionId: string;
  health: V2InventoryHealth;
  security1?: string;
  security2?: string;
  security3?: string;
  birthday?: string | null;
  appPassword?: string;
  registeredAt?: string | null;
  loginDevice?: string;
  remark1?: string;
  remark2?: string;
}
export interface V2AppleAccount extends V2AppleAccountInput {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: V2InventoryActor | null;
  updatedBy: V2InventoryActor | null;
  country: V2InventoryOption;
  source: V2InventoryOption;
  stock: V2GoogleMailbox['stock'];
}
export type V2AppleAccountQuery = V2GoogleMailboxQuery;
export type V2ClaudeProxyKind = 'dynamic_residential' | 'static_residential' | 'mobile';
export type V2ClaudeProxyProtocol = 'http' | 'https' | 'socks5';
export type V2ClaudeKycStatus = 'unknown' | 'verified' | 'unverified';
export interface V2ClaudeAccountInput {
  email: string;
  password?: string;
  mailCategoryOptionId: string;
  countryOptionId: string;
  cityOptionId: string;
  registrationIpLink?: string;
  proxyKind?: V2ClaudeProxyKind | null;
  proxyProtocol?: V2ClaudeProxyProtocol | null;
  proxyHost?: string;
  proxyPort?: number | null;
  proxyUsername?: string;
  proxyPassword?: string;
  registeredAt?: string | null;
  kycStatus?: V2ClaudeKycStatus;
  kycSource?: string;
  health: V2InventoryHealth;
  remark1?: string;
  remark2?: string;
}
export interface V2ClaudeAccount extends V2ClaudeAccountInput {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: V2InventoryActor | null;
  updatedBy: V2InventoryActor | null;
  country: V2InventoryOption;
  city: V2InventoryOption;
  mailCategory: V2InventoryOption;
  stock: V2GoogleMailbox['stock'];
  kycStatus: V2ClaudeKycStatus;
  ageHours: number | null;
  agingHours: number;
  eligible: boolean;
}
export interface V2ClaudeAccountQuery extends Omit<V2GptAccountQuery, 'sourceOptionId'> {
  cityOptionId?: string;
  eligible?: boolean;
}
export interface V2ClaudeInventoryPolicy {
  id: 'claude';
  agingHours: number;
  version: number;
  updatedAt: string | null;
  updatedBy: V2InventoryActor | null;
}
export type V2ExtractableInventoryKind = V2InventoryKind;
export interface V2InventoryExtractInput {
  kind: V2ExtractableInventoryKind;
  count: number;
  purpose: string;
  remark: string;
  countryOptionId?: string;
  sourceOptionId?: string;
  cityOptionId?: string;
  mailCategoryOptionId?: string;
}
export interface V2InventoryPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
export interface V2GoogleMailboxQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  health?: V2InventoryHealth | 'all';
  state?: V2InventoryState | 'all';
  countryOptionId?: string;
  sourceOptionId?: string;
}
export interface V2InventoryPreflight {
  valid: boolean;
  total: number;
  errors: { row: number; field: string; message: string }[];
}
export interface V2InventoryCommandResult {
  id: string;
  itemIds?: string[];
  count?: number;
  version?: number;
}
export interface V2InventoryImportBatch {
  id: string;
  kind: V2InventoryKind;
  rowCount: number;
  templateVersion: number;
  createdAt: string;
  createdBy: V2InventoryActor | null;
}
export interface V2ExtractionItem {
  id: string;
  version: number;
  state: V2ExtractionState;
  stockId: string;
  mailbox: V2GoogleMailbox;
  usedAt: string | null;
  returnedAt: string | null;
  usedBy: V2InventoryActor | null;
  returnedBy: V2InventoryActor | null;
  returnReason?: string | null;
  returnRemark?: string | null;
  useReason?: string | null;
  useRemark?: string | null;
}
export interface V2ExtractionBatch {
  id: string;
  kind: V2InventoryKind;
  purpose: string;
  remark: string | null;
  quantity: number;
  createdAt: string;
  createdBy: V2InventoryActor | null;
  counts: { pending: number; used: number; returned: number };
}
export interface V2ExtractionDetail extends V2ExtractionBatch {
  items: V2ExtractionItem[];
}
export interface V2GptExtractionItem extends Omit<V2ExtractionItem, 'mailbox'> {
  account: V2GptAccount;
  returnBlockedReason?: string;
}
export interface V2GptExtractionDetail extends V2ExtractionBatch {
  items: V2GptExtractionItem[];
}
export interface V2AppleExtractionItem extends Omit<V2ExtractionItem, 'mailbox'> {
  appleAccount: V2AppleAccount;
  returnBlockedReason?: string;
}
export interface V2AppleExtractionDetail extends V2ExtractionBatch {
  items: V2AppleExtractionItem[];
}
export interface V2ClaudeExtractionItem extends Omit<V2ExtractionItem, 'mailbox'> {
  claudeAccount: V2ClaudeAccount;
  returnBlockedReason?: string;
}
export interface V2ClaudeExtractionDetail extends V2ExtractionBatch {
  items: V2ClaudeExtractionItem[];
}
export interface V2InventoryEvent {
  id: string;
  action: string;
  stockId: string | null;
  batchId: string | null;
  itemId: string | null;
  createdAt: string;
  operator: V2InventoryActor | null;
  note: string | null;
  fromVersion: number | null;
  toVersion: number | null;
}
