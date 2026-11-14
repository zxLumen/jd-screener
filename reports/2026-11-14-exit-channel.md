# 2026-11-14 对位出口通道（大陆家宽）交付报告

> 2026-11-14 08:47 更新：第 2 轮已在服务器加 `jd-exit-socks`（强制认证的回退 SOCKS，仅 `127.0.0.1:1080`），并补 `duiwei.service` 包装；以 `reports/tasks/work/2026-11-14-task-0QVM0kUYBoqg-对位大陆出口通道.md` 为准。下文“SOCKS5 放在家里机器”的取舍已被“服务器回退 + 隧道时让出 1080”方案取代。

## 结论

**已交付并上线 v0.2.4，出口探测链路可用；北京家宽的那一跳还没接上，所以「归属地=北京」尚未实测。**

- 应用：`ac9e3a9`，镜像 `sha256:2e90c113…`，线上 `https://duiwei.zxlumen.cn`，容器 healthy / 33.47MiB / restarts=0。
- `GET /api/admin/exit`（需 `X-Admin-Token`，2s 硬超时）：
  - 无隧道：`{"configured":true,"online":false,"via":"unix","latencyMs":19,"error":"offline"}`，HTTP 200 / 19ms。
  - 临时在服务器 loopback 起一个 SOCKS5 模拟隧道：`online:true, ip:103.205.240.62, location:中国 香港 香港, latencyMs:141`；停掉后 6ms 回到 offline。
  - 未配置 `JD_EXIT_PROXY` 时毫秒级返回 `configured:false`，不碰网络。
- 出口桥：`jd-exit-bridge.service` active，`/run/jd-exit/bridge.sock`（0666，只在本机 `/run`），不新增任何 TCP 监听。`ss -lntp` 无隧道时没有 1080；模拟隧道时只见 `127.0.0.1:1080`，没有 0.0.0.0。
- 搜索回归：线上 `GET /api/search?q=Python后端&city=北京` → **200 / 12 条 / 候选 42 / 3.35s**；本地未配置出口同条件 **12 条 / 候选 42**，源诊断完全一致（liepin 40、linkedin 20、v2ex 10、eleduck 25、jobui empty、maimai no-match）。
- 测试：`node --test test/*.test.js` → **57 pass / 0 fail**（新增 8 个：出口解析、SOCKS5 握手、矩阵分类、API offline/401、GET search 校验）。
- 10 源矩阵（经本机 SOCKS5 出口，**出口仍是香港**，不是北京）：

| # | 源 | status | 耗时 | 判定 | 实测风控/特征 |
| --- | --- | ---: | ---: | --- | --- |
| 1 | 猎聘 | 200 | 1205ms | ✅ 解锁 | 正常返回岗位特征 |
| 2 | LinkedIn | 200 | 533ms | ✅ 解锁 | 正常返回岗位特征 |
| 3 | V2EX 酷工作 | 200 | 121ms | ✅ 解锁 | 正常返回岗位特征 |
| 4 | 电鸭社区 | 200 | 519ms | ✅ 解锁 | 正常返回岗位特征 |
| 5 | 职友集 | 200 | 159ms | ✅ 解锁 | 正常返回岗位特征 |
| 6 | 脉脉 | 200 | 552ms | ✅ 解锁 | 正常返回岗位特征 |
| 7 | 智联招聘 | 200 | 73ms | ⛔ 风控 | `Security Verification` |
| 8 | 前程无忧 | 200 | 230ms | ❔ 未识别 | 200 JS shell（无岗位数据） |
| 9 | 拉勾 | 200 | 279ms | ⛔ 风控 | 阿里云 WAF / 滑块 |
| 10 | BOSS直聘 | 200 | 275ms | ⛔ 风控 | `code 35` 您的 IP 地址存在异常行为 |

  **矩阵结论：香港出口 6 解锁 / 3 风控 / 1 未识别。** 直连对照为 6 解锁 / 2 未识别 / 2 风控（智联直连时偶发拿到 200 热门页，无岗位数据，已归为「未识别」而不是「解锁」）。智联、拉勾、BOSS 的拦截特征与任务背景一致；前程无忧只给 JS 壳，没有 SSR 岗位。北京家宽是否能把 7/8/9/10 解锁，必须等家里隧道起来后复跑 `npm run exit:doctor`，当前不能替它下结论。

**回滚**

```bash
# 代码回滚（会触发 CI 重新构建 latest）
cd /home/ubuntu/Projects/jd-screener && git revert ac9e3a9 && git push
# 线上立即回 0.2.3（不重建）
cd /home/ubuntu/zxLumen-Blog/docker && JD_TAG=rollback-v023 docker compose up -d duiwei
# 恢复 latest：把 JD_TAG 去掉后再 up -d
```

> 实际部署是 Docker Compose，不是 systemd；服务器上没有 `duiwei.service`，所以任务里写的 `systemctl restart duiwei` 在这台机器上不存在。等价的“重启应用”命令是上面的 `docker compose up -d duiwei`。

## 关键取舍

1. **SOCKS5 放在家里机器，不在服务器。** 任务里 `ssh -N -R 1080:127.0.0.1:1080` 和“服务器也装一个 127.0.0.1:1080 的 SOCKS5”会抢同一个端口；反向隧道本身就会在服务器 loopback 上开 1080。因此 `deploy/exit-tunnel.sh` 是给**家里 Linux 机器**用的：microsocks 只绑家里 `127.0.0.1:1080`，SSH 把它映射到服务器 `127.0.0.1:1080`。服务器侧不常驻 SOCKS5，只保留 sshd 的隧道监听。
2. **Docker 容器用 unix socket 桥，不改 host 网络、不监听 0.0.0.0。** 容器在 bridge 网络看不到宿主机 loopback；把 duiwei 改成 `network_mode: host` 会动 Caddy 反代，风险大。改用 `jd-exit-bridge.service` 把 `/run/jd-exit/bridge.sock` 转到 `127.0.0.1:1080`，容器只读挂载这个目录。代价是多一个低权限 systemd 服务、socket 0666（本机用户本来就能访问 1080，未扩大攻击面）。
3. **搜索主链路不经过出口，只有 BOSS 自动优先走出口。** 6 个公开源在香港本来就能用，强行全量绕出口会放大延迟和故障面；只有 BOSS 在没配 `JD_BOSS_PROXY` 时自动用 `JD_EXIT_PROXY`。这样未配置出口时 6 源搜索与 0.2.3 完全一致，配置后也只影响 BOSS。
4. **2s 硬超时 + API 不走缓存。** `GET /api/admin/exit` 每次实时探测（管理接口限 30 次/分），隧道掉线后下一次调用立刻返回 offline；未配置时 0ms。避免“缓存 online 15s”造成假在线。
5. **矩阵判定收紧，不把 200 当解锁。** 智联的热门落地页、前程无忧的 Vue 壳都会返回 200，但没有岗位卡片，统一标「未识别」；BOSS `code 35`（IP 异常）和 `code 37`（环境异常）都算风控。这样矩阵不会虚报解锁数。
6. **为验收补了 `GET /api/search?q=…&city=…`。** 原 API 只有 POST；GET 只是查询串兼容层（默认 6 个公开源、最小画像），POST 行为和参数校验完全没改。

## 待你拍板

1. **北京出口要你家里机器跑一条命令**（¥0，推荐）：在家里 Linux 机器上 `./deploy/exit-tunnel.sh`，保持窗口/tmux 运行；然后在服务器看 `GET /api/admin/exit` 是否 `online:true, beijing:true`，再跑 `npm run exit:doctor` 复测 10 源矩阵。没有这一步，报告里的矩阵只能是“香港出口基线”，不能声称北京已解锁。
2. **或者授权买大陆住宅/机房代理**（约 ¥24–40/月，备选）：把 `JD_EXIT_PROXY` 指向代理地址；机房 IP 仍可能被 BOSS 风控，住宅更稳。
3. **BOSS cookie 仍未配置**（`len=0`）：北京出口通了之后，还需要你在浏览器登录 `www.zhipin.com` 复制整串 Cookie，在「来源登录 → 体检」里先测再保存；否则矩阵里 BOSS 只能停在第 10 行。
4. **要不要补一个 `duiwei.service` 包装层**：现在回滚/重启用 `docker compose up -d duiwei`；如果你希望任务里写的 `systemctl restart duiwei` 真的可用，我可以加一个 oneshot 包装 unit，但这属于运维口味，不是出口功能必需。
