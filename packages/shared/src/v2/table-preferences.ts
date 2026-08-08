import type { IsoDateTimeString } from './common.js';

export const V2_TABLE_PREFERENCE_LIMITS = {
  tableId: 120,
  columnKey: 120,
  hiddenColumnCount: 100
} as const;

export interface V2TablePreference {
  tableId: string;
  hiddenColumnKeys: string[];
  updatedAt: IsoDateTimeString;
}

export interface V2TablePreferenceList {
  items: V2TablePreference[];
}

export interface UpdateV2TablePreferenceInput {
  hiddenColumnKeys: string[];
}

export interface ResetV2TablePreferenceResult {
  tableId: string;
  hiddenColumnKeys: [];
  deleted: boolean;
}
