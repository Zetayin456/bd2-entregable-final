#!/bin/sh
set -eu

clients=${BASELINE_CLIENTS:-10}
jobs=${BASELINE_JOBS:-2}
duration=${BASELINE_DURATION:-60}
seed=${BASELINE_SEED:-15015}
run_id=${RUN_ID:-baseline-manual}

case "$run_id" in
  *[!A-Za-z0-9._-]*|'') echo "RUN_ID solo puede contener letras, números, punto, guion y guion bajo." >&2; exit 2 ;;
esac
case "$clients:$jobs:$duration" in
  *[!0-9:]*|:*|*::*|*:) echo "BASELINE_CLIENTS, BASELINE_JOBS y BASELINE_DURATION deben ser enteros positivos." >&2; exit 2 ;;
esac
[ "$clients" -gt 0 ] && [ "$jobs" -gt 0 ] && [ "$duration" -gt 0 ] || {
  echo "Los parámetros de carga deben ser mayores que cero." >&2
  exit 2
}

mkdir -p /results
output="/results/${run_id}-pgbench.txt"
psql --set ON_ERROR_STOP=1 --file=/baseline/schema.sql
psql --set ON_ERROR_STOP=1 --command='TRUNCATE baseline_documents'

printf 'Baseline PostgreSQL | run_id=%s clients=%s jobs=%s duration_seconds=%s seed=%s\n' \
  "$run_id" "$clients" "$jobs" "$duration" "$seed" | tee "$output"
pgbench --no-vacuum --client="$clients" --jobs="$jobs" \
  --time="$duration" --log --log-prefix="/results/${run_id}-txn" \
  --random-seed="$seed" --file=/baseline/txn.sql --report-per-command \
  >>"$output" 2>&1
cat "$output"
