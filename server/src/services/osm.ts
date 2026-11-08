/**
 * Free business discovery from OpenStreetMap via the Overpass API.
 * Data © OpenStreetMap contributors, ODbL — attribution is shown wherever OSM-sourced leads appear.
 * Only tags that OSM contributors published are used; nothing is inferred.
 */
import { HttpError } from '../utils';
import type { DiscoveredPlace } from './places';

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
  [/it company|software|web/i, ['["office"~"^(it|company)$"]']]
];

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
  const area = `area["name"="${esc(opts.city.trim())}"]["boundary"="administrative"]->.city;`;
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

/** Direct-mode discovery (no n8n). */
export async function searchOsm(opts: { category: string; city?: string | null; country: string; keywords?: string | null; max: number }) {
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
        return selectOsmResults(data.elements || [], opts, opts.max);
      }
      last = `HTTP ${res.status}`; // 429/502/504 = server busy: try the next one
    } catch (e: any) {
      last = e.message;
    }
  }
  throw new HttpError(502, `OpenStreetMap servers are busy (${last}). The search will retry automatically.`, 'osm_busy');
}
