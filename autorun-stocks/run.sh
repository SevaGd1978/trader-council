#!/bin/bash
# Обёртка с перезапуском. Останавливается по файлу DONE (прогон закончен) или STOP.
cd "$(dirname "$0")"
echo $$ > wrapper.pid
while [ ! -f DONE ] && [ ! -f STOP ]; do
  node runner.js >> runner.out 2>&1
  code=$?
  [ -f DONE ] || [ -f STOP ] && break
  echo "$(date -Is) runner exited ($code), restart in 15s" >> runner.out
  sleep 15
done
