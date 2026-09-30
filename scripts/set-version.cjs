#!/usr/bin/env node
/**
 * scripts/set-version.cjs — 把 package.json 的 version 改成命令行给的版本号。
 *
 * CI（.github/workflows/release.yml）算完 YYYY.MM.DD.NNNN 之后调它回写版本号。
 * 单独抽成脚本，是为了 ubuntu（bash）和 windows（PowerShell）跑同一段逻辑，
 * 不用在 YAML 里跟两套引号/`$` 规则打架（PowerShell 里 `env: X` 变量得写 `$env:X`，
 * `"$X"` 是空的 —— 这坑很常见）。
 *
 * 跑：node scripts/set-version.cjs 2026.09.30.0001
 */

const fs = require("node:fs");
const path = require("node:path");

const PKG = path.join(__dirname, "..", "package.json");
const version = String(process.argv[2] || "").trim();

if (!version) {
	console.error("用法: node scripts/set-version.cjs <version>");
	process.exit(1);
}
if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(version)) {
	console.error(`版本号不合法: ${version}（期望 YYYY.MM.DD.NNNN 或 x.y.z）`);
	process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(PKG, "utf8"));
if (pkg.version === version) {
	console.log(`package.json 版本号已经是 ${version}，不改`);
	process.exit(0);
}
console.log(`package.json: ${pkg.version} → ${version}`);
pkg.version = version;
fs.writeFileSync(PKG, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
