# STATUS · 对位（AI 智能筛选 JD）

- **版本**：0.1.0
- **状态**：可用（本地验收通过，**未发布**）
- **日期**：2026-11-10
- **定位**：给求职者的 JD 批量筛选器。规则分永远可用，AI 只做加分项。
- **线上**：无（目标 `duiwei.zxlumen.cn`，等老板拍板）

## 已交付

- 单页应用：画像 → 批量 JD（最多 8 条）→ 排序结果 → Markdown/CSV 导出。
- 规则引擎：年限、学历、城市、薪资四项硬门槛 + 147 项技能词典 + 11 类风险信号。
- AI 层：主站网关、900 tokens、22s 超时、2h 缓存、失败自动回落规则分。
- 隐私：画像/JD 只在 `localStorage`，服务端只存匿名计数。
- 部署物料：`Dockerfile`、`deploy/compose.service.yml`、`deploy/duiwei.caddy`、`deploy/duiwei-icon.png`。

## 验收数字

- 测试：`node --test test/*.test.js` → **23 pass / 0 fail**。
- 本地：`GET /` **200 / 7.9KB / 15ms**；`/api/health` 在未配令牌时 `ai:false`，自动规则模式。
- 示例画像 + 3 条示例 JD：**94 强投 / 75 可投 / 25 不建议**；风险命中外包、大小周、职责过杂。
- 浏览器：Chromium 1440×1000 与 390×844，无 console error。
- 服务常驻：`PORT=8790 node server.js`，零依赖、无构建。

## 发布前还差

1. 建 GitHub 仓库 / GHCR 镜像（当前只有本地目录，无远端）。
2. 主站 compose 加 `duiwei` 服务、Caddy 加 `duiwei.caddy`。
3. admin 签 `JD_AI_TOKEN`，写入 `docker/.env`。
4. 主站应用栏新增「对位」（panel 打开 + 图标）。
5. 发布验收：首页 200、`/api/health` 200 且 `ai:true`、示例 3 条能出分。

## 明确不做 / 还没接

- 不抓招聘网站、不自动投递；JD 手动粘贴。
- 不解析 PDF/Word 简历；不做账号体系、云端同步、投递跟踪。
- 不做向量语义匹配；技能命中是词典 + 词边界。
- 不折算股票/期权/签字费总包；薪资只按月薪算。
- 没有 CI；镜像需手动 build/push。

## 回滚

无数据库、无迁移。`docker compose stop duiwei`，移除 `duiwei.caddy` 后 `caddy reload`，应用栏删入口即可。
