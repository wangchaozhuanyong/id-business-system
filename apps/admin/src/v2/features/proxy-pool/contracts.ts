import type { ProxyKind } from './options';
export interface ProxyPoolItem {
  id: string;
  countryCode: string;
  kind: ProxyKind | null;
  connectionMode: 'extraction' | 'direct';
  protocol: 'http' | 'https' | 'socks5';
  linkMask: string;
  status: 'active' | 'disabled';
  remark1: string | null;
  remark2: string | null;
  remark?: string | null;
  displayHost?: string | null;
  exitIp?: string | null;
  latencyMs?: number | null;
  testMessage?: string | null;
  testedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RechargeProxyDetail extends Omit<
  ProxyPoolItem,
  'linkMask' | 'createdAt' | 'updatedAt'
> {
  url: string;
}

export interface RechargeProxyWrite {
  countryCode: string;
  url: string;
  kind: ProxyKind;
  protocol?: ProxyPoolItem['protocol'];
  remark1?: string;
  remark2?: string;
  remark?: string;
  connectionMode?: ProxyPoolItem['connectionMode'];
}

export type RechargeProxyItem = ProxyPoolItem & { kind: ProxyKind };

export type ProxyTestStatus =
  | 'queued'
  | 'running'
  | 'awaiting_credentials'
  | 'awaiting_review'
  | 'succeeded'
  | 'failed';
export interface ProxyTestTask {
  id: string;
  proxyId: string;
  status: ProxyTestStatus;
  progress: number;
  message: string;
  requiresResubmission?: boolean;
  connectionChanged?: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface ProxyTestList {
  items: ProxyTestTask[];
  total: number;
  page: number;
  pageSize: number;
  revalidateAt: string | null;
}
