#!/usr/bin/env bash
#
# scripts/prepare_keystore.sh — decode KEYSTORE_BASE64, detect its type,
# and produce both BKS (for morphe-desktop) and PKCS12 (for apksigner) copies.
#
# Replaces the ~190-line `run:` block in the workflow's "Prepare signing
# keystore (required)" step. The script is large but no longer inline;
# it reads from a single source of truth.
#
# Behaviour matches the original step:
#   1. Verify KEYSTORE_BASE64 + KEYSTORE_PASSWORD secrets are present.
#   2. Locate BouncyCastle provider jar (installed by install_bouncycastle.sh).
#   3. Decode KEYSTORE_BASE64 to a temp keystore.
#   4. Auto-detect type (PKCS12 > JKS > BKS > UBER).
#   5. Convert source -> BKS for morphe-desktop. Retry with KEY_PASSWORD
#      when the no-keypass import fails.
#   6. Convert BKS -> PKCS12 for apksigner.
#   7. Pick alias: KEY_ALIAS secret if provided, else the first alias
#      in the converted keystore.
#   8. Hard-fail if any step fails. Signing is enforced; there is no
#      "unsigned output" path.
#
# Outputs ($GITHUB_OUTPUT):
#   path    path to BKS keystore
#   p12_path path to PKCS12 keystore
#   alias   key alias to use for signing
#
# Environment:
#   KEYSTORE_BASE64   required  base64-encoded source keystore
#   KEYSTORE_PASSWORD required  keystore password
#   KEY_PASSWORD      optional  key password (only if differs from store password)
#   KEY_ALIAS         optional  alias override (defaults to first found)
#   TOOLS_DIR         optional  destination dir, default ./tools
#   BCPROV_JAR        optional  explicit BouncyCastle jar path
#   MATRIX_NAME       optional  used in log filenames
#   GITHUB_OUTPUT     required  workflow output file

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"
. "$(dirname "$0")/lib/json.sh"

KEYSTORE_B64="${KEYSTORE_BASE64:-}"
KEYSTORE_PASSWORD="${KEYSTORE_PASSWORD:-}"
KEY_PASSWORD_RAW="${KEY_PASSWORD:-}"
KEY_ALIAS_INPUT="${KEY_ALIAS:-}"
TOOLS_DIR="${TOOLS_DIR:-./tools}"
BCPROV_JAR="${BCPROV_JAR:-}"
MATRIX_NAME="${MATRIX_NAME:-}"

if [ -z "$KEYSTORE_B64" ]; then
  log_error "KEYSTORE_BASE64 secret is required (signed builds are enforced)."
  exit 1
fi
if [ -z "$KEYSTORE_PASSWORD" ]; then
  log_error "KEYSTORE_PASSWORD secret is required (signed builds are enforced)."
  exit 1
fi
if [ -z "$BCPROV_JAR" ]; then
  BCPROV_JAR="$(ls -1 /usr/share/java/bcprov*.jar 2>/dev/null | head -n1 || true)"
fi
if [ -z "$BCPROV_JAR" ] || [ ! -f "$BCPROV_JAR" ]; then
  log_error "BouncyCastle provider JAR not found on runner."
  exit 1
fi

mkdir -p "$TOOLS_DIR"

RAW_KEYSTORE="$TOOLS_DIR/source.keystore"
BKS_KEYSTORE="$TOOLS_DIR/morphe.bks"
P12_KEYSTORE="$TOOLS_DIR/morphe.p12"
rm -f "$RAW_KEYSTORE" "$BKS_KEYSTORE" "$P12_KEYSTORE"

printf '%s' "$KEYSTORE_B64" | base64 -d > "$RAW_KEYSTORE"

# --- detect source type ---------------------------------------------------

detect_keystore_type() {
  local type="$1"
  local -a args=(keytool -list -keystore "$RAW_KEYSTORE" -storetype "$type" -storepass "$KEYSTORE_PASSWORD")
  if [ "$type" = "BKS" ] || [ "$type" = "UBER" ]; then
    args+=(-providerclass org.bouncycastle.jce.provider.BouncyCastleProvider -providerpath "$BCPROV_JAR")
  fi
  "${args[@]}" >/dev/null 2>&1
}

SRC_TYPE=""
for t in PKCS12 JKS BKS UBER; do
  if detect_keystore_type "$t"; then
    SRC_TYPE="$t"
    break
  fi
done

if [ -z "$SRC_TYPE" ]; then
  log_error "Could not detect source keystore type using PKCS12/JKS/BKS/UBER."
  exit 1
fi
log "Detected source keystore type: $SRC_TYPE"

# --- run an import with logging -------------------------------------------

run_import() {
  local mode="$1" dest="$2"
  shift 2
  local logf
  logf="$(mktemp "${RUNNER_TEMP:-/tmp}/keytool_${MATRIX_NAME:-import}_${dest//\//_}_${mode}_XXXXXX.log")"
  log "  importing (mode=$mode) → $dest"
  set +e
  "$@" >"$logf" 2>&1
  local rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    log_warn "keytool import failed (mode=$mode); see $logf"
  fi
  return "$rc"
}

# --- import: source -> BKS ------------------------------------------------

IMPORT_BASE_ARGS=(
  keytool -importkeystore -noprompt
  -srckeystore "$RAW_KEYSTORE"
  -srcstoretype "$SRC_TYPE"
  -srcstorepass "$KEYSTORE_PASSWORD"
  -deststorepass "$KEYSTORE_PASSWORD"
  -providerclass org.bouncycastle.jce.provider.BouncyCastleProvider
  -providerpath "$BCPROV_JAR"
)
BKS_IMPORT_ARGS=("${IMPORT_BASE_ARGS[@]}" -destkeystore "$BKS_KEYSTORE" -deststoretype BKS)

if ! run_import no-keypass BKS "${BKS_IMPORT_ARGS[@]}"; then
  if [ -n "$KEY_PASSWORD_RAW" ]; then
    rm -f "$BKS_KEYSTORE"
    if ! run_import explicit-keypass BKS "${BKS_IMPORT_ARGS[@]}" -srckeypass "$KEY_PASSWORD_RAW" -destkeypass "$KEY_PASSWORD_RAW"; then
      log_error "Failed to convert keystore to BKS."
      log_error "Check KEYSTORE_PASSWORD and KEY_PASSWORD secrets."
      exit 1
    fi
  else
    log_error "Failed to convert keystore to BKS."
    log_error "If your key password differs from KEYSTORE_PASSWORD, set KEY_PASSWORD secret."
    exit 1
  fi
fi

if [ ! -f "$BKS_KEYSTORE" ]; then
  log_error "Failed to create converted BKS keystore."
  exit 1
fi

# --- import: BKS -> PKCS12 (for apksigner) --------------------------------

P12_IMPORT_ARGS=(
  "${IMPORT_BASE_ARGS[@]}"
  -srckeystore "$BKS_KEYSTORE"
  -srcstoretype BKS
  -destkeystore "$P12_KEYSTORE"
  -deststoretype PKCS12
)

if ! run_import no-keypass PKCS12 "${P12_IMPORT_ARGS[@]}"; then
  if [ -n "$KEY_PASSWORD_RAW" ]; then
    rm -f "$P12_KEYSTORE"
    if ! run_import explicit-keypass PKCS12 "${P12_IMPORT_ARGS[@]}" -srckeypass "$KEY_PASSWORD_RAW" -destkeypass "$KEY_PASSWORD_RAW"; then
      log_error "Failed to convert BKS keystore to PKCS12 for apksigner."
      exit 1
    fi
  else
    log_error "Failed to convert BKS keystore to PKCS12 for apksigner."
    exit 1
  fi
fi

if [ ! -f "$P12_KEYSTORE" ]; then
  log_error "Failed to create PKCS12 keystore for apksigner."
  exit 1
fi

# --- pick alias ------------------------------------------------------------

list_aliases() {
  keytool -list \
    -keystore "$BKS_KEYSTORE" \
    -storetype BKS \
    -storepass "$KEYSTORE_PASSWORD" \
    -providerclass org.bouncycastle.jce.provider.BouncyCastleProvider \
    -providerpath "$BCPROV_JAR" \
    2>/dev/null | awk -F, '/,/{print $1}' | sed '/^$/d'
}

mapfile -t KEY_ALIASES < <(list_aliases)
if [ "${#KEY_ALIASES[@]}" -eq 0 ]; then
  log_error "No aliases found in converted keystore."
  exit 1
fi

KEY_ALIAS="$KEY_ALIAS_INPUT"
if [ -z "$KEY_ALIAS" ]; then
  KEY_ALIAS="${KEY_ALIASES[0]}"
  log "No KEY_ALIAS provided; using alias '$KEY_ALIAS'."
else
  found=false
  for a in "${KEY_ALIASES[@]}"; do
    if [ "$a" = "$KEY_ALIAS" ]; then
      found=true
      break
    fi
  done
  if [ "$found" = false ]; then
    log_error "KEY_ALIAS '$KEY_ALIAS' was not found in the converted keystore."
    log_error "Available aliases: ${KEY_ALIASES[*]}"
    exit 1
  fi
fi

json_set_output path "$BKS_KEYSTORE"
json_set_output p12_path "$P12_KEYSTORE"
json_set_output alias "$KEY_ALIAS"
log "BKS keystore (morphe-desktop) + PKCS12 keystore (apksigner) ready; alias=$KEY_ALIAS"