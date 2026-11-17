/**
 * 测试用的**真实** cordis 宿主替身。
 *
 * 教训：本插件 2.0.2 的测试用了一个自己写的假 ctx，直接调用 `handler(payload)`，
 * 于是"监听器忘了 `return next()`"这一整类错误完全测不出来 —— 而那正是让
 * 用户每次回合开始都崩 `Cannot read properties of undefined (reading 'kind')`
 * 的原因。假 ctx 复现不了 waterfall 的语义，所以这里只做两件事：
 *
 *   1. 加载**真正的** `@deepseek-ai/cordis`（npm 上有，与安装版本同号）；
 *   2. 照抄宿主源码的派发写法，包括返回值的读取方式。
 *
 * 缺依赖时抛出明确错误，绝不静默通过。
 *
 * @module dsh-image-budget/test/harness
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const pluginDir = join(here, "..");

/** 找到真实的 cordis 入口；找不到就抛错（测试不允许在缺依赖时通过）。 */
export function loadCordisEntry() {
  const candidates = [
    process.env.DSH_CORDIS_PATH,
    join(pluginDir, "node_modules", "@deepseek-ai", "cordis", "lib", "index.js"),
  ].filter((value) => typeof value === "string" && value.length > 0);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    return createRequire(join(pluginDir, "package.json")).resolve("@deepseek-ai/cordis");
  } catch {
    throw new Error(
      "找不到真实的 @deepseek-ai/cordis。先运行 `npm install`（devDependencies 里有 cordis@4.1.0），\n" +
        "或把 DSH_CORDIS_PATH 指向安装版本里的 cordis 入口。契约测试不允许在缺依赖时通过。",
    );
  }
}

export const cordisEntry = loadCordisEntry();
export const { Context } = await import(pathToFileURL(cordisEntry).href);

/**
 * 宿主派发站点：**照抄**安装版本的源码，连注释里的行号都对应。
 *
 * 每一项的 `read` 复现宿主读返回值的方式 —— 缺少保护，所以链断了就会抛。
 */
export const HOST = {
  /** dsh-agent-loop/lib/index.js:698-712 */
  async preStep(ctx, payload, probe) {
    if (probe !== undefined) ctx.on("agent/pre-step", async (inner, next) => (probe(), next()));
    const decision = await ctx.waterfall({}, "agent/pre-step", payload, () =>
      Promise.resolve({ kind: "enter", messages: [], startsRequestSeries: false }),
    );
    // 宿主紧接着的两行：无保护属性访问 + 展开
    if (decision.kind === "reject") return decision;
    return { ...decision };
  },

  /** dsh-agent-loop/lib/index.js:942-952 */
  async requestError(ctx, payload) {
    const action = await ctx.waterfall({}, "agent/request-error", payload, () => Promise.resolve(undefined));
    return { action, retry: action?.kind === "retry" };
  },

  /**
   * dsh-tools/lib/pipeline.js:667-699。
   *
   * **关键**：终端默认决策是裸的 `{kind:"accept"}`，工具结果的内容在 `result.content` 里。
   * 这个替身必须照抄这一点 —— 之前把内容塞进 fallback 决策里，导致"插件读错地方"
   * 这类缺陷在契约测试里完全看不出来（真机 runner 才发现）。
   * 返回的是宿主**应用决策之后**的最终结果，也就是模型真正看到的东西。
   */
  async postExecute(ctx, exec, result) {
    const decision = await ctx.waterfall({}, "tools/post-execute", exec, result, () => Promise.resolve({ kind: "accept" }));
    void decision.kind; // 宿主此处是无保护访问
    if (Object.hasOwn(decision, "content") && Object.hasOwn(decision, "value")) {
      throw new TypeError("tools/post-execute accept decision cannot replace both value and content");
    }
    // 照抄 pipeline.js:694-698 的应用步骤
    return { ...result, ...(decision.content === undefined ? {} : { content: decision.content }) };
  },

  /** dsh-compaction-basic/lib/index.js:1034-1039 */
  async summaryError(ctx, payload) {
    return ctx.waterfall({}, "compaction/summary-error", payload, () => false);
  },
};

/**
 * 启动一个装了插件的真 cordis 根上下文。
 *
 * @param plugin - 插件的 ES 模块命名空间。
 * @param config - 插件配置。
 * @param services - 额外服务桩，例如 `{sessions: {...}}`。
 */
export function boot(plugin, config = {}, services = {}) {
  const ctx = new Context();
  const provided = { sessions: { messageProjections: [{ type: "image/offload" }] }, ...services };
  for (const [name, impl] of Object.entries(provided)) {
    ctx.provide(name);
    ctx.set(name, impl);
  }
  plugin.apply(ctx, config);
  return ctx;
}

/**
 * 会话替身：实现本插件用到的四个成员，**并且忠实应用 `image/offload` 投影**。
 *
 * 这一条很重要：真实会话在派发消息时会按 `image/offload` 把指定图片标成
 * `offloaded: true`，于是 `imagesOf` 会跳过它们、第二次救援自然无图可删。
 * 如果替身不实现这一步，"救援会不会活锁"就测不出来（2.0.2 的测试就是这样漏掉的）。
 */
export function makeSession(events = []) {
  const appended = [];
  /** seq -> Set<imageIndex>，按追加顺序累积。 */
  const offloaded = new Map();
  const apply = (targets) => {
    for (const target of targets ?? []) {
      const set = offloaded.get(target.seq) ?? new Set();
      for (const index of target.imageIndexes ?? []) set.add(index);
      offloaded.set(target.seq, set);
    }
  };
  return {
    appended,
    surface: { nodes: events.map((event) => event.seq) },
    eventAt(seq) {
      return events.find((event) => event.seq === seq);
    },
    deriveEventMessage(event) {
      const message = event.data.message ?? event.data;
      const marked = offloaded.get(event.seq);
      if (marked === undefined || !Array.isArray(message?.content)) return message;
      let imageIndex = 0;
      const content = message.content.map((block) => {
        if (block?.type !== "image") return block;
        const index = imageIndex++;
        return marked.has(index) ? { ...block, offloaded: true } : block;
      });
      return { ...message, content };
    },
    append(type, data) {
      appended.push({ type, data });
      if (type === "image/offload") apply(data?.targets);
    },
  };
}

/** 一条只含图片的消息事件。 */
export function imageEvent(seq, bytes, extra = []) {
  return {
    seq,
    type: "user/message",
    data: { message: { content: [{ type: "image", attachment: { bytes } }, ...extra] } },
  };
}

/** 一份可用的浏览器会话桩（附件仓储）。 */
export function attachmentStub(overrides = {}) {
  return {
    async saveImage({ data, mediaType }) {
      return { attachmentId: "new", mediaType, bytes: data.byteLength, width: 900, height: 632, name: "budget.jpg" };
    },
    ...overrides,
  };
}

export { createReporter } from "./reporter.mjs";
