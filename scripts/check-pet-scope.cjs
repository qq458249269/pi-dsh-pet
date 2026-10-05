#!/usr/bin/env node
/**
 * check-pet-scope.cjs — pi/assets/pet.js 的**括号嵌套**自检（零依赖）
 *
 * 为什么要有：pet.js 里踩过一次「少一个右花括号」的坑 —— chatSay() 少了收尾的 `}`，
 * 于是后面那段 gestureSay() 的**函数声明被关进了 chatSay 体内**。语法完全合法
 * （node --check 过），但 gestureSay 全局不存在 → 鼠标 hover / 点击 / 拖拽的
 * 「交互气泡」一句都不冒，控制台只留一句 ReferenceError，气泡池配得再好看也没用。
 *
* 判据（不是括号配平，是**函数声明不该出现在别的函数体内**）：
 *   取每个 `function 名(` 开头的行，缩进 I；顺着括号走到它闭合的那行，
 *   中途任何**缩进也是 I 的 function 声明** → 它被关进了兄弟函数体内。
 *   只盯 function 声明：少了收尾 `}` 时，被关进去的普通语句照样跑得出结果（顶多
 *   变量私有），被关进去的**函数声明**却是全局不存在 —— 语法全绿，只在调用那行抛
 *   ReferenceError。少写 `{` 的其它形态 node --check 自己就会拦，不必在这儿重造。
 *
 * 用法：node scripts/check-pet-scope.cjs [文件路径]
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const FILE = process.argv[2] || path.join(__dirname, "..", "pi", "assets", "pet.js");
const SRC = fs.readFileSync(FILE, "utf8");

/** 去掉注释与字符串内容（只留结构字符），否则注释里的 `}` 会把深度数错。 */
function skeleton(src) {
  const out = [];
  let inBlock = false, prev = "";                           // prev = 上一个实义字符（判正则 vs 除号）
  for (const raw of src.split(/\r?\n/)) {
    let line = "", i = 0;
    while (i < raw.length) {
      const c = raw[i], d = raw[i + 1];
if (inBlock) {
        if (c === "*" && d === "/") { inBlock = false; line += "  "; i += 2; prev = " "; continue; }
        line += c === "\t" ? "\t" : " "; i++; continue;
      }
      // 正则字面量：前一个字符决定这是 /regex/ 还是除号 —— 不判的话
      // `/\/\*[\s\S]*?\*\//`（stripJsonc 里）会被当成 /* 块注释，后面整段深度全错。
      if (c === "/" && !"/*".includes(d || "") && "(,=:[!&|?{};+-*%<>~^".includes(prev)) {
        let j = i + 1, cls = false;
        while (j < raw.length && (raw[j] !== "/" || cls)) { cls = raw[j] === "\\" && !cls; if (raw[j] !== "\\") cls = false; j++; }
        line += "RE"; i = j + 1; prev = "E"; continue;
      }
      if (c === "/" && d === "*") { inBlock = true; line += "  "; i += 2; continue; }
      if (c === "/" && d === "/") break;                       // 行注释：到此为止
      if (c === '"' || c === "'" || c === "`") {              // 字符串/模板：吞到收尾（模板按行算够用）
        const q = c; i++;
        while (i < raw.length && raw[i] !== q) { if (raw[i] === "\\") i++; i++; }
        i++; line += '""'; continue;
      }
line += c; if (!/\s/.test(c)) prev = c; i++;
    }
    out.push(line);
  }
  return out;
}

const lines = skeleton(SRC);
const depth = [0];
const head = [];                                              // 每行的「进入前深度」
for (const line of lines) {
  head.push(depth[depth.length - 1]);
  let d = head[head.length - 1];
  for (const c of line) { if (c === "{" || c === "[" || c === "(") d++; else if (c === "}" || c === "]" || c === ")") d--; }
  depth.push(d);
}

const bad = [];
for (let i = 0; i < lines.length; i++) {
  const m = /^(\s*)function\s+\w*\s*\(/.exec(lines[i]);
  if (!m) continue;
  const indent = m[1].length, inner = head[i] + 1;            // 函数体深度
  for (let j = i + 1; j < lines.length && depth[j] >= inner; j++) {
    const t = lines[j];
if (!t.trim() || /^[\s]*[}\])]+[;,)]*$/.test(t)) continue;   // 空行/纯收尾括号不算兄弟
if (depth[j] === inner - 1) break;                        // 闭合那行，到了
if (head[j] === inner && t.length - t.trimStart().length === indent && /^\s*function\s/.test(t)) {
      bad.push(`${j + 1}: ${lines[j].trim()}  ← 被关进了第 ${i + 1} 行 ${m[0].trim()} 的函数体`);
      break;
    }
  }
}

try {
  new vm.Script(SRC, { filename: FILE });                   // 配平交给真编译器判，别数自己的
  if (process.env.DEBUG_DEPTH) {                            // 数法自己跑偏时看哪儿偏的
    let d = 0;
    lines.forEach((l, n) => { const b = d; for (const c of l) { if ("{[(".includes(c)) d++; else if ("}])".includes(c)) d--; }
      if (b === 0 && d !== 1 && d !== 0) console.error(`  ${n + 1}: depth ${d} ← ${l.trim().slice(0, 70)}`); });
    console.error(`skeleton final depth = ${d}`);
  }
} catch (e) {
  console.error(`✗ ${FILE} 语法错：${e.message}`);
  process.exit(1);
}
if (bad.length) {
  console.error(`✗ ${FILE} 有 ${bad.length} 处函数体被关进了兄弟行（手势气泡会静默失效）:\n  ` + bad.join("\n  "));
  process.exit(1);
}
console.log(`✓ pet-scope: ${FILE}（${lines.length} 行）括号嵌套正常`);