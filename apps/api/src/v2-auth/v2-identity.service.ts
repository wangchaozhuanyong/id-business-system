import { HttpStatus, Injectable } from '@nestjs/common';
import { authHttpError } from '../common/errors/api-http.exception';
import { TimedMemoryCache } from '../common/cache/timed-memory-cache';
import { PrismaService } from '../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';

const AUTHENTICATED_USER_CACHE_TTL_MS = 15_000;

@Injectable()
export class V2IdentityService {
  private readonly authenticatedUserCache = new TimedMemoryCache();
  private readonly authenticatedUserCacheKeys = new Map<string, string>();

  constructor(private readonly prisma: PrismaService) {}

  async getAuthenticatedUser(userId: string): Promise<AuthenticatedUser> {
    const authorizationVersion = await this.prisma.idBusinessV2ScopeVersion.findUnique({
      where: { scope: 'employees' },
      select: { version: true }
    });
    const cacheKey = `${userId}:${authorizationVersion?.version.toString() ?? '0'}`;
    const previousCacheKey = this.authenticatedUserCacheKeys.get(userId);
    if (previousCacheKey && previousCacheKey !== cacheKey) {
      this.authenticatedUserCache.delete(previousCacheKey);
    }
    this.authenticatedUserCacheKeys.set(userId, cacheKey);

    return this.authenticatedUserCache.getOrSet(
      cacheKey,
      AUTHENTICATED_USER_CACHE_TTL_MS,
      async () => {
        const user = await this.prisma.user.findFirst({
          where: {
            id: userId,
            status: 'active',
            deletedAt: null
          },
          include: {
            v2AuthIdentity: {
              select: {
                mustResetPassword: true
              }
            },
            userRoles: {
              include: {
                role: {
                  include: {
                    rolePermissions: {
                      include: {
                        permission: true
                      }
                    }
                  }
                }
              }
            }
          }
        });

        if (!user) {
          throw authHttpError(
            HttpStatus.UNAUTHORIZED,
            'AUTH_ACCOUNT_DISABLED',
            '登录账号不存在或已停用。'
          );
        }

        return {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          roles: [...new Set(user.userRoles.map((assignment) => assignment.role.code))],
          permissions: [
            ...new Set(
              user.userRoles.flatMap((assignment) =>
                assignment.role.rolePermissions.map(({ permission }) => permission.code)
              )
            )
          ],
          mustResetPassword: user.v2AuthIdentity?.mustResetPassword ?? false
        };
      }
    );
  }

  invalidateAuthenticatedUser(userId: string) {
    const cacheKey = this.authenticatedUserCacheKeys.get(userId);
    if (cacheKey) this.authenticatedUserCache.delete(cacheKey);
    this.authenticatedUserCacheKeys.delete(userId);
  }
}
