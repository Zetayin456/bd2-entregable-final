#!/bin/sh
set -eu

IFACE=${NETEM_INTERFACE:-eth0}
PROFILE=${NETEM_PROFILE:-}

case "$PROFILE" in
  ideal)
    # Applied at both ends: approximately 20 ms RTT, no configured loss.
    tc qdisc replace dev "$IFACE" root netem delay 10ms
    ;;
  degradado)
    # Applied at both ends: approximately 120 ms RTT and 2% path loss.
    tc qdisc replace dev "$IFACE" root netem delay 60ms 15ms distribution normal loss 1.01% rate 1mbit
    ;;
  intermitente)
    # Applied at both ends: approximately 250 ms RTT and 5% path loss.
    tc qdisc replace dev "$IFACE" root netem delay 125ms 40ms distribution normal loss 2.56% rate 512kbit
    ;;
  corte)
    tc qdisc replace dev "$IFACE" root netem loss 100%
    ;;
  limpiar|clear)
    tc qdisc del dev "$IFACE" root 2>/dev/null || true
    ;;
  *)
    echo "Perfil inválido '$PROFILE'. Usa ideal, degradado, intermitente, corte o clear." >&2
    exit 2
    ;;
esac

echo "netem aplicado: perfil=$PROFILE interfaz=$IFACE"
