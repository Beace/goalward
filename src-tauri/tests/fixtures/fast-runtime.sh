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
printf '%s\n' '中文输出正常，参数中的引号不会作为命令执行。'
printf '%s\n' 'Fixture end: completed successfully.'
exit 0
