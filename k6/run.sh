#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

SCENARIO="${1:-transaction_load}"
shift || true
ENV_FILE="${ENV_FILE:-.env}"

if [ -f "${ENV_FILE}" ]; then
    set -a
    # shellcheck disable=SC1090
    source "${ENV_FILE}"
    set +a
fi

RUN_ID="${RUN_ID:-$(date +%Y%m%d-%H%M%S)}"
export RUN_ID

mkdir -p results
SUMMARY="results/${SCENARIO}-${RUN_ID}.json"

if [ "${K6_USE_LOCAL:-0}" = "1" ]; then
    exec k6 run --summary-export "${SUMMARY}" "$@" "scripts/${SCENARIO}.js"
fi

docker compose --profile load run --rm k6 \
    run --summary-export "/results/${SCENARIO}-${RUN_ID}.json" "$@" "/scripts/${SCENARIO}.js"
