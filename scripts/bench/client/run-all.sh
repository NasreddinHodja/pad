#!/bin/sh
# Every client measurement of one build against its floors, on a quiet machine.
#
#   scripts/bench/client/run-all.sh <build dir> <seed.db> <results dir> [reps]
#
# <build dir> holds a built pad (bun run build); <seed.db> a database seeded
# by seed.ts with avgroot and bigroot (password hunter2hunter2), checkpointed:
# one file, no -wal. Every script that opens a pad gets its own server on a
# fresh copy of it, so what one types or claims isn't in the next one's pad.
# The floors and the pad alternate within each repeat, so whatever drifts over
# the hours drifts for both. load.log records the load and the busiest
# processes every 15 s: the evidence the machine was quiet.
set -u
B=$1
SEED=$2
R=$3
REPS=${4:-3}
S=$(cd "$(dirname "$0")" && pwd)
PORT=5641
P=hunter2hunter2
mkdir -p "$R"

(while :; do
  printf '%s load %s\n' "$(date +%T)" "$(cut -d' ' -f1-3 /proc/loadavg)"
  top -b -n 1 -o %CPU | sed -n '8,12p'
  sleep 15
done) > "$R/load.log" 2>&1 &
LOGGER=$!

DB="$R/work.db"
SERVER=
serve() {
  rm -f "$DB" "$DB-wal" "$DB-shm"
  command cp -f "$SEED" "$DB"
  (cd "$B" && PAD_DB="$DB" PORT=$PORT ORIGIN=http://localhost:$PORT \
    exec bun build/index.js >> "$R/server.log" 2>&1) &
  SERVER=$!
  until curl -s -o /dev/null "http://localhost:$PORT/_/limits"; do sleep 0.5; done
}
unserve() {
  kill "$SERVER" 2>/dev/null
  wait "$SERVER" 2>/dev/null
}
run() { echo "== $(date +%T) $*" >&2; }
json() { grep '^[{[]' || true; }
tag() { sed "s/^{/{\"rep\":$1,/"; }
# pad <script> <timeout> <out> <rep> <args...>: one script against a fresh server.
pad() {
  script=$1 limit=$2 out=$3 rep=$4
  shift 4
  run "$script" "$@" "$rep"
  serve
  timeout "$limit" bun "$S/$script" "http://localhost:$PORT" "$@" 2>/dev/null | json | tag "$rep" >> "$R/$out"
  unserve
}

for rep in $(seq "$REPS"); do
  for t in 0 avg max; do
    run floor "$t" "$rep"; timeout 300 bun "$S/floor.ts" "$t" 2>/dev/null | json | tag "$rep" >> "$R/floor.jsonl"
  done
  MOBILE=1 timeout 300 bun "$S/floor.ts" avg 2>/dev/null | json | tag "$rep" >> "$R/floor.jsonl"
  pad drive.ts 300 drive.jsonl "$rep" claim
  for sc in avg-type max-type max-export; do pad drive.ts 1200 drive.jsonl "$rep" "$sc"; done
  export MOBILE=1
  pad drive.ts 1200 drive.jsonl "$rep" avg-type
  unset MOBILE
  for t in avg max; do
    run floor-cpu "$t" "$rep"; timeout 1500 bun "$S/floor-cpu.ts" "$t" 2>/dev/null | json | tag "$rep" >> "$R/floor-cpu.jsonl"
    pad cpu.ts 1500 cpu.jsonl "$rep" "$t"
  done
  run typing-profile floor "$rep"
  timeout 600 bun "$S/typing-profile.ts" floor avgroot "$P" avg 2>/dev/null > "$R/profile-floor-$rep.json"
  run typing-profile pad "$rep"
  serve
  timeout 600 bun "$S/typing-profile.ts" "http://localhost:$PORT" avgroot "$P" avg 2>/dev/null > "$R/profile-pad-$rep.json"
  unserve
  run export-pss "$rep"
  serve
  timeout 900 bun "$S/export-pss.ts" "http://localhost:$PORT" bigroot "$P" max 2>/dev/null | json | tag "$rep" >> "$R/export-pss.jsonl"
  unserve
  for t in avg max; do pad costs.ts 1500 costs.jsonl "$rep" "$t"; done
done

run done
kill $LOGGER
rm -f "$DB" "$DB-wal" "$DB-shm"
rm -rf /tmp/pad-bench-profile-* /tmp/pad-typing-profile-* /tmp/pad-export-profile-*
