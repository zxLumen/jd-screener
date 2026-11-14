# 出口（大陆家宽）部署说明

目标：把对位的出口从香港机房切到北京家宽，让 BOSS/智联/前程/拉勾不再按「境外 IP」风控；没切时搜索行为不变。

## 1. 家里机器（北京家宽）

```bash
# Ubuntu/Debian + systemd；用现有 ~/.ssh 密钥，不生成/不回显私钥
./deploy/exit-tunnel.sh
```

它会装 microsocks（`jd-exit` 低权限用户，仅 `127.0.0.1:1080`，systemd 托管、日志只进 journal），
然后用现有密钥执行：

```bash
ssh -N -R 1080:127.0.0.1:1080 ubuntu@duiwei.zxlumen.cn
```

保持窗口/终端复用器（tmux）运行即可。Ctrl-C 或断线后服务器出口回到原网络。

## 2. 服务器（回退 SOCKS + Docker 容器访问 loopback 的桥）

服务器先装一个**回退 SOCKS**，只监听 `127.0.0.1:1080`，并强制用户名密码：
应用探针不带凭据，所以无隧道时 `/api/admin/exit` 会得到 `offline`；家里隧道起来前，
`deploy/exit-tunnel.sh` 会先暂停这个服务，把 1080 让给 sshd 的反向隧道，退出时再恢复。

```bash
sudo apt-get install -y microsocks
sudo useradd --system --no-create-home --shell /usr/sbin/nologin jd-exit 2>/dev/null || true
sudo install -d -m 0750 /etc/jd-exit

# 只生成一次；密码存 root 0600，不打印
if [ ! -f /etc/jd-exit/socks.env ]; then
  printf 'JD_SOCKS_USER=jdexit_%s\nJD_SOCKS_PASS=%s\n' "$(openssl rand -hex 4)" "$(openssl rand -hex 20)" |
    sudo tee /etc/jd-exit/socks.env >/dev/null
  sudo chmod 600 /etc/jd-exit/socks.env
fi

# 写 jd-exit-socks.service（ExecStart 只绑 127.0.0.1；模板见 deploy/jd-exit-socks.service）
sudo install -m 0644 deploy/jd-exit-socks.service /etc/systemd/system/jd-exit-socks.service
sudo systemctl daemon-reload && sudo systemctl enable --now jd-exit-socks
ss -lntp | grep ':1080'   # 必须只有 127.0.0.1:1080
```

SSH 反向隧道只监听宿主机 `127.0.0.1:1080`；容器在 bridge 网络看不到宿主机 loopback。
用一个只读 unix socket 桥接，不新增任何 TCP 监听：

```bash
sudo install -d -o jd-exit -g jd-exit /opt/jd-exit
sudo install -m 0755 deploy/exit-bridge.mjs /opt/jd-exit/exit-bridge.mjs
sudo install -m 0644 deploy/jd-exit-bridge.service /etc/systemd/system/jd-exit-bridge.service
sudo systemctl daemon-reload
sudo systemctl enable --now jd-exit-bridge
```

宿主机 `compose` 的 duiwei 服务挂载 `/run/jd-exit:/run/jd-exit:ro`，并设置：

```yaml
environment:
  JD_EXIT_PROXY: unix:/run/jd-exit/bridge.sock
```

没配置 `JD_EXIT_PROXY` 时 `/api/admin/exit` 毫秒级返回 `configured:false`，搜索完全走 0.2.3 原逻辑。

## 3. 验收

```bash
# 家里机器：只应看到 127.0.0.1:1080
ss -lntp | grep ':1080'

# 服务器：管理令牌在 docker/.env 的 JD_ADMIN_TOKEN
curl -s -H "X-Admin-Token: $JD_ADMIN_TOKEN" https://duiwei.zxlumen.cn/api/admin/exit | jq
# 期望：online=true, city/region=北京, beijing=true, latencyMs < 2000

# 10 源解锁矩阵（在服务器仓库目录；有出口时自动走出口）
npm run exit:doctor
# 对照组
npm run exit:doctor -- --direct
```

## 4. 回滚

```bash
# 家里机器 Ctrl-C 停隧道，或：
sudo systemctl stop jd-exit-socks

# 服务器只回滚应用（出口桥可保留，不影响搜索）：
cd /path/to/jd-screener && git revert <commit> && git push
# 然后拉旧镜像重启 duiwei（按实际编排）：
docker compose -f /home/ubuntu/zxLumen-Blog/docker/docker-compose.yml up -d duiwei
```

## 安全边界

- SOCKS5 只在**家里机器** bind `127.0.0.1:1080`，不监听 0.0.0.0；服务器侧反向隧道默认也只绑 loopback（`GatewayPorts no`）。
- 服务器 unix socket 权限 `0666`，只存在于 `/run/jd-exit`，不暴露 TCP 端口；能访问宿主机的本地用户本就能访问 1080。
- 脚本不生成、不读取、不回显私钥；只用现有 `~/.ssh` 配置和服务器 `authorized_keys`。
- 管理接口需要 `X-Admin-Token`；出口探测只打 `myip.ipip.net` / `ipinfo.io`，不携带 cookie。
