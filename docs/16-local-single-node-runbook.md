# 本地单机运行手册

> 面向：在一台机器上跑 Web 控制台 + 六阶段流水线的人。
> 对应规划书：`docs/14-web-single-node-productization-plan.md` W5/W6。
> 本手册只覆盖**单机 + 文件后端**；多副本、外部数据库、公网被测系统不在范围内
> （见 `docs/13` §3 的发布判定）。

---

## 1. 最小启动

### 1.1 前置

- Node **22 或更高**（源码直接用类型剥离运行，无需构建）；
  本仓库开发机用的是 `/usr/local/bin/node`（v26）。**不要用 `npm test`**——它走裸
  `node`，在部分版本上会因语法支持差异导致整个测试文件加载失败。
- 一份流水线配置（JSON 或 YAML）。仓库自带 `examples/pipeline.yaml`。

### 1.2 环境变量模板

```bash
# ── 必填 ──────────────────────────────────────────────────────────────────────
export PLATFORM_DATA_ROOT="$HOME/.harness-web/data"     # 数据根：检查点/产物/门任务/用量都在这里
export PLATFORM_CONFIG_PATH="/abs/path/examples/pipeline.yaml"

# ── 常用可选 ──────────────────────────────────────────────────────────────────
export PORT=3080                                        # 默认 3080
export HOST=127.0.0.1                                   # 默认 127.0.0.1（**不要**随意改成 0.0.0.0）
export PLATFORM_CONFIG_REF=default                      # 浏览器只认这个逻辑名，改不了路径
export PLATFORM_MAX_BODY=65536                          # 请求体上限（字节）；非法值启动即失败

# ── 身份（单机模式：服务端固定身份）───────────────────────────────────────────
export PLATFORM_ACTOR_ID=local-operator
export PLATFORM_ACTOR_TENANT=demo-tenant                # **必须与配置里的 scope.tenantId 一致**
export PLATFORM_ACTOR_ROLES=admin,reviewer,operator     # 默认只有 viewer（不能裁决人工门）
export PLATFORM_ACTOR_PROJECTS=acme-pay-2026            # 可选：项目白名单

# ── 后台运行身份：**刻意不声明角色**，这样"后台不得替人裁决"是机器保证 ────────
export PLATFORM_RUNNER_ACTOR_ID=web-runner

# ── provider 凭据：名字由配置里的 apiKeyEnv 决定，值只从进程环境变量读 ────────
export PLATFORM_LLM_API_KEY=sk-...                      # 变量名以你的配置为准
```

### 1.3 启动

```bash
cd /Users/zhangzhixiong/Downloads/harness/test-platform-design
/usr/local/bin/node web-app/server.mjs
```

启动成功只打印一行（**不含**数据根、配置路径、任何凭据）：

```text
Harness Web listening at http://127.0.0.1:3080 (configRef=default, trustActorHeaders=false)
```

浏览器打开 <http://127.0.0.1:3080/>。

---

## 2. 单机必备的两个坑

### 2.1 命令行访问必须绕开代理

本机常配 `http_proxy`，它会把 `127.0.0.1` 也代理走，于是 `curl` 返回代理的 **502**，
看起来像"服务没起来"。加 `--noproxy '*'`：

```bash
curl --noproxy '*' -sS http://127.0.0.1:3080/health
```

（浏览器与 `fetch` 不受影响，只有命令行工具中招。）

### 2.2 身份租户必须与配置一致

`PLATFORM_ACTOR_TENANT` 与配置里的 `scope.tenantId` 不一致时，创建流水线会返回
`403 scope-mismatch`。服务端**不会**替你猜一个租户——这是失败关闭的设计。

---

## 3. 危险模式：`PLATFORM_TRUST_ACTOR_HEADERS`

默认**关闭**：所有请求都用服务端固定身份，客户端伪造 `x-actor-*` 无效。

开启后身份**完全来自请求头**（含 `x-actor-roles`）。因此：

- 回环绑定（`HOST=127.0.0.1`）→ 允许（外部建连不可能）；
- 非回环绑定 + 显式声明 `PLATFORM_TRUSTED_PROXY=1` → 允许（你确认反向代理会**剥除**
  客户端同名头）；
- 非回环 + 未声明 → **拒绝启动**。

---

## 4. 一条流水线的完整生命周期

```text
1. 打开页面 → 填「基本信息 / 需求输入 / 被测服务 / 运行选项」→ 创建
2. 页面自动打开该流水线；点主操作按钮「触发运行」
3. 后台运行跑到第一个需要人工门的阶段 → 状态 waiting-human
4. 在「人工门任务」里：填说明 → 批准 / 打回重跑 / 拒绝 / 取消任务
5. 再点「触发运行」→ 消费裁决 → 推进到下一阶段
6. 六阶段全部完成 → 状态 completed，主操作变成「查看当前阶段产物」
```

要点：

- **裁决只写事实，不推进流水线**；必须由下一次「触发运行」消费。
- **批准不会自动发生**：超时、异常、轮询都不会把门变成 approved。
- **`gate-failed` 是终态**：机器门禁失败或预算超限时，页面给的是「去登记重入」，
  不是「批准」。该状态下会有一条**升级任务**（标记为"升级任务（非阶段门）"），
  它不对应产物，永远不会被当作阶段批准。
- **`reenter`（重入）** 在「高级」面板里，需要带当前 digest；旧 digest 会被拒（409）。

---

## 5. 重启与恢复

后台运行句柄只存在于进程内；**事实**（检查点、产物、门任务、事件、用量）都在数据根里。
因此：

```text
杀掉进程 → 重新启动 → 打开同一条流水线
  → 状态从持久化事实重建（不会因为重启丢掉已完成的阶段）
  → 需要继续跑时点「恢复扫描」（需要 admin 角色）
```

「恢复扫描」的判定是纯函数：

| 状态 | 动作 |
|---|---|
| `queued` / `running` / `needs-fix` | `resume`（从 cursor 继续） |
| `waiting-human` 且有未决门 | `await-human`（**不启动**，等真人） |
| `waiting-human` 且无未决门 | `resume`（去消费已登记的裁决） |
| 终态 | `terminal` |
| 索引不可读 | `unreadable`（报告出来，不静默跳过） |
| 创建停在中间态 | `creation-incomplete`（用同一 pipelineId 重新 create 即可接管） |

**恢复扫描永不替人裁决。**

---

## 6. 常见故障与处置

### 6.1 「未启动运行：provider-unavailable: ... missing API key environment variable: XXX」

**原因**：配置里 provider 声明的 `apiKeyEnv` 指向的环境变量没有设置。

**处置**：按提示里的变量名设置它，然后重启服务。页面会明确告诉你这是**配置问题、
重复点击不会变好**——这是刻意设计的（前置校验在启动后台任务**之前**就拦下了它，
所以失败会同步回到页面，而不是只写进服务端日志）。

### 6.2 创建返回 `403 scope-mismatch`

见 §2.2。检查 `PLATFORM_ACTOR_TENANT` 与配置的 `scope.tenantId`。

### 6.3 启动即退出（exit=1）

启动时就会失败的情况（都是刻意的失败关闭）：

| 现象 | 原因 |
|---|---|
| `PLATFORM_MAX_BODY：必须是十进制非负整数` | 配了 `NaN` / 小数 / `1e3` / `0x10` 等 |
| `PLATFORM_TRUST_ACTOR_HEADERS：…不是回环地址…` | 见 §3 |
| `PLATFORM_DATA_ROOT：必填` | 没设数据根 |
| `配置阶段 ACL：… unknown tool …` | 配置里 ACL 引用了不存在的工具 |
| `配置审批覆盖：…` | 某个允许写库的阶段没有阻塞人工门 |
| `配置门禁规则：…` | 阶段 `rules` 里写了不存在的规则 id |

### 6.4 页面显示「存储暂不可用」

这是 **503**，表示基础设施故障（不是"没有数据"）。页面会给出重试入口。
检查数据根是否可写、磁盘是否满。

### 6.5 页面显示「读取失败」但服务还活着

点「立即刷新」；若持续失败，看服务端日志。页面在轮询失败时会**保留最后一次可信状态**
并标注"最近一次刷新失败"，不会把页面清空。

---

## 7. 数据根里有什么

```text
<PLATFORM_DATA_ROOT>/
  pipelines/<pipelineId>.json                     # 流水线索引（作用域 + 配置引用 + 运行参数）
  tenants/<tenant>/projects/<project>/
    checkpoints/<pipelineId>/checkpoint.json      # 检查点（阶段状态、cursor、失败、重入）
    checkpoints/<pipelineId>/.pipeline.lock/      # 跨进程运行锁
    artifacts/<pipelineId>/<stageId>.json         # 阶段产物
    gates/<gateTaskId>.json                       # 人工门任务（含升级任务）
    tasks/<taskId>.json
    usage/<pipelineId>.jsonl                      # 用量事件（append-only）
    audit/audit.jsonl                             # 审计事件（append-only）
    idempotency/<namespace>/<key>.json            # 幂等台账
    executor/<pipelineId>/{session.json,evidence}/ # 执行会话与证据
```

**业务状态只写在数据根里**。备份 = 停写后整棵拷贝；恢复 = 拷到新数据根后用新的
`PLATFORM_DATA_ROOT` 启动（`docs/12` §5 有完整演练步骤）。

---

## 8. 已知限制（不要当成 bug）

1. **单机文件后端**：不支持多副本共享。多租户 SaaS 需要外部后端，**当前不可用**。
2. **运行期异常不写检查点**：driver 内部的崩溃不会变成持久化事实。前置校验失败已经
   前移到同步返回（§6.1），但真正的运行期崩溃仍只在服务端日志里。权威的运行遥测
   属于后续里程碑。
3. **真实跨天运行**未验证（时钟漂移、日志轮转、磁盘增长）。
4. **公网可达的真实被测系统 + 真实模型**未验证；`targetBaseUrl` 的 SSRF 判据默认
   拒绝本机与内网地址是**设计使然**。
