#!/bin/sh
set -eu
: "${COUCHDB_URL:=http://couchdb:5984}"
: "${COUCHDB_USER:?COUCHDB_USER requerido}"
: "${COUCHDB_PASSWORD:?COUCHDB_PASSWORD requerido}"
: "${COUCHDB_PROXY_SECRET:?COUCHDB_PROXY_SECRET requerido}"
: "${BOOTSTRAP_ADMIN_USER:?BOOTSTRAP_ADMIN_USER requerido}"
: "${BOOTSTRAP_ADMIN_PASSWORD:?BOOTSTRAP_ADMIN_PASSWORD requerido}"
auth="-u ${COUCHDB_USER}:${COUCHDB_PASSWORD}"
curl -fsS $auth -X PUT "$COUCHDB_URL/_node/_local/_config/chttpd_auth/secret" \
  --data "\"$COUCHDB_PROXY_SECRET\""
curl -fsS $auth -X PUT "$COUCHDB_URL/reciclaje" || true
curl -fsS $auth -X PUT "$COUCHDB_URL/reciclaje/_security" \
-H 'Content-Type: application/json' \
--data '{"admins":{"names":[],"roles":["admin_plataforma"]},"members":{"names":[],"roles":["operador_acopio","recolector","comercio"]}}'
curl -fsS $auth -X PUT "$COUCHDB_URL/_users/org.couchdb.user:$BOOTSTRAP_ADMIN_USER" \
-H 'Content-Type: application/json' \
--data "{\"name\":\"$BOOTSTRAP_ADMIN_USER\",\"roles\":[\"admin_plataforma\"],\"type\":\"user\",\"password\":\"$BOOTSTRAP_ADMIN_PASSWORD\"}" || true
