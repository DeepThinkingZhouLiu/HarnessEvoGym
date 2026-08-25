/**
 * Build an environment for one direct-network Controller command.
 *
 * This deliberately returns a new object. The parent shell and Codex process
 * keep their proxy configuration; only the spawned experiment command loses
 * proxy endpoints. NO_PROXY=* is retained as an explicit fail-open bypass for
 * libraries that inspect bypass variables even when no proxy URL is present.
 */
export function buildDirectCommandEnvironment(baseEnvironment = process.env) {
  const output = {}
  for (const [key, value] of Object.entries(baseEnvironment ?? {})) {
    if (/proxy/iu.test(key) || typeof value !== 'string') continue
    output[key] = value
  }
  output.NO_PROXY = '*'
  output.no_proxy = '*'
  return output
}
