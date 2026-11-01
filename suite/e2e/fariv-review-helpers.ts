import { createServer, type IncomingMessage, type Server } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { defaultAiSettings, resolveCustomEndpoints } from '@genoffice/ai-provider'

/**
 * A SIMULATED model for the Fariv review e2e: a local OpenAI-compatible endpoint whose
 * replies are scripted per run (no Codex/Claude involved). The script sees the user's
 * instruction and the tool results of the current run and answers with a tool call,
 * a text, or an HTTP failure; it may await a gate the test opens, to hold the run
 * while the test edits the document by hand.
 */

export interface RunContext {
  /** the last user message of the conversation */
  readonly instruction: string
  /** tool results since that message, oldest first */
  readonly toolResults: readonly string[]
}

export type ModelReply =
  | { readonly tool: string; readonly args: unknown }
  | { readonly text: string }
  | { readonly fail: string }

export type ModelScript = (run: RunContext) => ModelReply | Promise<ModelReply>

export interface Deferred {
  readonly promise: Promise<void>
  resolve(): void
}

export function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

function text(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content.map((p) => (p as { text?: string }).text ?? '').join('')
  return ''
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

let callSeq = 0

export async function startScriptedModel(
  script: ModelScript,
): Promise<{ server: Server; port: number }> {
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404).end()
      return
    }
    const body = JSON.parse(await readBody(req)) as {
      messages: Array<{ role: string; content: unknown }>
    }
    let lastUser = -1
    body.messages.forEach((m, i) => {
      if (m.role === 'user') lastUser = i
    })
    const run: RunContext = {
      instruction: text(body.messages[lastUser]?.content),
      toolResults: body.messages
        .slice(lastUser + 1)
        .filter((m) => m.role === 'tool')
        .map((m) => text(m.content)),
    }
    const reply = await script(run)
    if ('fail' in reply) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: reply.fail } }))
      return
    }
    const message =
      'tool' in reply
        ? {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: `call_${reply.tool}_${++callSeq}`,
                type: 'function',
                function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
              },
            ],
          }
        : { role: 'assistant', content: reply.text }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        choices: [{ message, finish_reason: 'tool' in reply ? 'tool_calls' : 'stop' }],
      }),
    )
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  return { server, port: (server.address() as AddressInfo).port }
}

/** Point the app at the simulated model (a custom OpenAI-compatible endpoint). */
export async function useScriptedModel(userDataDir: string, port: number): Promise<void> {
  const settings = defaultAiSettings()
  settings.provider = 'custom'
  settings.providers.custom = {
    apiKey: 'stub',
    model: 'stub-model',
    baseUrl: `http://127.0.0.1:${port}/v1`,
  }
  await writeFile(
    join(userDataDir, 'ai-settings.json'),
    JSON.stringify(resolveCustomEndpoints(settings)),
  )
}

/** `KEY: value` line of an instruction ('' when absent). */
export function directive(instruction: string, key: string): string {
  return new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm').exec(instruction)?.[1] ?? ''
}

/**
 * The common run shape of these tests: `steps` tool calls in order, then — when the
 * instruction says ESPERA — the gate (the run holds while the test edits by hand),
 * then FALHA (HTTP 500) or a closing text.
 */
export function scriptedRun(
  run: RunContext,
  steps: readonly ((results: readonly string[]) => ModelReply)[],
  gate?: { reached: Deferred; release: Deferred },
): ModelReply | Promise<ModelReply> {
  const done = run.toolResults.length
  if (done < steps.length) return steps[done]!(run.toolResults)
  const finish = (): ModelReply =>
    run.instruction.includes('FALHA')
      ? { fail: 'simulated failure after a change' }
      : { text: 'Pronto.' }
  if (gate && run.instruction.includes('ESPERA')) {
    gate.reached.resolve()
    return gate.release.promise.then(finish)
  }
  return finish()
}
