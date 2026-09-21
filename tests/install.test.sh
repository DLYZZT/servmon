#!/usr/bin/env bash
# Integration tests run only in a disposable Docker container (see README).
set -Eeuo pipefail
[[ $(uname -s) == Linux && -f /.dockerenv && $EUID == 0 ]] || {
  echo 'Run this test in a disposable root Docker container, not on the host.' >&2
  exit 1
}
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
case "$(uname -m)" in x86_64) arch=amd64;; aarch64) arch=arm64;; *) exit 1;; esac
binary="$repo/bin/servmon-linux-$arch"
[[ -f $binary && -f $repo/bin/servmon-darwin-amd64 && -f $repo/bin/servmon-darwin-arm64 ]] || { echo 'Run make release first.' >&2; exit 1; }
suite=$(mktemp -d)
app_pid=''
cleanup() { [[ -z $app_pid ]] || { kill "$app_pid" 2>/dev/null || true; wait "$app_pid" 2>/dev/null || true; }; rm -rf -- "$suite"; }
trap cleanup EXIT
mkdir -p "$suite/mock" "$suite/state"
export TEST_SYSTEMCTL_STATE="$suite/state"
export TEST_SYSTEMD_RUNNING=1
cat > "$suite/mock/systemctl" <<'MOCK'
#!/usr/bin/env bash
set -eu
s=$TEST_SYSTEMCTL_STATE
printf '%s\n' "$*" >> "$s/calls"
if [[ -f $s/fail-$1 ]]; then
  rm "$s/fail-$1"
  if [[ $1 == start || $1 == restart ]]; then rm -f "$s/active"; fi
  exit 1
fi
case "$1" in
  show-environment) [[ $TEST_SYSTEMD_RUNNING == 1 ]] ;;
  daemon-reload) : ;;
  is-active) [[ -f $s/active ]] ;;
  is-enabled) if [[ -f $s/enabled ]]; then cat "$s/enabled"; else echo disabled; exit 1; fi ;;
  enable) if [[ ${2:-} == --runtime ]]; then echo enabled-runtime > "$s/enabled"; else echo enabled > "$s/enabled"; fi ;;
  disable) [[ -f /etc/systemd/system/servmon.service ]]; rm -f "$s/enabled" ;;
  start|restart) touch "$s/active" ;;
  stop) rm -f "$s/active" ;;
  *) exit 1 ;;
esac
MOCK
chmod +x "$suite/mock/systemctl"
export PATH="$suite/mock:$PATH"
run() { bash "$repo/install.sh" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
expect_fail() { if run "$@" > "$suite/error" 2>&1; then fail "unexpected success: $*"; fi; }
clean_install() {
  rm -f /usr/local/bin/servmon /etc/systemd/system/servmon.service /etc/servmon.yaml
  rm -f "$suite/state/active" "$suite/state/enabled" "$suite/state/calls"
}
clean_install
run --help >/dev/null
expect_fail --binary
expect_fail --binary "$binary" --build
expect_fail --binary "$binary" --addr 'localhost:70000'
expect_fail --binary "$binary" --addr $'localhost:8080\ntoken: insecure'
printf 'not an executable\n' > "$suite/not-elf"
expect_fail --binary "$suite/not-elf"
cp "$binary" "$suite/wrong-arch"
# A different e_machine must be rejected before installation.
printf '\001\000' | dd of="$suite/wrong-arch" bs=1 seek=18 conv=notrunc status=none
expect_fail --binary "$suite/wrong-arch"
[[ ! -e /etc/servmon.yaml && ! -e /usr/local/bin/servmon ]] || fail 'preflight wrote files'
echo 'PASS: argument, ELF and architecture preflight'

export TEST_SYSTEMD_RUNNING=0
expect_fail --binary "$binary"
run --binary "$binary" --addr 127.0.0.1:18898 --no-start
[[ $(stat -c '%a' /etc/servmon.yaml) == 600 ]] || fail 'config permissions'
[[ $(stat -c '%a' /usr/local/bin/servmon) == 755 ]] || fail 'binary permissions'
[[ $(stat -c '%a' /etc/systemd/system/servmon.service) == 644 ]] || fail 'unit permissions'
[[ ! -f $suite/state/active && ! -f $suite/state/enabled ]] || fail '--no-start started service'
node - <<'JS'
const fs=require('fs'),assert=require('assert');const c=fs.readFileSync('/etc/servmon.yaml','utf8');
const admin=/^token: "([a-f0-9]{64})"$/m.exec(c)?.[1];const view=/^view_token: "([a-f0-9]{64})"$/m.exec(c)?.[1];
assert(admin&&view&&admin!==view);assert(c.includes('addr: "127.0.0.1:18898"'));
JS
echo 'PASS: offline file installation, random tokens and permissions'

# Smoke-test the real installed binary and generated YAML, without systemd.
/usr/local/bin/servmon -config /etc/servmon.yaml > "$suite/app.log" 2>&1 &
app_pid=$!
node - <<'JS'
const fs=require('fs'),assert=require('assert');
const token=/^token: "(.*)"$/m.exec(fs.readFileSync('/etc/servmon.yaml','utf8'))[1];
(async()=>{for(let i=0;i<50;i++){try{const r=await fetch('http://127.0.0.1:18898/api/ping',{headers:{Authorization:`Bearer ${token}`}});assert(r.ok);assert.equal((await r.json()).role,'admin');console.log('PASS: installed binary starts with generated config');return}catch(e){await new Promise(r=>setTimeout(r,100))}}process.exitCode=1})()
JS
kill "$app_pid"; wait "$app_pid"; app_pid=''
cp /etc/servmon.yaml "$suite/saved-config"
echo retained > /var/lib/servmon/install-test-sentinel
printf 'token: replacement\n' > "$suite/replacement.yaml"
export TEST_SYSTEMD_RUNNING=1
run --binary "$binary" --config "$suite/replacement.yaml" --addr :19999
cmp /etc/servmon.yaml "$suite/saved-config"
[[ $(cat /var/lib/servmon/install-test-sentinel) == retained ]] || fail 'data was modified'
[[ -f $suite/state/active && -f $suite/state/enabled ]] || fail 'service was not enabled/started'
run --binary "$binary"
grep -q '^restart servmon.service$' "$suite/state/calls" || fail 'upgrade did not restart service'
echo 'PASS: upgrade preserves config/data and restarts active service'

printf 'previous-binary\n' > /usr/local/bin/servmon
printf 'previous-unit\n' > /etc/systemd/system/servmon.service
touch "$suite/state/fail-restart"
expect_fail --binary "$binary"
[[ $(cat /usr/local/bin/servmon) == previous-binary ]] || fail 'binary rollback'
[[ $(cat /etc/systemd/system/servmon.service) == previous-unit ]] || fail 'unit rollback'
[[ -f $suite/state/active ]] || fail 'previous service was not restarted'
cmp /etc/servmon.yaml "$suite/saved-config"
echo 'PASS: failed restart restores previous binary, unit and active service'

clean_install
touch "$suite/state/fail-start"
expect_fail --binary "$binary"
[[ ! -e /usr/local/bin/servmon && ! -e /etc/systemd/system/servmon.service ]] || fail 'fresh failure left installed files'
[[ ! -f $suite/state/enabled && -f /etc/servmon.yaml ]] || fail 'fresh failure did not preserve config/restore enable state'
echo 'PASS: failed first startup removes install files and keeps config'

clean_install
run --binary "$binary" --config "$suite/replacement.yaml" --no-start
cmp /etc/servmon.yaml "$suite/replacement.yaml"
echo 'PASS: supplied first-install configuration is copied verbatim'

# Offline staging must not restart an already active service.
touch "$suite/state/active"
printf enabled > "$suite/state/enabled"
: > "$suite/state/calls"
run --binary "$binary" --no-start
if grep -Eq '^(start|restart|enable|disable|stop) ' "$suite/state/calls"; then fail '--no-start changed service state'; fi
echo 'PASS: --no-start leaves active service untouched'

# Restore runtime-only enablement after an unsuccessful upgrade.
printf 'previous-binary\n' > /usr/local/bin/servmon
printf 'previous-unit\n' > /etc/systemd/system/servmon.service
printf enabled-runtime > "$suite/state/enabled"
touch "$suite/state/fail-restart"
expect_fail --binary "$binary"
[[ $(cat "$suite/state/enabled") == enabled-runtime ]] || fail 'runtime enablement was not restored'
echo 'PASS: rollback restores runtime-only enablement'

# Failures reloading the unit also restore files, before startup is attempted.
touch "$suite/state/fail-daemon-reload"
expect_fail --binary "$binary"
[[ $(cat /usr/local/bin/servmon) == previous-binary ]] || fail 'daemon-reload rollback'
[[ $(cat /etc/systemd/system/servmon.service) == previous-unit ]] || fail 'daemon-reload unit rollback'
[[ -f $suite/state/active ]] || fail 'reload failure stopped the existing service'
echo 'PASS: daemon reload failure rolls back files'

: > "$suite/state/calls"
touch "$suite/state/fail-daemon-reload"
expect_fail --binary "$binary" --no-start
if grep -Eq '^(start|restart|enable|disable|stop) ' "$suite/state/calls"; then fail '--no-start rollback changed running service'; fi
echo 'PASS: --no-start failure does not restart the old service'

# Distribution with only the script and matching binary; cwd is unrelated.
clean_install
mkdir -p "$suite/path with spaces"
cp "$repo/install.sh" "$suite/path with spaces/install.sh"
cp "$binary" "$suite/path with spaces/servmon-linux-$arch"
(cd /tmp && bash "$suite/path with spaces/install.sh" --no-start)
[[ -x /usr/local/bin/servmon ]] || fail 'automatic binary discovery'
echo 'PASS: standalone distribution and paths with spaces'

# Check --build dispatch and arguments without fetching Go dependencies in tests.
clean_install
export TEST_PREBUILT_BINARY="$binary"
cat > "$suite/mock/go" <<'BUILD'
#!/usr/bin/env bash
set -eu
[[ $CGO_ENABLED == 0 && $GOOS == linux ]]
[[ -f go.mod && -d src ]]
[[ $1 == build && $2 == -trimpath && $3 == '-ldflags=-s -w' && $4 == -o && $6 == ./src ]]
cp "$TEST_PREBUILT_BINARY" "$5"
touch "$TEST_SYSTEMCTL_STATE/built"
BUILD
chmod +x "$suite/mock/go"
run --build --no-start
[[ -f $suite/state/built ]] || fail '--build did not call Go'
cmp /usr/local/bin/servmon "$binary"
echo 'PASS: --build command dispatch and installation'

if command -v runuser >/dev/null 2>&1; then
  if runuser -u nobody -- bash "$repo/install.sh" --no-start > "$suite/nonroot" 2>&1; then fail 'non-root installation accepted'; fi
  grep -q 'Run this installer as root' "$suite/nonroot" || fail 'unexpected non-root error'
  echo 'PASS: non-root user is rejected before file changes'
fi

# Mock GitHub transport so download tests stay deterministic and network-free.
clean_install
mkdir -p "$suite/releases" "$suite/standalone"
cp "$repo/install.sh" "$suite/standalone/install.sh"
cp "$repo"/bin/servmon-linux-* "$repo"/bin/servmon-darwin-* "$suite/releases/"
(cd "$suite/releases" && sha256sum servmon-* > checksums.txt)
export TEST_RELEASE_DIR="$suite/releases"
export TEST_DOWNLOAD_LOG="$suite/downloads"
export TEST_DOWNLOAD_FAILURE=''
cat > "$suite/mock/curl" <<'DOWNLOAD'
#!/usr/bin/env bash
set -eu
while [[ $# -gt 0 && $1 != --output ]]; do shift; done
[[ $# == 3 && $1 == --output ]]
out=$2 url=$3
printf '%s\n' "$url" >> "$TEST_DOWNLOAD_LOG"
case "$url" in
  https://github.com/example/servmon/releases/latest/download/*|https://github.com/example/servmon/releases/download/v1.2.3/*) ;;
  *) exit 22 ;;
esac
asset=${url##*/}
[[ $TEST_DOWNLOAD_FAILURE != "$asset" ]] || exit 22
cp "$TEST_RELEASE_DIR/$asset" "$out"
DOWNLOAD
chmod +x "$suite/mock/curl"
expect_fail --repo example/servmon --binary "$binary"
expect_fail --repo example/servmon --build
expect_fail --repo example/servmon --version '../bad'
expect_fail --repo 'example/servmon?bad'
expect_fail --repo
expect_fail --version
run --repo example/servmon --version v1.2.3 --no-start
cmp "$binary" /usr/local/bin/servmon
grep -q "/download/v1.2.3/servmon-linux-$arch$" "$suite/downloads" || fail 'versioned release URL'
echo 'PASS: pinned release download and checksum validation'

clean_install
(cd /tmp && SERVMON_REPO=example/servmon bash "$suite/standalone/install.sh" --no-start)
cmp "$binary" /usr/local/bin/servmon
grep -q "/latest/download/servmon-linux-$arch$" "$suite/downloads" || fail 'latest release URL'
echo 'PASS: standalone script automatically downloads latest release'

clean_install
# Emulate the repository-aware install.sh attached by the release workflow.
sed "s|^default_repo=.*$|default_repo='example/servmon'|" "$repo/install.sh" > "$suite/release-install.sh"
cat "$suite/release-install.sh" | bash -s -- --download --no-start
cmp "$binary" /usr/local/bin/servmon
echo 'PASS: release installer works through stdin without --repo'

cp /etc/servmon.yaml "$suite/online-config"
cp /etc/systemd/system/servmon.service "$suite/online-unit"
cp "$suite/releases/checksums.txt" "$suite/good-checksums"
# A corrupt download must leave a working installation untouched.
printf '\ncorruption\n' >> "$suite/releases/servmon-linux-$arch"
expect_fail --repo example/servmon --no-start
grep -q 'SHA-256 checksum mismatch' "$suite/error" || fail 'corrupt download accepted'
cmp "$binary" /usr/local/bin/servmon
cmp /etc/servmon.yaml "$suite/online-config"
cmp /etc/systemd/system/servmon.service "$suite/online-unit"
cp "$binary" "$suite/releases/servmon-linux-$arch"
: > "$suite/releases/checksums.txt"
expect_fail --repo example/servmon --no-start
grep -q 'Release checksum not found' "$suite/error" || fail 'missing checksum accepted'
cat "$suite/good-checksums" "$suite/good-checksums" > "$suite/releases/checksums.txt"
expect_fail --repo example/servmon --no-start
grep -q 'Invalid or duplicate' "$suite/error" || fail 'duplicate checksum accepted'
cp "$suite/good-checksums" "$suite/releases/checksums.txt"
export TEST_DOWNLOAD_FAILURE=checksums.txt
expect_fail --repo example/servmon --no-start
export TEST_DOWNLOAD_FAILURE="servmon-linux-$arch"
expect_fail --repo example/servmon --no-start
export TEST_DOWNLOAD_FAILURE=''
cmp "$binary" /usr/local/bin/servmon
echo 'PASS: corrupt, missing, duplicate and failed downloads preserve installation'

# Restrict PATH to exercise wget and shasum without curl or sha256sum.
mkdir "$suite/fallback"
for tool in bash uname install mktemp cp mv rm ln od tr cat dirname sleep systemctl; do
  ln -s "$(command -v "$tool")" "$suite/fallback/$tool"
done
# The slim test image has no Perl Digest::SHA; validate the shasum invocation
# and compute a real checksum with the system tool outside the restricted PATH.
cat > "$suite/fallback/shasum" <<'SHASUM'
#!/usr/bin/env bash
set -eu
[[ $# == 3 && $1 == -a && $2 == 256 ]]
exec /usr/bin/sha256sum "$3"
SHASUM
cat > "$suite/fallback/wget" <<'WGET'
#!/usr/bin/env bash
set -eu
while [[ $# -gt 0 && $1 != --output-document ]]; do shift; done
[[ $# == 3 && $1 == --output-document ]]
cp "$TEST_RELEASE_DIR/${3##*/}" "$2"
WGET
chmod +x "$suite/fallback/wget" "$suite/fallback/shasum"
PATH="$suite/fallback" bash "$repo/install.sh" --repo example/servmon --no-start
cmp "$binary" /usr/local/bin/servmon
echo 'PASS: wget and shasum fallback'

# Exercise macOS installation safely inside the disposable container.
clean_install
cat > "$suite/mock/uname" <<'UNAME'
#!/usr/bin/env bash
case "$1" in -s) echo Darwin;; -m) echo "$TEST_MAC_ARCH";; *) exit 1;; esac
UNAME
chmod +x "$suite/mock/uname"
for mac_arch in amd64 arm64; do
  export TEST_MAC_ARCH=$mac_arch
  : > "$suite/state/calls"
  run --repo example/servmon --no-start
  cmp "$repo/bin/servmon-darwin-$mac_arch" /usr/local/bin/servmon
  [[ ! -e /etc/servmon.yaml && ! -e /etc/systemd/system/servmon.service ]] || fail 'macOS installed Linux config/unit'
  [[ ! -s $suite/state/calls ]] || fail 'macOS called systemctl'
  expect_fail --binary "$binary"
  expect_fail --binary "$repo/bin/servmon-darwin-$mac_arch" --config "$suite/replacement.yaml"
  if [[ $mac_arch == amd64 ]]; then other_arch=arm64; else other_arch=amd64; fi
  expect_fail --binary "$repo/bin/servmon-darwin-$other_arch"
done
rm "$suite/mock/uname"
echo 'PASS: macOS amd64/arm64 download, Mach-O checks and binary-only installation'
