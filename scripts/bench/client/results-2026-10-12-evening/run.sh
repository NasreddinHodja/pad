#!/bin/sh
# head vs now (poll, export) and repeats of the near-target cells on now.
set -u
B=$1; R=$2; S=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$R"
for d in head:5631 now:5632; do
  (cd "$B/${d%%:*}" && PAD_DB="$B/${d%%:*}.db" PORT=${d#*:} ORIGIN=http://localhost:${d#*:} exec bun build/index.js > "$R/server-${d%%:*}.log" 2>&1) &
done
for p in 5631 5632; do until curl -s -o /dev/null "http://localhost:$p/_/limits"; do sleep 0.5; done; done
(while :; do
  printf '%s load %s\n' "$(date +%T)" "$(cut -d' ' -f1-3 /proc/loadavg)"
  top -b -n 1 -o %CPU | sed -n '8,12p'
  sleep 15
done) > "$R/load.log" 2>&1 &
LOGGER=$!
run() { echo "== $(date +%T) $*" >&2; }
json() { grep '^[{[]' || true; }
for rep in 1 2; do for r in avg max; do for b in 5631:head 5632:now; do
  run costs "${b#*:}" "$r" "$rep"; timeout 1500 bun "$S/costs.ts" "http://localhost:${b%%:*}" "$r" 2>/dev/null | json | sed "s/^{/{\"build\":\"${b#*:}\",\"rep\":$rep,/" >> "$R/costs.jsonl"
done; done; done
for rep in 1 2 3; do
  for u in http://localhost:5632/ http://localhost:5632/avgroot https://news.ycombinator.com/; do
    run sites "$u" "$rep"; timeout 150 bun "$S/sites.ts" "$u" 2>/dev/null | json | sed "s/^{/{\"rep\":$rep,/" >> "$R/sites.jsonl"
  done
  run drive now avg-type "$rep"; timeout 1200 bun "$S/drive.ts" http://localhost:5632 avg-type 2>/dev/null | json | sed "s/^{/{\"build\":\"now\",\"rep\":$rep,/" >> "$R/drive.jsonl"
  for b in http://localhost:5632 floor; do
    run typing-profile "$b" "$rep"; timeout 600 bun "$S/typing-profile.ts" "$b" avgroot hunter2hunter2 249000 2>/dev/null > "$R/profile-$(echo $b | tr -c 'a-z0-9\n' '_')-$rep.json"
  done
done
run floor; for n in 0 249000; do for i in 1 2 3; do timeout 300 bun "$S/floor.ts" x "$n" 2>/dev/null | json >> "$R/floor.jsonl"; done; done
run done
kill $LOGGER
for p in $(pgrep -f "bun build/index.js"); do
  tr '\0' '\n' < /proc/$p/environ | grep -q "^PAD_DB=$B/" && kill $p
done
