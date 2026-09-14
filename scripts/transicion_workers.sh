#!/bin/zsh
# Transición del lote serie → 3 workers paralelos, sin pisar la cuenta en proceso:
# 1) STOP al lote serie; espera a que termine la cuenta actual y salga.
# 2) Mata el Chrome :9222 del lote serie.
# 3) Quita el STOP y lanza los 3 workers (rangos fijos, sin solapamiento).
LOG=/tmp/skj900/transicion.log
echo "== transición arranca $(date) ==" >> $LOG
touch /tmp/skj900/STOP
# esperar al lote serie (máx 3 h por si la cuenta actual va a media)
for i in $(seq 1 360); do
  pgrep -f "lote_detached" >/dev/null || break
  sleep 30
done
pgrep -f "lote_detached" >/dev/null && { echo "lote serie no salió, aborto transición $(date)" >> $LOG; exit 1; }
echo "lote serie apagado $(date)" >> $LOG
pkill -f "remote-debugging-port=9222" 2>/dev/null
rm -f /tmp/skj900/STOP
sleep 3
for W in 1 2 3; do
  case $W in
    1) D=1;   H=300;;
    2) D=301; H=600;;
    3) D=601; H=900;;
  esac
  nohup $HOME/Documentos/skilljar-cursos/worker_detached.sh $W $D $H >/dev/null 2>&1 &
  echo "worker $W ($D-$H) lanzado pid $! $(date)" >> $LOG
  sleep 20   # escalonar arranques para no saturar el portal de golpe
done
echo "== transición completa $(date) ==" >> $LOG
