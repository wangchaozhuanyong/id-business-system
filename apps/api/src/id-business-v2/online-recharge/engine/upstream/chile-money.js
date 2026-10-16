'use strict';

// CLP uses whole pesos. A bare "$" is not proof of Chilean currency.
function parseLabelledChileMoney(text, label, { negative = false } = {}) {
    const money = '([0-9][0-9.,]*)';
    const currency = '(?:CLP\\s*\\$?|CL\\$)';
    const sign = negative ? '-?\\s*' : '';
    const patterns = [
        new RegExp(label + '[\\s:：]*' + sign + currency + '\\s*' + money, 'gi'),
        new RegExp(label + '[\\s:：]*' + sign + money + '\\s*' + currency + '(?![A-Z])', 'gi')
    ];
    const amounts = new Set();
    for (const pattern of patterns)
        for (const match of String(text || '').matchAll(pattern)) {
            const whole = match[1].replace(/[.,]00$/, '');
            if (!/^[0-9]+$/.test(whole) && !/^[0-9]{1,3}([.,])[0-9]{3}(?:\1[0-9]{3})*$/.test(whole)) return null;
            amounts.add(whole.replace(/[.,]/g, '').replace(/^0+(?=\d)/, ''));
        }
    return amounts.size === 1 ? { amount: [...amounts][0], currency: 'CLP' } : null;
}

module.exports = { parseLabelledChileMoney };
