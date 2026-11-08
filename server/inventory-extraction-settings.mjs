// Mail extraction choices live in the existing encrypted inventory document.
export function validMailExtractionSettings(tableSettings) {
  if (!Array.isArray(tableSettings)) return false;
  const entries = tableSettings.filter(entry => Array.isArray(entry) && entry[0] === 'mail-extraction');
  if (!entries.length) return true; // Existing inventories use the original defaults.
  if (entries.length !== 1 || entries[0].length !== 2) return false;
  const config = entries[0][1];
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).some(key => key !== 'purposes')) return false;
  const values = config.purposes;
  return Array.isArray(values) && values.length >= 1 && values.length <= 100 &&
    values.every(value => typeof value === 'string' && value.length >= 1 && value.length <= 100 &&
      value === value.trim() && !/[\x00-\x1f\x7f]/.test(value)) &&
    new Set(values.map(value => value.toLowerCase())).size === values.length;
}
