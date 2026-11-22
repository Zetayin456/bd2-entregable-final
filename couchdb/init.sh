#!/bin/sh
set -eu

COUCHDB_URL=$(printf '%s' "${COUCHDB_URL:-http://couchdb:5984}" | tr -d '\015')
COUCHDB_USER=$(printf '%s' "${COUCHDB_USER:-}" | tr -d '\015')
COUCHDB_PASSWORD=$(printf '%s' "${COUCHDB_PASSWORD:-}" | tr -d '\015')
BOOTSTRAP_ADMIN_USER=$(printf '%s' "${BOOTSTRAP_ADMIN_USER:-}" | tr -d '\015')
BOOTSTRAP_ADMIN_PASSWORD=$(printf '%s' "${BOOTSTRAP_ADMIN_PASSWORD:-}" | tr -d '\015')
COUCHDB_URL=${COUCHDB_URL%/}

: "${COUCHDB_USER:?COUCHDB_USER requerido}"
: "${COUCHDB_PASSWORD:?COUCHDB_PASSWORD requerido}"
: "${BOOTSTRAP_ADMIN_USER:?BOOTSTRAP_ADMIN_USER requerido}"
: "${BOOTSTRAP_ADMIN_PASSWORD:?BOOTSTRAP_ADMIN_PASSWORD requerido}"

case "$BOOTSTRAP_ADMIN_USER" in
  *[!A-Za-z0-9._-]*|'')
    echo "couchdb-init: BOOTSTRAP_ADMIN_USER solo puede contener letras, números, punto, guion y guion bajo." >&2
    exit 1
    ;;
esac
admin_name_length=$(printf '%s' "$BOOTSTRAP_ADMIN_USER" | wc -c | tr -d ' ')
if [ "$admin_name_length" -gt 128 ]; then
  echo "couchdb-init: BOOTSTRAP_ADMIN_USER supera los 128 caracteres." >&2
  exit 1
fi

json_escape() {
  printf '%s' "$1" \
    | tr -d '\015\012' \
    | sed 's/\\/\\\\/g; s/"/\\"/g; s/	/\\t/g'
}

request() {
  method=$1
  url=$2
  payload=${3-}
  response_file=$(mktemp)

  if [ "$#" -ge 3 ]; then
    if status=$(curl --silent --show-error --output "$response_file" --write-out '%{http_code}' \
      --user "$COUCHDB_USER:$COUCHDB_PASSWORD" --request "$method" \
      --header 'Content-Type: application/json' --data-binary "$payload" "$url"); then
      :
    else
      curl_status=$?
      rm -f "$response_file"
      echo "couchdb-init: curl falló (código $curl_status) en $method $url." >&2
      return 1
    fi
  else
    if status=$(curl --silent --show-error --output "$response_file" --write-out '%{http_code}' \
      --user "$COUCHDB_USER:$COUCHDB_PASSWORD" --request "$method" "$url"); then
      :
    else
      curl_status=$?
      rm -f "$response_file"
      echo "couchdb-init: curl falló (código $curl_status) en $method $url." >&2
      return 1
    fi
  fi

  HTTP_STATUS=$status
  HTTP_BODY=$(cat "$response_file")
  rm -f "$response_file"
}

require_success() {
  case "$HTTP_STATUS" in
    2??) ;;
    *)
      failure_code=$(printf '%s' "$HTTP_BODY" | sed -n 's/.*"error"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
      failure_reason=$(printf '%s' "$HTTP_BODY" | sed -n 's/.*"reason"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
      if [ -n "$failure_code" ] || [ -n "$failure_reason" ]; then
        echo "couchdb-init: HTTP $HTTP_STATUS en $1 $2 (${failure_code:-error}${failure_reason:+: $failure_reason})." >&2
      else
        echo "couchdb-init: HTTP $HTTP_STATUS en $1 $2; respuesta omitida." >&2
      fi
      return 1
      ;;
  esac
}

request PUT "$COUCHDB_URL/reciclaje"
case "$HTTP_STATUS" in
  201|202) echo "couchdb-init: base reciclaje creada." ;;
  412|409)
    request GET "$COUCHDB_URL/reciclaje"
    require_success GET "$COUCHDB_URL/reciclaje"
    echo "couchdb-init: base reciclaje ya existía; se conserva."
    ;;
  *) require_success PUT "$COUCHDB_URL/reciclaje" ;;
esac

create_mango_index() {
  index_name=$1
  fields_json=$2
  index_json="{\"ddoc\":\"$index_name\",\"name\":\"$index_name\",\"type\":\"json\",\"index\":{\"fields\":[$fields_json]}}"
  request POST "$COUCHDB_URL/reciclaje/_index" "$index_json"
  require_success "POST _index ($index_name)" "$COUCHDB_URL/reciclaje/_index"
  echo "couchdb-init: índice Mango $index_name disponible."
}

create_mango_index idx_document_type '"type"'
create_mango_index idx_rewards_active '"type","activo"'
create_mango_index idx_movements_commerce '"type","comercio_id"'
create_mango_index idx_weighings_state '"type","estado"'
create_mango_index idx_weighings_request '"type","solicitud_id"'
create_mango_index idx_capture_window '"type","recolector_id","comercio_id","capturado_en"'

security_json='{"admins":{"names":[],"roles":["admin_plataforma"]},"members":{"names":[],"roles":["operador_acopio","recolector","comercio"]}}'
request PUT "$COUCHDB_URL/reciclaje/_security" "$security_json"
require_success PUT "$COUCHDB_URL/reciclaje/_security"
echo "couchdb-init: permisos de la base aplicados."

points_json='{"_id":"config:puntos","type":"config_puntos","version":1,"puntos_por_kg":{"carton":5,"papel":4,"plastico":10,"vidrio":3,"metal":12,"aluminio":15}}'
request PUT "$COUCHDB_URL/reciclaje/config:puntos" "$points_json"
case "$HTTP_STATUS" in
  201|202) echo "couchdb-init: reglas iniciales de puntos creadas." ;;
  409|412)
    request GET "$COUCHDB_URL/reciclaje/config:puntos"
    require_success GET "$COUCHDB_URL/reciclaje/config:puntos"
    if ! printf '%s' "$HTTP_BODY" | grep -Eq '"type"[[:space:]]*:[[:space:]]*"config_puntos"'; then
      echo "couchdb-init: config:puntos ya existe con un tipo incompatible." >&2
      exit 1
    fi
    echo "couchdb-init: reglas de puntos ya existían; se conservan."
    ;;
  *) require_success PUT "$COUCHDB_URL/reciclaje/config:puntos" ;;
esac

for reward_id in recompensa:kit-reciclaje recompensa:vale-comercio; do
  case "$reward_id" in
    recompensa:kit-reciclaje) reward_json='{"_id":"recompensa:kit-reciclaje","type":"recompensa","nombre":"Kit de reciclaje","descripcion":"Kit reutilizable para separación de residuos.","costo_puntos":100,"activo":true}' ;;
    recompensa:vale-comercio) reward_json='{"_id":"recompensa:vale-comercio","type":"recompensa","nombre":"Vale para el comercio","descripcion":"Vale de incentivo canjeable en el comercio participante.","costo_puntos":250,"activo":true}' ;;
  esac
  request PUT "$COUCHDB_URL/reciclaje/$reward_id" "$reward_json"
  case "$HTTP_STATUS" in
    201|202) echo "couchdb-init: $reward_id creada." ;;
    409|412)
      request GET "$COUCHDB_URL/reciclaje/$reward_id"
      require_success GET "$COUCHDB_URL/reciclaje/$reward_id"
      ;;
    *) require_success PUT "$COUCHDB_URL/reciclaje/$reward_id" ;;
  esac
done

admin_name_json=$(json_escape "$BOOTSTRAP_ADMIN_USER")
admin_password_json=$(json_escape "$BOOTSTRAP_ADMIN_PASSWORD")
admin_doc_url="$COUCHDB_URL/_users/org.couchdb.user:$BOOTSTRAP_ADMIN_USER"
request GET "$admin_doc_url"
case "$HTTP_STATUS" in
  200)
    admin_rev=$(printf '%s' "$HTTP_BODY" | sed -n 's/.*"_rev"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
    if [ -z "$admin_rev" ]; then
      echo "couchdb-init: CouchDB devolvió el usuario bootstrap sin _rev." >&2
      exit 1
    fi
    rev_json=$(json_escape "$admin_rev")
    admin_json="{\"_rev\":\"$rev_json\",\"name\":\"$admin_name_json\",\"roles\":[\"admin_plataforma\"],\"type\":\"user\",\"password\":\"$admin_password_json\"}"
    ;;
  404)
    admin_json="{\"name\":\"$admin_name_json\",\"roles\":[\"admin_plataforma\"],\"type\":\"user\",\"password\":\"$admin_password_json\"}"
    ;;
  *) require_success GET "$admin_doc_url" ;;
esac

request PUT "$admin_doc_url" "$admin_json"
case "$HTTP_STATUS" in
  201|202|200) echo "couchdb-init: usuario bootstrap actualizado." ;;
  409|412)
    echo "couchdb-init: conflicto al guardar usuario bootstrap (HTTP $HTTP_STATUS); reintenta la inicialización." >&2
    exit 1
    ;;
  *) require_success PUT "$admin_doc_url" ;;
esac
