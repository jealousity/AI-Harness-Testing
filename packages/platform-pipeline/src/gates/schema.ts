/**
 * JSON Schema 子集校验器（docs/01 G-01：type/properties/required/additionalProperties/items/enum/const/oneOf）。
 * 仅实现设计约定的子集；错误带路径，供机器门禁判定留痕。
 * @module platform-pipeline/gates/schema
 */

export interface SubsetSchema {
  readonly type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'json'
  readonly properties?: Readonly<Record<string, SubsetSchema>>
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean
  readonly items?: SubsetSchema
  /** 数组最小长度（G-02 判定"必填数组不允许空"用；缺省 = 允许空）。 */
  readonly minItems?: number
  readonly enum?: readonly unknown[]
  readonly const?: unknown
  readonly oneOf?: readonly SubsetSchema[]
}

/** 深度相等（enum/const 判定用；仅处理 JSON 值）。 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((item, i) => deepEqual(item, b[i]))
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const oa = a as Record<string, unknown>
    const ob = b as Record<string, unknown>
    const ka = Object.keys(oa)
    const kb = Object.keys(ob)
    if (ka.length !== kb.length) return false
    return ka.every(key => key in ob && deepEqual(oa[key], ob[key]))
  }
  return false
}

function jsonType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case 'json': return true
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number'
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return false
  }
}

/** 校验值是否符合子集 schema；返回错误列表（空 = 通过）。 */
export function validateSubset(value: unknown, schema: SubsetSchema, path = '$'): string[] {
  const errors: string[] = []
  if (schema.type !== undefined && !typeMatches(value, schema.type)) {
    errors.push(`${path}: expected ${schema.type}, got ${jsonType(value)}`)
  }

  if (schema.type === 'object' || (schema.type === undefined && value !== null && typeof value === 'object' && !Array.isArray(value))) {
    const obj = value as Record<string, unknown>
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${path}: missing required "${key}"`)
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}))
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) errors.push(`${path}: unexpected property "${key}"`)
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj) errors.push(...validateSubset(obj[key], sub, `${path}.${key}`))
    }
  }

  if (schema.type === 'array' && Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) => {
      errors.push(...validateSubset(item, schema.items as SubsetSchema, `${path}[${index}]`))
    })
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.minItems !== undefined && value.length < schema.minItems) {
    errors.push(`${path}: expected at least ${schema.minItems} items, got ${value.length}`)
  }

  if (schema.enum !== undefined && !schema.enum.some(candidate => deepEqual(candidate, value))) {
    errors.push(`${path}: value not in enum ${JSON.stringify(schema.enum)}`)
  }
  if (schema.const !== undefined && !deepEqual(schema.const, value)) {
    errors.push(`${path}: value !== ${JSON.stringify(schema.const)}`)
  }
  if (schema.oneOf !== undefined) {
    const matched = schema.oneOf.filter(sub => validateSubset(value, sub, path).length === 0).length
    if (matched !== 1) errors.push(`${path}: must match exactly one of oneOf (matched ${matched})`)
  }
  return errors
}
