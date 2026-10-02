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

# cdc_audit 는 감사 키를 console.log 로 흘린다. --console-output 으로 console.* 만 따로 받고
# --log-format=raw 로 타임스탬프/레벨 장식을 떼어 한 줄이 그대로 JSON 이 되게 한다.
# setup() 의 로그 같은 비 JSON 줄도 같은 파일에 섞이므로, 읽는 쪽에서 '@@' 접두어로 거른다.
if [ "${K6_USE_LOCAL:-0}" = "1" ]; then
    RESULTS_DIR="results"
else
    RESULTS_DIR="/results"
fi

CONSOLE_ARGS=()
if [ "${SCENARIO}" = "cdc_audit" ]; then
    CONSOLE_ARGS=(--log-format=raw --console-output "${RESULTS_DIR}/${SCENARIO}-${RUN_ID}.ndjson")
    echo "audit keys -> results/${SCENARIO}-${RUN_ID}.ndjson" >&2
fi

if [ "${K6_USE_LOCAL:-0}" = "1" ]; then
    exec k6 run \
        --summary-export "results/${SCENARIO}-${RUN_ID}.json" \
        ${CONSOLE_ARGS[@]+"${CONSOLE_ARGS[@]}"} "$@" "scripts/${SCENARIO}.js"
fi

docker compose --profile load run --rm k6 \
    run --summary-export "/results/${SCENARIO}-${RUN_ID}.json" \
    ${CONSOLE_ARGS[@]+"${CONSOLE_ARGS[@]}"} "$@" "/scripts/${SCENARIO}.js"
