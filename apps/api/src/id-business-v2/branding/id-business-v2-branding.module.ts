import { Module } from '@nestjs/common';
import { IdBusinessV2RuntimeModule } from '../runtime/public-api';
import { IdBusinessV2BrandingController } from './id-business-v2-branding.controller';
import { IdBusinessV2BrandingService } from './id-business-v2-branding.service';
import { IdBusinessV2BrandingRepository } from './persistence/id-business-v2-branding.repository';

@Module({
  imports: [IdBusinessV2RuntimeModule],
  controllers: [IdBusinessV2BrandingController],
  providers: [IdBusinessV2BrandingService, IdBusinessV2BrandingRepository],
  exports: [IdBusinessV2BrandingService]
})
export class IdBusinessV2BrandingModule {}
