#!/bin/sh
# Prints the identifier of the restore that the marker of the lifecycle names.
#
# The identifier becomes the name of a file, so it is checked against the rule
# of the production code before it is used to build one:
#
#	^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$
#
# The rule is the rule of the production code (the restoreIDPattern of the
# privacy service): an alphanumeric first character and eight to one hundred
# and twenty eight characters in total. A marker that names no restore, or a
# restore whose identifier is not usable, is refused and nothing is printed.
#
# The program is the one the operator uses and the one the proofs exercise,
# so the rule of the procedure and the rule of the code cannot drift apart.
#
# Usage:
#   check-restore-id.sh <path of the owner marker>
set -eu

marker="${1:-}"
if [ -z "$marker" ]; then
  echo "the marker of the lifecycle is required" >&2
  exit 1
fi
if [ ! -r "$marker" ]; then
  echo "the marker of the lifecycle cannot be read" >&2
  exit 1
fi
identifier=$(sed -n 's/.*"restoreId":"\([^"]*\)".*/\1/p' < "$marker")
if [ -z "$identifier" ]; then
  echo "the marker of the lifecycle names no restore" >&2
  exit 1
fi
case "$identifier" in
  *[!A-Za-z0-9._-]*)
    echo "the identifier of the restore carries a character the production rule does not allow" >&2
    exit 1
    ;;
esac
case "$identifier" in
  [A-Za-z0-9]*) ;;
  *)
    echo "the identifier of the restore does not start with an alphanumeric character" >&2
    exit 1
    ;;
esac
length=${#identifier}
if [ "$length" -lt 8 ] || [ "$length" -gt 128 ]; then
  echo "the identifier of the restore is $length characters long and the production rule allows eight to one hundred and twenty eight" >&2
  exit 1
fi
printf '%s\n' "$identifier"
