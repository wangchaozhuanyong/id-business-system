import { randomInt } from 'node:crypto';

// 与线上代充采用相同的生成规则；资源只写入比特充值自己的地址与姓名绑定。
const locations: [string, string, string[]][] = [
  ['Portland', 'Oregon', ['97201', '97205', '97209', '97214']],
  ['Salem', 'Oregon', ['97301', '97302', '97306']],
  ['Eugene', 'Oregon', ['97401', '97402', '97404']],
  ['Wilmington', 'Delaware', ['19801', '19802', '19805']],
  ['Dover', 'Delaware', ['19901', '19904']],
  ['Billings', 'Montana', ['59101', '59102', '59105']],
  ['Missoula', 'Montana', ['59801', '59802']],
  ['Manchester', 'New Hampshire', ['03101', '03102', '03104']],
  ['Nashua', 'New Hampshire', ['03060', '03062']],
  ['Anchorage', 'Alaska', ['99501', '99503', '99508']],
  ['Fairbanks', 'Alaska', ['99701', '99709']]
];
const streets = [
  'Main St',
  'Oak Ave',
  'Maple Dr',
  'Cedar Ln',
  'Park Blvd',
  'Washington St',
  'Lake View Rd',
  'Highland Ave',
  'Pine St',
  'Elm St'
];
const firstNames = [
  'James',
  'Mary',
  'Robert',
  'Patricia',
  'John',
  'Jennifer',
  'Michael',
  'Linda',
  'David',
  'Elizabeth',
  'William',
  'Barbara',
  'Richard',
  'Susan',
  'Joseph',
  'Jessica',
  'Thomas',
  'Sarah',
  'Christopher',
  'Karen',
  'Charles',
  'Lisa',
  'Daniel',
  'Nancy',
  'Matthew',
  'Betty',
  'Anthony',
  'Margaret',
  'Mark',
  'Sandra'
];
const lastNames = [
  'Smith',
  'Johnson',
  'Williams',
  'Brown',
  'Jones',
  'Garcia',
  'Miller',
  'Davis',
  'Rodriguez',
  'Martinez',
  'Hernandez',
  'Lopez',
  'Gonzalez',
  'Wilson',
  'Anderson',
  'Thomas',
  'Taylor',
  'Moore',
  'Jackson',
  'Martin',
  'Lee',
  'Perez',
  'Thompson',
  'White',
  'Harris',
  'Sanchez',
  'Clark',
  'Ramirez',
  'Lewis',
  'Robinson'
];

export function generateRechargeBillingName() {
  return `${firstNames[randomInt(firstNames.length)]} ${lastNames[randomInt(lastNames.length)]}`;
}

export function generateRechargeBillingAddress() {
  const [city, state, postalCodes] = locations[randomInt(locations.length)]!;
  return {
    country: 'US',
    line1: `${randomInt(100, 9000)} ${streets[randomInt(streets.length)]}`,
    line2: null,
    city,
    state,
    postalCode: postalCodes[randomInt(postalCodes.length)]!
  };
}
