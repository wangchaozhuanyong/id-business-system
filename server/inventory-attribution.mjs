import { isDeepStrictEqual } from 'node:util';
import { toV2DateTimeInput } from '../modules/time/dateTime.ts';

const ordinaryTypes = new Set(['google', 'gpt', 'claude']);
const creationFields = ['createdById', 'createdBy', 'createdAt', 'importedAt'];
const operationFields = ['lastOperatedById', 'lastOperatedBy', 'lastOperatedAt'];
const modificationFields = ['updatedById', 'updatedBy', 'updatedAt'];
const personFields = [...creationFields, ...operationFields, ...modificationFields];
const collections = ['accounts', 'mailboxes'];
const eventActorFields = ['actorId', 'actor'];
const batchActorFields = ['actorId', 'actorName'];
const registrationCreationFields = ['createdById', 'createdBy', 'createdAt'];
const registrationPeopleFields = [...registrationCreationFields, ...eventActorFields, 'time'];
const lifecycleFields = [
  'inventoryState',
  'health',
  'healthChangedAt',
  'claimId',
  'claimBatchId',
  'purpose',
  'usedAt',
  'claimedAt',
  'actualUsedAt',
  'extractionNotes',
  'usageLinks',
  'accountLifecycle',
  'accountLifecycleEvents'
];
const list = (value) => (Array.isArray(value) ? value : []);
const stableId = (row) => typeof row?.id === 'string' && row.id.length > 0;

function businessFields(row, omitLifecycle = false) {
  const data = { ...row };
  for (const field of [...personFields, 'inventoryHistory', 'version']) delete data[field];
  data.inventoryState ||= data.used ? 'used' : 'available';
  data.health ||= 'normal';
  data.status ||= '正常';
  data.usageLinks ??= [];
  delete data.used;
  if (omitLifecycle) for (const field of lifecycleFields) delete data[field];
  return data;
}

function retainFields(row, prior, fields) {
  for (const field of fields) {
    if (Object.hasOwn(prior, field)) row[field] = prior[field];
    else delete row[field];
  }
}

function changedRegistrationAssets(previous, next) {
  const prior = new Map(list(previous?.registrationRecords).map((record) => [record?.id, record]));
  return new Set(
    list(next.registrationRecords)
      .filter((record) => stableId(record) && prior.get(record.id)?.state !== record.state)
      .map(({ assetId }) => assetId)
  );
}

function withKnownCreationTime(prior) {
  return prior.createdAt || !prior.importedAt ? prior : { ...prior, createdAt: prior.importedAt };
}

function peopleChanged(prior, row) {
  const known = withKnownCreationTime(prior);
  return personFields.some((field) => row[field] !== prior[field] && row[field] !== known[field]);
}

function indexInventory(document) {
  const index = new Map();
  for (const collection of collections) {
    for (const row of list(document?.[collection])) {
      if (!stableId(row)) continue;
      const entries = index.get(row.id);
      if (entries) entries.push({ collection, row });
      else index.set(row.id, [{ collection, row }]);
    }
  }
  return index;
}

function indexRecords(rows) {
  const index = new Map();
  for (const row of list(rows)) {
    if (!stableId(row)) continue;
    const entries = index.get(row.id);
    if (entries) entries.push(row);
    else index.set(row.id, [row]);
  }
  return index;
}

function stampLedger(previous, next, actor, time, { label, includes, kind }) {
  const beforeById = indexRecords(previous);
  const afterById = indexRecords(next);
  const unnamed = list(previous).filter((row) => !stableId(row) && includes(row));
  for (const row of list(next)) {
    if (stableId(row)) continue;
    if (!includes(row)) continue;
    const match = unnamed.findIndex((old) => isDeepStrictEqual(old, row));
    if (match < 0) return `${label}必须有稳定编号`;
    unnamed.splice(match, 1);
  }
  if (unnamed.length) return `原有${label}必须保留`;
  for (const [id, rows] of beforeById) {
    if (rows.some(includes) && !afterById.has(id)) return `原有${label}必须保留`;
  }
  for (const [id, rows] of afterById) {
    const before = beforeById.get(id) || [];
    if (![...rows, ...before].some(includes)) continue;
    if (rows.length !== 1 || before.length > 1) return `${label}编号不能重复`;
    const [row] = rows;
    const [prior] = before;
    if (kind === 'registration') {
      if (prior && row.state === prior.state) {
        if (registrationPeopleFields.some((field) => row[field] !== prior[field]))
          return '注册结果未变化，不能改写登记人员或时间';
        continue;
      }
      if (prior) retainFields(row, prior, registrationCreationFields);
      else Object.assign(row, { createdById: actor.id, createdBy: actor.name, createdAt: time });
      Object.assign(row, { actorId: actor.id, actor: actor.name, time });
      continue;
    }
    const fields = kind === 'batch' ? batchActorFields : eventActorFields;
    if (prior) {
      if (kind === 'import' && !isDeepStrictEqual(row, prior))
        return '原有导入记录及登记人员必须保留';
      if (fields.some((field) => row[field] !== prior[field]))
        return `原有${label}的登记人员不能改写`;
      continue;
    }
    row[fields[0]] = actor.id;
    row[fields[1]] = actor.name;
  }
}

function stampLedgers(previous, next, actor, time, previousIndex, nextIndex) {
  const assetTypes = new Map();
  const ordinaryImports = new Set();
  for (const index of [previousIndex, nextIndex]) {
    for (const [id, entries] of index) {
      for (const { row } of entries) {
        if (row.type) assetTypes.set(id, row.type);
        if (ordinaryTypes.has(row.type) && row.importId) ordinaryImports.add(row.importId);
      }
    }
  }
  const ordinaryAsset = (row) => ordinaryTypes.has(assetTypes.get(row?.assetId) ?? row?.type);
  for (const [key, label, kind, includes] of [
    ['batches', '提取批次', 'batch', (row) => list(row?.items).some(ordinaryAsset)],
    ['returnRecords', '归还记录', 'return', ordinaryAsset],
    [
      'importRecords',
      '导入记录',
      'import',
      (row) =>
        ordinaryImports.has(row?.id) ||
        ordinaryTypes.has(row?.type) ||
        list(row?.types).some((type) => ordinaryTypes.has(type)) ||
        list(row?.results).some(ordinaryAsset)
    ],
    ['registrationRecords', '注册记录', 'registration', ordinaryAsset]
  ]) {
    const error = stampLedger(previous?.[key], next[key], actor, time, { label, kind, includes });
    if (error) return error;
  }
}

function stampRow(row, prior, actor, time, registrationChanged) {
  const history = list(row.inventoryHistory);
  const before = list(prior?.inventoryHistory);
  if (
    (row.inventoryHistory !== undefined && !Array.isArray(row.inventoryHistory)) ||
    before.some((entry, index) => !isDeepStrictEqual(entry, history[index]))
  )
    return '原有库存操作历史必须保留，不能改写';
  const added = history.slice(before.length);
  const ids = new Set(before.filter(stableId).map(({ id }) => id));
  for (const entry of added) {
    if (!stableId(entry) || ids.has(entry.id)) return '新增库存操作必须使用独立编号';
    ids.add(entry.id);
  }
  if (prior) {
    const actualChange = !isDeepStrictEqual(businessFields(prior), businessFields(row));
    if (!actualChange && !registrationChanged) {
      if (peopleChanged(prior, row) || added.length)
        return '库存资料没有实际变化，不能单独修改人员或追加操作历史';
      return;
    }
    const detailsChanged = !isDeepStrictEqual(
      businessFields(prior, true),
      businessFields(row, true)
    );
    retainFields(row, withKnownCreationTime(prior), creationFields);
    retainFields(row, prior, modificationFields);
    if (detailsChanged) {
      if (Object.hasOwn(prior, 'updatedById')) row.updatedById = actor.id;
      if (Object.hasOwn(prior, 'updatedBy')) row.updatedBy = actor.name;
      if (Object.hasOwn(prior, 'updatedAt')) row.updatedAt = time;
    }
  } else {
    row.createdById = actor.id;
    row.createdBy = actor.name;
    row.createdAt = time;
    if (Object.hasOwn(row, 'importedAt')) row.importedAt = time;
    retainFields(row, {}, modificationFields);
  }
  row.lastOperatedById = actor.id;
  row.lastOperatedBy = actor.name;
  row.lastOperatedAt = time;
  for (const entry of added) Object.assign(entry, { actorId: actor.id, actor: actor.name, time });
}

export function attributeInventory(previous, next, actor, action) {
  if (!actor?.id || !actor.name) return;
  const time = toV2DateTimeInput(new Date()).replace('T', ' ');
  const previousIndex = indexInventory(previous);
  const nextIndex = indexInventory(next);
  const registered =
    action === 'inventory_registration_result' && changedRegistrationAssets(previous, next);
  for (const [id, entries] of nextIndex) {
    const before = previousIndex.get(id) || [];
    if (![...entries, ...before].some(({ row }) => ordinaryTypes.has(row.type))) continue;
    if (entries.length !== 1 || before.length > 1) return '普通库存资料编号不能重复';
    const [{ collection, row }] = entries;
    const [prior] = before;
    if (prior && prior.collection !== collection) return '普通库存资料不能跨集合改写';
    if (prior?.row.type && prior.row.type !== row.type) return '库存资料类型不能直接改写';
    const error = stampRow(row, prior?.row, actor, time, registered && registered.has(id));
    if (error) return error;
  }
  for (const collection of collections) {
    const anonymous = list(previous?.[collection]).filter((row) => row && !stableId(row));
    for (const row of next[collection]) {
      if (!ordinaryTypes.has(row?.type) || stableId(row)) continue;
      const match = anonymous.findIndex(
        (prior) =>
          isDeepStrictEqual(businessFields(prior), businessFields(row)) &&
          !peopleChanged(prior, row) &&
          isDeepStrictEqual(list(prior.inventoryHistory), list(row.inventoryHistory))
      );
      if (match === -1) return '普通库存资料必须有稳定编号';
      anonymous.splice(match, 1);
    }
  }
  return stampLedgers(previous, next, actor, time, previousIndex, nextIndex);
}

export function defaultInventoryRegistrationTimes(previous, next) {
  const priorIds = indexInventory(previous);
  const priorImports = indexRecords(previous?.importRecords);
  const imports = new Map();
  const time = toV2DateTimeInput(new Date()).replace('T', ' ');
  const key = ({ type, email }) => `${type}:${String(email || '').toLowerCase()}`;
  for (const [id, entries] of indexInventory(next)) {
    if (priorIds.has(id)) continue;
    for (const { row } of entries) {
      if (!ordinaryTypes.has(row.type) && row.type !== 'apple') continue;
      if (!String(row.registered ?? '').trim()) {
        row.createdAt ||= row.importedAt || time;
        row.registered = row.createdAt;
      }
      if (row.importId && !priorImports.has(row.importId)) {
        if (!imports.has(row.importId)) imports.set(row.importId, new Map());
        imports.get(row.importId).set(key(row), row);
      }
    }
  }
  for (const batch of list(next.importRecords)) {
    const imported = imports.get(batch?.id);
    if (!imported) continue;
    for (const result of list(batch.results)) {
      const asset = imported.get(key(result));
      if (!asset) continue;
      result.registered = asset.registered;
      if (asset.createdAt) result.createdAt = asset.createdAt;
    }
  }
}
