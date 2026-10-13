#!/bin/sh
# Every client measurement, on a quiet machine, in one go.
#
#   scripts/bench/client/run-all.sh <builds dir> <results dir>
#
# <builds dir> holds three built copies of the app, old/ cheap/ native/ (see
# client.org: the caret as committed, the JS caret forced on, the browser's
# own), and old.db cheap.db native.db, each seeded with avgroot and bigroot by
# seed.ts. Each build gets its own server and database; the runs alternate
# between builds, so whatever drifts over the hours drifts for all of them.
# load.log records the load and the busiest processes every 15 s: the
# evidence the machine was quiet.
set -u
B=$1
R=$2
S=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$R"

(while :; do
  printf '%s load %s\n' "$(date +%T)" "$(cut -d' ' -f1-3 /proc/loadavg)"
  top -b -n 1 -o %CPU | sed -n '8,12p'
  sleep 15
done) > "$R/load.log" 2>&1 &
LOGGER=$!

for d in old:5601 cheap:5602 native:5603; do
  (cd "$B/${d%%:*}" && PAD_DB="$B/${d%%:*}.db" PORT=${d#*:} ORIGIN=http://localhost:${d#*:} \
    exec bun build/index.js > "$R/server-${d%%:*}.log" 2>&1) &
done
for p in 5601 5602 5603; do
  until curl -s -o /dev/null "http://localhost:$p/_/limits"; do sleep 0.5; done
done

builds='5601:old 5602:cheap 5603:native'
run() { echo "== $(date +%T) $*" >&2; }
json() { grep '^[{[]' || true; }

for n in 0 249000 524224; do for i in 1 2 3; do
  run floor "$n" "$i"; timeout 300 bun "$S/floor.ts" x "$n" 2>/dev/null | json >> "$R/floor.jsonl"
done; done
for n in 249000 524224; do
  run floor-cpu "$n"; timeout 1500 bun "$S/floor-cpu.ts" "$n" 2>/dev/null | json >> "$R/floor-cpu.jsonl"
done
for how in insert keys; do for sp in spell nospell; do
  run typing-path "$how" "$sp"; timeout 900 bun "$S/typing-path.ts" 524224 "$how" "$sp" 2>/dev/null | json >> "$R/typing-path.jsonl"
done; done
for r in avg max; do for b in $builds; do
  run cpu "${b#*:}" "$r"; timeout 1500 bun "$S/cpu.ts" "http://localhost:${b%%:*}" "$r" 2>/dev/null | json | sed "s/^{/{\"build\":\"${b#*:}\",/" >> "$R/cpu.jsonl"
done; done
for sc in avg-type max-type; do for b in $builds; do
  run drive "${b#*:}" "$sc"; timeout 1200 bun "$S/drive.ts" "http://localhost:${b%%:*}" "$sc" 2>/dev/null | json | sed "s/^{/{\"build\":\"${b#*:}\",/" >> "$R/drive.jsonl"
done; done
for b in 5601:old 5602:cheap 5603:native floor floor-read; do
  base=$b; case $b in *:*) base=http://localhost:${b%%:*};; esac
  run typing-profile "${b#*:}"; timeout 600 bun "$S/typing-profile.ts" "$base" avgroot hunter2hunter2 249000 2>/dev/null > "$R/profile-${b#*:}.json"
done
for r in avg max; do
  run costs "$r"; timeout 1500 bun "$S/costs.ts" http://localhost:5601 "$r" 2>/dev/null | json >> "$R/costs.jsonl"
done
for u in http://localhost:5601/ http://localhost:5601/avgroot https://news.ycombinator.com/ https://lite.duckduckgo.com/lite/ https://text.npr.org/ https://sr.ht/ https://privatebin.net/ https://dontpad.com/ https://en.wikipedia.org/wiki/Notepad https://github.com/NasreddinHodja/pad.nassu.online https://www.youtube.com/ https://www.google.com/; do
  run sites "$u"; timeout 150 bun "$S/sites.ts" "$u" 2>/dev/null | json >> "$R/sites.jsonl"
done

run done
kill $LOGGER
for p in $(pgrep -f "bun build/index.js"); do
  tr '\0' '\n' < /proc/$p/environ | grep -q "^PAD_DB=$B/" && kill $p
done
rm -rf /tmp/pad-bench-profile-* /tmp/pad-typing-profile-*
