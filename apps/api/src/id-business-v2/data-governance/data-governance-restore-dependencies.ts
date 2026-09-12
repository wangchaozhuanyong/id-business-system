interface RestoreMasterState {
  id: string;
  type: string;
  status: 'active' | 'disabled';
  deletedAt: Date | null;
}

interface RestorableServiceState {
  type: string;
  parent: RestoreMasterState | null;
  countryOption: RestoreMasterState | null;
}

// A cascade may restore one master; the other must still be active at execution time.
export function canRestoreServiceMasters(
  option: RestorableServiceState,
  restoredStatus: 'active' | 'disabled',
  restoringMaster?: Pick<RestoreMasterState, 'id' | 'type' | 'status'>
) {
  if (option.type !== 'service' || restoredStatus !== 'active') return true;
  const active = (master: RestoreMasterState | null, expectedType: string) => {
    if (!master || master.type !== expectedType) return false;
    if (restoringMaster?.id === master.id) {
      return restoringMaster.type === expectedType && restoringMaster.status === 'active';
    }
    return master.deletedAt === null && master.status === 'active';
  };
  return active(option.parent, 'business_category') && active(option.countryOption, 'country');
}
