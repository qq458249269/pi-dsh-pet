#!/usr/bin/env node
/**
 * bin/pi-pet.cjs — npm 全局命令入口
 *
 * 装完就能用：`pi-pet start` / `pi-pet status` / `pi-pet feed thinking` …
 * 真正的活都在 app/main.cjs；这个文件只负责把退出码带出去。
 */

"use strict";

const { main } = require("../app/main.cjs");

main()
	.then((code) => {
		process.exitCode = code || 0;
	})
	.catch((err) => {
		process.stderr.write(`✗ pi-pet 崩了：${err && err.stack ? err.stack : err}\n`);
		process.exitCode = 1;
	});
