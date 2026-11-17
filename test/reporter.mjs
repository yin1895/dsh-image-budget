/**
 * 极简断言器：三个测试文件共用，**不引入任何依赖**。
 *
 * 刻意与 `harness.mjs` 分开：`harness.mjs` 顶层就会 import 真 cordis，
 * 而"没有图片后端"的 CI 作业只装生产依赖，不能因为缺少 cordis 而整体失败。
 *
 * @module dsh-image-budget/test/reporter
 */

export function createReporter() {
  const results = [];
  let failures = 0;
  return {
    check(ok, label, extra = "") {
      results.push({ ok, label, extra });
      if (!ok) failures += 1;
      console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
    },
    group(title) {
      console.log(`\n${title}`);
    },
    /** @returns 失败数（0 表示全绿）。 */
    finish() {
      const passed = results.filter((result) => result.ok).length;
      console.log(`\n${passed}/${results.length} passed${failures === 0 ? "" : `, ${failures} failing`}`);
      return failures;
    },
  };
}
