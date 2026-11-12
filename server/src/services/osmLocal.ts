/**
 * Local copy of OpenStreetMap business data (imported weekly from a Geofabrik extract by
 * scripts/osm-import.js). Searching it needs no public Overpass server, so searches are instant and
 * don't fail when those shared servers are overloaded. Data © OpenStreetMap contributors (ODbL).
 */
import mongoose, { Schema } from 'mongoose';
import type { DiscoveredPlace } from './places';

const OsmPlaceSchema = new Schema(
  { _id: String, lat: Number, lon: Number, tags: Schema.Types.Mixed, importedAt: Date },
  { versionKey: false, collection: 'osm_places' }
);
OsmPlaceSchema.index({ lat: 1, lon: 1 });
OsmPlaceSchema.index({ importedAt: 1 });

const OsmCitySchema = new Schema(
  { _id: String, name: String, names: [String], place: String, lat: Number, lon: Number, importedAt: Date },
  { versionKey: false, collection: 'osm_cities' }
);
OsmCitySchema.index({ names: 1 });
OsmCitySchema.index({ importedAt: 1 });

export const OsmPlace = mongoose.models.OsmPlace || mongoose.model('OsmPlace', OsmPlaceSchema);
export const OsmCity = mongoose.models.OsmCity || mongoose.model('OsmCity', OsmCitySchema);

/** How far from a settlement's centre its businesses reach, by OSM place type. */
const RADIUS_KM: Record<string, number> = { city: 15, town: 8, suburb: 4, village: 3, neighbourhood: 2 };
const RANK: Record<string, number> = { city: 0, town: 1, suburb: 2, village: 3, neighbourhood: 4 };

/**
 * Turn the Overpass tag filters used for categories (e.g. ["amenity"~"^(clinic|doctors)$"]["website"])
 * into a predicate over a tag object, so the same category rules work on local data.
 */
export function tagPredicate(filter: string): (tags: Record<string, string>) => boolean {
  const conds: ((t: Record<string, string>) => boolean)[] = [];
  const re = /\["([^"]+)"(?:\s*(=|~)\s*"((?:[^"\\]|\\.)*)"(\s*,\s*i)?)?\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(filter))) {
    const [, key, op, raw, ci] = m;
    const val = raw?.replace(/\\(.)/g, '$1');
    if (!op) conds.push((t) => t[key] != null);
    else if (op === '=') conds.push((t) => t[key] === val);
    else { const rx = new RegExp(val!, ci ? 'i' : ''); conds.push((t) => t[key] != null && rx.test(t[key])); }
  }
  return (t) => conds.every((c) => c(t));
}

/** True once an import has run. */
export async function localOsmReady() {
  if (mongoose.connection.readyState !== 1) return false;
  return !!(await OsmCity.exists({}));
}

export type LocalResult = { status: 'ok'; elements: any[] } | { status: 'unknown_city' } | { status: 'unavailable' };

/** Elements (Overpass-shaped: {type,id,tags,center}) for the given filters around the named city. */
export async function searchLocalElements(names: string[], filters: string[]): Promise<LocalResult> {
  if (!(await localOsmReady())) return { status: 'unavailable' };
  const lower = names.map((n) => n.toLowerCase());
  const cities = await OsmCity.find({ names: { $in: lower } }).lean<any[]>();
  if (!cities.length) return { status: 'unknown_city' };
  // Prefer a city over a same-named village; then the largest radius covers the rest
  cities.sort((a, b) => (RANK[a.place] ?? 9) - (RANK[b.place] ?? 9));
  const c = cities[0];
  const km = RADIUS_KM[c.place] ?? 5;
  const dLat = km / 111;
  const dLon = km / (111 * Math.cos((c.lat * Math.PI) / 180));
  const preds = filters.map(tagPredicate);
  const docs = await OsmPlace.find({ lat: { $gte: c.lat - dLat, $lte: c.lat + dLat }, lon: { $gte: c.lon - dLon, $lte: c.lon + dLon } }).lean<any[]>();
  const dist = (d: any) => (d.lat - c.lat) ** 2 + ((d.lon - c.lon) * Math.cos((c.lat * Math.PI) / 180)) ** 2;
  const hits = docs.filter((d) => preds.some((p) => p(d.tags || {}))).sort((a, b) => dist(a) - dist(b));
  return {
    status: 'ok',
    elements: hits.map((d) => {
      const [type, id] = String(d._id).split('/');
      return { type, id: Number(id), tags: d.tags, center: { lat: d.lat, lon: d.lon } };
    })
  };
}

export type { DiscoveredPlace };
