#!/usr/bin/env bash
# 把对位的出口切到「家里这台机器」的宽带。
#
# 在【家里机器】上执行（Linux + systemd）：
#   ./deploy/exit-tunnel.sh
#
# 它会：
#   1. 安装 microsocks（只监听 127.0.0.1:1080，专用 jd-exit 用户，systemd 托管）
#   2. 用你现有的 ~/.ssh 配置/authorized_keys 连服务器
#   3. 执行 ssh -N -R 1080:127.0.0.1:1080，服务器 127.0.0.1:1080 就是家里宽带的出口
#
# 不会生成、读取或回显任何私钥；不写 0.0.0.0；日志只进 journal。
set -euo pipefail

SERVER="${JD_EXIT_SERVER:-ubuntu@duiwei.zxlumen.cn}"
PORT="${JD_EXIT_PORT:-1080}"
SERVICE="jd-exit-socks"
RUN_USER="jd-exit"
INSTALL_ONLY=0
NO_INSTALL=0

usage() {
  cat <<'EOF'
用法: deploy/exit-tunnel.sh [--server user@host] [--port 1080] [--install-only] [--no-install]

  --server user@host  服务器 SSH 地址（默认 ubuntu@duiwei.zxlumen.cn）
  --port 1080         家里 SOCKS5 端口，也是服务器反向隧道端口
  --install-only      只装 systemd 服务，不建立 SSH 隧道
  --no-install        跳过安装，直接建立隧道（服务已装好时用）
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="${2:?}"; shift 2 ;;
    --port) PORT="${2:?}"; shift 2 ;;
    --install-only) INSTALL_ONLY=1; shift ;;
    --no-install) NO_INSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage; exit 2 ;;
  esac
done

say() { printf '[exit] %s\n' "$*"; }
die() { printf '[exit] 失败: %s\n' "$*" >&2; exit 1; }

need_root() {
  if [ "$(id -u)" -eq 0 ]; then
    SUDO=""
  elif command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    die "安装需要 root（或用 sudo 运行）"
  fi
}

install_socks() {
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

  # 硬校验：只允许 127.0.0.1:PORT，出现 0.0.0.0 / :: 就停服务
  local listen
  listen="$(ss -lntp 2>/dev/null | awk -v p=":${PORT}" '$4 ~ p {print $4}' || true)"
  if [ -z "$listen" ]; then
    die "microsocks 没起来（ss 看不到 :${PORT}）"
  fi
  if printf '%s\n' "$listen" | grep -Eq '^(0\.0\.0\.0|\*|\[::\]|::):'; then
    $SUDO systemctl stop "$SERVICE" || true
    die "microsocks 监听了公网地址（${listen}），已停服务"
  fi
  if ! printf '%s\n' "$listen" | grep -q '^127\.0\.0\.1:'; then
    $SUDO systemctl stop "$SERVICE" || true
    die "microsocks 没有绑定 127.0.0.1（${listen}），已停服务"
  fi
  say "SOCKS5 已就绪: $(printf '%s' "$listen" | tr '\n' ' ')"
}

check_ssh() {
  command -v ssh >/dev/null 2>&1 || die "没有 ssh"
  say "用现有 SSH 密钥做一次免交互预检: ${SERVER}"
  if ! ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new "$SERVER" true; then
    die "SSH 预检失败：请确认 ${SERVER} 可达、现有密钥已在服务器的 authorized_keys 里"
  fi
}

tunnel() {
  say "建立反向隧道 ${SERVER} 127.0.0.1:${PORT} -> 本机 127.0.0.1:${PORT}"
  say "保持这个窗口运行；Ctrl-C 后服务器出口回到原网络"
  exec ssh -N -T \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -o TCPKeepAlive=yes \
    -R "${PORT}:127.0.0.1:${PORT}" \
    "$SERVER"
}

if [ "$NO_INSTALL" -eq 0 ]; then
  install_socks
fi

check_ssh

if [ "$INSTALL_ONLY" -eq 1 ]; then
  say "只安装完成；之后执行: $0 --no-install --server ${SERVER} --port ${PORT}"
  exit 0
fi

tunnel
