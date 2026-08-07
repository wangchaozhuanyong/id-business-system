import { Injectable } from '@nestjs/common';
import type { UpdateV2BrandingSettingsInput } from '@apple-business/shared';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { V2CommandTransaction } from '../../runtime/public-api';

const BRANDING_SETTINGS_ID = 1;

type BrandingPersistenceClient = Pick<V2CommandTransaction, 'idBusinessV2BrandingSettings'>;

@Injectable()
export class IdBusinessV2BrandingRepository {
  constructor(private readonly prisma: PrismaService) {}

  findSettings(client: BrandingPersistenceClient = this.prisma) {
    return client.idBusinessV2BrandingSettings.findUnique({
      where: { id: BRANDING_SETTINGS_ID }
    });
  }

  createDefaultSettings(tx: V2CommandTransaction, input: UpdateV2BrandingSettingsInput) {
    return tx.idBusinessV2BrandingSettings.create({
      data: {
        id: BRANDING_SETTINGS_ID,
        ...input
      }
    });
  }

  upsertSettings(
    tx: V2CommandTransaction,
    input: UpdateV2BrandingSettingsInput & { updatedByUserId: string }
  ) {
    return tx.idBusinessV2BrandingSettings.upsert({
      where: { id: BRANDING_SETTINGS_ID },
      create: {
        id: BRANDING_SETTINGS_ID,
        ...input
      },
      update: input
    });
  }
}
