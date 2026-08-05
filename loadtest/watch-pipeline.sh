#!/usr/bin/env bash
# Watches every stage of the write path while a load run is in flight — one
# line every INTERVAL seconds with counts and rates, so you can see WHICH
# stage saturates:
#
#   LangWatch app → redis (bullmq queues) → workers → ClickHouse
#                                → trace-ingestion-worker → Mongo
#
# Read-only: queries containers, writes nothing.
#
# Usage:  CLIENT=<client slug> ./loadtest/watch-pipeline.sh [INTERVAL]
set -euo pipefail

: "${CLIENT:?export CLIENT first (the loadtest client slug)}"
INTERVAL="${1:-2}"

REDIS="${CLIENT}-langwatch-redis"
CH="${CLIENT}-langwatch-clickhouse"
MONGO="${CLIENT}-mongo"

for c in "$REDIS" "$CH" "$MONGO"; do
  docker inspect "$c" >/dev/null 2>&1 || { echo "ERROR: container '$c' not running"; exit 1; }
done

# bullmq backlog: wait/active are lists, delayed is a zset. Sum across queues.
redis_depth() {
  docker exec "$REDIS" sh -c '
    total=0
    for key in $(redis-cli --scan --pattern "bull:*:wait" ; redis-cli --scan --pattern "bull:*:active"); do
      n=$(redis-cli llen "$key"); total=$((total + n))
    done
    for key in $(redis-cli --scan --pattern "bull:*:delayed"); do
      n=$(redis-cli zcard "$key"); total=$((total + n))
    done
    echo $total' 2>/dev/null || echo "?"
}

ch_counts() {
  docker exec "$CH" clickhouse-client --user default --password langwatch --query \
    "SELECT (SELECT count() FROM langwatch.trace_summaries), (SELECT count() FROM langwatch.stored_spans) FORMAT TSV" 2>/dev/null \
    || echo "?	?"
}

mongo_count() {
  docker exec "$MONGO" mongosh --quiet --eval \
    "db.getSiblingDB('${CLIENT}').traces.countDocuments({})" 2>/dev/null || echo "?"
}

prev_traces=0
prev_mongo=0
prev_t=$(date +%s)

printf "%-8s %-10s %-12s %-12s %-10s %-10s %-10s\n" \
  "elapsed" "queue" "ch_traces" "ch_spans" "ch_tr/s" "mongo" "mongo/s"

start=$(date +%s)
while true; do
  q=$(redis_depth)
  IFS=$'\t' read -r ch_traces ch_spans <<< "$(ch_counts)"
  m=$(mongo_count)
  now=$(date +%s)
  dt=$((now - prev_t)); [ "$dt" -eq 0 ] && dt=1
  tr_rate="?"; mg_rate="?"
  [[ "$ch_traces" =~ ^[0-9]+$ ]] && tr_rate=$(( (ch_traces - prev_traces) / dt )) && prev_traces=$ch_traces
  [[ "$m" =~ ^[0-9]+$ ]] && mg_rate=$(( (m - prev_mongo) / dt )) && prev_mongo=$m
  prev_t=$now
  printf "%-8s %-10s %-12s %-12s %-10s %-10s %-10s\n" \
    "$((now - start))s" "$q" "$ch_traces" "$ch_spans" "$tr_rate" "$m" "$mg_rate"
  sleep "$INTERVAL"
done
