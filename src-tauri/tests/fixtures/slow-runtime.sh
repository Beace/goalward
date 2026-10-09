#!/bin/sh
# Local stop/lifecycle fixture: no network, model calls, or workspace writes.
if [ "${1-}" = "--version" ]; then
  printf '%s\n' 'Goalward Slow Fixture 1.0.0'
  exit 0
fi
if [ "$#" -ne 1 ]; then
  printf '%s\n' 'Expected exactly one prompt argument.' >&2
  exit 2
fi
trap 'printf "%s\n" "Fixture received termination signal." >&2; exit 143' TERM INT
printf '%s\n' 'Slow fixture begin: ready for stop testing.'
printf 'Received one prompt argument (%s characters).\n' "${#1}"
step=1
while [ "$step" -le 30 ]; do
  printf 'Slow fixture progress: %s/30\n' "$step"
  sleep 1
  step=$((step + 1))
done
printf '%s\n' 'Slow fixture end: completed after 30 seconds.'
exit 0
