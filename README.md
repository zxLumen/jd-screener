# 对位 · AI 智能筛选 JD

给求职者用的 JD 批量筛选器：把一堆 JD 粘进来，按你的画像算匹配分，先告诉你**该投哪几条**，再告诉你**简历缺什么、面试问什么**。

- 零依赖：Node 原生 `http` + 原生 ES module 前端，没有 `npm install`、没有构建步骤。
- 规则优先：年限/学历/城市/薪资/技能/风险信号全部确定性计算，**不配 AI 也能用**。
- AI 只加分：经主站 AI 网关调用，规则分仍占 55%，单次 900 tokens、22s 超时、2 小时缓存。
- 隐私默认关死：画像与 JD 只存浏览器 `localStorage`；服务端不存正文、不记 IP，只累计匿名计数。

线上地址：**https://duiwei.zxlumen.cn**（2026-11-10 已发布，主站应用栏「对位」panel 打开）。

## 快速开始

```bash
node server.js          # :8790，零依赖
# 或
PORT=8790 node server.js
```

打开 `http://localhost:8790/`。不配 AI 令牌时自动进入**规则模式**，秒出结果。

```bash
node --test test/*.test.js   # 23 个测试
```

## 怎么用

1. 填画像：目标岗位、工作年限、学历、期望城市、期望月薪；可粘贴简历摘要自动抽技能。
2. 粘 JD：多条用一行 `---` 分隔，一次最多 **8 条**，单条最多 20000 字。
3. 点「开始筛选」：规则层先算硬门槛与技能覆盖；勾选「用 AI 深评」再调模型。
4. 看结果：按分数排序，可筛「强投 / 可投 / 观望 / 不建议」或「只看硬门槛通过」。
5. 导出：复制 Markdown 或下载 CSV（带 BOM，Excel 直接打开）。

结果里每条 JD 包含：

- **匹配分 0–100** + 结论（强投 / 可投 / 观望 / 不建议）
- **四项硬门槛**：年限、学历、城市、薪资（pass / warn / fail / unknown）
- **技能命中**：命中、缺失、必须项缺失
- **风险信号**：外包/驻场、996/大小周、年龄限制、薪资面议、职责过杂、长试用期等 11 类
- **AI 深评**（可选）：3 条匹配理由、简历关键词、面试追问、额外风险

## 分数怎么算

规则分（永远可用）：

| 维度 | 权重 | 说明 |
| --- | --- | --- |
| 技能覆盖 | 45% | JD 技能按出现位置加权：标题 3 / 任职要求 2 / 其他 1 |
| 工作年限 | 20% | 低于下限直接 fail；高于上限 3 年以上 warn |
| 期望薪资 | 15% | 区间有交集 pass；低于期望 15% 以上 fail |
| 学历 | 10% | 低于要求 fail；高于要求 1 级以上 warn |
| 城市 | 10% | 同城或远程 pass；异地 warn |

再扣风险信号（11 类，合计最多扣 30 分）。年限或学历硬门槛不过，规则分封顶 **45**。

有 AI 时：`最终分 = 规则分 × 55% + AI 分 × 45%`，硬门槛不过最终分封顶 **50**。

结论阈值：`≥80 强投 / ≥65 可投 / ≥50 观望 / <50 不建议`。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 + AI 是否配置 |
| GET | `/api/config` | 版本、AI 状态、限流、上限 |
| GET | `/api/stats` | 匿名计数（筛选数 / AI 成功失败 / 结论分布 / tokens） |
| POST | `/api/parse-profile` | 解析画像，返回识别到的技能 |
| POST | `/api/parse-jd` | 解析单条 JD，不调模型 |
| POST | `/api/screen-one` | 筛选单条 JD（前端并发 3 条） |
| POST | `/api/screen` | 批量筛选，最多 8 条，服务端并发 3 |

请求示例：

```bash
curl -s http://localhost:8790/api/screen-one \
  -H 'Content-Type: application/json' \
  -d '{
    "profile": {"title":"AI 应用工程师","years":"5","education":"本科","city":"北京","salaryMin":"25","salaryMax":"40","resumeText":"Python FastAPI Kubernetes RAG LangChain"},
    "jd": "AI 应用工程师\n某公司 · 北京 · 25-40K\n\n任职要求\n1. 本科及以上，3-5 年经验；\n2. 熟悉 Python、RAG、Kubernetes。",
    "useAI": false
  }'
```

限流：AI 调用 **20 次/小时/IP**（缓存命中不占额度）、全站 **500 次/天**（北京时间日切），总请求 **240 次/小时/IP**。可用 `JD_AI_RATE` / `JD_AI_DAILY` / `JD_TOTAL_RATE` 调整。超限降级为规则分，不报错。

## AI 配置

默认走主站 AI 网关（OpenAI 兼容）：

```bash
ZX_AI_GATEWAY_URL=http://app:3000/api/ai/v1   # 容器内网；本地默认 http://localhost:3000/api/ai/v1
ZX_AI_APP_TOKEN=zxai_xxx                       # 主站 admin「AI 密钥」页签发
JD_MODEL=                                      # 可选；留空由网关按令牌/密钥决定
```

- 单次请求：`temperature=0.2`、`max_tokens=900`、`response_format=json_object`。
- 缓存键 = 画像 + JD 原文的 SHA-256；TTL 2 小时，最多 400 条。
- 网关 401/429/502、超时、JSON 解析失败都会自动回落到规则分，前端会标注原因。

## 隐私

- 画像、JD、上次结果只存在浏览器 `localStorage`；页脚可一键清除。
- 服务端不写画像/JD 正文，不记录请求 IP；`data/stats.json` 只有计数、结论分布和 token 数。
- **开启 AI 时**，画像摘要（含简历摘要）与 JD 原文会经主站网关转发给模型供应商；不开启 AI 则不出本机。
- 反代层（主站 Caddy）的访问日志仍会按主站统一策略记录请求 IP，这不在本应用控制范围内。

## 部署（2026-11-10 已发布）

发布走主站既有流程：应用仓库 CI 推 GHCR → 主站 compose/Caddy 由 CI 同步 → 服务器只 pull。

| 项 | 值 |
| --- | --- |
| 应用仓库 | `https://github.com/zxLumen/jd-screener`（public） |
| 镜像 | `ghcr.io/zxlumen/jd-screener:latest`（public，匿名 pull） |
| 应用提交 | `d8adcc4` |
| 主站提交 | `8738de6` |
| 线上路由 | `duiwei.{$DOMAIN} → duiwei:8790` |
| DNS | DNSPod A `duiwei → 103.205.240.62`（RecordId `2447180381`） |
| AI 令牌 | 网关应用 `duiwei`，`chat-default` / `deepseek-v4.1-flash`，日限 300k tokens |
| 应用栏 | 18 个应用，「对位」`openIn=panel`，图标 `/apps/duiwei.png` |

服务器侧改动（已提交主站仓库）：

- `docker/docker-compose.yml`：新增 `duiwei` 服务 + `duiwei-data` 卷。
- `docker/caddy/sites/duiwei.caddy`：子域反代。
- `docker/deploy.sh`：部署前 pull `duiwei` 镜像。
- `docker/.env`：新增 `JD_AI_TOKEN`（服务器本地，已备份）。
- `apps/next-home/src/lib/app-config.ts`：默认应用加入「对位」。

验收命令：

```bash
curl -sI https://duiwei.zxlumen.cn/ | head -1                 # 200
curl -s https://duiwei.zxlumen.cn/api/health                  # {"ok":true,...,"ai":true}
curl -s https://duiwei.zxlumen.cn/api/config | head -c 300    # ai:true, maxJDs:8
```

回滚：应用栏移除入口 → `docker compose stop duiwei` → 删 `duiwei.caddy` 后 `caddy reload` → 可选删 DNS 记录/禁用令牌。无数据库、无迁移。

## 文件结构

```
server.js              Node 原生 http：静态页 + /api + 限流 + 匿名统计
lib/parse.js           JD/简历解析：年限、薪资、学历、城市、风险
lib/skills.js          技能词典（147 项，中英别名）
lib/score.js           确定性打分 + 硬门槛 + AI 混合
lib/llm.js             AI 网关调用、JSON 容错、缓存、并发去重
lib/text.js            归一化 / 词边界匹配 / 稳定签名
web/index.html         单页界面
web/app.js             原生 ES module 前端（画像 / JD 列表 / 结果 / 导出）
web/styles.css         暗色主题，桌面 + 移动 + iframe 嵌入
web/samples.json       3 条示例 JD
test/                  23 个测试（解析 / 打分 / 网关 / API）
deploy/                compose 服务片段、Caddy 路由、应用栏图标
```

## 还没接的（别当成有）

- **不抓招聘网站**：不登录 BOSS/拉勾/猎聘，不做自动投递；JD 靠手动粘贴。
- **不解析 PDF/Word 简历**：只接受粘贴文本；没有 OCR、没有附件上传。
- **没有账号体系**：不做云端保存、多设备同步、投递进度跟踪。
- **没有向量语义匹配**：技能命中是词典 + 词边界，同义词覆盖有限；语义判断只靠 AI 提示词。
- **没有公司评价数据**：不接脉脉/看准网，风险信号只从 JD 文本里读。
- **薪资只算月薪**：股票/期权/签字费/年终奖不折算总包；`·15薪` 只展示，不参与打分。
- **CI 只做镜像**：GitHub Actions 只 build/push GHCR，没有自动跑本仓库测试；发布前本地跑 `node --test`。

## 已验证

- `node --test test/*.test.js`：**23 pass / 0 fail**（解析与打分 13、网关 3、API 7，其中 API 用真实子进程起服务）。
- 线上 `GET /`：**200 / 7925B / 106ms**；`/api/health` **200 / 83ms / ai:true**。
- 全站 Caddy 冒烟：**24 个 host 全 ok，app=0 / route=0**（含 `duiwei` 200）。
- 规则路径 3 条示例：**94 强投 / 75 可投 / 25 不建议**；AI 路径：**89 / 60 / 30**（3 条全成功，缓存 3 条）。
- 单条新 JD 真实 AI：**4.8s / aiScore 42**（硕士门槛 fail，结论「不建议」）。
- 网关用量：duiwei 今日 **5145 tokens**，7 成功 / 0 失败；容器 healthy、restarts=0。
- 应用栏 panel：iframe 加载 `https://duiwei.zxlumen.cn/`，标题与「AI 已接」正常。

## 版本

`0.1.0` · 2026-11-10 · 已发布。见 `STATUS.md`。
