# STATUS · 对位（AI 智能筛选 JD）

- **版本**：0.2.0
- **状态**：已上线（2026-11-10）
- **线上**：https://duiwei.zxlumen.cn
- **定位**：给求职者的岗位搜索 + 简历匹配器。规则分永远可用，AI 只做加分项。
- **仓库**：https://github.com/zxLumen/jd-screener（public）
- **镜像**：`ghcr.io/zxlumen/jd-screener:latest`（public，服务器匿名 pull）

## 0.2.0 已交付

- **不用粘 JD**：服务端直接搜公开岗位。已接猎聘、LinkedIn、V2EX 酷工作、电鸭社区、Remote OK（默认关）。
- **简历上传**：PDF / DOCX / TXT / MD / HTML，≤5MB；自动抽岗位/年限/学历/城市/技能/期望薪资；内存解析，不落库。
- **两段式匹配**：列表粗排 → 入围岗位补详情正文 → 完整 JD 重算，返回 8/12/20 条。
- **来源诊断**：每个源返回条数、耗时、错误码（`429` / `need-city` / `empty`），失败不藏。
- **多来源保底**：结果不被单一站点刷屏，LinkedIn 保 2 条、其他源保 1 条。
- **链接导入**：猎聘 / LinkedIn / 公司招聘页公开链接可直接抓正文。
- **未接且明说**：BOSS 直聘（`code 37`）、脉脉（需登录）。
- 旧的手动粘贴 / 批量筛选 / AI 深评 / Markdown / CSV 全部保留。

## 本地验收（2026-11-10）

- 测试：`node --test test/*.test.js` → **35 pass / 0 fail**（解析/打分 23、来源 2、简历 5、API 10）。
- 简历：真实 PDF **464KB → 8137 字 / 35 项技能 / 111ms**，自动填「后端研发工程师 / 6 年 / 北京」。
- 搜索（北京 · AI 应用工程师 · 4 源）：**候选 43 / 补详情 24 / 返回 12 / 4.6s**。
- 来源：猎聘 **40** / LinkedIn **20** / V2EX **10** / 电鸭 **25**。
- 结果：**89 强投 / 79 可投 / 63 观望**；9 猎聘 + 2 LinkedIn + 1 电鸭。
- 链接导入：猎聘 **200 / 0.65s / 1878 字**；LinkedIn **200 / 0.67s / 8255 字**。
- Playwright：上传 → 搜索 → 12 卡渲染，**0 console error**；390px 无横向溢出。

## 线上验收（2026-11-10 10:00）

- 首页 **200 / 11109B / 86ms**；health **200 / ai:true**；sources 5 可用 + 2 未接。
- 真实搜索：**2.97s / 候选 43 / 详情 24 / 返回 12**；猎聘 40 / LinkedIn 20 / V2EX 10 / 电鸭 25。
- 首条 **89 强投**（薪资 30-40K）；LinkedIn 2 条、电鸭 1 条进入结果。
- 简历 TXT：**107ms / 12 技能 / 期望 30-45K**；猎聘链接导入 **0.61s / 1873 字**。
- AI 精评：**5.6s / 规则 89 + AI 42 → 68**，`deepseek-v4.1-flash`。
- 容器 **healthy / restarts=0 / 30.31MiB / 96MiB**；Caddy 冒烟 **24/24 ok**。

## 发布记录

- 0.1.0：应用 `d8adcc4`，主站 `8738de6`；DNS `duiwei → 103.205.240.62`（RecordId `2447180381`）。
- 0.2.0：应用提交 `017a452`，镜像 digest `sha256:fee0cd49…`；容器新增 `curl` + `poppler-utils`；本地 rollback tag `rollback-20261110-1000`。
- AI 令牌：网关应用 `duiwei`，`chat-default` / `deepseek-v4.1-flash`，日限 300k tokens。

## 明确不做 / 还没接

- 不接 BOSS 直聘、脉脉（反爬/登录），也不绕验证码；不自动投递。
- 不做账号体系、云端同步、投递跟踪。
- 不做向量语义匹配；技能命中是词典 + 词边界。
- 不折算股票/期权/签字费总包；薪资只按月薪算。
- 英文 JD 的城市/学历解析弱，主要靠技能 + 来源地点兜底。

## 回滚

1. 主站应用栏移除「对位」入口。
2. `docker compose stop duiwei`；删除 `docker/caddy/sites/duiwei.caddy` 后 `caddy reload`。
3. 或把 compose 的 `JD_TAG` 指回上一个镜像 tag（`rollback-*` 或上一个 sha）。
4. 可选：DNSPod 删除 `duiwei` A 记录；admin「AI 密钥」禁用 `duiwei` 令牌。
5. 无数据库、无迁移；`duiwei-data` 卷只存匿名计数。
