#!/usr/bin/env node
/**
 * scripts/stamp.cjs — 打包前把「这个包是从哪一次提交打出来的」写进 app/build.cjs
 *
 * 真正的逻辑在 app/stamp.cjs（宿主启动时也要用它刷新，所以必须进包）；
 * 这个文件只是 CLI 外壳：node scripts/stamp.cjs（npm run build / build:dir 会先跑）。
 */

"use strict";

const { stamp } = require("../app/stamp.cjs");

module.exports = require("../app/stamp.cjs"); // after-pack.cjs 直接用这份

const s = stamp();
console.log(`  • build.cjs: ${s.sha}${s.dirty ? " (dirty)" : ""} @ ${s.builtAt}, ${s.thumbs} 个 webm`);
