/**
 * Time zone for a lead. Read the state first, then the phone's area code.
 * These are small tables, not complete ones. Anything unresolved returns undefined and the
 * harness then refuses to call (it never guesses a zone).
 */

const ZONES: Record<string, string[]> = {
  "America/Los_Angeles": [
    "206", "209", "213", "253", "310", "323", "360", "408", "415", "424", "425", "442", "503", "510",
    "530", "559", "562", "619", "626", "650", "657", "661", "669", "702", "707", "714", "747", "760",
    "775", "805", "818", "831", "858", "909", "916", "925", "949", "951",
  ],
  "America/Denver": ["303", "385", "406", "435", "505", "575", "719", "720", "801", "970"],
  // 928 is left out: it covers the Navajo Nation, which keeps daylight saving time, so Phoenix time is wrong for part of it.
  "America/Phoenix": ["480", "520", "602", "623"],
  "America/Chicago": [
    "210", "214", "217", "224", "281", "312", "314", "331", "346", "414", "469", "512", "515", "608",
    "630", "636", "708", "713", "773", "815", "816", "817", "832", "847", "872", "918", "972",
  ],
  "America/New_York": [
    "212", "239", "305", "321", "332", "347", "386", "404", "407", "470", "516", "518", "561", "585",
    "607", "617", "631", "646", "678", "703", "718", "727", "754", "770", "786", "813", "845", "857",
    "904", "914", "917", "929", "954",
  ],
};

ZONES["Pacific/Honolulu"] = ["808"];
ZONES["America/Anchorage"] = ["907"];

/**
 * States wholly inside one zone. Split states are left out on purpose: the area code decides them.
 * Arizona is left out too: the Navajo Nation there keeps daylight saving time, so the state alone
 * does not fix a zone. Its area code decides, and an unlisted one leaves the zone unknown.
 */
const STATE_ZONES: Record<string, string[]> = {
  "America/New_York": ["CT", "DE", "DC", "GA", "ME", "MD", "MA", "NH", "NJ", "NY", "NC", "OH", "PA", "RI", "SC", "VT", "VA", "WV"],
  "America/Chicago": ["AL", "AR", "IL", "IA", "LA", "MN", "MS", "MO", "OK", "WI"],
  "America/Denver": ["CO", "MT", "NM", "UT", "WY"],
  "America/Los_Angeles": ["CA", "NV", "WA"],
  "America/Anchorage": ["AK"],
  "Pacific/Honolulu": ["HI"],
};

const BY_STATE = new Map<string, string>(
  Object.entries(STATE_ZONES).flatMap(([zone, states]) => states.map((st) => [st, zone] as const)),
);

const BY_AREA_CODE = new Map<string, string>(
  Object.entries(ZONES).flatMap(([zone, codes]) => codes.map((c) => [c, zone] as const)),
);

export function zoneForPhone(phone: string): string | undefined {
  const digits = phone.replace(/\D/g, "");
  const national = digits.length >= 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (national.length < 10) return undefined;
  return BY_AREA_CODE.get(national.slice(0, 3));
}

/**
 * Read the lead's state first, then the phone's area code.
 * There is no agency fallback: if neither resolves, the zone is unknown and
 * the harness refuses to call.
 */
export function zoneForLead(state: unknown, phone: string): string | undefined {
  const st = typeof state === "string" ? state.trim().toUpperCase() : "";
  return BY_STATE.get(st) ?? zoneForPhone(phone);
}

export function isIanaZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || !zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Last ten digits, suitable for suppression and do-not-call keys. */
export function phoneKey(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}
