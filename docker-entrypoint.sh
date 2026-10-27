#!/bin/sh
# Startet Schottr als Benutzer "node". Vorher bekommt dieser die Dateiablage
# (als Volume eingebunden, vom Host meist root gehörend) übertragen.
set -e
if [ "$(id -u)" = "0" ]; then
  for dir in "$SCHOTTR_DATA_DIR/nachweise" "$SCHOTTR_DATA_DIR/verbindlichkeiten"; do
    mkdir -p "$dir"
    find "$dir" \( ! -user node -o ! -group node \) -exec chown node:node {} +
  done
  exec su-exec node "$@"
fi
exec "$@"
