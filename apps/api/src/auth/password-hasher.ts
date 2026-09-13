import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const keyLength = 64;
// Stored hashes carry their own work factor, so old passwords remain verifiable.
const pbkdf2Iterations = 600_000;
const pbkdf2Algorithm = 'pbkdf2-sha256';

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const derivedKey = await derivePbkdf2Key(password, salt, keyLength, pbkdf2Iterations);

  return `${pbkdf2Algorithm}$${pbkdf2Iterations}$${salt.toString('hex')}$${derivedKey.toString('hex')}`;
}

export async function verifyPassword(password: string, passwordHash: string) {
  if (
    !/^(?:pbkdf2-sha256\$[1-9][0-9]*\$[0-9a-f]{32}\$[0-9a-f]{128}|scrypt\$[0-9a-f]{32}\$[0-9a-f]{128})$/.test(
      passwordHash
    )
  ) {
    return false;
  }
  const [algorithm, firstValue, secondValue, thirdValue] = passwordHash.split('$');

  if (algorithm === pbkdf2Algorithm && firstValue && secondValue && thirdValue) {
    const iterations = Number(firstValue);
    if (!Number.isSafeInteger(iterations) || iterations < 100_000) return false;

    const salt = Buffer.from(secondValue, 'hex');
    const storedKey = Buffer.from(thirdValue, 'hex');
    const derivedKey = await derivePbkdf2Key(password, salt, storedKey.length, iterations);
    return safeEqual(storedKey, derivedKey);
  }

  if (algorithm === 'scrypt' && firstValue && secondValue) {
    const storedKey = Buffer.from(secondValue, 'hex');
    const derivedKey = (await scrypt(password, firstValue, storedKey.length)) as Buffer;
    return safeEqual(storedKey, derivedKey);
  }

  return false;
}

export function passwordNeedsRehash(passwordHash: string) {
  const [algorithm, iterations] = passwordHash.split('$');
  return (
    algorithm === 'scrypt' ||
    (algorithm === pbkdf2Algorithm && Number(iterations) < pbkdf2Iterations)
  );
}

async function derivePbkdf2Key(
  password: string,
  salt: Uint8Array,
  length: number,
  iterations: number
) {
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: Uint8Array.from(salt),
      iterations
    },
    passwordKey,
    length * 8
  );

  return Buffer.from(derivedBits);
}

function safeEqual(storedKey: Buffer, derivedKey: Buffer) {
  return storedKey.length === derivedKey.length && timingSafeEqual(storedKey, derivedKey);
}
