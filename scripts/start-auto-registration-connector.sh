#!/bin/sh
set -eu
REGISTRATION_PROJECT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec sh "$REGISTRATION_PROJECT_DIR/scripts/start-auto-recharge-connector.sh" --role=registration "$@"
