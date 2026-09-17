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
[[ -f $binary ]] || { echo 'Run make linux first.' >&2; exit 1; }
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
