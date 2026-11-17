/**
 * waterfall 监听器的安全注册：**从结构上**保证插件永远不会截断宿主的调用链。
 *
 * ## 为什么必须有这一层
 *
 * Cordis 的 `waterfall` 语义（`@deepseek-ai/cordis` lib/index.js:903-918）：
 *
 * ```js
 * waterfall(...args) {
 *   const inner = args.pop();          // 宿主提供的默认行为
 *   const dispatch = () => {
 *     const callback = callbacks.shift();
 *     if (!callback) return inner();
 *     let called = false;
 *     const next = () => {
 *       if (called) throw new Error("next() called multiple times");
 *       called = true;
 *       return dispatch();
 *     };
 *     return Reflect.apply(callback, thisArg, [...args, next]);
 *   };
 *   return dispatch();
 * }
 * ```
 *
 * 即：**不调用 `next()` 的监听器会否决它之后的整条链，包括宿主的默认行为**，
 * 而 waterfall 的返回值就是最外层监听器的返回值。宿主随后往往直接读属性：
 *
 * ```js
 * const decision = await this.dispatch.waterfall("agent/pre-step", {...}, () => ({kind:"enter", …}));
 * if (decision.kind === "reject") { … }        // 无保护访问
 * ```
 *
 * 所以一个忘了 `return next()` 的监听器会让 `decision` 变成 `undefined`，
 * 宿主立刻抛 `Cannot read properties of undefined (reading 'kind')` —— 这正是
 * 本插件 2.0.2 造成"每次回合开始即崩溃"的原因。DSH 官方文档
 * （`skills/dsh-doc/references/practices.md` 第 16 行）明确写着这条规则：
 * 不拥有该决策的 waterfall 监听器**必须** `return next()`。
 *
 * 依赖"人别忘"是不够的。这个包装器把规则变成结构约束：
 *
 *  1. handler 返回 `undefined`（无论它是忘了还是刻意弃权）→ 包装器补调用 `next()`；
 *  2. handler 抛错 → 记录后仍然调用 `next()`，插件的 bug 不会变成宿主的崩溃；
 *  3. `next()` 最多被调用一次（Cordis 会对重复调用抛错，包装器用 `consumed` 挡住）；
 *  4. 返回值永远是 `next()` 的结果或 handler 显式给出的决策，**不会是 undefined**。
 *
 * 因此"忘记 `next()`"这个失败模式在本插件里不可能再出现。
 *
 * @module dsh-image-budget/hooks
 */

/**
 * 注册一个 waterfall 监听器，并保证链不被截断。
 *
 * @param ctx - 插件上下文。
 * @param event - 事件名（必须是 waterfall 模式派发的事件）。
 * @param handler - `(...宿主参数, next) => decision | undefined`；
 *   返回 `undefined` 表示"不参与决策"，由包装器接着调用 `next()`。
 * @param options - 透传给 `ctx.on`（例如 `{prepend: true}`）。
 * @returns `ctx.on` 的注册句柄。
 */
export function onWaterfall(ctx, event, handler, options) {
  const report = (error) => {
    try {
      ctx.logger?.warn?.(`image-budget: "${event}" listener failed: ${String(error?.message ?? error)}`);
    } catch {
      /* 记录失败也不能影响链 */
    }
  };

  return ctx.on(
    event,
    async function waterfallListener(...args) {
      const next = args.pop();
      let consumed = false;
      let pending;
      /** 调用下游一次，重复调用返回同一个结果。 */
      const once = () => {
        if (!consumed) {
          consumed = true;
          pending = next();
        }
        return pending;
      };

      try {
        const decision = await handler(...args, once);
        if (decision !== undefined) return decision;
      } catch (error) {
        report(error);
      }
      // handler 弃权、抛错、或返回 undefined：一律交回下游，绝不让 waterfall 返回 undefined。
      return await once();
    },
    options,
  );
}

/**
 * 注册一个普通通知监听器（`emit` / `serial` 模式），并把抛错收进日志。
 *
 * `emit` 模式下 Cordis 会丢弃返回值并各自捕获异常，但 `serial` 会 await 并在
 * 抛错时中断后续监听器；统一在这里兜住，插件的 bug 不影响宿主。
 *
 * @param ctx - 插件上下文。
 * @param event - 事件名。
 * @param handler - 监听器。
 * @param options - 透传给 `ctx.on`。
 */
export function onNotify(ctx, event, handler, options) {
  return ctx.on(
    event,
    async (...args) => {
      try {
        return await handler(...args);
      } catch (error) {
        try {
          ctx.logger?.warn?.(`image-budget: "${event}" listener failed: ${String(error?.message ?? error)}`);
        } catch {
          /* ignore */
        }
        return undefined;
      }
    },
    options,
  );
}
