#!/usr/bin/env node
/**
 * **宿主契约测试**：用真正的 `@deepseek-ai/cordis` 复现宿主每一个派发站点，
 * 验证本插件的监听器符合该事件的返回契约。
 *
 *   node test/contracts.mjs
 *
 * 这一层是 2.0.2 事故的直接产物。当时的 `agent/pre-step` 监听器没有 `return next()`，
 * 于是 waterfall 返回 `undefined`，宿主读 `decision.kind` 抛出
 * `Cannot read properties of undefined (reading 'kind')` —— 每次回合开始必崩。
 * 假 ctx 测不出来，所以这里必须跑真 cordis（见 test/harness.mjs 的说明）。
 */

import { Context, HOST, attachmentStub, boot, createReporter, imageEvent, makeSession, pluginDir as defaultPluginDir } from "./harness.mjs";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// 允许指向别的版本，用来做回归证明：
//   node test/contracts.mjs --plugin /path/to/v2.0.2     # 应当失败（复现事故）
const argv = process.argv.slice(2);
const pluginIndex = argv.indexOf("--plugin");
const pluginDir = resolve(pluginIndex === -1 ? defaultPluginDir : argv[pluginIndex + 1]);
const pluginEntry = join(pluginDir, "lib", "index.js");
if (!existsSync(pluginEntry)) {
  console.error(`找不到插件入口：${pluginEntry}`);
  process.exit(2);
}
const plugin = await import(pathToFileURL(pluginEntry).href);
/** 旧版本没有 getStats；缺失时用一个空实现兜住，便于对旧版跑同一套断言。 */
const statsOf = typeof plugin.getStats === "function" ? plugin.getStats : () => [];

const { check, group, finish } = createReporter();

// ── agent/pre-step ──────────────────────────────────────────────────────────
// 本插件**不订阅**这个事件；这里验证的是它的存在不会再被任何东西否决。
// （回归护栏：一旦有人重新加回不调 next() 的 pre-step 监听器，这条立刻失败。）
group("agent/pre-step（插件不得掺和，链必须完整）");
{
  const ctx = boot(plugin, {});
  let downstream = 0;
  let thrown;
  let decision;
  try {
    decision = await HOST.preStep(
      ctx,
      { agent: { id: "a", session: { surface: { nodes: [] } } }, messages: [], turn: 1, step: 1, signal: { aborted: false } },
      () => {
        downstream += 1;
      },
    );
  } catch (error) {
    thrown = error;
  }
  check(thrown === undefined, "不抛错（宿主读 decision.kind 是安全的）", thrown?.message ?? "");
  check(decision?.kind === "enter", "decision.kind 保持 enter", String(decision?.kind));
  check(downstream === 1, "探针监听器（排在插件之后）仍被调用", String(downstream));
  check(ctx.lifecycle === undefined || true, "（信息）插件未注册 pre-step");
}

// ── agent/request-error ─────────────────────────────────────────────────────
group("agent/request-error（宿主读 action?.kind）");
{
  const ctx = boot(plugin, {});
  const session = makeSession([]);
  const payload = { agent: { id: "a", session }, turn: 1, step: 1, failure: { code: "INVALID_REQUEST", message: "rate limited" }, signal: { aborted: false } };
  const { action } = await HOST.requestError(ctx, payload);
  check(action === undefined, "非溢出错误返回 undefined（交回下游）", JSON.stringify(action));
}
{
  const ctx = boot(plugin, {});
  const session = makeSession([imageEvent(11, 538_463)]);
  const payload = { agent: { id: "a", session }, turn: 1, step: 1, failure: { message: "内容太长了，请精简输入或开启新对话" }, signal: { aborted: false } };
  const { action, retry } = await HOST.requestError(ctx, payload);
  check(retry === true && action?.kind === "retry", "溢出且有图可删时返回 retry", JSON.stringify(action));
  check(session.appended.length === 1 && session.appended[0].type === "image/offload", "写入了 image/offload");
}
{
  // 下游监听器必须仍然拿得到事件（本插件返回 next() 的结果而非 undefined 时也要能继续）
  const ctx = boot(plugin, {});
  let downstream = 0;
  ctx.on("agent/request-error", async (_payload, next) => {
    downstream += 1;
    return next();
  });
  const session = makeSession([]);
  await HOST.requestError(ctx, { agent: { id: "a", session }, step: 1, failure: { message: "rate limited" }, signal: { aborted: false } });
  check(downstream === 1, "非溢出路径下下游监听器被调用", String(downstream));
}

// ── tools/post-execute ──────────────────────────────────────────────────────
group("tools/post-execute（宿主读 decision.kind）");
{
  const ctx = boot(plugin, { maxImageBytes: 1_000_000 }, { attachments: attachmentStub() });
  const original = { isError: false, value: { path: "/nonexistent.png" }, content: [{ type: "text", text: "x" }] };
  const final = await HOST.postExecute(ctx, { name: "read_image", agent: { id: "a" } }, original);
  check(final?.content?.length === 1, "未超预算：内容原样", JSON.stringify(final?.content));
}
{
  const ctx = boot(plugin, { maxImageBytes: 1 });
  const original = { isError: false, content: [{ type: "text", text: "untouched" }] };
  const final = await HOST.postExecute(ctx, { name: "read" }, original);
  check(final.content === original.content, "非 read_image 原样透传（同一个数组）");
}
{
  // 插件自身失败（不存在的路径 → readFile 抛错）不得改变宿主结果
  const ctx = boot(plugin, { maxImageBytes: 1 });
  const original = {
    isError: false,
    value: { path: "/nonexistent-dir/x.png" },
    content: [{ type: "image", attachment: { attachmentId: "a", mediaType: "image/png", bytes: 999, width: 1, height: 1 } }],
  };
  const final = await HOST.postExecute(ctx, { name: "read_image" }, original);
  check(Array.isArray(final.content) && final.content.length === 1, "内部失败时结果仍可用", JSON.stringify(final.content.map((b) => b.type)));
}
{
  // **回归护栏**：内容在 result 里而不在 decision 里。
  // 旧实现读 decision.content（默认为空），于是真机上静默不生效。
  const ctx = boot(plugin, { maxImageBytes: 60_000, mode: "annotate" });
  const original = {
    isError: false,
    value: { path: "/tmp/looks-big.png" },
    content: [
      { type: "text", text: "<path>/tmp/looks-big.png</path>" },
      { type: "image", attachment: { attachmentId: "orig", mediaType: "image/png", bytes: 538_463, width: 1790, height: 1258 } },
    ],
  };
  const final = await HOST.postExecute(ctx, { name: "read_image" }, original);
  const types = final.content.map((block) => block.type).join("/");
  check(!final.content.some((block) => block.type === "image"), "读到 result.content 并拦下超预算图", types);
  check(/image-budget/u.test(JSON.stringify(final.content)), "留下了拦截说明");
}
{
  // 前面已有监听器改写 content 时，以 decision.content 为准
  const ctx = boot(plugin, { maxImageBytes: 60_000, mode: "annotate" });
  ctx.on("tools/post-execute", async () => ({
    kind: "accept",
    content: [
      { type: "text", text: "外层改写" },
      { type: "image", attachment: { attachmentId: "outer", mediaType: "image/png", bytes: 700_000, width: 1790, height: 1258 } },
    ],
  }));
  const original = { isError: false, value: { path: "/tmp/looks-big.png" }, content: [{ type: "text", text: "原始" }] };
  const final = await HOST.postExecute(ctx, { name: "read_image" }, original);
  check(!final.content.some((block) => block.type === "image"), "外层改写后的图同样被拦下", final.content.map((b) => b.type).join("/"));
}

// ── compaction/summary-error ────────────────────────────────────────────────
group("compaction/summary-error（宿主读布尔）");
{
  const ctx = boot(plugin, { summaryKeepImageBytes: 100_000 });
  const session = makeSession([imageEvent(10, 538_463), imageEvent(11, 655_858)]);
  const value = await HOST.summaryError(ctx, {
    session,
    sourceEventSeqs: [10, 11],
    error: { message: "内容太长了，请精简输入或开启新对话" },
    signal: { aborted: false },
  });
  check(value === true, "可救援时返回 true", String(value));
  check(session.appended[0]?.data?.targets?.length === 2, "两张都进 targets", JSON.stringify(session.appended[0]?.data?.targets));
}
{
  const ctx = boot(plugin, {});
  const value = await HOST.summaryError(ctx, { session: makeSession([]), sourceEventSeqs: [], error: { message: "rate limited" }, signal: { aborted: false } });
  check(value === false, "非溢出错误保持 false（不吞掉宿主默认）");
}
{
  const ctx = boot(plugin, {});
  const value = await HOST.summaryError(ctx, { session: makeSession([]), sourceEventSeqs: [], error: { message: "内容太长" }, signal: { aborted: true } });
  check(value === false, "已取消时保持 false");
}
{
  // 投影未挂载：救援降级为弃权，且不写事件
  const ctx = boot(plugin, {}, { sessions: { messageProjections: [] } });
  const session = makeSession([imageEvent(10, 538_463)]);
  const value = await HOST.summaryError(ctx, { session, sourceEventSeqs: [10], error: { message: "内容太长" }, signal: { aborted: false } });
  check(value === false && session.appended.length === 0, "无 image/offload 投影时不写事件、不吞默认");
}

// ── 激活与配置 ──────────────────────────────────────────────────────────────
group("激活（真 cordis 下 apply 不得抛错）");
{
  let thrown;
  try {
    boot(plugin, {});
  } catch (error) {
    thrown = error;
  }
  check(thrown === undefined, "apply() 不抛错", thrown?.message ?? "");
}
{
  const before = statsOf().length;
  const ctx = boot(plugin, { maxImageBytes: "60000", edges: "nope", unknownKey: 1 });
  const stats = statsOf().at(-1);
  check(statsOf().length === before + 1, "每次 apply 注册一份统计", String(statsOf().length));
  check(ctx.imageBudget === undefined, "不发布服务（卸载无残留）");
  check(
    (stats?.notes ?? []).some((line) => line.includes("maxImageBytes")),
    "非法配置被记录而不是抛错",
    JSON.stringify(stats?.notes),
  );
  check(stats?.gated === 0 && stats?.rescuedSummary === 0, "统计字段齐备", JSON.stringify({ gated: stats?.gated }));
}

// ── 结构护栏本身的行为 ──────────────────────────────────────────────────────
// 直接对 onWaterfall 做对抗性测试：即使有人写出"忘记 next""抛错""重复 next"
// 的监听器，宿主的链也必须完好。
group("onWaterfall 结构护栏（对抗性）");
{
  const { onWaterfall } = await import("../lib/hooks.js");
  const cases = [
    {
      label: "handler 忘记了 next（2.0.2 的事故形态）",
      handler: () => {
        /* 故意什么都不做 */
      },
    },
    {
      label: "handler 抛错",
      handler: () => {
        throw new Error("boom");
      },
    },
    {
      label: "handler 异步拒绝",
      handler: async () => {
        throw new Error("async boom");
      },
    },
    {
      label: "handler 返回 undefined",
      handler: async () => undefined,
    },
  ];
  for (const item of cases) {
    const ctx = new Context();
    onWaterfall(ctx, "agent/pre-step", item.handler);
    let downstream = 0;
    let thrown;
    let decision;
    try {
      decision = await HOST.preStep(ctx, { agent: { id: "a" }, messages: [], turn: 1, step: 1, signal: { aborted: false } }, () => {
        downstream += 1;
      });
    } catch (error) {
      thrown = error;
    }
    check(thrown === undefined, `${item.label}：宿主不抛错`, thrown?.message ?? "");
    check(decision?.kind === "enter", `${item.label}：默认决策保留`, String(decision?.kind));
    check(downstream === 1, `${item.label}：下游探针被调用`, String(downstream));
  }
}
{
  // 重复调用 next：Cordis 会对第二次抛 "next() called multiple times"，护栏必须挡住
  const { onWaterfall } = await import("../lib/hooks.js");
  const ctx = new Context();
  onWaterfall(ctx, "agent/pre-step", async (_payload, next) => {
    await next();
    await next();
    return undefined;
  });
  let downstream = 0;
  let thrown;
  let decision;
  try {
    decision = await HOST.preStep(ctx, { agent: { id: "a" }, messages: [], turn: 1, step: 1, signal: { aborted: false } }, () => {
      downstream += 1;
    });
  } catch (error) {
    thrown = error;
  }
  check(thrown === undefined, "重复 next() 被挡住（不抛 multiple times）", thrown?.message ?? "");
  check(downstream === 1, "下游只跑一次", String(downstream));
  check(decision?.kind === "enter", "默认决策保留", String(decision?.kind));
}
{
  // 契约一：handler 直接返回决策且**没有**委托下游 → 该决策拥有整条链，下游不跑。
  // （这是 Cordis 的既有语义：不调 next() 的监听器否决其后的链。护栏不改变它，
  //   只保证"没给出决策"时一定把链交回去。）
  const { onWaterfall } = await import("../lib/hooks.js");
  const ctx = new Context();
  let defaultRan = 0;
  onWaterfall(ctx, "agent/pre-step", () => ({ kind: "enter", messages: ["mine"], startsRequestSeries: true }));
  const value = await ctx.waterfall({}, "agent/pre-step", { agent: { id: "a" } }, () => {
    defaultRan += 1;
    return Promise.resolve({ kind: "enter", messages: ["default"] });
  });
  check(Array.isArray(value?.messages) && value.messages[0] === "mine", "采用 handler 的决策", JSON.stringify(value?.messages));
  check(defaultRan === 0, "未委托时下游不跑（Cordis 既有语义）", String(defaultRan));
}
{
  // 契约二：handler 先委托再改写 → 下游跑一次，且改写保留。
  const { onWaterfall } = await import("../lib/hooks.js");
  const ctx = new Context();
  let defaultRan = 0;
  onWaterfall(ctx, "agent/pre-step", async (_payload, next) => {
    const decision = await next();
    return { ...decision, messages: [...(decision.messages ?? []), "mine"] };
  });
  const value = await ctx.waterfall({}, "agent/pre-step", { agent: { id: "a" } }, () => {
    defaultRan += 1;
    return Promise.resolve({ kind: "enter", messages: ["default"], startsRequestSeries: true });
  });
  check(defaultRan === 1, "先委托时下游跑一次", String(defaultRan));
  check(value.messages.includes("default") && value.messages.includes("mine"), "下游内容与我的改写都在", JSON.stringify(value.messages));
  check(value.startsRequestSeries === true, "spread 保住了 startsRequestSeries", String(value.startsRequestSeries));
}
{
  // 多个插件监听器共存：我的护栏不得妨碍别人的链
  const { onWaterfall } = await import("../lib/hooks.js");
  const ctx = new Context();
  const order = [];
  ctx.on("agent/pre-step", async (_payload, next) => {
    order.push("outer");
    const decision = await next();
    order.push("outer-after");
    return { ...decision, messages: [...(decision.messages ?? []), "outer"] };
  });
  onWaterfall(ctx, "agent/pre-step", async (payload, next) => {
    order.push("mine");
    const decision = await next();
    return { ...decision, messages: [...(decision.messages ?? []), "mine"] };
  });
  const value = await ctx.waterfall({}, "agent/pre-step", { agent: { id: "a" } }, () => Promise.resolve({ kind: "enter", messages: ["default"] }));
  check(order.join(",") === "outer,mine,outer-after", "外层先跑、我的护栏在中间、外层能收到结果", order.join(","));
  check(value.messages.includes("mine") && value.messages.includes("outer"), "两层的改写都被保留", JSON.stringify(value.messages));
}

// ── 迁移护栏：不允许再出现"没调 next 的监听器" ──────────────────────────────
group("源码护栏");
{
  const source = await import("node:fs").then(({ readFileSync }) => readFileSync(new URL("../lib/index.js", import.meta.url), "utf8"));
  check(!/ctx\.on\(\s*["']agent\/pre-step["']/u.test(source), "lib/index.js 不再直接订阅 agent/pre-step");
  check(/onWaterfall\(/u.test(source), "waterfall 监听器统一通过 onWaterfall 注册");
  const directOn = [...source.matchAll(/ctx\.on\(/gu)].length;
  check(directOn === 0, "lib/index.js 里不再有裸 ctx.on(", String(directOn));
}
{
  const exists = existsSync(join(pluginDir, "lib", "hooks.js"));
  check(exists, `lib/hooks.js 存在（结构护栏，检查的是 ${pluginDir}）`);
}

// 防活锁（忠实语义：第二次已无图可删）
{
  const ctx = boot(plugin, { summaryKeepImageBytes: 100_000 });
  const session = makeSession([imageEvent(10, 538_463), imageEvent(11, 655_858)]);
  const payload = { session, sourceEventSeqs: [10, 11], error: { message: "内容太长" }, signal: { aborted: false } };
  const first = await HOST.summaryError(ctx, { ...payload, signal: { aborted: false } });
  const second = await HOST.summaryError(ctx, { ...payload, signal: { aborted: false } });
  check(first === true, "第一次救援发生");
  check(second === false, "第二次无图可删 → 弃权（结构性防活锁）", String(second));
  check(session.appended.length === 1, "只写了一条 image/offload", String(session.appended.length));
}
// 每 (agent, step) 上限
{
  const ctx = boot(plugin, { maxRescuesPerStep: 1 });
  const session = makeSession([imageEvent(1, 538_463), imageEvent(2, 655_858)]);
  const agent = { id: "a", session };
  const base = { turn: 1, step: 1, failure: { message: "prompt is too long" }, signal: { aborted: false } };
  const first = await HOST.requestError(ctx, { ...base, agent });
  const second = await HOST.requestError(ctx, { ...base, agent });
  check(first.retry === true, "同一 step 第一次救援");
  check(second.retry === false, "同一 step 第二次被上限挡住", String(second.retry));
}
// 投影不可用时请求救援也降级
{
  const ctx = boot(plugin, {}, { sessions: { messageProjections: [] } });
  const session = makeSession([imageEvent(11, 538_463)]);
  const { retry } = await HOST.requestError(ctx, { agent: { id: "a", session }, step: 1, failure: { message: "内容太长" }, signal: { aborted: false } });
  check(retry === false && session.appended.length === 0, "无投影时请求救援降级，不写事件");
}

process.exit(finish() === 0 ? 0 : 1);
