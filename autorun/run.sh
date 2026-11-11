#!/bin/bash
# Обёртка с перезапуском при падении. Останавливается, когда 24 часа прошли (файл DONE) или по файлу STOP.
cd "$(dirname "$0")"
echo $$ > wrapper.pid
while [ ! -f DONE ] && [ ! -f STOP ]; do
  node runner.js >> runner.out 2>&1
  [ -f DONE ] || [ -f STOP ] && break
  echo "$(date -Is) runner exited ($?), restart in 15s" >> runner.out
  sleep 15
done
