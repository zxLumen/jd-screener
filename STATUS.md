# STATUS · 对位（AI 智能筛选 JD）

- **版本**：0.2.4
- **状态**：已上线（2026-11-14 08:46 CST；应用 `3359281`；大陆出口隧道待老板家里机器启动）
- **线上**：https://duiwei.zxlumen.cn
- **定位**：岗位搜索 + 简历匹配器。规则分永远可用，AI 只做加分项。
- **仓库**：https://github.com/zxLumen/jd-screener（public）
- **镜像**：`ghcr.io/zxlumen/jd-screener:latest`（public，匿名 pull）；v0.2.4 digest `sha256:80f1d73e…`；回滚 tag `rollback-v023`（= 0.2.3 `sha256:40380bc9…`）、`rollback-v022-pre`（= 0.2.2 `a38d6a7f…`）

## 0.2.4 上线验收（2026-11-14 08:46 CST）

- 首页 **200 / 143ms / 13763B**；health `v0.2.4 / ai:true`；容器 **healthy / 33.47MiB / 96MiB / restarts=0**。
- 服务器 `jd-exit-socks.service`（microsocks）**active**，只监听 `127.0.0.1:1080`，强制认证、低权限 `jd-exit`；`ss` 无 `0.0.0.0`。
- `GET /api/admin/exit`（管理令牌）：无隧道（回退 SOCKS 认证拒绝）**offline / 5–11ms**（`configured:true, via:unix, error:offline`）；临时 no-auth SOCKS 模拟隧道 **online / 309–424ms / 103.205.240.62 / 中国 香港**，停掉后恢复 offline。2s 硬超时生效。
- `GET /api/search?q=Python后端&city=北京`：**200 / 12 条 / 候选 42 / 3.71s**；源诊断 liepin 40、linkedin 20、v2ex 10、eleduck 25、jobui empty、maimai no-match。与本地未配置出口同条件 **12/42 一致**（0 回归）。
- 出口桥：`jd-exit-bridge.service` **active**，`/run/jd-exit/bridge.sock` 0666，无新增 TCP 监听；模拟隧道时 `ss` 只见 `127.0.0.1:1080`。
- 10 源矩阵（经 127.0.0.1:1080 模拟隧道，出口仍香港）：**6 解锁 / 3 风控 / 1 未识别**；直连对照 **6 解锁 / 2 未识别 / 2 风控**。北京家宽值需家里隧道启动后复跑。
- 回滚入口：`deploy/duiwei.service`（compose 包装）已装，`systemctl restart duiwei` 实测可用。
- 测试：`node --test test/*.test.js` → **58 pass / 0 fail**（相对 0.2.3 新增 9 个：出口解析、SOCKS5、认证拒绝归 offline、矩阵分类、API offline/401、GET search 校验）。

## 0.2.3 上线验收（2026-11-14 07:38 CST）

- 首页 **200 / 117ms**；health `v0.2.3 / ai:true`；容器 **healthy / 32.81MiB / 96MiB**。
- 脉脉单源（线上，后端开发/北京）：**cand 11 / ret 11 / 1.36s（源 802ms）**，前三条 62/58/58 分；改前同条件 1 条。
- 6 源全量（AI 应用工程师/北京）：**1.90s / 候选 55 / 返回 12**；liepin 40、linkedin 20、v2ex 10、eleduck 25、maimai 18、jobui 10，全部无 error。
- 「来源登录 → 体检」线上可用：无令牌 **401**；无 cookie → `no-cookie`（ms 0）；假 cookie（本地）→ `risk` 194ms；配 `JD_BOSS_PROXY` → `proxy:true`。
- BOSS 仍未配置：`/api/sources` 把它列在 `unavailable`，文案「需登录 cookie + 大陆出口 IP（境外 IP 会 code 37）」。

## 0.2.3 改了什么

- **脉脉「匹配不到岗位」根因**：`maimai.cn/n/platform/job-list` 是**推荐流**，没有关键词搜索参数（`keyword/query/q/search` 全部无效，返回同一份 50 条）；旧实现只翻 2 页（100/4664）且用整串 `includes` 匹配，「后端开发」这种词在标题里几乎不存在 → 1 条或 0 条，0 条时直接报错。
- **改法**：翻到 6 页（约 300 条，1 页 520ms + 其余 110ms/页）；关键词切分（去「工程师/开发/专家/经理…」后缀，`后端开发→后端`）；英文按词边界（`go` 不再命中 `google`，`go→golang` 走别名）；命中 <3 条时补 6 条同方向岗位并标 `loose`，前端显示「脉脉推荐 · 未命中关键词」。
- **实测（本机直连，2026-11-13 23:20）**：`后端开发/北京` 1 → **11** 条；`前端/北京` 1 → **7**；`Python/北京` 1 → **9**；`Rust/北京` 报错 → **1 + 6 条推荐**；`大模型/北京` 8 条；单源耗时 110–760ms。
- **BOSS 根因（新发现）**：服务器出口在**香港**（`103.205.240.62` / AS206888 HanMing HK），BOSS 对境外 IP 一律 `code 37`；线上 `data/sources-auth.json` 里 BOSS cookie 为空、UA 还是 11-10 测试留下的 `Mozilla/5.0 Test` —— 所以不是"没接"，是**没配 + 出口会被拦**。
- **BOSS 改法**：新增「来源登录 → 体检」（`GET/POST /api/admin/sources/boss-check`，不改状态），直接区分 no-cookie / code 37 / 正常；新增 `JD_BOSS_PROXY`（HTTP/SOCKS 代理，curl `-x` 走代理）与 `JD_EGRESS_HINT`；code 37 文案点明「境外 IP 会判环境异常」。
- **测试**：`node --test test/*.test.js` → **49 pass / 0 fail**（新增 4 组：切词、词边界/别名、脉脉来源说明、BOSS 无 cookie 体检）。
- **验证**：本地 8897/8898 起服务；`/api/search` 脉脉单源返回 11 条、`/api/config` 文案已更新；`boss-check` 无令牌 401、无 cookie `no-cookie`、假 cookie `risk`（194ms）、走代理时 `proxy:true` 且错误可读。

## BOSS 待办（老板拍板：先贴 cookie 试 / 或开家里隧道）

0. **先补大陆出口**：家里 Linux 机器执行 `./deploy/exit-tunnel.sh`（microsocks 仅 127.0.0.1:1080 + `ssh -N -R 1080:127.0.0.1:1080`）；服务器 `GET /api/admin/exit` 看到 `online:true, beijing:true` 再做下面的 cookie 体检。
1. 浏览器登录 `www.zhipin.com` → F12 → 任意 zhipin.com 请求 → 复制整串 Cookie。
2. `https://duiwei.zxlumen.cn/` → 「来源登录」→ 填 `JD_ADMIN_TOKEN`（服务器 `docker/.env`）→ 粘贴 Cookie → UA 用当前浏览器 → **先点「体检」**。
3. 体检 `ok` 再保存；`risk` 说明出口被拦，把 `JD_BOSS_PROXY` 指到大陆 HTTP/SOCKS 代理后重启 `duiwei` 再体检。
4. 大陆代理预算 ¥24–40/月；机房 IP 仍可能被风控，住宅出口更稳。

## 0.2.2 已交付

- **来源登录**：网页「来源登录」可用管理令牌保存/清除来源 cookie；cookie 只落盘 `data/sources-auth.json`（0600），接口只回 `len=… · 尾4=…`。
- **BOSS 直聘**：带 cookie + 同浏览器 UA 搜索，解析 `jobList`，详情页补正文；`code 37` 明确报「cookie 失效或 UA/IP 不一致」。
- **脉脉**：公开岗位页，无需登录；解析 `__NEXT_DATA__` 列表 + JSON-LD 详情，按方向+城市筛，关键词本地过滤。
- **管理接口**：`GET/POST /api/admin/sources`，`X-Admin-Token` 鉴权，30 次/分钟/IP，错误令牌 401。
- **来源扩展**：新增职友集公开 RSS（公司/薪资/年限/学历/简介）；默认来源 6 个：猎聘、LinkedIn、V2EX、电鸭、脉脉、职友集。Remote OK 仍默认关；BOSS 配置 cookie 后自动出现。
- **明确 blocked**：智联招聘（Security Verification / `isVerification=1`）、前程无忧（需 user-token + Aliyun WAF）、拉勾（Aliyun WAF）；`publicSources` 标 `blocked:true` 并带 `reason`，默认不查。
- 0.2.0 的简历上传、两段式搜岗、链接导入、AI 精评、导出全部保留。

## 线上验收（2026-11-10 11:10）

- 首页 **200 / 11109B / 86ms**；health **v0.2.2 / ai:true**；sources **7 可用（默认 6）+ 3 blocked** + BOSS 未配置。
- 6 源搜索（北京 · AI 应用工程师）：冷缓存 **3.8s**、命中缓存 **0.42s**；候选 69 / 返回 12。猎聘 40 / LinkedIn 10 / V2EX 10 / 电鸭 25 / 脉脉 18 / 职友集 10，**6 个源都有结果**。
- 结果：**80 强投（脉脉）/ 80（猎聘）/ 78（脉脉）**；4 脉脉 + 7 猎聘 + 1 LinkedIn；薪资 `30-60K`、`45-75K·16薪`。
- 脉脉单源：**1.08s / 候选 18 / 返回 12**，缓存命中 **0.27s**；部分详情走 JSON-LD，失败标「按摘要算」。
- BOSS 假 cookie：**0.54s / 0 条 / `risk`**，文案 code 37；未带令牌 **401**；保存只回掩码；清除后恢复未配置。
- 容器 **healthy / restarts=0 / 27.28MiB / 96MiB**；Caddy 冒烟 **24/24 ok**。
- `/api/stats`：searches **15** / searchOk **13** / jds **168** / sourceHits 猎聘 68、脉脉 39、LinkedIn 19、职友集 12、电鸭 10。
- 来源栏：**已接 7 · 默认 6 · 未接 4**（BOSS + 智联/前程/拉勾），blocked 原因在 UI 可见，0 console error。
- 前端「来源登录」：令牌正确时显示「BOSS 未配置 / 脉脉已配置」，保存/清除正常，**0 console error**。
- 测试：`node --test test/*.test.js` → **45 pass / 0 fail**（新增职友集解析 + 3 个 blocked 用例等 ≥5 条）。
- 来源探测：智联/前程无忧/拉勾均拿不到列表（风控/WAF/登录），未假装接通；职友集 RSS 可用。

## 还需要老板做的一步（BOSS）

脉脉已经能直接搜；BOSS 还差你的登录 cookie：

1. 浏览器登录 `www.zhipin.com`，打开开发者工具 → Network → 任意 `zhipin.com` 请求 → 复制整串 Cookie。
2. 打开 `https://duiwei.zxlumen.cn/` → 「来源登录」→ 填管理令牌（服务器 `docker/.env` 的 `JD_ADMIN_TOKEN`）→ 粘贴 Cookie → 保存。
3. UA 默认 Chrome Windows；如果你用别的浏览器，填同一个 UA（`navigator.userAgent`）。
4. 保存后来源栏出现「BOSS直聘」，直接搜。若报 `code 37`，重新复制 cookie 或换与服务器同城的网络。

令牌不写在文档里；服务器上查看：

```bash
grep '^JD_ADMIN_TOKEN=' /home/ubuntu/zxLumen-Blog/docker/.env
```

## 发布记录

- 0.2.3：应用 `ba08844`；镜像 `sha256:40380bc9…`；脉脉切词+翻 6 页+推荐兜底；BOSS 体检接口与 `JD_BOSS_PROXY`；CI run `43528438440` success；回滚 tag `rollback-v022-pre`。
- 0.2.2：应用 `4b4dcdc`；镜像 `sha256:d1085d41…`；新增职友集 RSS + 三个 blocked 来源；BOSS/管理令牌逻辑未改。
- 0.2.1：应用 `a732785`；镜像 `sha256:4a3de8ac…`；容器重建，新增 `JD_ADMIN_TOKEN`（`.env` 已备份 `.env.bak-before-duiwei-auth-*`）。
- 0.2.0：应用 `420328d`；镜像 `sha256:69bad763…`；新增搜索 + 简历上传。
- 0.1.0：应用 `d8adcc4`，主站 `8738de6`；DNS `duiwei → 103.205.240.62`（RecordId `2447180381`）。
- AI 令牌：网关应用 `duiwei`，`chat-default` / `deepseek-v4.1-flash`，日限 300k tokens。
- 本地 rollback tag：`rollback-20261110-1000`（v0.1）、`rollback-v02-fee0`、`rollback-v02-6b22`、`rollback-v02-8c39`、`rollback-v021-pre`、`rollback-v021-5271`、`rollback-v021-final`、`rollback-v022-cb46`。

## 明确不做 / 还没接

- **BOSS 仍可能 code 37**：cookie 与 UA/IP 绑定，换网络/过期就要重新复制；不绕验证码、不自动投递。
- 脉脉公开页只覆盖公开岗位，不等于全站/会员搜索。
- 不做账号体系、云端同步、投递跟踪。
- 不做向量语义匹配；技能命中是词典 + 词边界。
- 不折算股票/期权/签字费总包；薪资只按月薪算。
- 英文 JD 城市/学历解析弱，主要靠技能 + 来源地点兜底。

## 回滚

1. 主站应用栏移除「对位」入口，或把 compose 的 `JD_TAG` 指回 `rollback-v021-pre`、`rollback-v021-5271`、`rollback-v021-final`、`rollback-v022-cb46` / `rollback-v02-8c39`。
2. `docker compose up -d duiwei`；必要时 `docker compose stop duiwei`。
3. 无数据库、无迁移；`duiwei-data` 卷只存匿名计数与来源 cookie（0600）。
