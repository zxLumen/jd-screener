# STATUS · 对位（AI 智能筛选 JD）

- **版本**：0.1.0
- **状态**：已上线（2026-11-10）
- **线上**：https://duiwei.zxlumen.cn
- **定位**：给求职者的 JD 批量筛选器。规则分永远可用，AI 只做加分项。
- **仓库**：https://github.com/zxLumen/jd-screener（public）
- **镜像**：`ghcr.io/zxlumen/jd-screener:latest`（public，服务器匿名 pull）

## 已交付

- 单页应用：画像 → 批量 JD（最多 8 条）→ 排序结果 → Markdown/CSV 导出。
- 规则引擎：年限、学历、城市、薪资四项硬门槛 + 147 项技能词典 + 11 类风险信号。
- AI 层：主站网关、900 tokens、22s 超时、2h 缓存、失败自动回落规则分。
- 隐私：画像/JD 只在 `localStorage`，服务端只存匿名计数。
- 部署：主站 compose + Caddy 子域 + 应用栏 panel 入口 + GHCR Actions。

## 线上验收（2026-11-10）

- 首页：`GET /` **200 / 7925B / 106ms**；`/api/health` **200 / 83ms / ai:true**。
- 全站冒烟：`caddy-smoke.sh` **24 个 host 全 ok，app=0 / route=0**（含 duiwei 200）。
- 容器：`docker-duiwei-1` **healthy、restarts=0**，镜像 digest `sha256:96f15a5e…`。
- 测试：`node --test test/*.test.js` → **23 pass / 0 fail**。
- 规则路径（3 条示例）：**94 强投 / 75 可投 / 25 不建议**。
- AI 路径（同 3 条）：**89 / 60 / 30**，3 条全成功、缓存 3 条；单条新 JD 真实调用 **4.8s / aiScore 42**。
- AI 网关：duiwei 令牌今日用量 **5145 tokens**，7 成功 / 0 失败；日上限 300k。
- 应用栏：18 个应用，panel 打开 `https://duiwei.zxlumen.cn/` 正常，iframe 内显示「AI 已接」。

## 发布记录

- 应用仓库：`d8adcc4`（CI 构建并推 GHCR；含 robots.txt）。
- 主站：`8738de6`（compose + `duiwei.caddy` + `deploy.sh` pull + 默认应用 + `.env.example`）。
- DNS：DNSPod A 记录 `duiwei → 103.205.240.62`，RecordId `2447180381`。
- AI 令牌：网关应用 `duiwei`，绑定 `chat-default` / `deepseek-v4.1-flash`，日限 300k tokens。
- 服务器 `.env`：新增 `JD_AI_TOKEN`（备份 `.env.bak-before-duiwei-*`）。

## 明确不做 / 还没接

- 不抓招聘网站、不自动投递；JD 手动粘贴。
- 不解析 PDF/Word 简历；不做账号体系、云端同步、投递跟踪。
- 不做向量语义匹配；技能命中是词典 + 词边界。
- 不折算股票/期权/签字费总包；薪资只按月薪算。

## 回滚

1. 主站应用栏移除「对位」入口。
2. `docker compose stop duiwei`；删除 `docker/caddy/sites/duiwei.caddy` 后 `caddy reload`。
3. 可选：DNSPod 删除 `duiwei` A 记录；admin「AI 密钥」禁用 `duiwei` 令牌。
4. 无数据库、无迁移；`duiwei-data` 卷只存匿名计数。
