#!/bin/bash
set -euo pipefail

CONNECT_CDC_URL="${CONNECT_CDC_URL:-http://debezium:8083}"
CONNECT_S3_URL="${CONNECT_S3_URL:-http://connect-s3:8083}"
CONNECTORS_DIR="${CONNECTORS_DIR:-/connectors}"

SETUP_MAX_RETRIES="${SETUP_MAX_RETRIES:-5}"
CONNECT_WAIT_TIMEOUT_SEC="${CONNECT_WAIT_TIMEOUT_SEC:-300}"
POLL_INTERVAL_SEC="${POLL_INTERVAL_SEC:-5}"
CURL_CONNECT_TIMEOUT="${CURL_CONNECT_TIMEOUT:-5}"
CURL_MAX_TIME="${CURL_MAX_TIME:-30}"

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

fatal() {
  log "FATAL: $*"
  exit 1
}

on_exit() {
  rc="$1"
  if [ "${rc}" -ne 0 ]; then
    log "Script exited with code ${rc} (line ${LAST_LINE:-unknown})"
    log "Hint: unset variable (set -u), command failure (set -e), or fatal() — check lines above."
  fi
}

trap 'LAST_LINE=${LINENO:-?}; on_exit $?' EXIT # LINENO 출력을 위해 sh대신 bash로 변경

connect_is_ready() {
  url="$1"
  http_code="$(
    curl -s -o /dev/null -w "%{http_code}" \
      --connect-timeout "${CURL_CONNECT_TIMEOUT}" \
      --max-time "${CURL_MAX_TIME}" \
      "${url}/connectors" 2>/dev/null || echo "000"
  )"

  case "${http_code}" in
    200) return 0 ;;
    000|502|503|504) return 1 ;;
    *)
      # API responded with an unexpected code — worker is up; registration may still fail.
      return 0
      ;;
  esac
}

wait_for_connect() {
  url="$1"
  worker_name="$2"
  elapsed=0

  log "Waiting for ${worker_name} at ${url} (timeout ${CONNECT_WAIT_TIMEOUT_SEC}s)..."

  while [ "${elapsed}" -lt "${CONNECT_WAIT_TIMEOUT_SEC}" ]; do
    if connect_is_ready "${url}"; then
      log "${worker_name} is reachable."
      return 0
    fi
    sleep "${POLL_INTERVAL_SEC}"
    elapsed=$((elapsed + POLL_INTERVAL_SEC))
  done

  # 타임아웃 시 컨테이너 재실행 로직으로 빠져나감
  fatal "${worker_name} not reachable within ${CONNECT_WAIT_TIMEOUT_SEC}s"
}

# 특수 문자가 포함되어도 제대로 치환 되도록 jq로 변경
substitute() {
  jq \
    --arg POSTGRES_DB "${POSTGRES_DB}" \
    --arg DEBEZIUM_USER "${DEBEZIUM_USER}" \
    --arg DEBEZIUM_PASSWORD "${DEBEZIUM_PASSWORD}" \
    --arg TOPIC_PREFIX "${TOPIC_PREFIX}" \
    --arg S3_BUCKET "${S3_BUCKET:-}" \
    --arg S3_PREFIX "${S3_PREFIX:-cdc/}" \
    --arg AWS_REGION "${AWS_REGION}" \
    'def r:
       gsub("__POSTGRES_DB__"; $POSTGRES_DB)
       | gsub("__DEBEZIUM_USER__"; $DEBEZIUM_USER)
       | gsub("__DEBEZIUM_PASSWORD__"; $DEBEZIUM_PASSWORD)
       | gsub("__TOPIC_PREFIX__"; $TOPIC_PREFIX)
       | gsub("__S3_BUCKET__"; $S3_BUCKET)
       | gsub("__S3_PREFIX__"; $S3_PREFIX)
       | gsub("__AWS_REGION__"; $AWS_REGION);
     walk(if type == "string" then r else . end)
     | .config'
}

# json 업데이트 고려 upsert 적용
upsert_connector_once() {
  connect_url="$1"
  name="$2"
  file="$3"

  payload="$(substitute < "${file}")"
  log "Upserting connector: ${name} @ ${connect_url}"

  raw="$(
    curl -s -w $'\n%{http_code}' \
      --connect-timeout "${CURL_CONNECT_TIMEOUT}" \
      --max-time "${CURL_MAX_TIME}" \
      -X PUT "${connect_url}/connectors/${name}/config" \
      -H "Content-Type: application/json" \
      -d "${payload}" 2>/dev/null || echo $'\n000'
  )"
  http_code="${raw##*$'\n'}"
  body="${raw%$'\n'*}"

  case "${http_code}" in
    200|201)
      log "Connector ${name} upserted (HTTP ${http_code})."
      return 0
      ;;
    *)
      if is_retryable_http "${http_code}"; then
        log "Retryable error upserting ${name} (HTTP ${http_code}): ${body}"
        return 1
      fi
      log "Non-retryable error upserting ${name} (HTTP ${http_code}): ${body}"
      fatal "Aborting setup due to connector config or client error."
      ;;
  esac
}

register_connector() {
  connect_url="$1"
  name="$2"
  file="$3"
  worker_name="$4"
  attempt=1

  while [ "${attempt}" -le "${SETUP_MAX_RETRIES}" ]; do
    # 무의미한 재시도를 막기 위해 커넥터가 준비되었는지 확인  
    # 여기서 네트워크 장애도 같이 감지(백오프 대기 제거)
    wait_for_connect "${connect_url}" "${worker_name}"

    if upsert_connector_once "${connect_url}" "${name}" "${file}"; then
      return 0
    fi

    log "Upsert ${name} failed (attempt ${attempt}/${SETUP_MAX_RETRIES})"
    if [ "${attempt}" -eq "${SETUP_MAX_RETRIES}" ]; then
      fatal "Failed to upsert connector ${name} after ${SETUP_MAX_RETRIES} attempts."
    fi

    attempt=$((attempt + 1))
  done
}

main() {
  log "Starting connector registration (max_retries=${SETUP_MAX_RETRIES})"

  register_connector \
    "${CONNECT_CDC_URL}" \
    "postgres-source" \
    "${CONNECTORS_DIR}/postgres-source.json" \
    "Debezium Connect"

  # S3 버킷이 있는 경우에만 등록
  if [ -n "${S3_BUCKET:-}" ]; then
    register_connector \
      "${CONNECT_S3_URL}" \
      "s3-sink" \
      "${CONNECTORS_DIR}/s3-sink.json" \
      "S3 Connect"
  else
    # S3 버킷이 없는 경우 로그 출력 후 스킵
    log "Skipping s3-sink (S3_BUCKET is empty)."
  fi

  log "Connector registration complete."
}

main "$@"
