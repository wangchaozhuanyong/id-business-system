import { PERMISSIONS_KEY } from '../../auth/auth.decorators';
import {
  IdBusinessV2AccountLossCommandsController,
  IdBusinessV2AccountLossesController
} from './id-business-v2-account-losses.controller';

describe('IdBusinessV2AccountLoss controllers permissions', () => {
  it('requires both account update and balance adjust to report a loss', () => {
    expect(
      Reflect.getMetadata(
        PERMISSIONS_KEY,
        IdBusinessV2AccountLossCommandsController.prototype.reportLoss
      )
    ).toEqual(['apple.account.update', 'apple.balance.adjust']);
  });

  it('requires balance view to read immutable loss records', () => {
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, IdBusinessV2AccountLossesController.prototype.list)
    ).toEqual(['apple.balance.view']);
  });
});
