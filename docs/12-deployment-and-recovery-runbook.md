# 部署与恢复 runbook

> 适用对象：在单机或小集群上部署本平台、以及在事故中把它救回来的人。
>
> 本文只写**可执行动作**：每一条都给出命令、预期输出与失败时的处置。
> 判据来自 `docs/10`（规划与端口）、`docs/11`（审计与整改）与
> `docs/adr/0002-storage-backends.md`（后端边界）。凡是"尚未支持"的能力，
> 本文明确写"未支持"，不写"待补充"。

---

## 1. 部署形态与前提

### 1.1 最小可运行形态

| 组件 | 说明 |
|---|---|
| Node.js | ≥ 22（仓库用 `node --test` 的原生类型剥离运行测试，不需要构建产物） |
| 数据根 `dataRoot` | 一个**可写**目录。所有项目级事实都落在它下面 |
| 配置 | 每项目一份 `pipeline.yaml`（`configRef` 指向它） |
| 模型凭据 | 通过**环境变量**注入（`llm.providers[].apiKeyEnv`）；凭据不写进配置、不写进清单 |
| 被测服务基址 | `targetBaseUrl`，必须是**公网可达的 http(s)**；本机/内网地址会被拒绝 |

### 1.2 数据根布局（部署前必须知道）

```text
<dataRoot>/
├── pipelines/<pipelineId>.json          # 运行清单（= 索引，同一次原子写）
├── tenants/<tenantId>/projects/<projectId>/
│   ├── checkpoints/<pipelineId>/checkpoint.json
│   ├── artifacts/<pipelineId>/<stage>.json
│   ├── gates/<gateTaskId>.json          # 人工门任务
│   ├── gates/.locks/<gateTaskId>.lock/  # 门任务互斥（正常释放后不残留）
│   ├── tasks/<taskId>.json
│   ├── usage/<pipelineId>.jsonl         # 用量事件（追加写）
│   ├── idempotency/<namespace>/<key>.json
│   └── executor/<pipelineId>/
│       ├── session.json                 # 执行记录链 + 证据索引
│       ├── evidence/                    # 证据快照
│       └── invocations/<caseId>.json    # 调用状态机（intent/sent/received/done）
└── ...
```

**哪些目录可以删、哪些绝对不能删**：

| 目录 | 可否删除 | 原因 |
|---|---|---|
| `pipelines/` | ❌ | 删掉等于"这条流水线从未创建"，但它的检查点还在——形成孤儿记录 |
| `checkpoints/` | ❌ | 事实来源。删掉即丢失进度，且无法与产物对账 |
| `artifacts/` | ❌ | 人工门批准的对象；删掉后门任务指向不存在的产物 |
| `gates/` | ❌ | 真人裁决的审计凭据 |
| `executor/session.json` | ❌ | R4-08/09/10 的唯一对账依据 |
| `executor/evidence/` | ❌ | 证据文件；`session.json` 里的引用会指向空 |
| `executor/invocations/` | ⚠️ 仅按 §4.3 的流程删 | 它是"请求是否已发出"的唯一记录，删错会导致重复副作用 |
| `usage/` | ⚠️ 可归档 | 预算统计会归零，但不会破坏正确性 |
| `idempotency/` | ⚠️ 可删 | 删掉只会让重试再执行一次（对 create/decision 无害） |

### 1.3 存储后端（当前实际支持的范围）

```ts
// 缺省装配 = 文件后端；换后端只改这一处
createStorageBackend: (roots) => createFileStorageBackendFromRoots(roots)
```

- **已接入后端工厂的入口**：`createPlatformHost`、`createCheckpointHost`、
  `FilePipelineRunService`（Web）、`PlatformToolContext`（工具集）。
- **未接入的入口**：`cli.ts` 的门任务存储、`plugin.ts`（cordis 插件）、
  `harness/host-plugin.ts`（可选 Harness 适配层）、`src/e2e/minimal-host.ts`（测试宿主）。
- **仍是文件记录、不随后端切换的部分**：`pipelines/`（索引/清单）、
  `idempotency/`、`executor/**`。见 `docs/adr/0002` §7 第 7/8 行。
- **可运行的外部后端（PostgreSQL / Object Store）：未支持。** 目前只有接口层与
  契约测试，没有生产实现。因此**当前生产部署只能用文件后端 + 本地磁盘**。

---

## 2. 首次部署

### 2.1 前置检查

```bash
cd packages/platform-pipeline
npm ci                      # 或 npm install
npx tsc --noEmit            # 类型检查必须通过
node --test 2>&1 | tail -5  # 全量测试必须全绿（当前基线见 docs/10 §1）
```

### 2.2 目录与权限

```bash
install -d -m 0750 "$DATA_ROOT"
install -d -m 0750 "$DATA_ROOT/pipelines"
```

- `dataRoot` 必须**只对运行进程可写**。人工门任务、检查点、执行证据都靠它的完整性，
  多写者会破坏互斥与链式摘要。
- **不要**把 `dataRoot` 放在会做跨机同步的目录（NFS/Dropbox/iCloud）上：
  `mkdir` 独占与 `rename` 原子性在那些文件系统上不成立，
  per-task 互斥与"先落盘后宣告"会同时失效。

### 2.3 凭据注入

```bash
export SUT_LLM_API_KEY='...'    # 名字必须与配置里的 apiKeyEnv 一致
```

- 凭据**只经环境变量**进入进程；不要写进 `pipeline.yaml`，
  更不要写进 `targetBaseUrl`（携带 userinfo 的 URL 会被直接拒绝）。
- 启动后确认凭据没有出现在任何响应里：

```bash
curl -s "$WEB/api/pipelines/$PIPELINE" | grep -i "$SUT_LLM_API_KEY" && echo '泄露！' || echo 'ok'
```

### 2.4 启动

```bash
node web-app/server.mjs
# Harness Web listening at http://127.0.0.1:8787 (configRef=..., trustActorHeaders=false)
```

**默认只监听回环地址**，且默认**不信任请求头里的身份**（`trustActorHeaders=false`）。
对外暴露前必须：

1. 在前面放一层已认证的反向代理（本服务不做用户登录）；
2. 明确决定是否打开 `trustActorHeaders`——打开意味着"代理注入的身份头即身份"，
   只有在代理**保证剥掉外部同名头**时才安全。

### 2.5 冒烟验证

```bash
curl -s "$WEB/health"
# {"ok":true,"app":"harness-web-app","configRef":"...","trustActorHeaders":false,"running":[]}

curl -s -X POST "$WEB/api/projects/$PROJECT/pipelines" \
  -H 'content-type: application/json' -d '{"pipelineId":"smoke-1"}'
# 202；随后 GET 应看到 status=queued
```

---

## 3. 日常运维

### 3.1 状态查询

| 目的 | 命令 |
|---|---|
| 单条流水线 | `curl -s "$WEB/api/pipelines/$ID"` |
| 待裁决的门 | `curl -s "$WEB/api/gates?projectId=$P"` |
| 事件时间线 | `curl -s "$WEB/api/pipelines/$ID/events"` |
| 用量与预算 | `curl -s "$WEB/api/pipelines/$ID/usage"` |
| 谁在跑 | `curl -s "$WEB/health"` 的 `running` |

### 3.2 角色（**失败关闭**：未声明角色即拒绝）

| 动作 | 需要的角色 |
|---|---|
| 查询状态、列出门任务 | 任意非空身份 |
| `claimGate` / `decideGate` | `reviewer` 或 `admin` |
| `reenter` / `cancelGate` / 取消运行 | `operator` 或 `admin` |
| 恢复扫描 `POST /api/admin/recover` | `admin` |

后台运行身份**刻意不声明任何角色**，因此它无法替真人裁决，也无法执行运维动作。

### 3.3 预算

- 用量事件追加写在 `usage/<pipelineId>.jsonl`；超限时流水线以 `gate-failed` 结束
  （复用既有终态，`failures[].kind='budget-exceeded'`），**不会**进入人工门等批准。
- 归档 `usage/*.jsonl` 会让预算统计归零；如需保留统计，先复制到别处再删。

---

## 4. 恢复流程

### 4.1 进程重启后（正常情况）

```bash
curl -s -X POST "$WEB/api/admin/recover"      # 需要 admin 角色
# {"outcomes":[{"pipelineId":"...","action":"resume|await-human|terminal","started":true|false}, ...]}
```

判定表（`decideRecovery`）：

| 持久化状态 | 动作 | 含义 |
|---|---|---|
| `queued` / `running` / `needs-fix` | `resume` | 进程在运行中被杀，从 cursor 继续 |
| `waiting-human`（有未决门任务） | `await-human` | **不启动**，等真人 |
| `waiting-human`（无未决门任务） | `resume` | 裁决已下但未被消费，续跑即去消费它 |
| `completed` / `rejected` / `gate-failed` / `review-failed` / `cancelled` / `failed` | `terminal` | **不动**；重跑必须显式 `reenter` |

**恢复扫描不会替人裁决，也不会对未知结果重发请求。**

### 4.2 人工门卡住 / 需要回退

```bash
# 列出待裁决任务
curl -s "$WEB/api/gates?projectId=$P" -H "x-actor-id: $ME" -H "x-actor-roles: reviewer"

# 回退到某阶段重跑（需要 operator/admin）
curl -s -X POST "$WEB/api/pipelines/$ID/reenter" \
  -H 'content-type: application/json' -H "x-actor-roles: operator" \
  -d '{"stageId":"analyze","reason":"上游输入变了"}'
```

- `reenter` 会在**锁内**读取检查点并比对 digest，因此不会基于过期快照回退。
- 回退后该阶段与其下游都进入 `needs-reentry`，重跑时按当前输入重新执行。
- 若 `reenter` 返回 `conflict`，说明 digest 已变化或别人正在跑：先 `GET` 刷新再重试。

### 4.3 执行器崩溃：`invocation-unknown` 的处置（**最需要小心的一条**）

症状：`executor_run` 返回

```json
{ "error": "拒绝执行：以下用例的上一次调用结果未知，重发可能造成重复副作用。",
  "blockedCaseIds": ["c3"], "hint": "..." }
```

含义：`c3` 的调用日志停在 `sent`——**请求可能已经发出**，但响应没有落盘。
此时平台**一个请求都不会发**（连未受影响的用例也不发）。

处置（二选一，都必须先向被测系统确认）：

```bash
JOURNAL="$DATA_ROOT/tenants/$T/projects/$P/executor/$PIPELINE/invocations/c3.json"
cat "$JOURNAL"        # 看 phase / key / remoteIdempotencyKey / updatedAt
```

1. **确认远端未执行** → 删除日志文件，然后重试：

   ```bash
   rm "$JOURNAL"       # 只删这一个用例的文件，不要删整个 invocations/
   ```

2. **确认远端已执行** → 把结论写回日志，避免重复执行：

   ```bash
   # 用远端返回的真实结果填 result，phase 改为 done
   node -e 'const f=process.argv[1];const fs=require("fs");const r=JSON.parse(fs.readFileSync(f,"utf8"));r.phase="done";r.detail="人工确认：远端已执行";r.updatedAt=Date.now();fs.writeFileSync(f,JSON.stringify(r,null,2))' "$JOURNAL"
   ```

3. 如果被测服务**支持幂等键**，在宿主声明 `executorIdempotencyHeader`（例如
   `Idempotency-Key`）后，这类用例可以安全重发——平台会为每次请求带上同一个稳定键。
   **不要为了"让它跑过去"而随便声明它**：声明等于承诺远端会折叠重复请求。

**绝不要**因为"想让它继续"就删掉整个 `invocations/` 目录：那会让所有
"`sent` 之后结果未知"的用例变成"从未执行"，从而重复副作用。

### 4.4 人工门任务卡住（`GateTaskBusyError`）

症状：裁决返回 `conflict`，消息含 `human gate task ... is busy`。

含义：另一个进程正持有该门任务的互斥锁（临界区只有几次小文件读写，正常在毫秒级）。

处置：

1. 先重试一次（绝大多数情况已释放）；
2. 仍失败则看锁目录：

   ```bash
   ls -la "$DATA_ROOT/tenants/$T/projects/$P/gates/.locks/"
   ```

   年龄超过 30 秒的锁会被后来者**自动接管**（原子改名到墓碑再删），
   因此通常不需要人工干预；
3. 只有当锁目录持续存在且年龄不断刷新时，才说明真有一个进程在写——
   先查 `ps` 与 `GET /health` 的 `running`，不要直接 `rm -rf` 锁目录。

### 4.5 检查点损坏 / `pipelineId` 不一致

症状：`GET` 返回 `storage-unavailable`，消息含
`检查点记录的 pipelineId（X）与请求的 Y 不一致`。

含义：**登记记录损坏或被放错了位置**（不是"流水线不存在"）。

处置：

```bash
F="$DATA_ROOT/tenants/$T/projects/$P/checkpoints/$PIPELINE/checkpoint.json"
node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pipelineId)' "$F"
```

- 若内容里的 `pipelineId` 是被误改的 → 改回正确值（或从备份恢复）；
- 若是从别的项目目录误拷过来的 → 找到它真正的归属，**不要**直接改 id 硬凑，
  否则产物路径、门任务归属、用量 scope 全部会指向错误的位置。

### 4.6 产物不可读 / 不是合法 JSON

症状：`gate-failed`，violation 为 `R-ARTIFACT-READABLE`。

处置：按提示重写该产物为合法 JSON（注意字符串内部的双引号必须转义），
然后 `reenter` 该阶段重跑。**不要**手工把检查点里的 digest 改成新值——
那会让 G-08 摘要锁失去意义。

### 4.7 存储故障

- `unreadable`（基础设施读不了）→ 服务在首次使用时抛 `storage-unavailable`(503)，
  **不会**降级到文件后端。先修基础设施（磁盘满/权限/挂载），再重启。
- 单条记录 `corrupt-json` / `schema-invalid` → **不阻断启动**，只在
  `backend.diagnose()` 的返回里报告。用诊断里的 `ref` 定位文件后单独处理。

---

## 5. 备份与演练

### 5.1 备份

```bash
# 一致性要点：先停写，再拷贝
curl -s -X POST "$WEB/api/pipelines/$ID/cancel" -H "x-actor-roles: operator"   # 停掉在跑的
tar -czf "backup-$(date +%Y%m%d-%H%M%S).tgz" -C "$DATA_ROOT" .
```

- 热备（不停写）在文件后端上**不保证一致**：检查点、产物、门任务可能跨代。
  备份必须来自同一个静止点。
- 备份产物里包含凭据吗？**不包含**——清单只存环境变量名，用量与证据不含请求头。

### 5.2 恢复演练（建议每季度一次）

1. 把备份解到新的 `dataRoot`；
2. 用同一份配置启动一个**临时**实例（换端口、换 `dataRoot`）；
3. `GET /api/pipelines/<id>` 应与备份时一致；
4. `POST /api/admin/recover`（admin 身份）→ 停在人工门的应报 `await-human` 且
   `started: false`，终态应报 `terminal`；
5. 批准一个门任务，确认能继续跑；
6. 删除临时实例。

### 5.3 回滚

| 回滚到 | 风险 |
|---|---|
| 批次 D 之前（`0389322`） | 后端工厂选项消失；Web 直接 `new Fs*`。**数据兼容**（落盘格式未变） |
| 批次 C 之前（`fa07142`） | `executor/invocations/` 被忽略 → 退回"只看台账"，重新暴露"请求已发出却重发"的窗口 |
| 批次 B 之前（`0f6bc3d`） | 门任务不再绑定 digest；**带 userinfo 的 URL 会被重新接受**（P2-04 的回滚风险） |
| 批次 A 之前（`3a05f09`） | 运行清单字段丢失（`targetBaseUrl` 等），`execute` 阶段拿不到被测基址 |

回滚前请确认没有处于人工门/execute 阶段的在跑流水线。

---

## 6. 发布门槛（M5，**尚未收口**）

以下门槛**尚未全部完成**，因此在它们收口之前不得对外宣称"平台化 M0-M4 全部完成"
（`docs/11` §12）：

| 门槛 | 当前状态 |
|---|---|
| 安全：SSRF、路径越权、凭据不泄露 | 判据已落地并有负向测试；**缺**一次整体的渗透式复核 |
| 恢复：备份/恢复演练 | 本 runbook 给出流程；**缺**一次真实演练记录 |
| 并发：锁、门任务 CAS、执行器状态机 | 已落地并有并发测试；**缺**多进程压测 |
| 预算：超限终止与查询 | 已落地并有测试；**缺**长跑（跨天）验证 |
| Web 集成：六阶段端到端 | 12 项 e2e 全绿；**缺**真实被测系统（非脚本化宿主）的端到端 |
| 外部后端：PostgreSQL / Object Store | **未支持**（仅接口层） |

---

## 7. 常见问题速查

| 症状 | 最可能的原因 | 第一条命令 |
|---|---|---|
| `409 conflict` 且消息含 `locked by` | 另一进程在跑 | `curl -s "$WEB/health"` |
| `409 conflict` 且消息含 `is busy` | 门任务互斥未释放 | `ls gates/.locks/` |
| `503 storage-unavailable` | 磁盘/权限，或登记记录损坏 | 看错误消息里的 `checkpointRoot` |
| `403 forbidden` 且消息含 `私有地址` | `targetBaseUrl` 指向内网/回环 | 看清单里的 `targetBaseUrl` |
| `403 forbidden` 且消息含 `userinfo` | URL 里带了凭据 | 把凭据改成环境变量注入 |
| `blockedCaseIds` 非空 | 调用结果未知 | 按 §4.3 处置 |
| `waiting-human` 一直不动 | 没有真人裁决 | `curl -s "$WEB/api/gates?projectId=$P"` |
| `gate-failed` 且 `R-ARTIFACT-READABLE` | 产物不是合法 JSON | 按 §4.6 处置 |
