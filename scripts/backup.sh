#!/bin/sh
# Sicherung von Schottr (Docker Compose): Datenbank als ./backup/schottr-JJJJ-MM-TT_HHMM.sql.gz
# und die Dateiablage (Nachweise, Eingangsrechnungen, Belegeingang) als ./backup/schottr-dateien-JJJJ-MM-TT_HHMM.tar.gz.
# Für tägliche Sicherung z. B. per cron:  0 2 * * *  cd /pfad/zu/schottr && ./scripts/backup.sh
# Wiederherstellen:  gunzip -c backup/DATEI.sql.gz | docker compose exec -T db sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" schottr'
#                    tar -xzf backup/schottr-dateien-DATUM.tar.gz -C data
set -e
cd "$(dirname "$0")/.."
mkdir -p backup
stamp="$(date +%Y-%m-%d_%H%M)"
file="backup/schottr-$stamp.sql.gz"
docker compose exec -T db sh -c 'mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" --single-transaction --routines --triggers schottr' | gzip > "$file"
echo "Sicherung erstellt: $file"
dirs=""
for d in nachweise verbindlichkeiten other; do [ -d "data/$d" ] && dirs="$dirs $d"; done
if [ -n "$dirs" ]; then
  tar -czf "backup/schottr-dateien-$stamp.tar.gz" -C data $dirs
  echo "Dateien gesichert: backup/schottr-dateien-$stamp.tar.gz"
fi
