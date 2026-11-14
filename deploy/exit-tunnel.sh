#!/usr/bin/env bash
# 把对位的出口切到「家里这台机器」的宽带。
#
# 在【家里机器】上执行（Linux + systemd；macOS 需先装 gost/microsocks）：
#   ./deploy/exit-tunnel.sh
#
# 它会：
#   1. 确保本机 SOCKS5 只监听 127.0.0.1:1080（Linux 用 systemd + jd-exit 低权限用户）
#   2. 用你现有的 ~/.ssh 配置/authorized_keys 连服务器
#   3. 暂停服务器上的回退 SOCKS，再执行 ssh -N -R 1080:127.0.0.1:1080
#   4. 隧道退出时自动恢复服务器回退 SOCKS
#
# 不会生成、读取或回显任何私钥；不写 0.0.0.0；日志只进 journal。
set -euo pipefail

SERVER="${JD_EXIT_SERVER:-ubuntu@duiwei.zxlumen.cn}"
PORT="${JD_EXIT_PORT:-1080}"
SERVICE="jd-exit-socks"
SERVER_SOCKS_SERVICE="${JD_EXIT_SERVER_SOCKS_SERVICE:-jd-exit-socks}"
RUN_USER="jd-exit"
INSTALL_ONLY=0
NO_INSTALL=0
STOP_SERVER_SOCKS=1
LOCAL_SOCKS_PID=""
CLEANED=0

usage() {
  cat <<'EOF'
用法: deploy/exit-tunnel.sh [--server user@host] [--port 1080] [--install-only] [--no-install] [--keep-server-socks]

  --server user@host       服务器 SSH 地址（默认 ubuntu@duiwei.zxlumen.cn）
  --port 1080              本机 SOCKS5 端口，也是服务器反向隧道端口
  --install-only           只装本机 systemd 服务，不建立 SSH 隧道
  --no-install             跳过安装，直接建立隧道（服务已装好时用）
  --keep-server-socks      不暂停服务器回退 SOCKS（仅当服务器 1080 已空闲时用）
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="${2:?}"; shift 2 ;;
    --port) PORT="${2:?}"; shift 2 ;;
    --install-only) INSTALL_ONLY=1; shift ;;
    --no-install) NO_INSTALL=1; shift ;;
    --keep-server-socks) STOP_SERVER_SOCKS=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage; exit 2 ;;
  esac
done

say() { printf '[exit] %s\n' "$*"; }
die() { printf '[exit] 失败: %s\n' "$*" >&2; exit 1; }
ssh_q() { ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new "$@"; }

need_root() {
  if [ "$(id -u)" -eq 0 ]; then
    SUDO=""
  elif command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    die "安装需要 root（或用 sudo 运行）"
  fi
}

verify_local_listen() {
  local listen=""
  if command -v ss >/dev/null 2>&1; then
    listen="$(ss -lntp 2>/dev/null | awk -v p=":${PORT}" '$4 ~ p {print $4}' || true)"
  elif command -v lsof >/dev/null 2>&1; then
    listen="$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $9}' || true)"
  fi
  if [ -z "$listen" ]; then
    die "本机 SOCKS5 没起来（找不到 127.0.0.1:${PORT}）"
  fi
  if printf '%s\n' "$listen" | grep -Eq '^(0\.0\.0\.0|\*|\[::\]|::):'; then
    die "本机 SOCKS5 监听了公网地址（${listen}），拒绝继续"
  fi
  if ! printf '%s\n' "$listen" | grep -q '127\.0\.0\.1'; then
    die "本机 SOCKS5 没有绑定 127.0.0.1（${listen}），拒绝继续"
  fi
  say "本机 SOCKS5 已就绪: $(printf '%s' "$listen" | tr '\n' ' ')"
}

install_socks_systemd() {
  need_root
  if ! command -v microsocks >/dev/null 2>&1; then
    say "安装 microsocks"
    if command -v apt-get >/dev/null 2>&1; then
      $SUDO apt-get update -qq
      $SUDO apt-get install -y -qq microsocks
    elif command -v dnf >/dev/null 2>&1; then
      $SUDO dnf install -y microsocks
    else
      die "没找到 apt-get/dnf；请先安装 microsocks 后加 --no-install"
    fi
  fi
  if ! id "$RUN_USER" >/dev/null 2>&1; then
    say "创建低权限用户 $RUN_USER"
    $SUDO useradd --system --no-create-home --shell /usr/sbin/nologin "$RUN_USER"
  fi
  say "写入 systemd 服务 $SERVICE"
  $SUDO tee "/etc/systemd/system/${SERVICE}.service" >/dev/null <<EOF
[Unit]
Description=JD exit SOCKS5 (loopback only)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_USER}
# -i 只监听 127.0.0.1，绝不写 0.0.0.0
ExecStart=/usr/bin/microsocks -i 127.0.0.1 -p ${PORT}
Restart=always
RestartSec=2
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6
RestrictNamespaces=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
StandardOutput=null
StandardError=journal
LogLevelMax=notice
LogRateLimitIntervalSec=30s
LogRateLimitBurst=20

[Install]
WantedBy=multi-user.target
EOF
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now "$SERVICE"
}

start_local_socks() {
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    install_socks_systemd
  else
    # macOS / 非 systemd：用已装好的 gost 或 microsocks 前台起一个本机代理
    if command -v gost >/dev/null 2>&1; then
      say "启动本机 gost SOCKS5 127.0.0.1:${PORT}"
      gost -L "socks5://127.0.0.1:${PORT}" >/dev/null 2>&1 &
      LOCAL_SOCKS_PID=$!
    elif command -v microsocks >/dev/null 2>&1; then
      say "启动本机 microsocks 127.0.0.1:${PORT}"
      microsocks -i 127.0.0.1 -p "${PORT}" >/dev/null 2>&1 &
      LOCAL_SOCKS_PID=$!
    else
      die "非 systemd 机器：先 brew install gost（或 microsocks），再重跑"
    fi
    sleep 0.5
  fi
  verify_local_listen
}

check_ssh() {
  command -v ssh >/dev/null 2>&1 || die "没有 ssh"
  say "用现有 SSH 密钥做一次免交互预检: ${SERVER}"
  if ! ssh_q "$SERVER" true; then
    die "SSH 预检失败：请确认 ${SERVER} 可达、现有密钥已在服务器的 authorized_keys 里"
  fi
}

stop_server_socks() {
  [ "$STOP_SERVER_SOCKS" -eq 1 ] || return 0
  say "暂停服务器回退 SOCKS（${SERVER_SOCKS_SERVICE}），给反向隧道让出 127.0.0.1:${PORT}"
  ssh_q "$SERVER" "sudo systemctl stop ${SERVER_SOCKS_SERVICE} 2>/dev/null || true" || true
  sleep 0.3
  local busy
  busy="$(ssh_q "$SERVER" "ss -lntn 2>/dev/null | grep -q ':${PORT} ' && echo BUSY || true" || true)"
  if [ "$busy" = "BUSY" ]; then
    die "服务器 ${PORT} 仍被占用；请先停掉占用进程，或加 --keep-server-socks 自行处理"
  fi
}

start_server_socks() {
  [ "$STOP_SERVER_SOCKS" -eq 1 ] || return 0
  ssh_q "$SERVER" "sudo systemctl start ${SERVER_SOCKS_SERVICE} 2>/dev/null || true" >/dev/null 2>&1 || true
}

cleanup() {
  [ "$CLEANED" -eq 1 ] && return 0
  CLEANED=1
  if [ -n "$LOCAL_SOCKS_PID" ]; then
    kill "$LOCAL_SOCKS_PID" >/dev/null 2>&1 || true
  fi
  start_server_socks
}

trap cleanup EXIT
trap 'exit 130' INT TERM

if [ "$NO_INSTALL" -eq 0 ]; then
  start_local_socks
fi

check_ssh

if [ "$INSTALL_ONLY" -eq 1 ]; then
  say "只安装完成；之后执行: $0 --no-install --server ${SERVER} --port ${PORT}"
  exit 0
fi

stop_server_socks

say "建立反向隧道 ${SERVER} 127.0.0.1:${PORT} -> 本机 127.0.0.1:${PORT}"
say "保持这个窗口运行；Ctrl-C 后服务器出口回到回退 SOCKS"
ssh -N -T \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o TCPKeepAlive=yes \
  -R "${PORT}:127.0.0.1:${PORT}" \
  "$SERVER"
