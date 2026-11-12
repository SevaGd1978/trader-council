#!/bin/bash
# Обёртка с перезапуском при падении. Останавливается по файлу DONE или STOP.
cd "$(dirname "$0")"
trap '' HUP
echo $$ > wrapper.pid
if [ -f ../.env.gh ]; then set -a; . ../.env.gh; set +a; fi
while [ ! -f DONE ] && [ ! -f STOP ]; do
  stdbuf -oL node runner.js >> runner.out 2>&1
  code=$?
  [ -f DONE ] || [ -f STOP ] && break
  echo "$(date -Is) runner exited ($code), restart in 15s" >> runner.out
  sleep 15
done
