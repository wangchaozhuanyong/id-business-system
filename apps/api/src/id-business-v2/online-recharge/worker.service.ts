import { Injectable } from '@nestjs/common';
import { OnlineRechargeWorkerRpcRepository } from './persistence/worker-rpc.repository';
import { object } from './validation';
export { secureEqual } from './persistence/worker-rpc.repository';

@Injectable()
export class OnlineRechargeWorkerService {
  constructor(private readonly worker: OnlineRechargeWorkerRpcRepository) {}
  authorize(token: unknown) {
    return this.worker.authorize(token);
  }
  rpc(token: unknown, raw: unknown) {
    this.authorize(token);
    return this.worker.rpc(token, object(raw));
  }
}
