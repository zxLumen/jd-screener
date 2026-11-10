# 对位 · AI 智能筛选 JD

给求职者用的岗位搜索 + 匹配器：**不用一条条粘 JD**。从猎聘、LinkedIn、V2EX、电鸭等公开来源搜岗位，上传简历自动解析，按硬门槛、技能命中、风险信号算匹配分，再告诉你**该投哪几条、简历缺什么、面试问什么**。

- 零构建：Node 原生 `http` + 原生 ES module 前端，没有 `npm install`，没有打包步骤。
- 规则优先：年限/学历/城市/薪资/技能/风险信号全部确定性计算，**不配 AI 也能用**。
- AI 只加分：经主站 AI 网关调用，规则分仍占 55%，单次 900 tokens、22s 超时、2 小时缓存。
- 隐私默认关死：简历、画像与 JD 只存浏览器 `localStorage`；上传文件在内存解析后即丢弃，服务端不存正文、不记 IP。

线上地址：**https://duiwei.zxlumen.cn**（2026-11-10 上线，主站应用栏「对位」panel）。

## 快速开始

```bash
node server.js          # :8790
# 或
PORT=8790 node server.js
```

打开 `http://localhost:8790/`。不配 AI 令牌时自动进入**规则模式**，秒出结果。

```bash
node --test test/*.test.js   # 35 个测试
```

> PDF 解析优先用 `pdftotext`（容器内已装 poppler-utils），没有时退回内置抽取；DOCX 用内置 zip 解压，不依赖 npm 包。猎聘用 `curl` 抓取（见下方「来源」）。

## 怎么用

1. **上传简历**：PDF / DOCX / TXT / MD / HTML，≤5MB。自动抽目标岗位、年限、学历、城市、技能，填进左侧画像；文本可手改。
2. **搜岗位**：填关键词 + 城市，勾选来源。服务端并行抓列表，先按标题/卡片信息粗排，再给入围岗位补详情正文，最后用完整 JD 算分。
3. **看结果**：按匹配分排序；可筛「强投 / 可投 / 观望 / 不建议」或「只看硬门槛通过」。每条带原帖链接，点「AI 精评」可单独调模型。
4. **手动粘贴**：BOSS/脉脉等没有公开接口的来源，复制 JD 进来；也支持粘贴一条公开 JD 链接（猎聘、LinkedIn、公司招聘页）自动抓正文。
5. **导出**：复制 Markdown 或下载 CSV（带 BOM，Excel 直接打开，含来源与链接）。

结果里每条 JD 包含：

- **匹配分 0–100** + 结论（强投 / 可投 / 观望 / 不建议）
- **四项硬门槛**：年限、学历、城市、薪资（pass / warn / fail / unknown）
- **技能命中**：命中、缺失、必须项缺失
- **风险信号**：外包/驻场、996/大小周、年龄限制、薪资面议、职责过杂、长试用期等 11 类
- **来源与原帖链接**：猎聘 / LinkedIn / V2EX / 电鸭 / Remote OK
- **AI 深评**（可选）：3 条匹配理由、简历关键词、面试追问、额外风险

## 来源（真实接了哪些）

| 来源 | 方式 | 说明 |
| --- | --- | --- |
| 猎聘 | 公开 SEO 列表页 + 职位详情页 | 按城市 + 关键词；列表 40 条/页，服务端抓详情补正文 |
| LinkedIn | `jobs-guest` 公开职位接口 | 无需登录；北京/上海等城市检索；偶发 429 就降级 |
| V2EX 酷工作 | 公开 API | 创业公司/远程岗偏多，详情在列表里 |
| 电鸭社区 | 公开 API | 远程/兼职为主，默认按远程处理 |
| Remote OK | 公开 API | 英文远程岗，默认关闭；使用时保留回链 |
| **BOSS 直聘** | **未接** | 接口返回 `code 37`（环境异常），需要登录态与风控 cookie，不硬闯 |
| **脉脉** | **未接** | 职位搜索强制登录，无公开接口 |

没有账号体系、不自动投递、不绕验证码。源失败会在结果页标出原因（如 `429`、`need-city`、`empty`），不会拿假数据凑数。

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
| GET | `/api/config` | 版本、AI 状态、限流、来源列表 |
| GET | `/api/sources` | 已接来源 + 未接来源及原因 |
| GET | `/api/stats` | 匿名计数（筛选/搜索/简历/导入/AI/tokens） |
| POST | `/api/resume` | 上传简历（base64），返回正文 + 解析出的画像 |
| POST | `/api/search` | 按关键词/城市/来源搜岗位并匹配 |
| POST | `/api/import-jd` | 从公开 JD 链接导入正文 |
| POST | `/api/parse-profile` | 解析画像，返回识别到的技能 |
| POST | `/api/parse-jd` | 解析单条 JD，不调模型 |
| POST | `/api/screen-one` | 筛选单条 JD（前端并发 3 条） |
| POST | `/api/screen` | 批量筛选，最多 8 条，服务端并发 3 |

搜索示例：

```bash
curl -s http://localhost:8790/api/search \
  -H 'Content-Type: application/json' \
  -d '{
    "profile": {"title":"AI 应用工程师","years":"5","education":"本科","city":"北京","salaryMin":"30","salaryMax":"50","resumeText":"Python FastAPI Ray Kubernetes RAG LangChain"},
    "query": "AI 应用工程师",
    "city": "北京",
    "sources": ["liepin","linkedin","v2ex","eleduck"],
    "limit": 12
  }'
```

简历示例：

```bash
curl -s http://localhost:8790/api/resume \
  -H 'Content-Type: application/json' \
  -d "{\"filename\":\"resume.pdf\",\"data\":\"$(base64 -w0 resume.pdf)\"}"
```

限流：AI **20 次/小时/IP**（缓存命中不占额度）、全站 **500 次/天**；搜索 **30 次/小时/IP**、全站 **300 次/天**；简历解析 **20 次/小时/IP**；总请求 **240 次/小时/IP**。可用 `JD_*` 环境变量调整。超限降级或返回 429，不会把错误藏起来。

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

- 简历、画像、JD、上次结果只存在浏览器 `localStorage`；页脚可一键清除。
- 上传文件只在内存解析，解析完即丢弃；服务端不写简历/JD 正文，不记录请求 IP；`data/stats.json` 只有计数、结论分布和 token 数。
- **开启 AI 时**，画像摘要（含简历摘要）与 JD 原文会经主站网关转发给模型供应商；不开启 AI 则不出本机。
- 反代层（主站 Caddy）的访问日志仍会按主站统一策略记录请求 IP，这不在本应用控制范围内。

## 部署（2026-11-10）

发布走主站既有流程：应用仓库 CI 推 GHCR → 主站 compose/Caddy 由 CI 同步 → 服务器只 pull。

| 项 | 值 |
| --- | --- |
| 应用仓库 | `https://github.com/zxLumen/jd-screener`（public） |
| 镜像 | `ghcr.io/zxlumen/jd-screener:latest`（public，匿名 pull）；v0.2.0 digest `sha256:8c397bcd…` |
| 应用提交 | `5f44281`（v0.2.0） |
| 主站提交 | `8738de6`（v0.1 上线时） |
| 线上路由 | `duiwei.{$DOMAIN} → duiwei:8790` |
| DNS | DNSPod A `duiwei → 103.205.240.62`（RecordId `2447180381`） |
| AI 令牌 | 网关应用 `duiwei`，`chat-default` / `deepseek-v4.1-flash`，日限 300k tokens |
| 应用栏 | 18 个应用，「对位」`openIn=panel`，图标 `/apps/duiwei.png` |

容器额外依赖：`curl`（猎聘）、`poppler-utils`（PDF 简历），已写进 `Dockerfile`。

验收命令：

```bash
curl -sI https://duiwei.zxlumen.cn/ | head -1                 # 200
curl -s https://duiwei.zxlumen.cn/api/health                  # {"ok":true,...,"ai":true}
curl -s https://duiwei.zxlumen.cn/api/sources | head -c 400   # 5 个可用 + boss/maimai 未接
```

回滚：应用栏移除入口 → `docker compose stop duiwei` → 删 `duiwei.caddy` 后 `caddy reload`；或把 compose 的 `JD_TAG` 指回上一个镜像 tag。无数据库、无迁移。

## 文件结构

```
server.js              Node 原生 http：静态页 + /api + 限流 + 匿名统计
lib/sources.js         招聘源适配器：猎聘/LinkedIn/V2EX/电鸭/RemoteOK + 链接导入
lib/http.js            抓取：超时、大小上限、重定向逐跳校验（防 SSRF）、curl 兜底
lib/html.js            HTML → 文本、实体解码、按 class 取块
lib/resume.js          PDF / DOCX / TXT 简历解析（内置 zip + PDF 兜底）
lib/cache.js           有上限的 TTL 缓存（列表 10 分钟 / 详情 30 分钟）
lib/parse.js           JD/简历解析：年限、薪资、学历、城市、风险
lib/skills.js          技能词典（147 项，中英别名）
lib/score.js           确定性打分 + 硬门槛 + AI 混合
lib/llm.js             AI 网关调用、JSON 容错、缓存、并发去重
lib/text.js            归一化 / 词边界匹配 / 稳定签名
web/index.html         单页界面：简历上传 / 搜岗位 / 粘贴 JD / 结果
web/app.js             原生 ES module 前端
web/styles.css         暗色主题，桌面 + 移动 + iframe 嵌入
web/samples.json       3 条示例 JD
test/                  35 个测试（解析 / 打分 / 来源 / 简历 / 网关 / API）
deploy/                compose 服务片段、Caddy 路由、应用栏图标
```

## 还没接的（别当成有）

- **BOSS 直聘 / 脉脉没有接口**：BOSS 返回 `code 37`，脉脉要求登录；只能手动粘贴或贴公开链接导入。
- **不自动投递**：只做搜索与匹配，不登录招聘账号、不批量打招呼。
- **没有账号体系**：不做云端保存、多设备同步、投递进度跟踪。
- **没有向量语义匹配**：技能命中是词典 + 词边界，同义词覆盖有限；语义判断只靠 AI 提示词。
- **没有公司评价数据**：不接脉脉/看准网，风险信号只从 JD 文本里读。
- **薪资只算月薪**：股票/期权/签字费/年终奖不折算总包；`·15薪` 只展示，不参与打分。
- **英文岗位的城市/学历解析弱**：LinkedIn/Remote OK 的英文 JD 主要靠技能与年限，城市用来源地点兜底。
- **CI 只做镜像**：GitHub Actions 只 build/push GHCR，没有自动跑测试；发布前本地跑 `node --test`。

## 已验证（本地 v0.2）

- `node --test test/*.test.js`：**35 pass / 0 fail**（解析/打分 23、来源 2、简历 5、API 10，其中 API 用真实子进程起服务）。
- 简历：真实 PDF **464KB → 8137 字 / 35 项技能 / 111ms**，自动填出「后端研发工程师 / 6 年 / 北京」。
- 搜索（北京 · AI 应用工程师 · 4 源）：**候选 43 条，补详情 24 条，返回 12 条 / 4.6s**；来源 猎聘 40 / LinkedIn 20 / V2EX 10 / 电鸭 25。
- 结果：**89 强投 / 79 可投 / 63 观望**，含 9 条猎聘 + 2 条 LinkedIn + 1 条电鸭；薪资 `30-50K`、`30-60K·18薪` 正常解析。
- 链接导入：猎聘详情 **200 / 0.65s / 1878 字**；LinkedIn 公开职位 **200 / 0.67s / 8255 字**。
- 浏览器端（Playwright）：上传简历 → 搜索 → 12 张结果卡渲染，**0 console error**；390px 无横向溢出。

线上验收（2026-11-10，`5f44281` / digest `sha256:8c397bcd…`）：

- 首页 **200 / 11109B / 86ms**；`/api/health` **200 / ai:true**；`/api/sources` 5 可用 + 2 未接。
- 真实搜索（北京 · AI 应用工程师 · 4 源）：首次 **200 / 3.75s / 候选 43 / 补详情 24 / 返回 12**，命中缓存后 **0.23s**；猎聘 40 / LinkedIn 20 / V2EX 10 / 电鸭 25。
- 结果：**89 强投 / 85 强投 / 73 可投**；薪资 `30-40K`、`30-50K`、`60-90K·15薪` 正常。
- 简历 TXT 上传：**200 / 107ms / 12 项技能 / 期望 30-45K**。
- 猎聘链接导入：**200 / 0.61s / 1873 字**。
- AI 精评（deepseek-v4.1-flash）：**200 / 5.6s / 规则 89 + AI 42 → 68 可投**，返回 3 条理由 + 6 个简历关键词。
- 容器：**healthy / restarts=0 / 28.74MiB / 96MiB**；全站 Caddy 冒烟 **24/24 ok，app=0 / route=0**。
- 远程岗位未勾选「接受远程」时城市 gate = warn（score 77）；LinkedIn 429 会冷却 10 分钟并在结果页标原因。

## 版本

`0.2.0` · 2026-11-10 · 搜索 + 简历上传。见 `STATUS.md`。
