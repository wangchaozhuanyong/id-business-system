import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('V2 finance permission contracts', () => {
  it('keeps analytics reads separate from the finance ledger permission', () => {
    const controller = readFileSync(
      resolve(process.cwd(), 'src/id-business-v2/finance/id-business-v2-finance.controller.ts'),
      'utf8'
    );
    const analyticsStart = controller.indexOf("@Get('analytics/bootstrap')");
    const ledgerStart = controller.indexOf("@Get('ledger/bootstrap')");
    const analyticsEndpoint = controller.slice(analyticsStart, ledgerStart);

    expect(analyticsStart).toBeGreaterThan(-1);
    expect(analyticsEndpoint).toContain("@RequirePermissions('data.analytics.view')");
    expect(controller).toContain("@RequirePermissions('finance.view')");
  });

  it('protects every analytics report endpoint with the analytics permission', () => {
    const controller = readFileSync(
      resolve(process.cwd(), 'src/id-business-v2/finance/id-business-v2-finance.controller.ts'),
      'utf8'
    );

    for (const route of [
      'reports/overview',
      'reports/profit-loss',
      'reports/currency-breakdown',
      'reports/assets',
      'reports/after-sales',
      'reports/reconciliation'
    ]) {
      const routeStart = controller.indexOf(`@Get('${route}')`);
      const nextRoute = controller.indexOf('\n  @Get(', routeStart + 1);
      const endpoint = controller.slice(routeStart, nextRoute === -1 ? undefined : nextRoute);
      expect(routeStart).toBeGreaterThan(-1);
      expect(endpoint).toContain("@RequirePermissions('data.analytics.view')");
    }
  });
});
