import type { NestExpressApplication } from '@nestjs/platform-express';

export function configureRegistrationNameImportBodyParser(app: NestExpressApplication) {
  app.useBodyParser('json', {
    limit: '1mb',
    type: (request) =>
      request.method === 'POST' &&
      request.url?.split('?')[0] === '/api/id-business-v2/auto-registration/names/import' &&
      request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() === 'application/json'
  });
  // Keep the default 100KB JSON limit for all other routes.
  app.useBodyParser('json');
}
