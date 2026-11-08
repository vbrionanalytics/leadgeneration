import { env } from '../config/env';
import { HttpError } from '../utils';

/** Normalised business record produced by discovery (from n8n or direct mode). */
export interface DiscoveredPlace {
  sourceId: string;
  name: string;
  category?: string;
  address?: string;
  city?: string;
  country?: string;
  phone?: string;
  website?: string;
  rating?: number;
  reviewCount?: number;
  location?: { lat: number; lng: number };
  googleMapsUrl?: string;
  businessStatus?: string;
  /** Published business email (OpenStreetMap only; Google doesn't provide emails) */
  email?: string;
  /** Public listing page (e.g. openstreetmap.org/node/123) */
  listingUrl?: string;
  provider?: 'google_places' | 'openstreetmap';
}

export const PLACES_FIELD_MASK = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.addressComponents', 'places.internationalPhoneNumber',
  'places.nationalPhoneNumber', 'places.websiteUri', 'places.rating', 'places.userRatingCount', 'places.location',
  'places.googleMapsUri', 'places.businessStatus', 'places.primaryTypeDisplayName', 'nextPageToken'
].join(',');

export const PLACES_MAX_PER_QUERY = 60; // Text Search returns max 60 results (3 pages x 20)

/** Map a Google Places API (New) place object to our record. Shared shape with the n8n Code node. */
export function mapPlace(p: any, fallbackCountry?: string): DiscoveredPlace | null {
  if (!p?.id || !p?.displayName?.text) return null;
  const comp = (type: string, short = false) => {
    const c = (p.addressComponents || []).find((a: any) => (a.types || []).includes(type));
    return c ? (short ? c.shortText : c.longText) : undefined;
  };
  return {
    sourceId: p.id,
    name: p.displayName.text,
    category: p.primaryTypeDisplayName?.text,
    address: p.formattedAddress,
    city: comp('locality') || comp('administrative_area_level_2'),
    country: comp('country', true) || fallbackCountry,
    phone: p.internationalPhoneNumber || p.nationalPhoneNumber,
    website: p.websiteUri,
    rating: p.rating,
    reviewCount: p.userRatingCount,
    location: p.location ? { lat: p.location.latitude, lng: p.location.longitude } : undefined,
    googleMapsUrl: p.googleMapsUri,
    businessStatus: p.businessStatus,
    provider: 'google_places'
  };
}

/** Direct-mode discovery via Google Places Text Search (New). Paginates up to `max` results. */
export async function searchPlaces(opts: { category: string; city?: string; country: string; keywords?: string; max: number; apiKey?: string }): Promise<DiscoveredPlace[]> {
  const key = opts.apiKey || env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new HttpError(503, 'Google Places API key is not configured.', 'places_not_configured');
  const textQuery = [opts.keywords, opts.category, opts.city ? `in ${opts.city}` : '', opts.country].filter(Boolean).join(' ');
  const out: DiscoveredPlace[] = [];
  let pageToken: string | undefined;
  const limit = Math.min(opts.max, PLACES_MAX_PER_QUERY);
  do {
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': PLACES_FIELD_MASK },
      body: JSON.stringify({ textQuery, pageSize: 20, regionCode: opts.country, pageToken })
    });
    if (!res.ok) throw new HttpError(502, `Google Places error ${res.status}: ${(await res.text()).slice(0, 300)}`, 'places_error');
    const data: any = await res.json();
    for (const p of data.places || []) {
      const m = mapPlace(p, opts.country);
      if (m && m.businessStatus !== 'CLOSED_PERMANENTLY') out.push(m);
    }
    pageToken = data.nextPageToken;
  } while (pageToken && out.length < limit);
  return out.slice(0, limit);
}
