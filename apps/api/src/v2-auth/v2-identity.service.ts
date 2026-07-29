import { Injectable, NotFoundException } from '@nestjs/common';
import { TimedMemoryCache } from '../common/cache/timed-memory-cache';
import { PrismaService } from '../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';

const AUTHENTICATED_USER_CACHE_TTL_MS = 15_000;

@Injectable()
export class V2IdentityService {
  private readonly authenticatedUserCache = new TimedMemoryCache();

  constructor(private readonly prisma: PrismaService) {}

  async getAuthenticatedUser(userId: string): Promise<AuthenticatedUser> {
    return this.authenticatedUserCache.getOrSet(
      userId,
      AUTHENTICATED_USER_CACHE_TTL_MS,
      async () => {
        const user = await this.prisma.user.findFirst({
          where: {
            id: userId,
            status: 'active',
            deletedAt: null
          },
          include: {
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
          throw new NotFoundException('登录账号不存在或已停用。');
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
          ]
        };
      }
    );
  }
}
