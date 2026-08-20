import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toContentBlocks, toToolRestriction } from '../src/harness/index.ts'
import type { ToolFilter } from '../src/types.ts'

test('toContentBlocks wraps prompt as a text ContentBlock', () => {
  const blocks = toContentBlocks('# 阶段 receive')
  assert.equal(blocks.length, 1)
  const block = blocks[0] as { type: string; text?: string }
  assert.equal(block.type, 'text')
  assert.equal(block.text, '# 阶段 receive')
})

test('toToolRestriction maps allow/deny and omits undefined keys', () => {
  const filter: ToolFilter = { allow: ['kb_query', 'fs_read'], deny: ['kb_write'] }
  const restriction = toToolRestriction(filter)
  assert.deepEqual(restriction.allow, ['kb_query', 'fs_read'])
  assert.deepEqual(restriction.deny, ['kb_write'])
  // allow 存在即白名单（harness 语义）
  assert.ok(restriction.allow !== undefined)

  const bare: ToolFilter = { deny: ['subagent'] }
  const bareRestriction = toToolRestriction(bare)
  assert.equal(bareRestriction.allow, undefined)
  assert.deepEqual(bareRestriction.deny, ['subagent'])
})
