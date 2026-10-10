/**
 * afterPack —— 打包完做两件 electron-builder 自己不方便做的事
 *
 * ① 删掉用不到的 Electron 自带文件（**dxcompiler.dll**，连带 dxil.dll）。
 *    它是 Dawn 的 **D3D12** 后端编译器，本应用只用到 WebGL + 一个透明置顶窗，
 *    Electron 默认走 ANGLE/D3D11，这两个文件从头到尾没人加载 —— 纯白带 26MB。
 *    缺了它 GPU 进程初始化 D3D12 会失败并自动回落（不是崩溃），本项目实测照样出窗。
 *    ⚠️ ponytail: 万一将来换到 D3D12 / WebGPU（`--enable-unsafe-webgpu`）并出现黑屏，
 *    第一个要怀疑的就是 ① —— 把下面 TRIM 清空即可回退，别去动别的地方。
 *
 * ② 写 exe 的版本信息（Windows 文件属性里那几行字）。
 *    为什么不用 electron-builder 自带的那一步，见 writeVersionInfo 上面那段。
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** 白名单式：只列确证没人用的。要删别的先在这里加一行，别写通配。 */
const TRIM = ["dxcompiler.dll", "dxil.dll"];

/** 写同一个文件偶尔会被防护抢一下（见 writeVersionInfo），等一下重试就够了 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 打包身份：确保 asar 里带着一份**此刻的** build.cjs。
 *
 * 之前这里是「不匹配就抛错拦打包」，结果把 CI 打挂了：exe job 直接调
 * `npx electron-builder`，不走 npm 脚本 → prebuild 不跑 → build.cjs 根本不存在。
 * 拦的是「没人绕过脚本」这种自己造成的小失误，坏的是自动发布 —— 方向反了。
 *
 * 正确分工：
 *   · 这里 —— **缺/旧就当场重生成**（幂等），保证包里的身份戳是真的；
 *   · `pi-pet doctor` 与 /health —— 报出 sha 与素材数，这才是发现
 *     「我跑的是旧 exe」的地方（对着旧 exe 调试，界面完全看不出来）。
 */
function assertFreshStamp() {
	const ROOT = path.join(__dirname, "..");
	const out = path.join(ROOT, "app", "build.cjs");
	let prev = null;
	try {
		prev = require(out);
	} catch {
		/* 没有就重建，下面会写 */
	}
const s = require("./stamp.cjs").stamp();
	if (!prev) console.log(`  • 生成包身份戳 ${s.sha}（之前没有 app/build.cjs）`);
	else if (prev.sha !== s.sha || prev.builtAt !== s.builtAt) console.log(`  • 包身份戳重生成 ${prev.sha} → ${s.sha}`);
	console.log(`  • 包身份 = ${s.sha}${s.dirty ? " (dirty)" : ""}，素材 ${s.thumbs} 段`);
}

/**
 * 版本信息：把「文件属性」里那几行字写进 win-unpacked\<product>.exe。
 *
 * ⚠️ 为什么不用 electron-builder 自带的那一步（win.signAndEditExecutable，默认开着）：
 *   那一步调的是 **rcedit-x64.exe**，改资源走 Windows 的 BeginUpdateResource /
 *   EndUpdateResource —— 那套 API 会把整个文件**重写一遍**。
 *   机器上装着实时防护（腾讯电脑管家、360、各种安全软件都算）时，刚 unpack 出来的
 *   180MB exe 还在被扫描，句柄没放开，EndUpdateResource 直接返回 FALSE：
 *
 *     Fatal error: Unable to commit changes
 *     command='…\winCodeSign-2.6.0\rcedit-x64.exe' '…\dist\win-unpacked\pi-dsh-pet.exe' --set-version-string …
 *
 *   病根是「文件正被扫描」，不是参数或版本号（实测同一份文件过几十秒再跑同一条命令
 *   又成功，去掉空值参数、换小文件都照样失败）。electron-builder 自带 3 次重试、
 *   每次紧挨着几秒内，扫描没结束 → 4 次全挂，整个 build 红掉，
 *   而且报错指不到本仓库任何文件。
 *
 *   所以 electron-builder.yml 里把这一步**关掉**（win.signAndEditExecutable: false），
 *   改在这里用 resedit 写：resedit 是「读文件 → 改 buffer → 写文件」，不碰那套 API。
 *
 *   ⚠️ 但 resedit 也躲不开「写进去的瞬间文件正被扫描」本身（同一台机器上
 *   electron-builder 写 asar integrity 资源时 open 失败过一次，QQPCRTP 的锅）。
 *   所以：内容没变就不写，要写就重试几次 —— 别让一个几秒的扫描窗口毁掉一次 build。
 *
 * 关掉它顺带丢的：图标、代码签名。本项目两者本来就没有（没有 build/ 图标目录、
 * 没有证书，manifest 默认 asInvoker），所以产物和以前一样。
 *   ⚠️ 将来真要给 exe 换图标：那行仍然是关的，光往 build/ 丢 icon.ico **不会生效**，
 *     得在这里用 resedit 的 IconGroup/IconFile 补上。
 */
async function writeVersionInfo(appOutDir) {
	const ROOT = path.join(__dirname, "..");
	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
	const productName = yamlScalar(path.join(ROOT, "electron-builder.yml"), "productName") || pkg.name;
	const copyright = yamlScalar(path.join(ROOT, "electron-builder.yml"), "copyright") || pkg.license || "";

	const exePath = path.join(appOutDir, `${productName}.exe`);
	if (!fs.existsSync(exePath)) {
		console.log(`  • 跳过版本信息：没找到 ${path.basename(exePath)}`);
		return;
	}

	let resedit = null;
	try {
		resedit = require("resedit");
	} catch {
		// resedit 是 electron-builder 的依赖，正常都跟着装；真没有也不拦打包（见 assertFreshStamp 的注释）
		console.log("  • 跳过版本信息：resedit 没装上（它是 electron-builder 的依赖，正常都在）");
		return;
	}
	const { NtExecutable, NtExecutableResource, Resource } = resedit;
	const exeFileName = path.basename(exePath);
	const lang = { lang: 1033, codepage: 1200 };
	const win4 = windowsVersion(pkg.version);
	// 键名与 electron-builder 那步保持一致（Win10「文件属性 → 详细信息」就显示这些）
	const want = {
		FileDescription: pkg.description || productName,
		ProductName: productName,
		LegalCopyright: copyright,
		InternalName: path.basename(exePath, ".exe"),
		OriginalFilename: exeFileName,
		CompanyName: (pkg.author && pkg.author.name) || "",
		FileVersion: win4,
		ProductVersion: win4,
	};

	// 读 → 改 → 写。已经是目标状态就别写（少一次写 = 少撞一次防护窗口）
	for (let i = 1; i <= 4; i++) {
		try {
			const executable = NtExecutable.from(fs.readFileSync(exePath));
			const resource = NtExecutableResource.from(executable);
			const existing = Resource.VersionInfo.fromEntries(resource.entries)[0];
			const useLang = (existing && existing.getAllLanguagesForStringValues()[0]) || lang;
			if (existing && versionInfoMatches(existing, useLang, want)) {
				console.log(`  • exe 版本信息已对（${win4} · ${productName}），不重写`);
				return;
			}
			const vi = existing || Resource.VersionInfo.createEmpty(lang.lang, lang.codepage);
			vi.setFileVersion(win4, lang.lang);
			vi.setProductVersion(win4, lang.lang);
			vi.setStringValues(useLang, want);
			// Electron 自带的 SquirrelAwareVersion=1 是「给 Squirrel 安装器用的」，本项目是免安装 exe
			vi.removeStringValue(useLang, "SquirrelAwareVersion");
			// ⚠️ 这一行不能少：fromEntries 返回的是**副本**，直接 outputResource 写回去的还是
			//    原来那个 RT_VERSION，值改了等于没改（写完读回来还是 Electron，静默失败）。
			//    必须先把改好的 VersionInfo 吐回 entries，outputResource 才认。
			vi.outputToResourceEntries(resource.entries);
			resource.outputResource(executable);
			fs.writeFileSync(exePath, Buffer.from(executable.generate()));
			console.log(`  • exe 版本信息 ${win4} · ${productName}（resedit）`);
			return;
		} catch (e) {
			if (i === 4) {
				// 不拦打包：版本信息只是文件属性里那几行字（真身份在 asar 的 app/build.cjs）
				console.log(`    ⚠ 版本信息写不进去（${e.code || e.message}），本次 exe 的文件属性沿用 Electron 的`);
				return;
			}
			await sleep(1500 * i); // 防护扫完就放开了，等一下再写
		}
	}
}

/** 现在 exe 里是不是已经是我们要写的那套值（只比字符串项：它们就是文件属性显示的那些） */
function versionInfoMatches(vi, lang, want) {
	const have = vi.getStringValues(lang) || {};
	return Object.keys(want).every((k) => have[k] === want[k]);
}

/** 版本号补成 Windows 想要的四段：`2026.10.8.0003` → `2026.10.8.3`（每段上限 65535） */
function windowsVersion(version) {
	const parts = String(version || "0")
		.split(".")
		.slice(0, 4)
		.map((n) => {
			const x = parseInt(n, 10);
			return Number.isFinite(x) ? Math.min(65535, Math.max(0, x)) : 0;
		});
	while (parts.length < 4) parts.push(0);
	return parts.join(".");
}

/** 只认「顶格 `key: 值`」这一种写法 —— electron-builder.yml 就是这么写的；
 *  认不出来就返回空串让调用方兜底，别为了读两个标量引入 yaml 依赖。 */
function yamlScalar(file, key) {
	let text = "";
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
	const m = text.match(new RegExp(`^${key}:[ \\t]*(.+?)\\s*$`, "m"));
	if (!m) return "";
	return m[1].replace(/^["']|["']$/g, "").trim();
}

exports.default = async function afterPack(context) {
	assertFreshStamp();
	// context.appOutDir 是打包输出目录（win-unpacked 之类）；Linux/Mac 布局不同就跳过。
	const dir = context && context.appOutDir;
	if (!dir || process.platform !== "win32") return;
	for (const name of TRIM) {
		const file = path.join(dir, name);
		try {
			const mb = fs.statSync(file).size / 1048576;
			fs.rmSync(file, { force: true });
			console.log(`  • 删掉 ${name}（${mb.toFixed(1)}MB，D3D12 后端用不上）`);
		} catch {
			/* 本次布局里没有这个文件：无所谓 */
		}
	}
await writeVersionInfo(dir);
}