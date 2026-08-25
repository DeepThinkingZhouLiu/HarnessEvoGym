#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { buildDirectCommandEnvironment } from '../controller/src/direct-environment.mjs'

const args = process.argv.slice(2)
const credentialOptions = ['--provider-key-fd', '--zcloud-key-fd']
  .map((name) => args.indexOf(name))
  .filter((index) => index >= 0)
if (credentialOptions.length > 1) {
  throw new Error('provide exactly one provider credential descriptor option')
}
const credentialOption = credentialOptions[0] ?? -1
let credentialFd = null
if (credentialOption >= 0) {
  const value = Number(args[credentialOption + 1])
  if (!Number.isSafeInteger(value) || value < 3 || value > 64) {
    throw new Error('provider key must be an inherited descriptor in 3..64')
  }
  credentialFd = value
}

const stdio = ['inherit', 'inherit', 'inherit']
if (credentialFd !== null) {
  while (stdio.length <= credentialFd) stdio.push('ignore')
  stdio[credentialFd] = credentialFd
}

const cliPath = fileURLToPath(new URL('../controller/src/cli.mjs', import.meta.url))
const child = spawn(process.execPath, [cliPath, ...args], {
  env: buildDirectCommandEnvironment(process.env),
  stdio,
})

child.once('error', (error) => {
  process.stderr.write(`Unable to start direct Controller command: ${error.message}\n`)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0)
})
