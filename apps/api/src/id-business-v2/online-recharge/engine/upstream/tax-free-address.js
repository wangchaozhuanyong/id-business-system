'use strict';
const store = require('./mysql-store');
const US_STATE_LABELS = {
    OR: 'Oregon',
    DE: 'Delaware',
    MT: 'Montana',
    NH: 'New Hampshire',
    AK: 'Alaska'
};

const US_STATE_CODES = Object.fromEntries(
    Object.entries(US_STATE_LABELS).map(([code, name]) => [name.toLowerCase(), code])
);

/**
 * 将州字段规范为结账下拉可用的完整州名（Oregon，而非 OR）
 */
function normalizeUsStateName(state) {
    const raw = String(state || '').trim();
    if (!raw) return raw;
    const upper = raw.toUpperCase();
    if (US_STATE_LABELS[upper]) return US_STATE_LABELS[upper];
    const lower = raw.toLowerCase();
    if (US_STATE_CODES[lower]) return US_STATE_LABELS[US_STATE_CODES[lower]];
    return raw;
}

/** 美国无销售税州：Oregon, Delaware, Montana, New Hampshire, Alaska */
const US_TAX_FREE_LOCATIONS = [
    { city: 'Portland', state: 'Oregon', postalCodes: ['97201', '97205', '97209', '97214'] },
    { city: 'Salem', state: 'Oregon', postalCodes: ['97301', '97302', '97306'] },
    { city: 'Eugene', state: 'Oregon', postalCodes: ['97401', '97402', '97404'] },
    { city: 'Wilmington', state: 'Delaware', postalCodes: ['19801', '19802', '19805'] },
    { city: 'Dover', state: 'Delaware', postalCodes: ['19901', '19904'] },
    { city: 'Billings', state: 'Montana', postalCodes: ['59101', '59102', '59105'] },
    { city: 'Missoula', state: 'Montana', postalCodes: ['59801', '59802'] },
    { city: 'Manchester', state: 'New Hampshire', postalCodes: ['03101', '03102', '03104'] },
    { city: 'Nashua', state: 'New Hampshire', postalCodes: ['03060', '03062'] },
    { city: 'Anchorage', state: 'Alaska', postalCodes: ['99501', '99503', '99508'] },
    { city: 'Fairbanks', state: 'Alaska', postalCodes: ['99701', '99709'] }
];

const US_STREET_NAMES = [
    'Main St', 'Oak Ave', 'Maple Dr', 'Cedar Ln', 'Park Blvd',
    'Washington St', 'Lake View Rd', 'Highland Ave', 'Pine St', 'Elm St'
];

/**
 * 随机生成一条美国免税州地址（不落库）
 * @returns {{ line1: string, city: string, state: string, postal_code: string, country: string, generated: true }}
 */
function generateRandomUsTaxFreeAddress() {
    const loc = US_TAX_FREE_LOCATIONS[Math.floor(Math.random() * US_TAX_FREE_LOCATIONS.length)];
    const streetNum = Math.floor(Math.random() * 8900) + 100;
    const street = US_STREET_NAMES[Math.floor(Math.random() * US_STREET_NAMES.length)];
    const postalCodes = loc.postalCodes;
    const postal_code = postalCodes[Math.floor(Math.random() * postalCodes.length)];
    return {
        line1: `${streetNum} ${street}`,
        city: loc.city,
        state: loc.state,
        postal_code,
        country: 'US',
        generated: true
    };
}


async function pickTaxFreeAddress(region, lastUsedId = null) {
    const addresses = (await store.listAddresses(region)).filter((a) => a.is_active !== false && a.is_active !== 0 && !a.is_bound);
    if (!addresses.length) throw new Error('该地区无可用免税地址模板');
    const candidates = addresses.filter((a) => String(a.id) !== String(lastUsedId));
    const pool = candidates.length ? candidates : addresses;
    const picked = pool[Math.floor(Math.random() * pool.length)];
    await store.setAppConfigValue('last_used_address_id', String(picked.id));
    return picked;
}
async function pickBillingAddressForCheckout(lastUsedId = null) {
    let picked;
    try { picked = await pickTaxFreeAddress('US', lastUsedId); }
    catch (error) { if (['LEASE_LOST', 'RESULT_UNKNOWN'].includes(error.code)) throw error; picked = { id: null, ...generateRandomUsTaxFreeAddress() }; }
    return { ...picked, state: normalizeUsStateName(picked.state) };
}
const markAddressBound = (addressId, cardId) => store.markAddressBound(addressId, cardId);
module.exports = { pickTaxFreeAddress, pickBillingAddressForCheckout, generateRandomUsTaxFreeAddress, normalizeUsStateName, markAddressBound, US_STATE_LABELS };
