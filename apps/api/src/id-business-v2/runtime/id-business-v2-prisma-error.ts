interface PrismaErrorLike {
  code?: unknown;
  meta?: unknown;
  name?: unknown;
}

interface PrismaErrorMetaLike {
  code?: unknown;
}

export function getPrismaErrorCode(error: unknown) {
  if (!error || typeof error !== 'object') return null;
  const code = (error as PrismaErrorLike).code;
  return typeof code === 'string' && /^P\d{4}$/.test(code) ? code : null;
}

export function isPrismaErrorCode(error: unknown, ...codes: string[]) {
  const code = getPrismaErrorCode(error);
  return code !== null && codes.includes(code);
}

export function isUniqueConstraintError(error: unknown) {
  return isPrismaErrorCode(error, 'P2002');
}

export function isWriteConflictError(error: unknown) {
  if (isPrismaErrorCode(error, 'P2034')) return true;
  if (!isPrismaErrorCode(error, 'P2010')) return false;
  const meta = (error as PrismaErrorLike).meta;
  return Boolean(
    meta && typeof meta === 'object' && (meta as PrismaErrorMetaLike).code === '40001'
  );
}
