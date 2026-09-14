#!/bin/zsh
# 3 → 6 workers: frena w1-w3 SUAVE (terminan su cuenta en curso), espera, relanza los 6.
LOG=/tmp/skj900/transicion6.log
echo "== transición-6 arranca $(date) ==" >> $LOG
for W in 1 2 3; do touch /tmp/skj900-w$W/STOP; done
for i in $(seq 1 360); do
  pgrep -f "worker_detached" >/dev/null || break
  sleep 30
done
pgrep -f "worker_detached" >/dev/null && { echo "workers viejos no salieron, aborto $(date)" >> $LOG; exit 1; }
echo "workers 1-3 apagados limpio $(date)" >> $LOG
for W in 1 2 3; do rm -f /tmp/skj900-w$W/STOP; done
while read W D H; do
  [ -z "$W" ] && continue
  nohup $HOME/Documentos/skilljar-cursos/worker_detached.sh $W $D $H >/dev/null 2>&1 &
  echo "worker $W ($D-$H) lanzado pid $! $(date)" >> $LOG
  sleep 15
done < $HOME/Documentos/skilljar-cursos/rangos.txt
echo "== transición-6 completa $(date) ==" >> $LOG
