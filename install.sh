#!/usr/bin/env bash
# Install a local servmon binary (or build this checkout) on Linux/systemd.
set -Eeuo pipefail
umask 077

usage() {
  cat <<'HELP'
Usage: sudo ./install.sh [options]

  --binary PATH  Install this Linux amd64/arm64 binary.
  --build        Build ./src from this checkout (requires Go).
  --config PATH  Use this YAML file on first installation only.
  --addr ADDR    Listen address for generated config (default 127.0.0.1:8080).
  --no-start     Install files only; do not enable, start or restart the service.
  -h, --help     Show this help.

Without --binary/--build, look for a matching binary beside the script or in
bin/, then build from source if Go is available. Existing /etc/servmon.yaml
and monitoring data are preserved. No downloads of release binaries are made.

Paths:
  /usr/local/bin/servmon
  /etc/servmon.yaml
  /etc/systemd/system/servmon.service
  /var/lib/servmon
HELP
}
log() { printf '[servmon] %s\n' "$*"; }
die() { printf '[servmon] ERROR: %s\n' "$*" >&2; exit 1; }
need_value() { [[ $# -ge 2 && -n $2 && $2 != --* ]] || die "$1 requires a value"; }

binary=''
config_source=''
addr='127.0.0.1:8080'
force_build=0
no_start=0
while (($#)); do
  case "$1" in
    --binary) need_value "$@"; binary=$2; shift 2 ;;
    --config) need_value "$@"; config_source=$2; shift 2 ;;
    --addr) need_value "$@"; addr=$2; shift 2 ;;
    --build) force_build=1; shift ;;
    --no-start) no_start=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done
[[ -z $binary || $force_build == 0 ]] || die '--binary and --build cannot be combined'
[[ $(uname -s) == Linux ]] || die 'This installer requires Linux'
[[ $EUID == 0 ]] || die 'Run this installer as root, e.g. sudo ./install.sh'
for command in install mktemp cp mv rm ln od tr cat dirname sleep systemctl; do
  command -v "$command" >/dev/null 2>&1 || die "Required command not found: $command"
done
case "$(uname -m)" in
  x86_64|amd64) arch=amd64; machine='62 0' ;;
  aarch64|arm64) arch=arm64; machine='183 0' ;;
  *) die "Unsupported architecture: $(uname -m) (supported: amd64, arm64)" ;;
esac
# Keep generated YAML a single, unambiguous quoted scalar.
if [[ ! $addr =~ ^(\[[[:alnum:]_.:%-]+\]|[[:alnum:]_.-]*):([0-9]{1,5})$ ]]; then
  die 'Invalid --addr; use HOST:PORT, :PORT or [IPv6]:PORT'
fi
port=${BASH_REMATCH[2]}
((10#$port >= 1 && 10#$port <= 65535)) || die 'Port must be between 1 and 65535'

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
unit=/etc/systemd/system/servmon.service
target=/usr/local/bin/servmon
config=/etc/servmon.yaml
manager=0
if systemctl show-environment >/dev/null 2>&1; then manager=1; fi
((manager || no_start)) || die 'systemd is not running; use --no-start to install files in an offline image'
# Reject directories before writing anything. Preserve existing config symlinks.
for path in "$target" "$unit" "$config"; do
  [[ ! -d $path ]] || die "Expected a file, found a directory: $path"
done
if [[ -L $config && ! -e $config ]]; then die "Dangling configuration symlink: $config"; fi
[[ ! -e $config || -f $config ]] || die "Configuration is not a regular file: $config"
if [[ ! -e $config && -n $config_source ]]; then
  [[ -f $config_source && -r $config_source ]] || die "Cannot read config: $config_source"
fi

work_dir=$(mktemp -d)
staged_binary=''
staged_unit=''
staged_config=''
deploying=0
success=0
had_binary=0
had_unit=0
was_active=0
was_enabled=''
enabled_by_us=0
service_attempted=0
cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if ((deploying && !success)); then
    log 'Installation failed; restoring previous binary and unit.' >&2
    if ((service_attempted && !was_active)); then systemctl stop servmon.service >/dev/null 2>&1; fi
    # Disable while the newly installed unit still exists, before restoring it.
    if ((manager && enabled_by_us)); then systemctl disable servmon.service >/dev/null 2>&1; fi
    if ((had_binary)); then
      local restore_binary
      restore_binary=$(mktemp /usr/local/bin/.servmon-restore.XXXXXX)
      cp -a -- "$work_dir/previous-binary" "$restore_binary" && mv -fT -- "$restore_binary" "$target"
      rm -f -- "$restore_binary"
    else
      rm -f -- "$target"
    fi
    if ((had_unit)); then
      cp -a -- "$work_dir/previous-unit" "$unit"
    else
      rm -f -- "$unit"
    fi
    if ((manager)); then
      systemctl daemon-reload
      if ((enabled_by_us)) && [[ $was_enabled == enabled-runtime ]]; then systemctl enable --runtime servmon.service >/dev/null 2>&1; fi
      if ((was_active && service_attempted)); then systemctl restart servmon.service || log 'Previous service could not be restarted; inspect journalctl -u servmon.' >&2; fi
    fi
    log 'Configuration and data were retained.' >&2
    ((status != 0)) || status=1
  fi
  [[ -z $staged_binary ]] || rm -f -- "$staged_binary"
  [[ -z $staged_unit ]] || rm -f -- "$staged_unit"
  [[ -z $staged_config ]] || rm -f -- "$staged_config"
  rm -rf -- "$work_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -z $binary && $force_build == 0 ]]; then
  for candidate in \
    "$script_dir/bin/servmon-linux-$arch" \
    "$script_dir/servmon-linux-$arch" \
    "$script_dir/bin/servmon" \
    "$script_dir/servmon"; do
    if [[ -f $candidate ]]; then binary=$candidate; break; fi
  done
fi
if [[ -z $binary ]]; then
  [[ -f $script_dir/go.mod && -d $script_dir/src ]] || die 'No binary/source found; pass --binary PATH'
  command -v go >/dev/null 2>&1 || die 'Building from source requires Go; alternatively run make linux elsewhere and pass --binary PATH'
  log "Building Linux/$arch from source..."
  (cd -- "$script_dir" && CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -trimpath -ldflags='-s -w' -o "$work_dir/servmon" ./src)
  binary=$work_dir/servmon
fi
[[ -f $binary && -r $binary ]] || die "Cannot read binary: $binary"
magic=$(od -An -N6 -tx1 -- "$binary" | tr -d ' \n')
[[ $magic == 7f454c460201 ]] || die "Not a 64-bit little-endian Linux ELF binary: $binary"
actual_machine=$(od -An -j18 -N2 -tu1 -- "$binary")
read -r byte1 byte2 <<< "$actual_machine"
[[ "$byte1 $byte2" == "$machine" ]] || die "Binary architecture does not match Linux/$arch: $binary"

# Prepare everything before replacing the running executable.
for directory in /usr/local/bin /etc/systemd/system; do
  [[ -d $directory ]] || install -d -m 0755 "$directory"
done
install -d -m 0700 /var/lib/servmon
if [[ ! -e $config ]]; then
  if [[ -n $config_source ]]; then
    install -m 0600 -- "$config_source" "$work_dir/config"
  else
    token=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
    view_token=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
    [[ ${#token} == 64 && ${#view_token} == 64 ]] || die 'Failed to generate access tokens'
    cat > "$work_dir/config" <<CONFIG
# Generated by servmon install.sh. Existing configuration is never overwritten.
addr: "$addr"
token: "$token"
view_token: "$view_token"
services: []
interval: 2s
proc_interval: 5s
data_dir: /var/lib/servmon
alerts:
  cpu: 90
  mem: 90
  disk: 90
  load1: 0
  service_failed: true
  sustain: 30s
  cooldown: 10m
notify:
  webhook: []
  telegram:
    token: ""
    chat_id: ""
CONFIG
  fi
  # An exclusive hard link publishes the complete config without overwriting
  # a config created concurrently. The temporary file is on the same filesystem.
  staged_config=$(mktemp /etc/.servmon-config.XXXXXX)
  install -m 0600 -- "$work_dir/config" "$staged_config"
  ln -- "$staged_config" "$config"
  log "Created $config (mode 600). Read it locally for the access tokens."
else
  log "Preserving $config; --config and --addr do not modify existing configuration."
fi
cat > "$work_dir/unit" <<'UNIT'
# Managed by servmon install.sh; put custom overrides in servmon.service.d/.
[Unit]
Description=servmon server monitor
After=network.target

[Service]
Type=simple
User=root
ExecStart=/usr/local/bin/servmon -config /etc/servmon.yaml
WorkingDirectory=/var/lib/servmon
StateDirectory=servmon
StateDirectoryMode=0700
UMask=0077
Restart=on-failure
RestartSec=3s
TimeoutStopSec=15s

[Install]
WantedBy=multi-user.target
UNIT
staged_binary=$(mktemp /usr/local/bin/.servmon-install.XXXXXX)
staged_unit=$(mktemp /etc/systemd/system/.servmon-install.XXXXXX)
install -m 0755 -- "$binary" "$staged_binary"
install -m 0644 -- "$work_dir/unit" "$staged_unit"
if [[ -e $target || -L $target ]]; then cp -a -- "$target" "$work_dir/previous-binary"; had_binary=1; fi
if [[ -e $unit || -L $unit ]]; then cp -a -- "$unit" "$work_dir/previous-unit"; had_unit=1; fi
if ((manager)); then
  if systemctl is-active --quiet servmon.service; then was_active=1; fi
  was_enabled=$(systemctl is-enabled servmon.service 2>/dev/null || true)
fi
deploying=1
mv -fT -- "$staged_binary" "$target"
mv -fT -- "$staged_unit" "$unit"
if ((manager)); then systemctl daemon-reload; fi
if ((no_start)); then
  log 'Files installed; service enable/start/restart was skipped.'
else
  if [[ $was_enabled != enabled ]]; then
    enabled_by_us=1
    systemctl enable servmon.service
  fi
  service_attempted=1
  if ((was_active)); then systemctl restart servmon.service; else systemctl start servmon.service; fi
  sleep 1
  systemctl is-active --quiet servmon.service || die 'Service did not become active; inspect journalctl -u servmon.service'
  log 'servmon.service is enabled and active.'
fi
success=1
log "Installed Linux/$arch: $target"
log "Config: $config | Data: /var/lib/servmon"
log 'Manage: systemctl status servmon.service | journalctl -u servmon.service -f'
