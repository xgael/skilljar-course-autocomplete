#!/usr/bin/env bash
# Abre un Chrome con depuración remota que HEREDA la sesión del Chrome del usuario,
# sin tocarlo: se copia el perfil (cookies incluidas) a /tmp y se abre una segunda
# instancia apuntando ahí. Las cookies siguen cifradas con la misma llave del llavero,
# así que la sesión viaja intacta.
#
# Alternativas descartadas: ejecutar JavaScript por AppleScript viene desactivado en
# Chrome y el menú para activarlo no responde al clic programático.

set -euo pipefail
PUERTO="${1:-9222}"
PERFIL="${SKILLJAR_PROFILE:-/tmp/skilljar-chrome}"
ORIGEN="$HOME/Library/Application Support/Google/Chrome"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if curl -s -m 2 "http://localhost:$PUERTO/json/version" >/dev/null 2>&1; then
  echo "ya hay un Chrome con depuración en :$PUERTO"; exit 0
fi

[[ -x "$CHROME" ]] || { echo "no encuentro Google Chrome" >&2; exit 1; }
[[ -d "$ORIGEN" ]] || { echo "no encuentro el perfil de Chrome en $ORIGEN" >&2; exit 1; }

rm -rf "$PERFIL"; mkdir -p "$PERFIL"
cp "$ORIGEN/Local State" "$PERFIL/" 2>/dev/null || true
for p in "Default" "Profile 1" "Profile 2"; do
  [[ -d "$ORIGEN/$p" ]] || continue
  mkdir -p "$PERFIL/$p"
  for f in Cookies Preferences "Login Data"; do
    [[ -f "$ORIGEN/$p/$f" ]] && cp "$ORIGEN/$p/$f" "$PERFIL/$p/" 2>/dev/null || true
  done
done

# "Profile 1" suele ser el perfil de trabajo; si no existe cae a Default.
CUAL="Default"; [[ -d "$PERFIL/Profile 1" ]] && CUAL="Profile 1"
# nohup + disown: sin esto Chrome es hijo del shell que lo lanzó y se muere en cuanto
# ese shell termina. El script siguiente encontraba el puerto abierto pero el navegador
# agonizando, y fallaba con "ECONNREFUSED" o "Browser context management is not
# supported". Fue la causa de toda la inestabilidad del navegador.
nohup "$CHROME" --user-data-dir="$PERFIL" --profile-directory="$CUAL" \
  --remote-debugging-port="$PUERTO" --no-first-run --no-default-browser-check \
  --window-size=1500,950 about:blank >/dev/null 2>&1 &
disown 2>/dev/null || true

for _ in $(seq 1 20); do
  sleep 1
  curl -s -m 2 "http://localhost:$PUERTO/json/version" >/dev/null 2>&1 && {
    echo "Chrome listo en :$PUERTO (perfil $CUAL copiado en $PERFIL)"; exit 0; }
done
echo "el navegador no levantó" >&2; exit 1
