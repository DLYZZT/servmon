#!/usr/bin/env bash
# Install servmon from GitHub Releases, a local binary, or this checkout.
set -Eeuo pipefail
umask 077

usage() {
  cat <<'HELP'
Usage: sudo ./install.sh [options]

  --binary PATH  Install this local binary (must match the host).
  --build        Build ./src from this checkout (requires Go).
  --download     Download a release, ignoring local binaries and source.
  --repo OWNER/REPO  GitHub repository (default DLYZZT/servmon; or SERVMON_REPO).
  --version TAG  Download this release tag (default: latest stable release).
  --config PATH  Use this YAML file on first installation only.
  --addr ADDR    Listen address for generated config (default 127.0.0.1:8080).
  --no-start     Install files only; do not enable, start or restart the service.
  --uninstall    Remove the binary and Linux service; preserve config and data.
  --purge        With --uninstall, also remove Linux default config/data/overrides.
  -h, --help     Show this help.

Without an explicit source, look for a matching local binary, then build if
source and Go are available, otherwise download a release with SHA-256 checking.
--repo/--version imply --download. Downloads require curl or wget and a SHA-256
utility. Linux installs a systemd service and preserves configuration/data.
macOS installs only /usr/local/bin/servmon; run it with your own YAML config.
Uninstallation needs no downloads or Go. Custom config/data paths are never
deleted. On macOS, stop any manually started process before uninstalling.

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
default_repo='DLYZZT/servmon'
release_repo=${SERVMON_REPO:-$default_repo}
version=latest
download=0
config_source=''
addr='127.0.0.1:8080'
force_build=0
no_start=0
uninstall=0
purge=0
install_options=0
while (($#)); do
  case "$1" in
    --binary|--config|--addr|--build|--download|--repo|--version|--no-start) install_options=1 ;;
  esac
  case "$1" in
    --binary) need_value "$@"; binary=$2; shift 2 ;;
    --config) need_value "$@"; config_source=$2; shift 2 ;;
    --addr) need_value "$@"; addr=$2; shift 2 ;;
    --build) force_build=1; shift ;;
    --download) download=1; shift ;;
    --repo) need_value "$@"; release_repo=$2; download=1; shift 2 ;;
    --version) need_value "$@"; version=$2; download=1; shift 2 ;;
    --no-start) no_start=1; shift ;;
    --uninstall) uninstall=1; shift ;;
    --purge) purge=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done
((!purge || uninstall)) || die '--purge requires --uninstall'
((!uninstall || !install_options)) || die '--uninstall cannot be combined with installation options'
[[ -z $binary || $force_build == 0 ]] || die '--binary and --build cannot be combined'
[[ $download == 0 || ( -z $binary && $force_build == 0 ) ]] || die '--download/--repo/--version cannot be combined with --binary/--build'
[[ $version =~ ^[[:alnum:]][[:alnum:]._-]*$ ]] || die 'Invalid release version; use a tag such as v1.0.0'
case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) die 'This installer supports Linux and macOS' ;;
esac
if [[ $os == darwin && ( -n $config_source || $addr != 127.0.0.1:8080 ) ]]; then
  die '--config and --addr configure the Linux service only; on macOS provide YAML when running servmon'
fi
[[ $EUID == 0 ]] || die 'Run this installer as root, e.g. sudo ./install.sh'
unit=/etc/systemd/system/servmon.service
target=/usr/local/bin/servmon
config=/etc/servmon.yaml

uninstall_servmon() {
  command -v rm >/dev/null 2>&1 || die 'Required command not found: rm'
  [[ ! -d $target || -L $target ]] || die "Expected a file, found a directory: $target"
  if [[ $os == darwin ]]; then
    (( !purge )) || die '--purge is Linux-only; macOS config and data are managed manually'
    rm -f -- "$target"
    log 'Removed /usr/local/bin/servmon. Your macOS configuration and data were retained.'
    log 'Manually started processes and custom background services must be stopped separately.'
    return
  fi
  command -v systemctl >/dev/null 2>&1 || die 'Required command not found: systemctl'
  [[ ! -d $unit || -L $unit ]] || die "Expected a file, found a directory: $unit"
  if ((purge)); then
    [[ ! -d $config || -L $config ]] || die "Expected a file, found a directory: $config"
  fi
  local running=0
  if systemctl show-environment >/dev/null 2>&1; then running=1; fi
  if ((running)); then
    if [[ -e $unit || -L $unit ]] || systemctl is-active --quiet servmon.service; then
      systemctl stop servmon.service || die 'Could not stop servmon.service; no files were removed'
    fi
  else
    log 'systemd is not running; removing files and disabling offline startup links.'
  fi
  # Disable while the unit still exists; an unsuccessful stop/disable must not
  # remove the executable or user data. Repeated uninstalls are harmless.
  if [[ -e $unit || -L $unit ]]; then
    systemctl disable servmon.service || die 'Could not disable servmon.service; no files were removed'
  fi
  rm -f -- "$target" "$unit"
  if ((running)); then systemctl daemon-reload; fi
  if ((purge)); then
    # Fixed paths only, with no trailing slash: remove symlinks themselves,
    # never their targets. Do not derive deletion paths from user YAML.
    rm -f -- "$config"
    rm -rf -- /var/lib/servmon /etc/systemd/system/servmon.service.d
    log 'Removed default configuration, data and systemd overrides. Custom paths were retained.'
  else
    log 'Preserved /etc/servmon.yaml, /var/lib/servmon and systemd overrides.'
  fi
  log 'Uninstalled servmon.'
}
if ((uninstall)); then
  uninstall_servmon
  exit 0
fi

for command in install mktemp cp mv rm ln od tr cat dirname sleep; do
  command -v "$command" >/dev/null 2>&1 || die "Required command not found: $command"
done
case "$(uname -m)" in
  x86_64|amd64) arch=amd64; machine='62 0'; macho_cpu=07000001 ;;
  aarch64|arm64) arch=arm64; machine='183 0'; macho_cpu=0c000001 ;;
  *) die "Unsupported architecture: $(uname -m) (supported: amd64, arm64)" ;;
esac
# Keep generated YAML a single, unambiguous quoted scalar.
if [[ ! $addr =~ ^(\[[[:alnum:]_.:%-]+\]|[[:alnum:]_.-]*):([0-9]{1,5})$ ]]; then
  die 'Invalid --addr; use HOST:PORT, :PORT or [IPv6]:PORT'
fi
port=${BASH_REMATCH[2]}
((10#$port >= 1 && 10#$port <= 65535)) || die 'Port must be between 1 and 65535'

# BASH_SOURCE is unset when invoked with curl | bash under nounset.
script_dir=''
if [[ -n ${BASH_SOURCE[0]:-} && -f ${BASH_SOURCE[0]} ]]; then
  script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
fi
manager=0
if [[ $os == linux ]]; then
  command -v systemctl >/dev/null 2>&1 || die 'Required command not found: systemctl'
  if systemctl show-environment >/dev/null 2>&1; then manager=1; fi
  ((manager || no_start)) || die 'systemd is not running; use --no-start to install files in an offline image'
fi
# Reject directories before writing anything. Preserve existing config symlinks.
[[ ! -d $target ]] || die "Expected a file, found a directory: $target"
if [[ $os == linux ]]; then
  for path in "$unit" "$config"; do
    [[ ! -d $path ]] || die "Expected a file, found a directory: $path"
  done
  if [[ -L $config && ! -e $config ]]; then die "Dangling configuration symlink: $config"; fi
  [[ ! -e $config || -f $config ]] || die "Configuration is not a regular file: $config"
  if [[ ! -e $config && -n $config_source ]]; then
    [[ -f $config_source && -r $config_source ]] || die "Cannot read config: $config_source"
  fi
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

download_release() {
  [[ $release_repo =~ ^[[:alnum:]_.-]+/[[:alnum:]_.-]+$ ]] || die 'Specify the GitHub repository with --repo OWNER/REPO or SERVMON_REPO'
  local asset="servmon-$os-$arch" base digest name extra expected='' actual
  local -a fetch hash
  if command -v curl >/dev/null 2>&1; then
    fetch=(curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 300 --proto '=https' --proto-redir '=https' --output)
  elif command -v wget >/dev/null 2>&1; then
    fetch=(wget --quiet --https-only --tries=3 --timeout=30 --output-document)
  else
    die 'Online installation requires curl or wget'
  fi
  if command -v sha256sum >/dev/null 2>&1; then hash=(sha256sum)
  elif command -v shasum >/dev/null 2>&1; then hash=(shasum -a 256)
  else die 'Online installation requires sha256sum or shasum'; fi
  base="https://github.com/$release_repo/releases"
  if [[ $version == latest ]]; then base+='/latest/download'
  else base+="/download/$version"; fi
  log "Downloading $release_repo ($version), $os/$arch..."
  "${fetch[@]}" "$work_dir/checksums.txt" "$base/checksums.txt" || die 'Could not download release checksums; check the repository and version'
  while read -r digest name extra; do
    if [[ $name == "$asset" ]]; then
      [[ -z $expected && -z $extra && $digest =~ ^[0-9a-f]{64}$ ]] || die 'Invalid or duplicate release checksum'
      expected=$digest
    fi
  done < "$work_dir/checksums.txt"
  [[ -n $expected ]] || die "Release checksum not found for $asset"
  "${fetch[@]}" "$work_dir/servmon" "$base/$asset" || die "Could not download $asset"
  actual=$("${hash[@]}" "$work_dir/servmon")
  [[ ${actual%% *} == "$expected" ]] || die "SHA-256 checksum mismatch for $asset"
  binary=$work_dir/servmon
}

if [[ -n $script_dir && -z $binary && $force_build == 0 && $download == 0 ]]; then
  for candidate in \
    "$script_dir/bin/servmon-$os-$arch" \
    "$script_dir/servmon-$os-$arch" \
    "$script_dir/bin/servmon" \
    "$script_dir/servmon"; do
    if [[ -f $candidate ]]; then binary=$candidate; break; fi
  done
fi
if [[ -z $binary ]]; then
  if ((download)); then
    download_release
  elif ((force_build)) || { [[ -n $script_dir && -f $script_dir/go.mod && -d $script_dir/src ]] && command -v go >/dev/null 2>&1; }; then
    [[ -n $script_dir && -f $script_dir/go.mod && -d $script_dir/src ]] || die 'No source checkout found; --build requires go.mod and src beside the script'
    command -v go >/dev/null 2>&1 || die 'Building from source requires Go'
    log "Building $os/$arch from source..."
    (cd -- "$script_dir" && CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags='-s -w' -o "$work_dir/servmon" ./src)
    binary=$work_dir/servmon
  else
    download_release
  fi
fi
[[ -f $binary && -r $binary ]] || die "Cannot read binary: $binary"
if [[ $os == darwin ]]; then
  magic=$(od -An -N8 -tx1 "$binary" | tr -d ' \n')
  [[ $magic == "cffaedfe$macho_cpu" ]] || die "Binary is not a matching macOS/$arch Mach-O executable: $binary"
  [[ -d /usr/local/bin ]] || install -d -m 0755 /usr/local/bin
  staged_binary=$(mktemp /usr/local/bin/.servmon-install.XXXXXX)
  install -m 0755 "$binary" "$staged_binary"
  mv -f "$staged_binary" "$target"
  success=1
  log "Installed macOS/$arch: $target"
  log 'Run: servmon -config /path/to/servmon.yaml (set token and a writable data_dir). No background service was created.'
  exit 0
fi
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
