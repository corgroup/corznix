// Reconciling India Post's spellings with the canonical names in geo_states.
//
// The directory writes "UTTAR PRADESH", "DELHI", "THE DADRA AND NAGAR HAVELI
// AND DAMAN AND DIU", and still uses some pre-reorganisation names. Our
// geo_states rows are the canonical form every address stores — tax compares
// against them — so a lookup must resolve to one of those rows, never write
// India Post's raw string into an address.

const collapse = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

// The source writes "NA" (and friends) where it has no value. That is an
// absence, not a name: stored as a name it would read as data and be reported
// as a state we failed to map.
const PLACEHOLDER = /^(na|n\/a|null|none|-)$/i;
const present = (value) => {
  const text = collapse(value);
  return text && !PLACEHOLDER.test(text) ? text : null;
};

export function normalizeStateKey(name) {
  return collapse(
    String(name ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' '),
  ).replace(/^the /, '');
}

// Official names that have since changed. Canonicalisation, not postal data:
// each maps a former name to the region as it exists today.
const FORMER_NAMES = new Map([
  ['orissa', 'odisha'],
  ['pondicherry', 'puducherry'],
  ['uttaranchal', 'uttarakhand'],
  ['dadra and nagar haveli', 'dadra and nagar haveli and daman and diu'],
  ['daman and diu', 'dadra and nagar haveli and daman and diu'],
  ['nct of delhi', 'delhi'],
  ['national capital territory of delhi', 'delhi'],
  ['andaman and nicobar', 'andaman and nicobar islands'],
]);

export function resolveStateCode(rawName, stateRows) {
  const key = normalizeStateKey(rawName);
  if (!key) return null;
  const target = FORMER_NAMES.get(key) || key;
  const match = stateRows.find((state) => normalizeStateKey(state.name) === target);
  return match ? match.code : null;
}

// "RAE BARELI" and "Rae Bareli" appear for the same district in the same file.
// Placeholder values the source uses for "unknown" become null, so they are
// never offered to a customer as if they were a place.
export function tidyPlaceName(value) {
  const text = collapse(value);
  if (!text || /^(na|n\/a|null|none|-)$/i.test(text)) return null;
  return text.toLowerCase().replace(/(^|[\s\-(/.])([a-z])/g, (_m, before, letter) => before + letter.toUpperCase());
}

// A coordinate outside its range is a bad value in the source, not a place.
// Rejecting it here matters: one out-of-range latitude would fail the whole
// batch insert under strict SQL mode.
const coordinate = (value, limit) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= limit ? parsed : null;
};

// One directory record, in the shape the rest of the module uses. Field names
// cover both published resources: the current one ("district", "delivery")
// and the older ("districtname", "deliverystatus").
export function normalizeRecord(record) {
  return {
    pincode: collapse(record?.pincode).replace(/\.0+$/, ''),
    officeName: collapse(record?.officename) || null,
    officeType: collapse(record?.officetype) || null,
    delivery: collapse(record?.delivery ?? record?.deliverystatus) || null,
    district: tidyPlaceName(record?.district ?? record?.districtname),
    stateName: present(record?.statename),
    division: collapse(record?.divisionname) || null,
    region: collapse(record?.regionname) || null,
    circle: collapse(record?.circlename) || null,
    latitude: coordinate(record?.latitude, 90),
    longitude: coordinate(record?.longitude, 180),
  };
}
