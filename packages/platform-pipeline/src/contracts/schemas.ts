/**
 * 六阶段契约 schema（docs/02 第 3 节输出 schema，转成 G-01/G-02 可判定的 SubsetSchema）。
 * 供机器门禁 G-01（结构校验）与 G-02（必填非空）使用；阶段特定语义由 R 系列规则承担。
 * @module platform-pipeline/contracts/schemas
 */

import type { StageId } from '../types.ts'
import type { SubsetSchema } from '../gates/schema.ts'

const STRING = { type: 'string' } as const
const STRING_ARRAY = { type: 'array', items: STRING } as const
const NON_EMPTY_STRING_ARRAY = { type: 'array', minItems: 1, items: STRING } as const

export const STAGE_SCHEMAS: Readonly<Record<StageId, SubsetSchema>> = {
  receive: {
    type: 'object',
    additionalProperties: false,
    required: ['requirements', 'clarifications'],
    properties: {
      requirements: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'title', 'goals', 'changePoints', 'acceptance', 'priority', 'sourceRef'],
          properties: {
            id: STRING,
            title: STRING,
            background: STRING,
            goals: NON_EMPTY_STRING_ARRAY,
            changePoints: NON_EMPTY_STRING_ARRAY,
            acceptance: NON_EMPTY_STRING_ARRAY,
            priority: { type: 'string', enum: ['P0', 'P1', 'P2'] },
            sourceRef: STRING,
          },
        },
      },
      clarifications: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['requirementId', 'field', 'question'],
          properties: { requirementId: STRING, field: STRING, question: STRING },
        },
      },
    },
  },

  analyze: {
    type: 'object',
    additionalProperties: false,
    required: ['boundaries', 'scope', 'versionImpact', 'reuseSuggestions', 'openQuestions', 'riskNotes', 'retrievalTruncated'],
    properties: {
      boundaries: {
        type: 'object',
        additionalProperties: false,
        required: ['in', 'out'],
        properties: { in: NON_EMPTY_STRING_ARRAY, out: STRING_ARRAY },
      },
      scope: STRING,
      versionImpact: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['version', 'impact', 'evidence'],
          properties: { version: STRING, impact: STRING, evidence: STRING },
        },
      },
      reuseSuggestions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['caseId', 'reason', 'adaptation'],
          properties: {
            caseId: STRING,
            reason: STRING,
            adaptation: { type: 'string', enum: ['unchanged', 'modify-data', 'modify-expectation'] },
          },
        },
      },
      openQuestions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['question', 'needs', 'related'],
          properties: { question: STRING, needs: STRING, related: STRING },
        },
      },
      riskNotes: STRING_ARRAY,
      retrievalTruncated: { type: 'boolean' },
    },
  },

  design: {
    type: 'object',
    additionalProperties: false,
    required: ['testCases', 'reusedCases', 'coverageMatrix', 'gaps'],
    properties: {
      testCases: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'title', 'preconditions', 'execution_level', 'priority', 'coverageRef', 'steps', 'expected'],
          properties: {
            id: STRING,
            title: STRING,
            preconditions: STRING_ARRAY,
            execution_level: { type: 'string', enum: ['auto', 'hybrid', 'manual'] },
            priority: { type: 'string', enum: ['P0', 'P1', 'P2'] },
            coverageRef: NON_EMPTY_STRING_ARRAY,
            steps: { type: 'array', minItems: 1, items: { type: 'object' } },
            expected: NON_EMPTY_STRING_ARRAY,
            data: STRING,
            cleanup: STRING,
          },
        },
      },
      reusedCases: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'sourceCaseId', 'title', 'adaptation', 'coverageRef', 'steps', 'expected'],
          properties: {
            id: STRING,
            sourceCaseId: STRING,
            title: STRING,
            adaptation: { type: 'string', enum: ['unchanged', 'modify-data', 'modify-expectation'] },
            preconditions: STRING_ARRAY,
            execution_level: { type: 'string', enum: ['auto', 'hybrid', 'manual'] },
            priority: { type: 'string', enum: ['P0', 'P1', 'P2'] },
            coverageRef: NON_EMPTY_STRING_ARRAY,
            steps: { type: 'array', minItems: 1, items: { type: 'object' } },
            expected: NON_EMPTY_STRING_ARRAY,
          },
        },
      },
      coverageMatrix: { type: 'object' },
      gaps: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['requirementId', 'reason'],
          properties: { requirementId: STRING, reason: STRING },
        },
      },
    },
  },

  execute: {
    type: 'object',
    additionalProperties: false,
    required: ['plan', 'results', 'envIssues', 'pendingManual', 'resumed'],
    properties: {
      plan: {
        type: 'object',
        additionalProperties: false,
        required: ['env', 'executors', 'order'],
        properties: {
          env: NON_EMPTY_STRING_ARRAY,
          executors: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['level', 'impl'],
              properties: {
                level: { type: 'string', enum: ['auto', 'hybrid', 'manual'] },
                impl: STRING,
              },
            },
          },
          order: { type: 'array', minItems: 1, items: STRING },
        },
      },
      results: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['caseId', 'recordRef', 'status', 'durationMs', 'attempts'],
          properties: {
            caseId: STRING,
            recordRef: STRING,
            status: { type: 'string', enum: ['pass', 'fail', 'pending'] },
            evidence: { type: 'array', items: STRING },
            durationMs: { type: 'integer' },
            attempts: { type: 'integer' },
            envIssueId: STRING,
            manualClaimed: { type: 'boolean' },
            attestedBy: STRING,
            sessionId: STRING,
            note: STRING,
          },
        },
      },
      envIssues: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'category', 'severity', 'issue', 'diagnosis', 'impact', 'resolution', 'recommendation'],
          properties: {
            id: STRING,
            category: { type: 'string', enum: ['network', 'disk', 'server', 'credentials', 'other'] },
            severity: { type: 'string', enum: ['blocking', 'degrading', 'warning'] },
            issue: STRING,
            diagnosis: NON_EMPTY_STRING_ARRAY,
            impact: { type: 'array', items: STRING },
            resolution: STRING,
            recommendation: STRING,
          },
        },
      },
      pendingManual: { type: 'array', items: STRING },
      resumed: { type: 'boolean' },
    },
  },

  report: {
    type: 'object',
    additionalProperties: false,
    required: ['stats', 'defectAnalysis', 'risks', 'releaseRecommendation', 'recommendationReason', 'unconfirmed'],
    properties: {
      stats: {
        type: 'object',
        additionalProperties: false,
        required: ['total', 'passed', 'failed', 'passRate', 'byPriority', 'byModule', 'bySource'],
        properties: {
          total: { type: 'integer' },
          passed: { type: 'integer' },
          failed: { type: 'integer' },
          passRate: { type: 'number' },
          byPriority: { type: 'object' },
          byModule: { type: 'object' },
          bySource: { type: 'object' },
        },
      },
      defectAnalysis: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['caseId', 'defect', 'severity', 'evidence', 'classification'],
          properties: {
            caseId: STRING,
            defect: STRING,
            severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
            evidence: { type: 'array', items: STRING },
            classification: { type: 'string', enum: ['defect', 'case-issue', 'env-issue', 'suspected'] },
          },
        },
      },
      risks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['risk', 'level', 'evidence'],
          properties: {
            risk: STRING,
            level: { type: 'string', enum: ['high', 'medium', 'low'] },
            evidence: STRING,
          },
        },
      },
      releaseRecommendation: { type: 'string', enum: ['approve', 'conditional', 'reject'] },
      recommendationReason: STRING,
      unconfirmed: { type: 'array', items: STRING },
    },
  },

  archive: {
    type: 'object',
    additionalProperties: false,
    required: ['knowledgeEntries', 'caseArchive', 'versionArchive', 'archiveReport'],
    properties: {
      knowledgeEntries: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'title', 'date', 'project', 'version', 'tags', 'entities', 'body', 'sourcePipeline'],
          properties: {
            id: STRING, title: STRING, date: STRING, project: STRING, version: STRING,
            tags: STRING_ARRAY,
            entities: NON_EMPTY_STRING_ARRAY,
            body: STRING,
            sourcePipeline: STRING,
          },
        },
      },
      caseArchive: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['caseId', 'version', 'sourceRequirement', 'ticketRef', 'content'],
          properties: {
            caseId: STRING, version: STRING, sourceRequirement: STRING, ticketRef: STRING,
            content: { type: 'json' },
          },
        },
      },
      versionArchive: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['version', 'changeSummary'],
          properties: { version: STRING, changeSummary: STRING },
        },
      },
      archiveReport: {
        type: 'object',
        additionalProperties: false,
        required: ['entries', 'cases', 'skipped', 'written'],
        properties: {
          entries: { type: 'integer' },
          cases: { type: 'integer' },
          skipped: { type: 'array', items: STRING },
          written: { type: 'boolean' },
        },
      },
    },
  },
}

/** 插件默认契约：各阶段 schema 表（G-01/G-02 用）。 */
export function pipelineContractSchemas(): Readonly<Record<StageId, SubsetSchema>> {
  return STAGE_SCHEMAS
}
