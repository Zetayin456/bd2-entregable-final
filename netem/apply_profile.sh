#!/bin/sh
IF=eth0
case "$NETEM_PROFILE" in
  ideal) tc qdisc replace dev $IF root netem delay 20ms;;
  degradado) tc qdisc replace dev $IF root netem delay 120ms 30ms loss 2% rate 1mbit;;
  intermitente) tc qdisc replace dev $IF root netem delay 250ms 80ms loss 5% rate 512kbit;;
esac