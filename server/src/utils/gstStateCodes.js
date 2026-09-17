// GST state / union-territory codes (the first two digits of a GSTIN), used for
// the invoice's place of supply and to decide CGST+SGST (same state as the
// supplier) versus IGST (another state).
//
// The tax engine used to recognise only Uttar Pradesh ("up", "09", "uttar
// pradesh") and treat every other spelling as inter-state. Addresses reach us
// as state names from the PIN directory, ISO 3166-2 codes (IN-UP) or short
// forms, so all of those resolve here.

const STATES = [
  ['01', 'Jammu and Kashmir', ['IN-JK', 'JK', 'J&K']],
  ['02', 'Himachal Pradesh', ['IN-HP', 'HP']],
  ['03', 'Punjab', ['IN-PB', 'PB']],
  ['04', 'Chandigarh', ['IN-CH', 'CH']],
  ['05', 'Uttarakhand', ['IN-UK', 'IN-UT', 'UK', 'Uttaranchal']],
  ['06', 'Haryana', ['IN-HR', 'HR']],
  ['07', 'Delhi', ['IN-DL', 'DL', 'NCT of Delhi', 'New Delhi']],
  ['08', 'Rajasthan', ['IN-RJ', 'RJ']],
  ['09', 'Uttar Pradesh', ['IN-UP', 'UP']],
  ['10', 'Bihar', ['IN-BR', 'BR']],
  ['11', 'Sikkim', ['IN-SK', 'SK']],
  ['12', 'Arunachal Pradesh', ['IN-AR', 'AR']],
  ['13', 'Nagaland', ['IN-NL', 'NL']],
  ['14', 'Manipur', ['IN-MN', 'MN']],
  ['15', 'Mizoram', ['IN-MZ', 'MZ']],
  ['16', 'Tripura', ['IN-TR', 'TR']],
  ['17', 'Meghalaya', ['IN-ML', 'ML']],
  ['18', 'Assam', ['IN-AS', 'AS']],
  ['19', 'West Bengal', ['IN-WB', 'WB']],
  ['20', 'Jharkhand', ['IN-JH', 'JH']],
  ['21', 'Odisha', ['IN-OD', 'IN-OR', 'OD', 'Orissa']],
  ['22', 'Chhattisgarh', ['IN-CG', 'IN-CT', 'CG']],
  ['23', 'Madhya Pradesh', ['IN-MP', 'MP']],
  ['24', 'Gujarat', ['IN-GJ', 'GJ']],
  ['26', 'Dadra and Nagar Haveli and Daman and Diu', ['IN-DH', 'IN-DN', 'IN-DD', 'Dadra and Nagar Haveli', 'Daman and Diu']],
  ['27', 'Maharashtra', ['IN-MH', 'MH']],
  ['29', 'Karnataka', ['IN-KA', 'KA']],
  ['30', 'Goa', ['IN-GA', 'GA']],
  ['31', 'Lakshadweep', ['IN-LD', 'LD']],
  ['32', 'Kerala', ['IN-KL', 'KL']],
  ['33', 'Tamil Nadu', ['IN-TN', 'TN']],
  ['34', 'Puducherry', ['IN-PY', 'PY', 'Pondicherry']],
  ['35', 'Andaman and Nicobar Islands', ['IN-AN', 'AN']],
  ['36', 'Telangana', ['IN-TG', 'IN-TS', 'TG', 'TS']],
  ['37', 'Andhra Pradesh', ['IN-AP', 'AP']],
  ['38', 'Ladakh', ['IN-LA', 'LA']],
  ['97', 'Other Territory', []],
];

const key = (v) => String(v ?? '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

const LOOKUP = new Map();
for (const [code, name, aliases] of STATES) {
  const entry = Object.freeze({ code, name });
  for (const v of [code, name, ...aliases]) LOOKUP.set(key(v), entry);
}

/** @returns {{ code: string, name: string } | null} */
export function gstStateFor(value) {
  const k = key(value);
  return k ? LOOKUP.get(k) ?? null : null;
}

export const GST_STATES = Object.freeze(STATES.map(([code, name]) => Object.freeze({ code, name })));
