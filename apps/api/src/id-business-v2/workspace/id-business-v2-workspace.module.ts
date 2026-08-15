import { Module } from '@nestjs/common';
import { IdBusinessV2RuntimeModule } from '../runtime/public-api';
import { IdBusinessV2WorkspaceController } from './id-business-v2-workspace.controller';
import { IdBusinessV2WorkspaceService } from './id-business-v2-workspace.service';
import { IdBusinessV2WorkspaceRepository } from './persistence/id-business-v2-workspace.repository';

@Module({
  imports: [IdBusinessV2RuntimeModule],
  controllers: [IdBusinessV2WorkspaceController],
  providers: [IdBusinessV2WorkspaceService, IdBusinessV2WorkspaceRepository]
})
export class IdBusinessV2WorkspaceModule {}
