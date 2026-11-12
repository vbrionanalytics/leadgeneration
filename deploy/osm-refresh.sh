#!/usr/bin/env bash
# Download OpenStreetMap data for the configured regions, keep only businesses and towns, and load
# them into MongoDB so searches don't depend on the public Overpass servers.
# Run as root. Safe to re-run; installs a weekly cron job the first time.
#   bash deploy/osm-refresh.sh                       # default: South India
#   OSM_REGIONS="asia/india/southern-zone asia/india/western-zone" bash deploy/osm-refresh.sh
# Regions are Geofabrik paths (https://download.geofabrik.de). Data © OpenStreetMap contributors, ODbL.
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK=/var/lib/leadgen-osm
REGIONS="${OSM_REGIONS:-asia/india/southern-zone}"
mkdir -p "$WORK"
cd "$WORK"

command -v osmium >/dev/null || { echo "Installing osmium-tool…"; apt-get update -qq && apt-get install -y -qq osmium-tool >/dev/null; }

free_gb=$(df -BG --output=avail "$WORK" | tail -1 | tr -dc 0-9)
if (( free_gb < 6 )); then echo "Need about 6 GB free in $WORK, only ${free_gb} GB available."; exit 1; fi

parts=()
for r in $REGIONS; do
  f="$(basename "$r").osm.pbf"
  echo "Downloading $r…"
  if ! curl -fsSL --retry 3 -o "$f.part" "https://download.geofabrik.de/${r}-latest.osm.pbf"; then
    if [[ $r == asia/india/* ]]; then
      echo "  $r isn't available; downloading all of India instead (larger, slower)…"
      r=asia/india; f=india.osm.pbf
      curl -fsSL --retry 3 -o "$f.part" "https://download.geofabrik.de/asia/india-latest.osm.pbf"
    else
      echo "Download failed for $r"; exit 1
    fi
  fi
  mv "$f.part" "$f"
  echo "  $(du -h "$f" | cut -f1)"
  parts+=("$f")
done

echo "Keeping businesses and towns…"
if (( ${#parts[@]} > 1 )); then osmium merge "${parts[@]}" -o merged.osm.pbf --overwrite; src=merged.osm.pbf; else src="${parts[0]}"; fi
osmium tags-filter "$src" nwr/amenity nwr/shop nwr/office nwr/tourism nwr/healthcare nwr/leisure nwr/craft nwr/place=city,town,suburb,village,neighbourhood -o pois.osm.pbf --overwrite
osmium export pois.osm.pbf -f geojsonseq -a type,id -o pois.geojsonseq --overwrite

echo "Loading into the database…"
(cd "$APP_DIR/server" && node scripts/osm-import.js "$WORK/pois.geojsonseq")
rm -f pois.osm.pbf pois.geojsonseq merged.osm.pbf

# Weekly refresh (Sunday 03:17), so new and closed businesses are picked up
CRON=/etc/cron.d/leadgen-osm
if [[ ! -f $CRON ]]; then
  echo "17 3 * * 0 root OSM_REGIONS=\"$REGIONS\" bash $APP_DIR/deploy/osm-refresh.sh >> /var/log/leadgen-osm.log 2>&1" > "$CRON"
  echo "Weekly refresh scheduled (Sundays 03:17, log: /var/log/leadgen-osm.log)."
fi
echo "OSM_READY"
