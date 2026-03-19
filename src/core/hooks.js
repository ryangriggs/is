export class HookRegistry {
  #hooks = new Map()

  /**
   * Register a handler for an event.
   * @param {string} name - e.g. 'pre:link:create', 'post:link:visit'
   * @param {Function} fn - async (ctx) => void  (may throw to abort pre: hooks)
   * @param {number} priority - lower runs first (default 10)
   */
  on(name, fn, priority = 10) {
    if (!this.#hooks.has(name)) this.#hooks.set(name, [])
    this.#hooks.get(name).push({ fn, priority })
    this.#hooks.get(name).sort((a, b) => a.priority - b.priority)
  }

  /**
   * Run all handlers for an event.
   * pre: hooks — if any throws, the error propagates (aborts the operation).
   * post: hooks — errors are swallowed and logged.
   */
  async run(name, ctx) {
    const handlers = this.#hooks.get(name) ?? []
    const isPre = name.startsWith('pre:')

    for (const { fn } of handlers) {
      try {
        await fn(ctx)
      } catch (err) {
        if (isPre) throw err
        ctx.log?.warn({ err, hook: name }, 'post-hook error (swallowed)')
      }
    }
  }
}
