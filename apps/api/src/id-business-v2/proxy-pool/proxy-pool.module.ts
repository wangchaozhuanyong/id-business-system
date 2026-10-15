import { OnlineProxyPoolRepository } from './persistence/online-proxy.repository';
import { Module } from '@nestjs/common';
import { IdBusinessV2RuntimeModule } from '../runtime/public-api';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { RechargeProxyService } from './proxy-pool.service';
import { RechargeProxyRepository } from './persistence/proxy-pool.repository';
import { ProxyPoolController } from './proxy-pool.controller';
@Module({
  imports: [IdBusinessV2RuntimeModule],
  controllers: [ProxyPoolController],
  providers: [
    OnlineProxyPoolRepository,
    FieldEncryptionService,
    RechargeProxyRepository,
    RechargeProxyService
  ],
  exports: [OnlineProxyPoolRepository, RechargeProxyRepository, RechargeProxyService]
})
export class ProxyPoolModule {}
