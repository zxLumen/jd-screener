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

## 2. 服务器（Docker 容器访问 loopback 的桥）

SSH 反向隧道只监听宿主机 `127.0.0.1:1080`；容器在 bridge 网络看不到宿主机 loopback。
用一个只读 unix socket 桥接，不新增任何 TCP 监听：

```bash
sudo install -d -o jd-exit -g jd-exit /opt/jd-exit
sudo install -m 0755 deploy/exit-bridge.mjs /opt/jd-exit/exit-bridge.mjs
sudo install -m 0644 deploy/jd-exit-bridge.service /etc/systemd/system/jd-exit-bridge.service
# 没有 jd-exit 用户时：
sudo useradd --system --no-create-home --shell /usr/sbin/nologin jd-exit
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
