import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { PermissionsGuard } from '../auth/permissions.guard';
import { AuditLogsController } from './audit-logs.controller';
import { IdBusinessV2DataGovernanceController } from '../id-business-v2/data-governance/id-business-v2-data-governance.controller';
import { IdBusinessV2AuditRestoreController } from '../id-business-v2/data-governance/id-business-v2-audit-restore.controller';

describe('audit and recovery administrator boundary', () => {
  const guard = new PermissionsGuard(new Reflector());
  const endpoints = [
    [AuditLogsController, 'list'],
    [AuditLogsController, 'listSensitiveAccess'],
    [AuditLogsController, 'export'],
    [IdBusinessV2AuditRestoreController, 'preview'],
    [IdBusinessV2AuditRestoreController, 'restore'],
    [IdBusinessV2DataGovernanceController, 'previewRestore'],
    [IdBusinessV2DataGovernanceController, 'decide'],
    [IdBusinessV2DataGovernanceController, 'execute']
  ] as const;
  for (const [controller, method] of endpoints) {
    const context = (roles: string[]) =>
      ({
        getClass: () => controller,
        getHandler: () => Reflect.get(controller.prototype, method),
        switchToHttp: () => ({
          getRequest: () => ({ user: { roles, permissions: ['audit_log.view'] } })
        })
      }) as ExecutionContext;
    it(`${controller.name}.${method} blocks employees even with the old audit permission`, () => {
      expect(() => guard.canActivate(context(['employee']))).toThrow();
      expect(guard.canActivate(context(['admin']))).toBe(true);
      expect(guard.canActivate(context(['admin', 'super_admin']))).toBe(true);
    });
  }
});
