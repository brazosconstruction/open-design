# AMR Capability Gaps — Open Design 一键点亮诉求

> 受众:AMR (`agentic-model-router`) 维护者
> 来源方:Open Design 客户端团队
> 目标:让 Open Design 用户**一次 OAuth = chat / image / 视频 / 音频 / web-search / connectors / MCP / skills 全部可用且计费自动包好**,不再为每个 surface 单独配置 API key。
>
> 与之配套,Open Design 客户端会重构 `SettingsDialog`,把按"供应商"分 tab 改成按"能力"分卡片,所有卡片同时支持 `AMR` 与 `BYOK` 两种来源。本文聚焦 AMR 侧需要补的事;客户端侧改造见 `docs/integrations/amr.md` 的后续补充。

## 一、当前可用 vs 缺失矩阵

| 能力域 | AMR 现状 | Open Design 现状 | 是否阻塞一键 |
|---|---|---|---|
| Chat / Code (LLM 路由) | ✅ `/v1/chat/completions` + `/v1/messages` + adapters | ✅ Claude / Codex / OpenCode 通过 AMR adapter 已可用 | 否 |
| 图像生成 | ⚠️ 只有 `fal-image` 一个 connector + `gpt-image-2` 计费表 | ✅ `media-config.ts` 已实现 AMR token 回退 | 部分:模型覆盖不全 |
| 视频生成 | ❌ 无 | ❌ 无 | **是** |
| 音频 / TTS | ❌ 有计费字段无端点 | ⚠️ 无 UI | **是** |
| Embeddings | ❌ 计费表预留无端点 | N/A | 否(P1 再说) |
| Web search | ✅ SerpAPI `web-search` | ✅ 已通过 AMR connector | 否 |
| Connectors (Notion/Drive/Gmail/Slack/GitHub) | ❌ 仅有 `composio` 占位,无真实实现 | ⚠️ 用户必须额外配 Composio API key | **是** |
| MCP servers | ❌ Agent resource 有 `mcp_servers` 字段,adapter 未真正 bind | ⚠️ `mcp-config.json` 需要用户手填 headers/env | **是** |
| Skills (计费包装) | ❌ 无 skill catalog 概念 | ⚠️ skill 寄生于父 agent 的 env,无计费包装 | 是(可选) |
| 计费 | ✅ preflight 402 + per-call 扣费 + ledger | ✅ 已对接 | 否 |
| 身份 / OAuth | ✅ device flow + `/v1/whoami` | ✅ `~/.amr/session.json` + SQLite | 否 |

## 二、需要 AMR 侧补的能力清单(按优先级)

### P0 — 阻塞一键 OAuth 真正"全开"

#### G1. `GET /v1/capabilities` 统一发现端点 ⭐

**问题**:Open Design 客户端目前没有任何方式问 AMR"这个 token 当前可以做什么"。客户端必须分别打 `/v1/models`, `/v1/adapters`, 硬编码 `web-search/fal-image/composio` 列表,而 connectors 增删时客户端要发版。

**建议形态**:

```http
GET /v1/capabilities
Authorization: Bearer <token>

200 OK
{
  "identity": { "org_id": "...", "user_id": "...", "project_id": "...", "plan": "..." },
  "balance_usd": 12.45,
  "domains": {
    "chat":      { "available": true,  "items": [ { "id": "anthropic/claude-sonnet-4-6", "label": "Claude Sonnet 4.6", "capabilities": ["chat","vision","tools","streaming"], "pricing": { ... } } ] },
    "image":     { "available": true,  "items": [ { "id": "openai/gpt-image-2", "pricing": { "unit": "call", "amount_usd": 0.05 } } ] },
    "video":     { "available": false, "items": [] },
    "audio":     { "available": false, "items": [] },
    "embedding": { "available": false, "items": [] },
    "web_search":{ "available": true,  "items": [ { "id": "serpapi", "pricing": { "unit": "call", "amount_usd": 0.01 } } ] },
    "connector": { "available": true,  "items": [ { "id": "notion", "label": "Notion", "auth_url": "https://gateway/.../oauth/notion", "status": "needs_auth" }, ... ] },
    "mcp":       { "available": true,  "items": [ { "id": "higgsfield", "transport": "http", "url": "...", "headers": { "Authorization": "Bearer <forwarded>" } } ] },
    "skill":     { "available": false, "items": [] }
  },
  "scopes": ["admin","billing","inference"]
}
```

**关键点**:
- 客户端只需调用一次,就能渲染整个"能力面板"。
- `items[].status` 区分 `ok` / `needs_auth` / `unavailable`,客户端能直接做 UI 状态。
- 新增 connector / model / MCP 不需要客户端发版。

#### G2. 第三方 Connectors 真实实现(Notion / Drive / Gmail / Slack / GitHub)

**问题**:`ConnectorId = 'web-search' | 'fal-image' | 'composio'` 中 `composio` 是 stub。Open Design 用户配 Composio 必须额外去拿一份 Composio API key,体验割裂。

**建议**:

- AMR 内置 `connectors/composio/` 实际实现,把 Composio 的 OAuth 在 AMR 端跑完;Open Design 用户只看到"这些 connector 已 ready",不感知 Composio 存在。
- 对外暴露:
  - `GET  /v1/connectors`(枚举,已在 G1 的 `domains.connector` 中)
  - `POST /v1/connectors/:id/authorize` → 返回 `{ authorize_url, state }`,客户端打开浏览器
  - `GET  /v1/connectors/:id/status` → `{ authorized: bool, expires_at?: ... }`
  - `POST /v1/connectors/:id/call` 复用现有接口
- 计费按 `connector_id` 走 ledger,不再加 connector-specific 字段。

#### G3. MCP Server 提供与转发

**问题**:`AgentMcpServerBinding.id` 没有 discovery 来源;Open Design 想给用户呈现"AMR 帮你 host 了一组 MCP server,直接用就行",但目前 AMR 没真正实现绑定。

**建议**:

- AMR 提供 `GET /v1/mcp-servers` 列出托管 MCP servers,每条返回 `{ id, label, description, transport, url_or_command, default_enabled, requires_auth }`。
- 对于 `requires_auth: true` 的 MCP,提供 `POST /v1/mcp-servers/:id/authorize` 走 OAuth,token 由 AMR 持有,客户端通过 AMR 的代理 URL 转发(`https://gateway/v1/mcp-proxy/:id`),不接触原始 token。
- 计费按 MCP server 的 tool call 计入 ledger,`surface: 'mcp'`,`model: '<server-id>:<tool-name>'`。
- Agent runtime 侧实际 bind MCP servers(目前是 scaffold,见 ARCHITECTURE.md "Phase 1"),让 `Agent.mcp_servers` 真正生效。

### P1 — 让"全开"覆盖更广

#### G4. Video / Audio 生成 connectors

**建议先支持**:
- Video:`fal-video`(直接复用 fal.ai 同账户)+ `runway-gen` 二选一
- Audio:`elevenlabs-tts` 或 `openai-tts`(走 chat key)

Schema 与 `fal-image` 对齐,只是 connector id 与 pricing 不同。Open Design 媒体 tab 会自动展示。

#### G5. Skills marketplace(计费包装的 skill)

**问题**:Open Design 的 `skills/` 目录里现在每个 skill 自己挑模型/API,缺统一计费。未来想做"用户安装 skill → 自动按 skill 元数据计费"。

**建议**(可后置):
- AMR 提供 `GET /v1/skills` 与 `POST /v1/skills/:id/run`,run 时 AMR 把 skill 的子调用全部记到 trace 上,聚合扣费。
- skill 元数据:`{ id, name, description, version, models[], connectors[], pricing_strategy: 'passthrough' | 'fixed' }`。
- 与 Open Design 现有的 `od.craft.requires` 约定对齐。

#### G6. Embeddings 端点

`POST /v1/embeddings` 上线(对接 OpenAI / Voyage / Cohere)。pricing 表已经预留位置,补 endpoint 即可。

### P2 — 安全与生产化

#### G7. OAuth refresh token

**问题**:当前 `expires_in: 0`,access token 永不过期,只能 revoke。安全合规上需要短期 token + refresh。

**建议**:
- `POST /v1/oauth/token` 同时返回 `refresh_token`(180 天)和 `access_token`(2 小时)。
- 新增 `POST /v1/oauth/refresh`,Open Design daemon 在 401 时自动调用。

#### G8. Per-key capability scoping

**问题**:目前所有 key 默认 `scopes: ['admin','billing','inference']`,粒度太粗。Open Design 希望支持"只给某个用户开放 chat,不允许 image"。

**建议**:
- `scopes` 扩展为带 capability 维度的字符串,如 `inference:chat`, `inference:image`, `connector:notion`, `mcp:higgsfield`。
- `POST /v1/keys` 支持指定 scopes 子集。
- gateway 在每个能力路由处检查 scope。

#### G9. `GET /v1/verify-key` 健康检查端点

**问题**:Open Design 客户端目前用 `/v1/whoami` 作为"token 还活着吗"的间接验证,语义不清。

**建议**:轻量端点,返回 `{ valid: bool, expires_at?: ..., scopes: [...] }`,不做任何计费动作。

#### G10. 计费按 feature(surface)聚合的查询

**问题**:`/v1/billing/usage` 是按时间维度的扁平 ledger。Open Design 想展示"你这个月在 image 上花了多少 / connectors 多少 / chat 多少"。

**建议**:
- `GET /v1/billing/usage?group_by=surface,model` 返回聚合结果,而不是让客户端自己 group。
- 字段:`{ surface, model, calls, input_tokens, output_tokens, amount_usd }[]`。

## 三、上线顺序建议

```
Sprint 1 (P0):  G1  ─┐
                G2 ──┼─→  Open Design 可以做"AMR 一键点亮 connectors"
                G3 ──┘    （MCP P1 即可,但 discovery 必须 P0）

Sprint 2 (P1):  G4  ──→  视频 / 音频 卡片可见
                G6  ──→  embeddings 卡片可见

Sprint 3 (P2):  G7  ──→  token 过期 + refresh
                G8  ──→  multi-tenant 安全
                G9  ──→  健康检查
                G10 ──→  计费仪表盘
                G5  ──→  skill marketplace（可后置）
```

## 四、与 Open Design 客户端的约定

Open Design 客户端会按以下顺序读取能力:

1. 启动时调用 `GET /v1/capabilities`(若 401 提示用户重新 OAuth)。
2. 缓存 5 分钟,过期或用户主动刷新时重新拉。
3. UI 渲染基于 `domains[*].items`,客户端**不再硬编码** model / connector / MCP 清单。
4. BYOK 模式仍可在客户端单独配置(Composio API key、自托管 base URL 等),与 AMR 模式并存,以 UI 上的"AMR ⇄ BYOK"开关切换。

> 当 G1 上线后,Open Design 这边会同步 PR:`apps/daemon/src/capabilities/` 新增聚合层,把 `media-config.ts` / `composio-config.ts` / `mcp-config.ts` / `agentCliEnv` 全部代理到 capability 视图,旧 tab 折叠进 Advanced。

## 五、Open 问题(请 AMR 团队 review)

1. `/v1/capabilities` 的缓存语义:AMR 内部需要多久重算一次 connector / MCP 列表?是否需要 ETag?
2. MCP 代理(G3)的 transport:HTTP/SSE 已经够,还是必须支持 stdio?Open Design 客户端目前两种都需要。
3. Refresh token(G7)与现有 `~/.amr/session.json` 文件格式如何兼容?是否需要文件版本字段?
4. Skills marketplace(G5)与 Open Design 已有的 `skills/AGENTS.md` 协议是否一致?需不需要单独跑一轮设计对齐?

---

**联系**:Open Design 客户端 review 路径 `docs/integrations/amr.md` + 本文档。变更应通过 PR 双向同步,任何 capability schema 变更先更新 G1 端点契约。
