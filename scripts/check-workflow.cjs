#!/usr/bin/env node
/**
 * check-workflow.cjs — .github/workflows/release.yml 的结构自检
 *
 * 跑在 `npm test` 的**第一步**：这个文件踩过两次同一类坑，而两次的报错都指不到病根，
 * 所以把「病根长什么样」写成断言，改坏了当场红，别等 GitHub 报一句天书。
 *
 *   ① 事件键顶格（`workflow_dispatch:` 写在第 0 列）
 *      它就成了**根级**键：`on:` 里只剩 `push`，手动触发入口直接消失。
 *      合法 YAML，GitHub 也认语法，但工作流少了个人工入口 —— 而报错是
 *        (Line: 11, Col: 1): Unexpected value 'workflow_dispatch'
 *      看着像「这个事件不支持」，实际是缩进错了一格。
 *   ② 半截 step（`- name: xxx` 后面既没有 run: 也没有 uses:）
 *      合法 YAML（解析成 `{name: xxx}`），但 schema 上它哪个分支都不属于，报错是
 *        There's not enough info to determine what you meant. Add one of these
 *        properties: cancel, run, shell, uses, wait, wait-all, with, working-directory
 *      看着像「忘了写 run」，实际是**多了一个 step 头**（重排步骤时留下的残渣）。
 *
 * 为什么不用 yaml/js-yaml + JSON Schema（那才是编辑器/VS Code 用的那套）：
 *   ① 仓库是**零依赖**的，测试不该为了查一个文件去装包；
 *   ② schema 每次都可能变，拿别人内部实现当契约就是拿版本号当断言（见 release.yml 里
 *      对 electron-builder 版本规范化的那段注释）。
 *   这个文件结构很规整（顶层 0 列 / job 2 列 / step 6 列），按行扫足够，
 *   而且**只查本项目自己定的规矩**，换 schema 也不会假失败。
 *
 * 用法：node scripts/check-workflow.cjs [文件路径]
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const FILE = process.argv[2] || path.join(__dirname, "..", ".github", "workflows", "release.yml");
const lines = fs.readFileSync(FILE, "utf8").split(/\r?\n/);

/** GitHub Actions 允许的顶层键（schemastore/github-workflow.json 的那一组） */
const TOP_KEYS = new Set(["name", "on", "run-name", "env", "defaults", "concurrency", "jobs", "permissions"]);
/** 事件键：这些**必须**缩进在 on: 里面，顶格就是 ① 那种错 */
const EVENTS = new Set([
	"push",
	"pull_request",
	"workflow_dispatch",
	"workflow_call",
	"schedule",
	"release",
	"issue_comment",
	"repository_dispatch",
	"push_pull_request",
]);
/** job 里必须有这两个（缺一个 = 那个 job 永远不会跑） */
const JOB_KEYS = ["runs-on", "steps"];

const problems = [];
const indentOf = (line) => line.search(/\S/);
const at = (i) => `第 ${i + 1} 行`;

// ---- ① 顶层键 / 事件键缩进 ----
let sawOn = false;
let onBodyKeys = [];
for (let i = 0; i < lines.length; i++) {
	const line = lines[i];
	if (!line.trim() || line.trimStart().startsWith("#")) continue;
	const m = /^([A-Za-z_][\w-]*):/.exec(line);
	if (!m) continue;
	const key = m[1];
	if (key === "on") {
		sawOn = true;
		// 收 on: 块里的子键（缩进 2 列）
		for (let j = i + 1; j < lines.length; j++) {
			const l = lines[j];
			if (!l.trim() || l.trimStart().startsWith("#")) continue;
			const ind = indentOf(l);
			if (ind === 0) break;
			if (ind === 2) {
				const km = /^\s{2}([A-Za-z_][\w-]*):/.exec(l);
				if (km) onBodyKeys.push({ key: km[1], line: j });
			}
		}
		continue;
	}
	if (!TOP_KEYS.has(key)) {
		problems.push(`${at(i)}：顶层出现未知键 \`${key}\`（合法顶层键只有 ${[...TOP_KEYS].join(" / ")}）`);
	}
	if (EVENTS.has(key)) {
		problems.push(
			`${at(i)}：\`${key}:\` 顶格了 —— 它是 \`on:\` 的**子键**，必须缩进 2 格。` +
				`顶格等于告诉 GitHub「有个根级键叫这个」，on 里就只剩 push 了。`,
		);
	}
}
if (!sawOn) problems.push("没有 `on:`：这个工作流永远不会触发");
if (sawOn && !onBodyKeys.some((k) => k.key === "workflow_dispatch")) {
	problems.push(
		`on: 里没有 workflow_dispatch（只有 ${onBodyKeys.map((k) => k.key).join(" / ") || "什么都没有"}）` +
			`—— 手动触发入口没了，只能靠推 tag/main`,
	);
}

// ---- ② 半截 step：只有 name 头、没有 run:/uses: 正文 ----
// （`- uses: actions/xxx@v4` 本身就是正文，不算半截 —— 半截只指那种光秃秃的 `- name:`）
for (let i = 0; i < lines.length; i++) {
	const m = /^(\s*)- (name|uses):/.exec(lines[i]);
	if (!m) continue;
	if (m[2] === "uses") continue; // - uses: 已经有动作了
	const indent = m[1].length;
	let hasBody = false;
	for (let j = i + 1; j < lines.length; j++) {
		const l = lines[j];
		if (!l.trim() || l.trimStart().startsWith("#")) continue;
		const ind = indentOf(l);
		if (ind <= indent && l.trimStart().startsWith("- ")) break; // 下一个同级 step
		if (ind < indent) break; // 已经退到更外层的键 → 这个 step 到头了
		if (new RegExp(`^\\s{${indent + 2}}(run|uses):`).test(l)) {
			hasBody = true;
			break;
		}
	}
	if (!hasBody) {
problems.push(
			`${at(i)}：step \`${lines[i].trim()}\` 是个半截 step —— 只有名字，没有 \`run:\` / \`uses:\`。` +
				`（多半是重排步骤时留下的残渣：删掉这个 step 头，别去给它补 run）`,
		);
	}
}

// ---- ③ 每个 job 都要能跑 ----
// 只在顶层 `jobs:` **之后**找 `  jobId:` —— 否则 on: 里的 `push:` / `workflow_dispatch:`
// （都缩进 2 格，和 job 一样齐）会被当成 job，报一堆「缺 runs-on」的假错。
const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
const jobStarts = [];
for (let i = jobsAt + 1; jobsAt >= 0 && i < lines.length; i++) {
	const top = /^([A-Za-z_][\w-]*):/.exec(lines[i]);
	if (top) break; // 遇到下一个顶层键 → 出了 jobs 块
	const m = /^ {2}([A-Za-z_][\w-]+):\s*$/.exec(lines[i]);
	if (m) jobStarts.push({ key: m[1], line: i });
}
if (jobsAt < 0) problems.push("没有 `jobs:`：没有 job 可跑");
if (jobsAt >= 0 && jobStarts.length === 0) problems.push("`jobs:` 下面一个 job 都没有");
for (let k = 0; k < jobStarts.length; k++) {
	const start = jobStarts[k];
	const end = k + 1 < jobStarts.length ? jobStarts[k + 1].line : lines.length;
	const body = lines.slice(start.line, end).join("\n");
	for (const need of JOB_KEYS) {
		if (!new RegExp(`^ {4}${need}:`, "m").test(body)) {
			problems.push(`${at(start.line)}：job \`${start.key}\` 缺 \`${need}:\`（这个 job 不会跑）`);
		}
	}
}

if (problems.length) {
	console.error(`✗ ${path.relative(process.cwd(), FILE)} 结构不对（${problems.length} 处）：\n`);
	for (const p of problems) console.error(`  · ${p}`);
	console.error("");
	process.exit(1);
}
console.log(
	`✓ ${path.relative(process.cwd(), FILE)} 结构对：` +
		`on = [${onBodyKeys.map((x) => x.key).join(", ")}]，${jobStarts.length} 个 job，` +
		`没有半截 step`,
);
