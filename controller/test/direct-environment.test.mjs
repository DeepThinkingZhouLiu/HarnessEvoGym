import assert from 'node:assert/strict'
import test from 'node:test'

import { buildDirectCommandEnvironment } from '../src/direct-environment.mjs'

test('direct command environment removes proxy endpoints without mutating its parent', () => {
  const parent = {
    PATH: '/usr/bin',
    HTTP_PROXY: 'http://proxy.invalid:8017',
    https_proxy: 'http://proxy.invalid:8017',
    ALL_PROXY: 'socks5://proxy.invalid:1080',
    VSCODE_PROXY_URI: 'http://proxy.invalid:8017',
    NO_PROXY: 'localhost',
  }
  const direct = buildDirectCommandEnvironment(parent)
  assert.equal(direct.PATH, '/usr/bin')
  assert.equal(direct.HTTP_PROXY, undefined)
  assert.equal(direct.https_proxy, undefined)
  assert.equal(direct.ALL_PROXY, undefined)
  assert.equal(direct.VSCODE_PROXY_URI, undefined)
  assert.equal(direct.NO_PROXY, '*')
  assert.equal(direct.no_proxy, '*')
  assert.equal(parent.HTTP_PROXY, 'http://proxy.invalid:8017')
  assert.equal(parent.NO_PROXY, 'localhost')
})
