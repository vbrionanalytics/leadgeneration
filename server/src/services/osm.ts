/**
 * Free business discovery from OpenStreetMap via the Overpass API.
 * Data © OpenStreetMap contributors, ODbL — attribution is shown wherever OSM-sourced leads appear.
 * Only tags that OSM contributors published are used; nothing is inferred.
 */
import { HttpError } from '../utils';
import type { DiscoveredPlace } from './places';
import { searchLocalElements } from './osmLocal';

/** Public servers, tried in order. They throttle heavy automated use; set OVERPASS_URL to your own instance for volume. */
export const OVERPASS_URLS = (process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter')
  .split(',').map((u) => u.trim()).filter(Boolean);
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors (ODbL)';

/** Common search words → OSM tag filters. Anything else falls back to a name search across business tags. */
const CATEGORY_TAGS: [RegExp, string[]][] = [
  [/dent(al|ist)|orthodont/i, ['["amenity"="dentist"]', '["healthcare"="dentist"]']],
  [/clinic|doctor|physician|medical|health/i, ['["amenity"~"^(clinic|doctors)$"]', '["healthcare"~"^(clinic|doctor|centre)$"]']],
  [/hospital/i, ['["amenity"="hospital"]', '["healthcare"="hospital"]']],
  [/pharmac|chemist|medical shop/i, ['["amenity"="pharmacy"]', '["shop"="chemist"]']],
  [/physio/i, ['["healthcare"="physiotherapist"]']],
  [/lab(oratory)?|diagnostic|scan|imaging/i, ['["healthcare"~"^(laboratory|sample_collection)$"]', '["amenity"="clinic"]["healthcare:speciality"~"radiology"]']],
  [/restaurant|food|biryani|mess/i, ['["amenity"="restaurant"]']],
  [/cafe|coffee|bakery|sweet/i, ['["amenity"="cafe"]', '["shop"~"^(bakery|confectionery|pastry)$"]']],
  [/hotel|lodge|stay|resort|guest ?house|hostel/i, ['["tourism"~"^(hotel|guest_house|hostel|motel)$"]']],
  [/gym|fitness/i, ['["leisure"="fitness_centre"]']],
  [/salon|beauty|spa|parlou?r/i, ['["shop"~"^(beauty|hairdresser)$"]', '["leisure"="spa"]']],
  [/school/i, ['["amenity"="school"]']],
  [/college|university|institute/i, ['["amenity"~"^(college|university)$"]']],
  [/coaching|tuition|training|academy/i, ['["amenity"~"^(training|language_school|music_school|driving_school)$"]', '["office"="educational_institution"]']],
  [/real estate|estate agent|property/i, ['["office"="estate_agent"]', '["shop"="estate_agent"]']],
  [/lawyer|advocate|legal/i, ['["office"="lawyer"]']],
  [/account|\bca\b|chartered|audit|tax/i, ['["office"~"^(accountant|tax_advisor)$"]']],
  [/architect|interior/i, ['["office"="architect"]', '["shop"="interior_decoration"]', '["craft"="interior_designer"]']],
  [/textile|saree|cloth|garment|boutique|fashion/i, ['["shop"~"^(clothes|fabric|boutique|tailor)$"]']],
  [/jewel/i, ['["shop"="jewelry"]']],
  [/furniture/i, ['["shop"="furniture"]']],
  [/car|auto|garage|motor/i, ['["shop"~"^(car|car_repair|motorcycle)$"]']],
  [/electronic|mobile shop|computer/i, ['["shop"~"^(electronics|mobile_phone|computer)$"]']],
  [/super ?market|grocery/i, ['["shop"~"^(supermarket|convenience|greengrocer)$"]']],
  [/travel|tour/i, ['["shop"="travel_agency"]', '["office"="travel_agent"]']],
  [/^\s*it\b|\bit (company|companies|firm|services?|park)|software|web (design|develop)|tech(nology)? (company|firm)/i, ['["office"~"^(it|company|telecommunication)$"]', '["office"]["name"~"(soft|tech|infotech|systems|solutions|digital)",i]']]
];

/** Common spellings and old names → the names OpenStreetMap uses (matched case-insensitively). */
const CITY_ALIASES: Record<string, string[]> = {
  bangalore: ['Bengaluru', 'Bangalore'], banglore: ['Bengaluru', 'Bangalore'], bengaluru: ['Bengaluru', 'Bangalore'], bengalore: ['Bengaluru', 'Bangalore'], blr: ['Bengaluru'],
  bombay: ['Mumbai'], mumbai: ['Mumbai', 'Bombay'], madras: ['Chennai'], chennai: ['Chennai', 'Madras'], calcutta: ['Kolkata'], kolkata: ['Kolkata', 'Calcutta'],
  kovai: ['Coimbatore'], coimbatore: ['Coimbatore', 'Kovai'], cbe: ['Coimbatore'], trichy: ['Tiruchirappalli', 'Tiruchirapalli', 'Trichy'], tiruchy: ['Tiruchirappalli'],
  tiruchirappalli: ['Tiruchirappalli', 'Tiruchirapalli'], madurai: ['Madurai'], salem: ['Salem'], tirupur: ['Tiruppur', 'Tirupur'], tiruppur: ['Tiruppur', 'Tirupur'],
  pondicherry: ['Puducherry', 'Pondicherry'], pondy: ['Puducherry'], puducherry: ['Puducherry', 'Pondicherry'], ooty: ['Udhagamandalam', 'Ooty'],
  mysore: ['Mysuru', 'Mysore'], mysuru: ['Mysuru', 'Mysore'], mangalore: ['Mangaluru', 'Mangalore'], mangaluru: ['Mangaluru', 'Mangalore'],
  gurgaon: ['Gurugram', 'Gurgaon'], gurugram: ['Gurugram', 'Gurgaon'], poona: ['Pune'], baroda: ['Vadodara'], vizag: ['Visakhapatnam'],
  trivandrum: ['Thiruvananthapuram', 'Trivandrum'], cochin: ['Kochi', 'Cochin'], kochi: ['Kochi', 'Cochin'], calicut: ['Kozhikode', 'Calicut'],
  delhi: ['Delhi', 'New Delhi'], 'new delhi': ['New Delhi', 'Delhi'], hyderabad: ['Hyderabad'], secunderabad: ['Secunderabad'], tanjore: ['Thanjavur'], thanjavur: ['Thanjavur', 'Tanjore'],
  nellai: ['Tirunelveli'], tirunelveli: ['Tirunelveli'], vellore: ['Vellore'], erode: ['Erode'], karur: ['Karur'], namakkal: ['Namakkal'], hosur: ['Hosur'], dindigul: ['Dindigul']
};

/** Names to look for when finding the city's boundary: known spellings, else the typed name in Title Case and as typed. */
export function cityNames(city: string): string[] {
  const typed = city.trim().replace(/\s+/g, ' ').replace(/ (city|district|town)$/i, '');
  const known = CITY_ALIASES[typed.toLowerCase()];
  if (known) return known;
  const title = typed.toLowerCase().replace(/(^|[\s-])\S/g, (c) => c.toUpperCase());
  return [...new Set([title, typed])];
}
/**
 * Overpass filter for the city's boundary. Exact matches on several name tags use Overpass's index,
 * so this stays fast on busy public servers (a case-insensitive regex here scans every area and times out).
 */
function cityAreaFilter(city: string) {
  const keys = ['name', 'name:en', 'alt_name', 'old_name'];
  const parts = cityNames(city).flatMap((n) => keys.map((k) => `area["boundary"="administrative"]["${k}"="${esc(n)}"];`));
  return `(${parts.join('')})->.city;`;
}

const titleCase = (s?: string | null) => (s ? s.trim().replace(/\b\w/g, (c) => c.toUpperCase()) : s);
const esc = (s: string) => s.replace(/["\\]/g, '\\$&');

export function categoryFilters(category: string, keywords?: string): string[] {
  const text = `${category} ${keywords || ''}`;
  for (const [re, filters] of CATEGORY_TAGS) if (re.test(text)) return filters;
  // Unknown category: match the words in business names
  const word = esc(category.replace(/s\b/i, '').trim());
  return [`["shop"]["name"~"${word}",i]`, `["office"]["name"~"${word}",i]`, `["amenity"]["name"~"${word}",i]`, `["craft"]["name"~"${word}",i]`];
}

/** Overpass QL for businesses of a category inside a city's administrative area. */
export function buildOverpassQuery(opts: { category: string; city?: string | null; country: string; keywords?: string | null; requireWebsite?: boolean }) {
  if (!opts.city) throw new HttpError(400, 'Enter a city to search OpenStreetMap.', 'city_required');
  const area = cityAreaFilter(opts.city);
  const site = opts.requireWebsite ? '["website"]' : '';
  const parts = categoryFilters(opts.category, opts.keywords ?? undefined).map((f) => `nwr${f}${site}(area.city);`).join('');
  return `[out:json][timeout:60];${area}(${parts});out center tags 500;`;
}

/** Map one Overpass element to our discovery record (shape shared with Google results). */
export function mapOsmElement(e: any, fallback: { city?: string | null; country: string }): DiscoveredPlace | null {
  const t = e?.tags || {};
  const name = t.name || t['name:en'] || t.brand;
  if (!e?.type || !e?.id || !name) return null;
  if (t.disused || t['disused:shop'] || t['abandoned'] || t.opening_hours === 'closed') return null;
  let website: string | undefined = t.website || t['contact:website'] || t.url;
  if (website && !/^https?:\/\//i.test(website)) website = `https://${website}`;
  const lat = e.lat ?? e.center?.lat;
  const lon = e.lon ?? e.center?.lon;
  return {
    sourceId: `osm:${e.type}/${e.id}`,
    name: String(name).trim(),
    category: t.healthcare || t.amenity || t.shop || t.office || t.tourism || t.craft || t.leisure,
    address: [t['addr:housenumber'], t['addr:street'], t['addr:full'], t['addr:suburb'], t['addr:postcode']].filter(Boolean).join(', ') || undefined,
    city: titleCase(t['addr:city'] || fallback.city || t['addr:district']) || undefined,
    country: (t['addr:country'] || fallback.country || '').toUpperCase(),
    phone: (t.phone || t['contact:phone'] || t['contact:mobile'] || '').split(';')[0].trim() || undefined,
    website,
    email: (t.email || t['contact:email'] || '').split(';')[0].trim().toLowerCase() || undefined,
    location: lat != null && lon != null ? { lat, lng: lon } : undefined,
    listingUrl: `https://www.openstreetmap.org/${e.type}/${e.id}`,
    provider: 'openstreetmap'
  };
}

/** Websites first (they can be analysed), then the rest; capped at max. */
export function selectOsmResults(elements: any[], fallback: { city?: string | null; country: string }, max: number): DiscoveredPlace[] {
  const mapped = elements.map((e) => mapOsmElement(e, fallback)).filter((p): p is DiscoveredPlace => !!p);
  mapped.sort((a, b) => Number(!!b.website) - Number(!!a.website));
  return mapped.slice(0, max);
}

/**
 * Search the server's own copy of OpenStreetMap data. Returns null when there's no local copy or the
 * city isn't in it (then the public Overpass servers are used).
 */
export async function searchOsmLocal(opts: { category: string; city?: string | null; country: string; keywords?: string | null; max: number }): Promise<DiscoveredPlace[] | null> {
  if (!opts.city) return null;
  const r = await searchLocalElements(cityNames(opts.city), categoryFilters(opts.category, opts.keywords ?? undefined));
  if (r.status !== 'ok') return null;
  const places = selectOsmResults(r.elements, opts, opts.max);
  if (!places.length) {
    const err: any = new HttpError(404, `No "${opts.category}" are mapped in ${titleCase(opts.city)} on OpenStreetMap. Try a broader category (for example Hospitals, Schools, Hotels, Restaurants) or a nearby larger city.`, 'osm_none');
    err.permanent = true;
    throw err;
  }
  return places;
}

/** Direct-mode discovery (no n8n): local copy first, public Overpass servers as fallback. */
export async function searchOsm(opts: { category: string; city?: string | null; country: string; keywords?: string | null; max: number }) {
  const local = await searchOsmLocal(opts);
  if (local) return local;
  const body = `data=${encodeURIComponent(buildOverpassQuery(opts))}`;
  let last = '';
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'AILeadGen/1.0' },
        body,
        signal: AbortSignal.timeout(90_000)
      });
      if (res.ok) {
        const data: any = await res.json();
        // An overloaded server can answer 200 with no elements and a remark like "runtime error: Query timed out".
        // That is not "nothing found": try the next server / retry later.
        if (data.remark && /error|timed out|out of memory/i.test(data.remark) && !(data.elements || []).length) { last = data.remark; continue; }
        const places = selectOsmResults(data.elements || [], opts, opts.max);
        if (!places.length) await explainEmpty(url, opts);
        return places;
      }
      last = `HTTP ${res.status}`; // 429/502/504 = server busy: try the next one
    } catch (e: any) {
      if (e?.permanent) throw e; // a definite answer (unknown city / nothing mapped), not a busy server
      last = e.message;
    }
  }
  throw new HttpError(502, `OpenStreetMap servers are busy (${last}). The search will retry automatically.`, 'osm_busy');
}

/**
 * A search with no results either named a city OpenStreetMap doesn't know (spelling) or found no
 * mapped businesses of that kind there. Tell the user which, so they can fix the search.
 */
async function explainEmpty(url: string, opts: { category: string; city?: string | null }) {
  let cityFound = true;
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'AILeadGen/1.0' },
      body: `data=${encodeURIComponent(`[out:json][timeout:25];${cityAreaFilter(opts.city || '')}.city out ids;`)}`, signal: AbortSignal.timeout(30_000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    {
      const d: any = await res.json();
      if (d.remark && /error|timed out/i.test(d.remark)) throw new Error(d.remark);
      cityFound = (d.elements || []).length > 0;
    }
  } catch (e: any) {
    // Can't tell right now: report busy so the search retries rather than wrongly saying "nothing here"
    throw new HttpError(502, `OpenStreetMap servers are busy (${e?.message || 'no answer'}). The search will retry automatically.`, 'osm_busy');
  }
  const err: any = cityFound
    ? new HttpError(404, `No "${opts.category}" are mapped in ${titleCase(opts.city)} on OpenStreetMap. Try a broader category (for example Hospitals, Schools, Hotels, Restaurants) or a nearby larger city.`, 'osm_none')
    : new HttpError(404, `OpenStreetMap doesn't know a city called "${opts.city}". Check the spelling (for example Bengaluru, Coimbatore, Erode).`, 'osm_city_unknown');
  err.permanent = true; // retrying won't help
  throw err;
}
