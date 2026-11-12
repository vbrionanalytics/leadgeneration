/**
 * Load businesses and settlements from an osmium GeoJSON-sequence export into MongoDB
 * (collections osm_places and osm_cities). Run by deploy/osm-refresh.sh; safe to re-run:
 * records are upserted and anything not in the new export is removed at the end.
 *   node scripts/osm-import.js /var/lib/leadgen-osm/pois.geojsonseq
 * Data © OpenStreetMap contributors, ODbL.
 */
require('dotenv').config();
const fs = require('fs');
const readline = require('readline');
const mongoose = require('mongoose');

const BUSINESS_KEYS = ['amenity', 'shop', 'office', 'tourism', 'healthcare', 'leisure', 'craft'];
const SETTLEMENTS = new Set(['city', 'town', 'suburb', 'village', 'neighbourhood']);
// Tags worth keeping: what search filters on and what a lead shows. Everything else is dropped to save space.
const KEEP = /^(name|name:en|brand|amenity|shop|office|tourism|healthcare|healthcare:speciality|craft|leisure|website|url|phone|email|contact:.*|addr:.*|opening_hours|disused.*|abandoned)$/;
// Not businesses: no point storing benches, toilets, parking and the like
const SKIP_AMENITY = /^(bench|toilets|parking|parking_space|parking_entrance|waste_basket|waste_disposal|recycling|drinking_water|shelter|bicycle_parking|motorcycle_parking|vending_machine|post_box|telephone|clock|fountain|grave_yard|water_point|watering_place|hunting_stand|loading_dock|letter_box|bus_station|taxi)$/;

function centre(g) {
  if (!g) return null;
  if (g.type === 'Point') return g.coordinates;
  const ring = g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates[0][0] : g.type === 'LineString' ? g.coordinates : null;
  if (!ring || !ring.length) return null;
  let x = 0, y = 0;
  for (const [lon, lat] of ring) { x += lon; y += lat; }
  return [x / ring.length, y / ring.length];
}

(async () => {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) { console.error('Usage: node scripts/osm-import.js <export.geojsonseq>'); process.exit(1); }
  await mongoose.connect(process.env.MONGODB_URI);
  const { OsmPlace, OsmCity } = require('../dist/services/osmLocal');
  await Promise.all([OsmPlace.syncIndexes(), OsmCity.syncIndexes()]);
  const started = new Date();
  let places = [], cities = [], nPlaces = 0, nCities = 0, lines = 0;

  const flush = async (force) => {
    if (places.length >= 2000 || (force && places.length)) {
      await OsmPlace.bulkWrite(places.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })), { ordered: false });
      nPlaces += places.length; places = [];
    }
    if (cities.length >= 2000 || (force && cities.length)) {
      await OsmCity.bulkWrite(cities.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })), { ordered: false });
      nCities += cities.length; cities = [];
    }
  };

  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (let line of rl) {
    line = line.replace(/^\x1e/, '').trim(); // geojsonseq records may start with a record separator
    if (!line) continue;
    lines++;
    let f;
    try { f = JSON.parse(line); } catch { continue; }
    const p = f.properties || {};
    const type = p['@type'], id = p['@id'];
    const name = p.name || p['name:en'];
    if (!type || !id || !name) continue;
    const c = centre(f.geometry);
    if (!c) continue;
    const [lon, lat] = c;
    const _id = `${type}/${id}`;

    if (SETTLEMENTS.has(p.place)) {
      const names = new Set();
      for (const k of ['name', 'name:en', 'alt_name', 'old_name', 'official_name', 'short_name']) {
        for (const v of String(p[k] || '').split(';')) if (v.trim()) names.add(v.trim().toLowerCase());
      }
      cities.push({ _id, name, names: [...names], place: p.place, lat, lon, importedAt: started });
    }
    if (BUSINESS_KEYS.some((k) => p[k]) && !(p.amenity && SKIP_AMENITY.test(p.amenity) && !p.shop && !p.office)) {
      const tags = {};
      for (const [k, v] of Object.entries(p)) if (!k.startsWith('@') && KEEP.test(k)) tags[k] = v;
      places.push({ _id, lat, lon, tags, importedAt: started });
    }
    await flush(false);
    if (lines % 200000 === 0) console.log(`  read ${lines.toLocaleString()} records…`);
  }
  await flush(true);
  // Remove businesses that closed or were deleted from the map since the last import
  const [gp, gc] = await Promise.all([OsmPlace.deleteMany({ importedAt: { $lt: started } }), OsmCity.deleteMany({ importedAt: { $lt: started } })]);
  console.log(`Imported ${nPlaces.toLocaleString()} businesses and ${nCities.toLocaleString()} cities/towns (removed ${gp.deletedCount + gc.deletedCount} stale).`);
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
