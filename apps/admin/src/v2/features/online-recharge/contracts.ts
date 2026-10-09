export type OnlineSection =
  | 'overview'
  | 'config'
  | 'proxies'
  | 'browser-pool'
  | 'addresses'
  | 'checkout-debug'
  | 'cards'
  | 'cdks'
  | 'sessions'
  | 'renewal'
  | 'jobs'
  | 'automation'
  | 'billing'
  | 'runtime-logs'
  | 'login-logs';
export type OnlinePlan = 'plus' | 'pro_5x' | 'pro_20x';
export type OnlineRow = { id: string; updatedAt?: string; [key: string]: unknown };
export interface OnlineList {
  items: OnlineRow[];
  total: number;
  page: number;
  pageSize: number;
  summary?: Record<string, string | number>;
  config?: Record<string, unknown>;
  runtime?: Record<string, unknown> | null;
  observedAt?: string | null;
}
export interface OnlineQuery {
  page: number;
  pageSize: number;
  keyword: string;
  status: string;
  dispatched?: string;
  sortOrder?: 'asc' | 'desc';
  plan?: string;
  region?: string;
  startDate?: string;
  endDate?: string;
}
export interface PublicTask {
  id: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  progress?: number;
  stage?: string;
  message?: string;
  plan?: OnlinePlan;
  result?: Record<string, unknown>;
  taskToken?: string;
}
export interface PublicConfig {
  maintenanceMode?: boolean;
  available?: boolean;
  activeJobs?: number;
  capacity?: number;
  region?: string;
  currency?: string;
  plans?: { value: OnlinePlan; label: string }[];
}
export type FormValue = string | number | boolean;
export interface OnlineField {
  key: string;
  label: string;
  type?: 'text' | 'textarea' | 'number' | 'select' | 'switch' | 'secret';
  required?: boolean;
  help?: string;
  options?: readonly { value: string; label: string }[];
  min?: number;
  max?: number;
  initial?: FormValue;
  transient?: boolean;
}
export interface OnlineAction {
  key: string;
  label: string;
  fields?: readonly OnlineField[];
  danger?: boolean;
  confirm?: string;
}
