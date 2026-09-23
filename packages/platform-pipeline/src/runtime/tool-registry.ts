import type { ToolDefinition, ToolExecutionContext, ToolFilter, ToolRegistry } from './ports.ts'

export class ToolAccessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolAccessError'
  }
}

/** 轻量、无 Harness 依赖的工具注册表；可作为 CLI/Web/其他 Agent runtime 的基础实现。 */
export class InMemoryToolRegistry implements ToolRegistry {
  private readonly tools: Map<string, ToolDefinition>
  private readonly filter?: ToolFilter

  constructor(tools?: Iterable<ToolDefinition>, filter?: ToolFilter) {
    this.tools = new Map([...tools ?? []].map(tool => [tool.name, tool]))
    this.filter = filter
  }

  register<TArgs, TResult>(tool: ToolDefinition<TArgs, TResult>): void {
    if (tool.name.trim() === '') throw new Error('tool name must not be empty')
    if (this.tools.has(tool.name)) throw new Error(`tool already registered: ${tool.name}`)
    this.tools.set(tool.name, tool)
  }

  get(name: string): ToolDefinition | undefined {
    const tool = this.tools.get(name)
    if (tool === undefined || !isAllowed(name, this.filter)) return undefined
    return tool
  }

  list(): readonly ToolDefinition[] {
    return [...this.tools.values()].filter(tool => isAllowed(tool.name, this.filter))
  }

  restrict(filter: ToolFilter): ToolRegistry {
    for (const name of [...filter.allow ?? [], ...filter.deny ?? []]) {
      if (!this.tools.has(name)) throw new ToolAccessError(`unknown tool in restriction: ${name}`)
    }
    return new InMemoryToolRegistry(this.tools.values(), mergeFilters(this.filter, filter))
  }
}

export async function executeTool<TArgs, TResult>(registry: ToolRegistry, name: string, args: TArgs, context: ToolExecutionContext): Promise<TResult> {
  const tool = registry.get(name)
  if (tool === undefined) throw new ToolAccessError(`tool is not available: ${name}`)
  return tool.execute(args, context) as Promise<TResult>
}

function isAllowed(name: string, filter: ToolFilter | undefined): boolean {
  if (filter === undefined) return true
  if (filter.deny?.includes(name)) return false
  return filter.allow === undefined || filter.allow.includes(name)
}

function mergeFilters(parent: ToolFilter | undefined, child: ToolFilter): ToolFilter {
  const parentAllow = parent?.allow
  const childAllow = child.allow
  const allow = childAllow === undefined
    ? parentAllow
    : parentAllow === undefined
      ? childAllow
      : childAllow.filter(name => parentAllow.includes(name))
  return {
    ...(allow === undefined ? {} : { allow }),
    deny: [...new Set([...(parent?.deny ?? []), ...(child.deny ?? [])])],
  }
}
