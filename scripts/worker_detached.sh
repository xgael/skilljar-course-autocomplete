#!/bin/zsh
# Worker paralelo del lote Academy.  Uso: worker_detached.sh <N> <DESDE> <HASTA>
# Cada worker: su Chrome (:922N+9), su perfil, su estado y su archivo de progreso.
# Para TODOS: touch /tmp/skj900/STOP · para uno: touch /tmp/skj900-w<N>/STOP
N=$1; DESDE=$2; HASTA=$3
PUERTO=$((9230 + N))
export SKILLJAR_DIR=/tmp/skj900-w$N
export SKILLJAR_PUERTO=$PUERTO
export SKILLJAR_NOTAS=$HOME/Documentos/skilljar-cursos
export SKILLJAR_SIN_CAPTURAS=1
PERFIL=/tmp/skj900-chrome-w$N
PROG=$HOME/Documentos/skilljar-cursos/academia900_progreso_w$N.json
LOG=$SKILLJAR_DIR/lote.log
CSV=$HOME/telegram_files/CUENTAS_SKILLJAR_900.csv
mkdir -p $SKILLJAR_DIR
cd $HOME/.claude/skills-source/skilljar-course-runner/scripts
echo "===== WORKER $N ($DESDE-$HASTA) ARRANCA $(date) =====" >> $LOG
while true; do
  [ -f /tmp/skj900/STOP ] && { echo "STOP global $(date)" >> $LOG; break; }
  [ -f $SKILLJAR_DIR/STOP ] && { echo "STOP worker $(date)" >> $LOG; break; }
  if ! curl -s -m 3 http://localhost:$PUERTO/json/version >/dev/null 2>&1; then
    echo "chrome w$N muerto, relanzo $(date)" >> $LOG
    pkill -f "remote-debugging-port=$PUERTO" 2>/dev/null; sleep 3
    rm -rf $PERFIL; mkdir -p $PERFIL
    nohup "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
      --user-data-dir=$PERFIL --remote-debugging-port=$PUERTO \
      --no-first-run --no-default-browser-check --window-size=1380,900 about:blank >/dev/null 2>&1 &
    sleep 8
  fi
  node academia900.mjs --csv $CSV --desde $DESDE --hasta $HASTA --progreso $PROG >> $LOG 2>&1
  RC=$?
  echo "----- tramo w$N rc=$RC $(date) -----" >> $LOG
  # ¿rango completo? pendientes = cuentas del rango no-hechas en NINGÚN progreso
  PEND=$(python3 - <<PYEOF
import json,glob,os
csv=open("$CSV").read().strip().split("\n")[1:]
emails=[l.split(",")[1].strip() for l in csv if "@" in l][$DESDE-1:$HASTA]
done=set()
for f in glob.glob(os.path.expanduser("~/Documentos/skilljar-cursos/academia900_progreso*.json")):
    try:
        for em,v in json.load(open(f)).items():
            if v.get("status")=="hecho": done.add(em)
    except: pass
print(sum(1 for e in emails if e not in done))
PYEOF
)
  echo "pendientes en rango w$N: $PEND" >> $LOG
  [ "$PEND" = "0" ] && { echo "RANGO w$N COMPLETO $(date)" >> $LOG; break; }
  sleep 60
done
