#!/bin/bash
# SPDX-License-Identifier: GPL-2.0-only
#
# Regenerate po/templates/homeproxy.pot from the source tree and merge it into
# the .po files.
#
# Not `sh`: the curl fallback below uses process substitution, and the shebang
# has always said bash.
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$BASE_DIR/.." && pwd)"
PO_DIR="$ROOT/po"
LUCI_DIR="$BASE_DIR/../../luci"
LUCI_URL="https://raw.githubusercontent.com/openwrt/luci/691574263356689912c5bd31984bb1b96417a847"

TMP_FILES=""
cleanup() {
	# shellcheck disable=SC2086
	[ -n "$TMP_FILES" ] && rm -f $TMP_FILES
}
trap cleanup EXIT

# Prefer a sibling luci checkout, but only when it actually carries the two
# scripts.  Testing for the *directory* alone is what made this destructive:
# a checkout of the luci package feed exists without a build/ directory, perl
# then failed, and because its stdout went straight into the template,
# po/templates/homeproxy.pot was left EMPTY - every msgid gone, and the i18n
# coverage gate cheerfully reporting 0/0 = 100%.
if [ -f "$LUCI_DIR/build/i18n-scan.pl" ] && [ -f "$LUCI_DIR/build/i18n-update.pl" ]; then
	SCAN="$LUCI_DIR/build/i18n-scan.pl"
	UPDATE="$LUCI_DIR/build/i18n-update.pl"
else
	SCAN="$(mktemp)"; UPDATE="$(mktemp)"
	TMP_FILES="$SCAN $UPDATE"
	curl -fsS "$LUCI_URL/build/i18n-scan.pl" -o "$SCAN"
	curl -fsS "$LUCI_URL/build/i18n-update.pl" -o "$UPDATE"
fi

TMP_POT="$(mktemp)"
TMP_FILES="$TMP_FILES $TMP_POT"

# The scanner walks the tree it is given, so make that the repository root
# rather than whatever directory the caller happened to be in.
cd "$ROOT"
perl "$SCAN" . > "$TMP_POT"

# Refuse to publish a scan that found nothing: that is always a failure, never a
# legitimate result for this package.
if ! grep -q '^msgid ' "$TMP_POT"; then
	echo "rescan-translation: the scan produced no msgids - refusing to replace" >&2
	echo "                   po/templates/homeproxy.pot" >&2
	exit 1
fi

mv "$TMP_POT" "$PO_DIR/templates/homeproxy.pot"
TMP_FILES="$SCAN $UPDATE"

perl "$UPDATE" "$PO_DIR"
find "$PO_DIR" -name '*.po~' -delete
