#!/bin/sh
# Sicherung der Schottr-Datenbank (Docker Compose). Legt ./backup/schottr-JJJJ-MM-TT_HHMM.sql.gz an.
# Für tägliche Sicherung z. B. per cron:  0 2 * * *  /pfad/zu/schottr/backup.sh
# Wiederherstellen:  gunzip -c backup/DATEI.sql.gz | docker compose exec -T db sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" schottr'
set -e
cd "$(dirname "$0")"
mkdir -p backup
file="backup/schottr-$(date +%Y-%m-%d_%H%M).sql.gz"
docker compose exec -T db sh -c 'mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" --single-transaction --routines --triggers schottr' | gzip > "$file"
echo "Sicherung erstellt: $file"
