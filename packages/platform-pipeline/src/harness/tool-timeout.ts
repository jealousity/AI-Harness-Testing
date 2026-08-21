/**
 * 工具调用超时强制（用户硬性要求：工具调用时间超过 3 分钟自动退出并汇报）。
 *
 * 独立 npm 包部署模型（I-4）：本模块只依赖 cordis + dsh-tools + dsh-timeout
 * （peer/devDeps），不依赖 harness 的 timeout-policy 插件包，宿主可零配置获得
 * 同等语义：
 * - 工具定义声明 `timeoutMs`（如 180000 = 3 分钟）即被强制执行；
 * - 超时后工具调用被中止（exec.signal abort），返回结构化 `TOOL_TIMEOUT`
 *   错误结果给 agent（模型可见，可据此重试/降级），并向宿主汇报（console +
 *   结果 detail）；
 * - 未声明 timeoutMs 的工具不设时限，原样委托。
 *
 * 用法：
 * ```ts
 * import { applyToolTimeoutPolicy } from './tool-timeout.ts'
 * applyToolTimeoutPolicy(ctx) // 注册一次
 * // 之后：defineTool({ ..., timeoutMs: 180000 }) 即受保护
 * ```
 * @module platform-pipeline/harness/tool-timeout
 */

import type { Context } from '@deepseek-ai/cordis'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/** 本插件拥有的超时代码（与 harness timeout-policy 对齐，便于跨宿主识别）。 */
export const TOOL_TIMEOUT = 'TOOL_TIMEOUT'

/** 结构化超时结果：agent 可见的 isError 消息 + 宿主可路由的 error.code。 */
export function toolTimeoutResult(timeoutMs: number): ToolExecutionResult {
  const message = `工具调用超过 ${Math.round(timeoutMs / 1000)} 秒（${timeoutMs}ms）未返回，已自动中止并退出本次调用`
  console.error(`[tool-timeout] ${message}`) // 宿主侧汇报
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
    error: { message, info: { name: 'ToolTimeoutError', code: TOOL_TIMEOUT } },
  }
}

/**
 * 注册 tools/execute 包装：为声明 timeoutMs 的工具套上 deadline（超时 → abort
 * 信号 → 工具自我收敛），并在本插件计时器胜出时把结果替换为 TOOL_TIMEOUT。
 * 嵌套外层 deadline 的计时器先触发时按普通上游取消处理（timeoutOf 按 code 区分）。
 */
export function applyToolTimeoutPolicy(ctx: Context): void {
  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    const timeoutMs = ctx.tools.get(exec.name, exec.agent)?.timeoutMs
    if (timeoutMs === undefined || timeoutMs <= 0) return next()

    using d = deadline(exec.signal, timeoutMs, TOOL_TIMEOUT)
    const upstream = exec.signal
    exec.signal = d.signal
    try {
      const result = await next()
      if (timeoutOf(d.signal, TOOL_TIMEOUT) !== undefined) {
        return toolTimeoutResult(timeoutMs)
      }
      return result
    } finally {
      exec.signal = upstream
    }
  })
}
