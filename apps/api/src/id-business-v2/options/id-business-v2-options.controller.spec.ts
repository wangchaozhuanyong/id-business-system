import { PERMISSIONS_KEY } from '../../auth/auth.decorators';
import { IdBusinessV2OptionsController } from './id-business-v2-options.controller';

describe('IdBusinessV2OptionsController permissions', () => {
  it('keeps mutations behind dictionary management while allowing authenticated selector reads', () => {
    expect(Reflect.getMetadata(PERMISSIONS_KEY, IdBusinessV2OptionsController)).toEqual([
      'data.dictionary.manage'
    ]);
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, IdBusinessV2OptionsController.prototype.listSelectors)
    ).toEqual([]);
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, IdBusinessV2OptionsController.prototype.getBusinessTree)
    ).toEqual([]);
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, IdBusinessV2OptionsController.prototype.create)
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, IdBusinessV2OptionsController.prototype.update)
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, IdBusinessV2OptionsController.prototype.remove)
    ).toBeUndefined();
  });
});

describe('IdBusinessV2OptionsController bootstrap', () => {
  it('keeps the selected list and exposes all prefetched type lists', async () => {
    const types = {
      items: [{ type: 'id_status', label: 'ID状态' }],
      systemStatusCodes: ['normal', 'frozen']
    };
    const list = {
      items: [{ id: 'normal', type: 'id_status', name: '正常' }],
      total: 2,
      page: 1,
      pageSize: 20
    };
    const listsByType = {
      id_status: list,
      customer_source: { items: [], total: 0, page: 1, pageSize: 20 }
    };
    const optionsService = {
      listTypes: vi.fn(() => types),
      list: vi.fn(async () => list),
      listDefaultPages: vi.fn(async () => listsByType)
    };
    const controller = new IdBusinessV2OptionsController(optionsService as never);

    const result = await controller.bootstrap(
      '1',
      '20',
      undefined,
      'id_status',
      undefined,
      undefined,
      'sortOrder',
      'asc'
    );

    expect(result).toMatchObject({
      types,
      list,
      listsByType
    });
    expect(result.generatedAt).toEqual(expect.any(String));
  });
});

describe('IdBusinessV2OptionsController selectors', () => {
  it('passes the explicit include-disabled flag to the selector query', async () => {
    const optionsService = {
      listSelectors: vi.fn(async () => ({ items: [] }))
    };
    const controller = new IdBusinessV2OptionsController(optionsService as never);

    await controller.listSelectors('id_supplier', undefined, 'true');

    expect(optionsService.listSelectors).toHaveBeenCalledWith('id_supplier', undefined, 'true');
  });
});
