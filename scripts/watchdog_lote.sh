#!/bin/zsh
# Watchdog del lote Academy (corre por cron cada 15 min y @reboot):
# - Relanza el worker N si está muerto y su rango sigue incompleto (sin STOP).
# - Al llegar a 900 hechas, avisa una vez por Telegram y deja de relanzar.
export PATH=/usr/local/bin:/usr/bin:/bin
CSV=$HOME/telegram_files/CUENTAS_SKILLJAR_900.csv
NOTAS=$HOME/Documentos/skilljar-cursos
LOG=/tmp/skj900/watchdog.log
mkdir -p /tmp/skj900
[ -f /tmp/skj900/STOP ] && exit 0

HECHAS=$(python3 - <<'PYEOF'
import json,glob,os
done=set()
for f in glob.glob(os.path.expanduser("~/Documentos/skilljar-cursos/academia900_progreso*.json")):
    try:
        for em,v in json.load(open(f)).items():
            if v.get("status")=="hecho": done.add(em)
    except: pass
print(len(done))
PYEOF
)
if [ "$HECHAS" = "900" ]; then
  if [ ! -f /tmp/skj900/NOTIFICADO ]; then
    TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/.arca/app/_internal/telegram_bot/config.json'))['telegram_token'])" 2>/dev/null)
    [ -n "$TOKEN" ] && curl -s -X POST "https://api.telegram.org/bot$TOKEN/sendMessage" \
      --data-urlencode "chat_id=2091564608" \
      --data-urlencode "text=🏁 LOTE COMPLETO: 900/900 cuentas de la Academy con sus cursos cerrados y verificados." >/dev/null
    touch /tmp/skj900/NOTIFICADO
    echo "900/900 — notificado $(date)" >> $LOG
  fi
  exit 0
fi

# la transición sigue en curso? no interferir
pgrep -f "transicion_workers" >/dev/null && exit 0
pgrep -f "lote_detached" >/dev/null && exit 0

while read W D H; do
  [ -z "$W" ] && continue
  [ -f /tmp/skj900-w$W/STOP ] && continue
  pgrep -f "worker_detached.sh $W " >/dev/null && continue
  PEND=$(python3 - <<PYEOF
import json,glob,os
csv=open("$CSV").read().strip().split("\n")[1:]
emails=[l.split(",")[1].strip() for l in csv if "@" in l][$D-1:$H]
done=set()
for f in glob.glob(os.path.expanduser("~/Documentos/skilljar-cursos/academia900_progreso*.json")):
    try:
        for em,v in json.load(open(f)).items():
            if v.get("status")=="hecho": done.add(em)
    except: pass
print(sum(1 for e in emails if e not in done))
PYEOF
)
  if [ "$PEND" != "0" ]; then
    nohup $NOTAS/worker_detached.sh $W $D $H >/dev/null 2>&1 &
    echo "relancé worker $W (pendientes $PEND) $(date)" >> $LOG
  fi
done < $NOTAS/rangos.txt
