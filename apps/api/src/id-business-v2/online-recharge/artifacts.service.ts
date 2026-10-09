import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { OnlineRechargeWorkerRpc } from './contracts';
import { OnlineRechargeArtifactsRepository } from './persistence/artifacts.repository';
import { id } from './validation';
import { assertOnlineSensitive } from './assets.service';

@Injectable()
export class OnlineRechargeArtifactsService {
  constructor(private readonly artifacts: OnlineRechargeArtifactsRepository) {}
  upload(rpc: OnlineRechargeWorkerRpc) {
    if (rpc.args?.redacted !== true) throw new BadRequestException('运行资料必须先脱敏');
    return this.artifacts.upload(rpc);
  }
  list(taskId: string) {
    return this.artifacts.list(id(taskId));
  }
  download(artifactId: string, operator: AuthenticatedUser) {
    assertOnlineSensitive(operator);
    return this.artifacts.download(id(artifactId), operator);
  }
}
