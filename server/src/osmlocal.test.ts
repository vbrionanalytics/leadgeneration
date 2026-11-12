import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.ENCRYPTION_KEY = 'test-encryption-key-test-encryption-key';
const { OsmCity, OsmPlace, tagPredicate } = await import('./services/osmLocal');
const { searchOsmLocal } = await import('./services/osm');

beforeAll(async () => {
  await mongoose.connect((process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/leadgen') .replace(/\/[^/]*$/, '/osmlocal_test'));
  await Promise.all([OsmCity.deleteMany({}), OsmPlace.deleteMany({})]);
  await OsmCity.create([
    { _id: 'node/1', name: 'Salem', names: ['salem'], place: 'city', lat: 11.6643, lon: 78.146 },
    { _id: 'node/9', name: 'Salem', names: ['salem'], place: 'village', lat: 10.1, lon: 77.1 },
    { _id: 'node/6', name: 'Bengaluru', names: ['bengaluru', 'bangalore'], place: 'city', lat: 12.97, lon: 77.59 }
  ]);
  await OsmPlace.create([
    { _id: 'node/2', lat: 11.67, lon: 78.15, tags: { amenity: 'restaurant', name: 'Saravana', website: 'saravana.example', email: 'info@saravana.example' } },
    { _id: 'node/3', lat: 11.65, lon: 78.13, tags: { amenity: 'restaurant', name: 'Selvi Mess' } },
    { _id: 'node/4', lat: 10.1, lon: 77.1, tags: { amenity: 'restaurant', name: 'Village Mess' } },
    { _id: 'way/20', lat: 11.66, lon: 78.14, tags: { amenity: 'hospital', name: 'GH Salem' } }
  ]);
});
afterAll(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

describe('local OpenStreetMap copy', () => {
  it('evaluates the category tag filters', () => {
    expect(tagPredicate('["amenity"~"^(clinic|doctors)$"]')({ amenity: 'doctors' })).toBe(true);
    expect(tagPredicate('["shop"]["name"~"silk",i]')({ shop: 'clothes', name: 'Sri Krishna SILKS' })).toBe(true);
    expect(tagPredicate('["amenity"="restaurant"]["website"]')({ amenity: 'restaurant' })).toBe(false);
  });
  it('finds businesses around the city (not a same-named village), websites first', async () => {
    const r = await searchOsmLocal({ category: 'Restaurants', city: 'salem', country: 'IN', max: 20 });
    expect(r!.map((p) => p.name)).toEqual(['Saravana', 'Selvi Mess']);
    expect(r![0]).toMatchObject({ website: 'https://saravana.example', email: 'info@saravana.example', listingUrl: 'https://www.openstreetmap.org/node/2', provider: 'openstreetmap' });
  });
  it('returns null for a city outside the local copy, so the public servers are used', async () => {
    expect(await searchOsmLocal({ category: 'Restaurants', city: 'Ooty', country: 'IN', max: 20 })).toBeNull();
  });
  it('says clearly when nothing of that kind is mapped', async () => {
    await expect(searchOsmLocal({ category: 'Gyms', city: 'Salem', country: 'IN', max: 20 })).rejects.toMatchObject({ permanent: true });
  });
});
