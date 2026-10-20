/**
 * update-mirror.cjs — 更新器的镜像选路自检（纯字符串，不联网）。
 *
 * 只钉两件容易改坏的事：**镜像在前、直连兜底**的顺序，和**非 GitHub URL 不许加前缀**
 * （给 example.com 套上 ghfast.top 前缀 = 直接 404）。真机拉包靠 `pi-pet doctor` 之外的手测。
 */
"use strict";

const assert = require("node:assert/strict");

process.env.PI_PET_GH_PROXY = "https://m1.test,https://m2.test/";
const { mirrorUrls } = require("../app/updater.cjs");

const api = "https://api.github.com/repos/x/y/releases/latest";
assert.deepEqual(
	mirrorUrls(api),
	[`https://m1.test/${api}`, `https://m2.test/${api}`, api],
	"镜像按顺序在前，直连垫底（镜像全挂也得能查）",
);
assert.deepEqual(mirrorUrls("https://example.com/a.exe"), ["https://example.com/a.exe"], "非 GitHub 不加前缀");
assert.equal(mirrorUrls("https://github.com/x/y.git")[0], "https://m1.test/https://github.com/x/y.git", "尾部斜杠要削掉");

console.log("update-mirror: ok（镜像顺序 / 直连兜底 / 非 GitHub 不加前缀）");
