#!/bin/sh
# Local integration fixture: no network, model calls, or workspace writes.
if [ "${1-}" = "--version" ]; then
  printf '%s\n' 'Goalward Fast Fixture 1.0.0'
  exit 0
fi
if [ "$#" -ne 1 ]; then
  printf '%s\n' 'Expected exactly one prompt argument.' >&2
  exit 2
fi
printf '%s\n' 'Fixture begin: native process started.'
printf 'Received one prompt argument (%s characters).\n' "${#1}"
printf '%s\n' 'Fixture stderr: this is a controlled diagnostic line.' >&2
printf '%s\n' 'UTF-8 output café is intact; quotes in arguments are not executed as commands.'
printf '%s\n' 'Fixture end: completed successfully.'
exit 0
