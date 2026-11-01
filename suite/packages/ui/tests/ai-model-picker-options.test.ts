import { describe, expect, it } from 'vitest'
import { AI_PROVIDERS, defaultAiSettings } from '@genoffice/ai-provider'
import {
  aiModelPickerGroups,
  aiModelPickerSelection,
  withAiModelSelection,
} from '../src/ai-model-picker-options'

const anthropicModels = AI_PROVIDERS.find((m) => m.id === 'anthropic')!.models
/** Fariv: the default local Codex is always offered (it auto-discovers its binary) */
const CODEX = { id: 'codex', label: 'Codex CLI', models: [] }

describe('aiModelPickerGroups', () => {
  it('lists only the default local Codex while signed out with no keys', () => {
    expect(aiModelPickerGroups(defaultAiSettings(), false)).toEqual([CODEX])
  })

  it('lists Genspark only when signed in', () => {
    const ids = aiModelPickerGroups(defaultAiSettings(), true).map((g) => g.id)
    expect(ids).toEqual(['genspark', 'codex'])
  })

  it('adds a vendor once its key is set and puts an off-catalog model first', () => {
    const settings = defaultAiSettings()
    settings.providers.anthropic = { apiKey: 'k', model: 'claude-next' }
    const groups = aiModelPickerGroups(settings, false)
    expect(groups.map((g) => g.id)).toEqual(['codex', 'anthropic'])
    expect(groups[1]!.models).toEqual(['claude-next', ...anthropicModels])
  })

  it('needs a base URL for custom endpoints', () => {
    const settings = defaultAiSettings()
    settings.providers.custom = { apiKey: '', model: 'llama', baseUrl: '' }
    expect(aiModelPickerGroups(settings, false)).toEqual([CODEX])
    settings.providers.custom = { apiKey: '', model: 'llama', baseUrl: 'http://localhost:11434/v1' }
    expect(aiModelPickerGroups(settings, false).map((g) => g.id)).toEqual(['codex', 'custom'])
  })
})

describe('selection round trip', () => {
  it('switches provider and model in one write and reads back', () => {
    const settings = defaultAiSettings()
    settings.providers.anthropic = { apiKey: 'k', model: anthropicModels[0]! }
    const next = withAiModelSelection(settings, {
      provider: 'anthropic',
      model: anthropicModels[1]!,
    })
    expect(next.provider).toBe('anthropic')
    expect(next.providers.anthropic.apiKey).toBe('k')
    expect(aiModelPickerSelection(next)).toEqual({
      provider: 'anthropic',
      model: anthropicModels[1],
    })
    expect(settings.providers.anthropic.model).toBe(anthropicModels[0])
  })

  it('falls back to the default local Codex when the stored provider is unusable', () => {
    const settings = defaultAiSettings()
    settings.provider = 'anthropic'
    expect(aiModelPickerSelection(settings).provider).toBe('codex')
  })
})

describe('CLI vendors', () => {
  it('always lists the default Codex, with or without a stored path', () => {
    const settings = defaultAiSettings()
    expect(aiModelPickerGroups(settings, false)).toEqual([CODEX])
    settings.providers.codex = { apiKey: '', model: '', cliPath: '/usr/local/bin/codex' }
    expect(aiModelPickerGroups(settings, false)).toEqual([CODEX])
  })
})

describe('custom endpoints', () => {
  const settings = () => ({
    ...defaultAiSettings(),
    customEndpoints: [
      {
        id: 'a',
        name: 'Ollama',
        baseUrl: 'http://localhost:11434/v1',
        apiKey: '',
        model: 'llama3',
      },
      {
        id: 'b',
        name: '',
        baseUrl: 'https://gw.example.com/v1',
        apiKey: 'k',
        model: 'gpt-x',
        models: ['gpt-y'],
      },
      { id: 'c', name: 'Empty', baseUrl: '', apiKey: '', model: 'm' },
    ],
    customEndpoint: 'a',
  })

  it('lists one group per configured endpoint with its cached models', () => {
    const groups = aiModelPickerGroups(settings(), false)
    expect(groups).toEqual([
      CODEX,
      { id: 'custom', endpoint: 'a', label: 'Ollama', models: ['llama3'] },
      { id: 'custom', endpoint: 'b', label: 'gw.example.com', models: ['gpt-x', 'gpt-y'] },
    ])
  })

  it('picking a model on another endpoint activates that endpoint', () => {
    const start = { ...settings(), provider: 'custom' as const }
    expect(aiModelPickerSelection(start)).toEqual({
      provider: 'custom',
      endpoint: 'a',
      model: 'llama3',
    })
    const next = withAiModelSelection(start, { provider: 'custom', endpoint: 'b', model: 'gpt-y' })
    expect(aiModelPickerSelection(next)).toEqual({
      provider: 'custom',
      endpoint: 'b',
      model: 'gpt-y',
    })
    expect(next.providers.custom).toEqual({
      apiKey: 'k',
      model: 'gpt-y',
      baseUrl: 'https://gw.example.com/v1',
    })
    expect(next.customEndpoints!.find((e) => e.id === 'a')!.model).toBe('llama3')
  })
})
