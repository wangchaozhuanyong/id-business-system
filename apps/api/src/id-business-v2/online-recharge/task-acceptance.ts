/** Raised only before dispatch or when the task-creation transaction was rejected. */
export class OnlineRechargeTaskNotAccepted extends Error {
  constructor() {
    super('充值任务未受理');
  }
}
