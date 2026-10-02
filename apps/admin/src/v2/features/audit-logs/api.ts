import { http, request, type ApiRequestOptions } from '@/api/client';
import type {
  V2AuditLogExportInput,
  V2AuditLogExportResult,
  V2AuditLogListQuery,
  V2AuditLogListResult,
  V2AuditLogRecord,
  V2AuditRestoreInput,
  V2AuditRestorePreview,
  V2AuditRestoreResult,
  V2SensitiveAccessLogListQuery,
  V2SensitiveAccessLogRecord
} from './contracts';

export const v2AuditLogsApi = {
  restorePreview(id: string, options: ApiRequestOptions = {}) {
    return request<V2AuditRestorePreview>(
      http.get(`/audit-logs/${id}/restore-preview`, { signal: options.signal })
    );
  },
  restoreFields(id: string, input: V2AuditRestoreInput) {
    return request<V2AuditRestoreResult>(http.post(`/audit-logs/${id}/restore`, input));
  },
  listOperations(query: V2AuditLogListQuery, options: ApiRequestOptions = {}) {
    return request<V2AuditLogListResult<V2AuditLogRecord>>(
      http.get('/audit-logs', { params: query, signal: options.signal })
    );
  },
  listSensitiveAccess(query: V2SensitiveAccessLogListQuery, options: ApiRequestOptions = {}) {
    return request<V2AuditLogListResult<V2SensitiveAccessLogRecord>>(
      http.get('/audit-logs/sensitive-access', { params: query, signal: options.signal })
    );
  },
  exportOperations(input: V2AuditLogExportInput) {
    return request<V2AuditLogExportResult<V2AuditLogRecord>>(
      http.post('/audit-logs/export', input)
    );
  },
  exportSensitiveAccess(input: V2AuditLogExportInput) {
    return request<V2AuditLogExportResult<V2SensitiveAccessLogRecord>>(
      http.post('/audit-logs/export', input)
    );
  }
};
