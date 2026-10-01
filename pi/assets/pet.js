/**
 * pi-dsh-pet — pet.js (vanilla JS, no bundler)
 *
 * Port of dsh-pet/src/client/*.ts to vanilla JavaScript.
 * Runs in the browser, connects to pi's WebSocket server for event reactivity,
 * plays the full animation chain with 91 WebM assets.
 *
 * Dependencies: none (pure HTML5 APIs: <video>, WebSocket, Fetch, DOMParser)
 */
(function () {
  "use strict";

  // ========================================================================
  // 1. Constants (from constants.ts)
  // ========================================================================
  var CANVAS_H = 360;
  var FEET_Y = 330;
  var HIT_BOX = { x0: 200, y0: 50, x1: 440, y1: 335 };
  var DRAG_THRESHOLD = 5;

  // ========================================================================
  // 2. Config helpers (from config.ts)
  // ========================================================================

  /** Strip JSONC comments (// and /* * /) → pure JSON string */
  function stripJsonc(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^\\:])\/\/.*$/gm, "$1")
      .trim();
  }

  /**
   * 节奏参数（可选，写在 config.jsonc 的 timing 里）。写错/漏写都回落到默认值 ——
   * 手感参数不值得为它把整扇窗搞崩（assertClientConfig 抛错 = 宠物直接不出现）。
   *
   *   minPlayMs    一段动画**最少**播多久才允许被别人切走（毫秒）
   *   idleDwellMs  待机动画播完之后原地续播多久再由链子往下抽（毫秒）
   *   idleSleepMs  多久没动静就把动画**整个冻住**（毫秒，0 = 不冻，见 4.7）
   *
   * 这三个数是同一件事的三头：minPlayMs 治「动画没演完就被切一半」，
   * idleDwellMs 治「待机太短，一口气连着演、看着一直忙个不停」，
   * idleSleepMs 治「一直在动，把别的窗口的渲染预算都抢走了」（见 4.7）。
   */
  var TIMING_DEFAULT = { minPlayMs: 2600, idleDwellMs: 6000, idleSleepMs: 45000 };

  function readTiming(raw) {
    var t = raw && typeof raw === "object" ? raw : {};
    function num(key, def) {
      var v = Number(t[key]);
      if (!isFinite(v) || v < 0) return def;
      return Math.min(60000, Math.round(v));
    }
    return {
      minPlayMs: num("minPlayMs", TIMING_DEFAULT.minPlayMs),
      idleDwellMs: num("idleDwellMs", TIMING_DEFAULT.idleDwellMs),
      idleSleepMs: num("idleSleepMs", TIMING_DEFAULT.idleSleepMs),
    };
  }

  /** 窗里到处都要问这两个数（config 可能还没加载完，所以都带兜底） */
  function minPlayMs() {
    return config && config.timing ? config.timing.minPlayMs : TIMING_DEFAULT.minPlayMs;
  }
  function idleDwellMs() {
    return config && config.timing ? config.timing.idleDwellMs : TIMING_DEFAULT.idleDwellMs;
  }

  var CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"];
  var CORNER_SET = {};
  CORNERS.forEach(function (c) { CORNER_SET[c] = true; });

  /** Validate raw config object → return sane ClientConfig or throw */
  function assertClientConfig(raw) {
    if (!raw || typeof raw !== "object") throw new Error("config not object");

    // pets
    var petsArr = Array.isArray(raw.pets) ? raw.pets : [];
    if (!petsArr.length) throw new Error("missing pets");
    var seen = {};
    var pets = [];
    for (var i = 0; i < petsArr.length; i++) {
      var p = petsArr[i];
      var id = String(p.id || "");
      if (!id || seen[id]) throw new Error("pet id invalid or duplicate: " + id);
      var size = Number(p.size);
      if (!isFinite(size) || size <= 0) throw new Error("pet " + id + " size invalid");
      var corner = (p.position && p.position.corner) || "";
      if (!CORNER_SET[corner]) throw new Error("pet " + id + " corner invalid");
      var marginX = Number(p.position && p.position.marginX);
      var marginY = Number(p.position && p.position.marginY);
      if (!isFinite(marginX) || !isFinite(marginY)) throw new Error("pet " + id + " margin invalid");
      seen[id] = true;
      pets.push({ id: id, size: size, position: { corner: corner, marginX: marginX, marginY: marginY } });
    }

    // animations
    var a = raw.animations;
    if (!a || typeof a !== "object") throw new Error("missing animations");
    ["idle", "turn", "drag", "clicks"].forEach(function (k) {
      if (!Array.isArray(a[k])) throw new Error("animations." + k + " missing");
    });
    // 可选池：没写就不播（老配置照样能用）
    if (a.hover !== undefined && !Array.isArray(a.hover)) throw new Error("animations.hover must be an array");
    if (!a.moves || typeof a.moves !== "object" || !a.moves.default || !Array.isArray(a.moves.actions)) {
      throw new Error("animations.moves structure invalid");
    }
    if (!Array.isArray(a.categories)) throw new Error("animations.categories missing");

    // weights
    var w = raw.animationWeights;
    if (!w || typeof w !== "object") throw new Error("missing animationWeights");
    ["idle", "turn", "move"].forEach(function (k) {
      var v = Number(w[k]);
      if (!isFinite(v) || v < 0) throw new Error("animationWeights." + k + " invalid");
    });

    return { pets: pets, animations: a, animationWeights: w, timing: readTiming(raw.timing) };
  }

  // ========================================================================
  // 3. Pickers (from pickers.ts)
  // ========================================================================

  function pick(pool, exclude) {
    var entries = exclude ? pool.filter(function (n) { return n !== exclude; }) : pool;
    var src = entries.length ? entries : pool;
    return src[Math.floor(Math.random() * src.length)];
  }

  function randomBetween(min, max) {
    return Math.floor(min + Math.random() * (max - min));
  }

  function pickWeightedCategory(categories, facing) {
    var cats = categories.filter(function (c) { return c.actions.length > 0; });
    if (!cats.length) return null;
    var filtered = cats.filter(function (c) { return !(c.noMirror && facing === "right"); });
    var eligible = filtered.length ? filtered : cats;
    var totalW = eligible.reduce(function (s, c) { return s + c.weight; }, 0) || 1;
    var t = Math.random() * totalW;
    for (var i = 0; i < eligible.length; i++) {
      t -= eligible[i].weight;
      if (t <= 0) return eligible[i];
    }
    return eligible[eligible.length - 1];
  }

  function rollKind(roll, w) {
    var topEnd = (w.idle + w.turn + w.move) / 100;
    if (roll < w.idle / 100) return "idle";
    if (roll < (w.idle + w.turn) / 100) return "turn";
    if (roll < topEnd) return "move";
    return "action";
  }

  function pickCategoryAction(categories, idlePool, facing, current) {
    var cat = pickWeightedCategory(categories, facing);
    if (!cat) return { id: "FALLBACK", name: pick(idlePool, current) };
    return { id: cat.id, name: pick(cat.actions, current) };
  }

  // ========================================================================
  // 4. Motion (from motion.ts)
  // ========================================================================

  function planMove(o) {
    var distance = randomBetween(o.minDist, o.maxDist);
    var target = o.cx + o.dir * distance;
    var leftBound = o.margin + o.halfW;
    var rightBound = o.W - o.margin - o.halfW;
    if (target < leftBound || target > rightBound) return null;
    return {
      startRatio: o.cx / o.W,
      startYRatio: o.cy / o.H,
      targetRatio: target / o.W,
      totalRatio: Math.abs(target - o.cx) / o.W,
    };
  }

  // ========================================================================
  // 4.5 命中区（Hit region）
  //
  // 窗是全屏的，如果不去管它，鼠标一扫到宠物身上就把整屏点击都吃了（下面的窗口全部
  // 点不动，必须把鼠标移出宠物才恢复）。所以把「宠物包围盒」实时报给主进程，
  // 由主进程 setShape 把整窗命中区裁到宠物身上：只有宠物能点，别处的点击照常落到下面。
  //
  // 取的是**真正能点的那块**（.pet-hit），不是宠物容器：容器是 16:9 的整块画布，
  // 四边留着一圈透明边。按容器报会把那圈透明边也划进命中区，鼠标停在那儿
  // 点下去什么都不会发生（被透明窗吃掉），却又到不了下面的窗口 —— 正是本节要消灭的毛病。
  //
  // 包围盒还要包含头顶的气泡（否则正在输入的「说点什么…」会被裁掉），四周留一点余量。
  // ========================================================================

  var HIT_PAD_X = 10;
  var HIT_PAD_TOP = 12;
  var HIT_PAD_BOTTOM = 10;
  /** 漫游/拖拽时每帧都在动，而主进程每次都要 SetWindowRgn：50ms 一次（20fps）跟手又不至于卡 */
  var HIT_THROTTLE_MS = 50;
  /** 命中区量化到 2px 的网格。不动的宠物不该因为亚像素抖动一直让主进程重裁形状
   *  （主进程那边每次 setShape = 一次全屏重合成，见 pet-electron.cjs 的说明）。 */
  var HIT_QUANT = 2;
  var regionQueued = false;
  var regionTimer = null;
  var lastRegionKey = "";
  var lastRegionAt = 0;

  /** 量化：把亚像素抖动抹平（主进程只认量化后的值，这边也就只按量化后的值去重） */
  function quant2(v) {
    return Math.round(Number(v) / HIT_QUANT) * HIT_QUANT;
  }

  /** 把每只宠物的可见气泡夹在屏幕内（超出就往回挪），挪完再算命中区，
      保证主进程拿到的形状和屏幕上画出来的是同一个位置。 */
  function clampBubbles() {
    for (var i = 0; i < pets.length; i++) {
      var p = pets[i];
      if (p && typeof p.clampBubble === "function") p.clampBubble();
    }
  }

  function collectHitRects() {
    var out = [];
    for (var i = 0; i < pets.length; i++) {
      var p = pets[i];
      var el = p.hitEl || p.el;
      if (!el || !el.getBoundingClientRect) continue;
      var r = el.getBoundingClientRect();
      if (!r || !(r.width > 0) || !(r.height > 0)) continue;
      var box = {
        left: r.left - HIT_PAD_X,
        top: r.top - HIT_PAD_TOP,
        right: r.right + HIT_PAD_X,
        bottom: r.bottom + HIT_PAD_BOTTOM,
      };
      // 气泡长在头顶（bottom:100%），可见时并进来
      var b = p.bubbleEl;
      if (b && b.classList && b.classList.contains("show")) {
        var br = b.getBoundingClientRect();
        if (br && br.width > 0) {
          box.left = Math.min(box.left, br.left - 6);
          box.right = Math.max(box.right, br.right + 6);
          box.top = Math.min(box.top, br.top - 6);
        }
      }
      out.push({
        x: quant2(box.left),
        y: quant2(box.top),
        width: Math.max(HIT_QUANT, quant2(box.right - box.left)),
        height: Math.max(HIT_QUANT, quant2(box.bottom - box.top)),
      });
    }
    // 「掉线了」提示条长在屏幕右上角，不在宠物身上，一并算进去免得被裁掉
    var banner = document.getElementById(DISCONNECT_BANNER_ID);
    if (banner && banner.classList && banner.classList.contains("show")) {
      var rr = banner.getBoundingClientRect();
      if (rr && rr.width > 0) {
        out.push({
          x: quant2(rr.left) - 4,
          y: quant2(rr.top) - 4,
          width: quant2(rr.width) + 8,
          height: quant2(rr.height) + 8,
        });
      }
    }
    return out;
  }

  /** 真发一次：矩形没变就不发（省掉一次跨进程 + 一次 SetWindowRgn）。 */
  function emitHitRegion() {
    clampBubbles(); // 先把气泡夹回屏幕内，形状才算得准
    var api = window.__petElectron__;
    if (!api || !api.setHitRegion) return;
    var rects = collectHitRects();
    // 一只都算不出来（还没布局完）就别报：主进程收到空数组会保持上一次的形状，
    // 报上去反而可能把命中区清空。
    if (!rects.length) return;
    var key = "";
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      key += r.x + "," + r.y + "," + r.width + "," + r.height + "|";
    }
    if (key === lastRegionKey) return;
    lastRegionKey = key;
    lastRegionAt = Date.now();
    try {
      api.setHitRegion(rects);
    } catch (e) {
      /* 主进程还没 ready 就算了，下一次变化还会再报 */
    }
  }

  /**
   * 请求上报命中区。同一帧里的多次请求会合并，连续移动时按 HIT_THROTTLE_MS 节流。
   * ⚠️ 被节流挡掉的那次**必须补一个尾巴定时器**，否则这次移动就永远丢了：
   *   rAF 只在我们主动排下一次时才跑，不排就没有「下一帧」这回事。
   *
   * force=true = 无视「睡着了不报」（删掉一只宠物时必须报，否则形状留在老地方）。
   */
  function pushHitRegion(force) {
    if (asleep && !force) return; // 冻住时位置不变，形状也就不会变
    if (regionQueued || regionTimer) return;
    var wait = HIT_THROTTLE_MS - (Date.now() - lastRegionAt);
    if (wait <= 0) {
      regionQueued = true;
      var fired = false;
      var fallback = 0;
      var fire = function () {
        if (fired) return;
        fired = true;
        regionQueued = false;
        if (fallback) clearTimeout(fallback);
        emitHitRegion();
      };
      // rAF 不是保险的：窗只要有一阵子不合成帧（被另一只透明全屏窗盖住、屏保、锁屏、
      // 远程桌面断开），rAF 就一直不回调 —— 于是命中区永远发不出去，宠物看着好好的
      // 却点不动（主进程还停在 1×1 的起步形状）。所以 setTimeout 兜底，谁先到算谁。
      fallback = setTimeout(fire, 32);
      requestAnimationFrame(fire);
      return;
    }
    regionTimer = setTimeout(function () {
      regionTimer = null;
      pushHitRegion();
    }, wait);
  }

  /** 漫游时写样式/上报命中区的帧率上限（毫秒/帧）。全屏透明窗每改一次样式就得
   *  重合成一次（见 4.7），60fps 的漫游 = 每秒 60 次全屏重合成。 */
  var MOVE_FRAME_MS = 33;

  // ========================================================================
  // 4.6 位置记忆（拖到哪儿，下次启动还在哪儿）
  //
  // 以前拖完就丢：宠物下一次启动又回 config.jsonc 写死的那个角落，用户得每次重拖。
  // 现在：
  //   写：松手 → savePosition() → preload → 主进程 → /control set-position
  //        → 宿主落盘 home/positions.json（**比例** 0~1，不是像素：换分辨率/换屏幕
  //        之后仍落在同一个「地方」，而不是停在旧分辨率下的坐标上跑到屏外）
  //   读：窗连上 /ws 时宿主补发一帧 {"type":"positions",...}（老窗不认识 → 直接忽略）
  //        → applySavedPositions() 盖掉 config 的角落。
  // ⚠️ 只在「本次运行还没人拖过它」时套用：用户已经动过的宠物，不能被迟到的补发帧拽回去。
  // ========================================================================

  var savedPositions = {}; // id → {rx, ry}

  /** 把宿主给的位置套到宠物身上（按 id；单只且只有一条记录时允许借用，见下）。 */
  function applySavedPositions() {
    var keys = Object.keys(savedPositions || {});
    if (!keys.length || !pets.length) return;
    for (var i = 0; i < pets.length; i++) {
      var p = pets[i];
      if (!p || p.movedLocally || p.destroyed) continue;
      var pos = savedPositions[p.id];
      // config.jsonc 里的 id 被改过时位置会认不出来。只有**单只 + 只有一条记录**才借：
      // 多条记录时猜（拿 keys[0]）会把宠物放到别的只记住的地方去，那更糟。
      if (!pos && pets.length === 1 && keys.length === 1) pos = savedPositions[keys[0]];
      if (!pos) continue;
      p.customPos = { rx: Number(pos.rx), ry: Number(pos.ry) };
      if (typeof p.applyPosition === "function") p.applyPosition();
    }
    pushHitRegion(); // 位置变了 = 命中区变了（宠物挪走了，得跟着走）
  }

  /** 记住一只的落点（拖拽松手时调）。没有桥（浏览器里直接看）就静默跳过。 */
  function savePosition(pet) {
    var api = window.__petElectron__;
    if (!api || !api.savePosition || !pet || !pet.customPos) return;
    try {
      api.savePosition(pet.id, pet.customPos.rx, pet.customPos.ry);
    } catch (e) {
      /* 主进程还没 ready —— 下次拖就存上了 */
    }
  }

  // ========================================================================
  // 4.7 空闲休眠（别抢别的窗口的渲染预算）
  //
  // 症状：这扇窗是**全屏透明 + 置顶**的。它每产生一帧，DWM 就得把整块桌面重新合成一遍
  // （连带下面所有窗口一起）。而待机链本来就在不停地抽动画 —— 于是宠物永远有新帧，
  // 别的程序（浏览器、IDE、播放器）的后台窗口就抢不到合成预算了：
  // 「桌宠一开，别人的窗口就不刷新 / 卡成幻灯片」。
  //
  // 修法只有一个原则：**没事的时候别产生帧**。
  //   · 空闲超过 timing.idleSleepMs（默认 45s）→ 冻在当前那一帧：
  //     视频 pause()、漫游的 rAF 停、命中区不再上报。逻辑（定时器）还留着，
  //     所以醒来时状态机还在原地，不会有「要重新选一段动画」的突变。
  //   · 任何活动立刻醒：WS 事件（思考中/写代码/气泡）、鼠标碰到宠物、右键菜单、
  //     「说点什么」输入框、窗尺寸变了。
  //   · 主进程也会喊：窗被最小化 / 屏保锁屏 / 系统挂起 → 睡（pet:power，见 pet-electron.cjs）。
  //   · 用户手动开的省电模式（右键菜单）是无条件的，睡到他自己关掉为止。
  //
  // 睡 ≠ 暂停响应（那个是「不理 agent 状态」）：省电时气泡文字照常更新，
  // 只是没有新帧而已。
  // ========================================================================

  var sleepTimer = null;
  var asleep = false;    // 冻住了吗（= 全屏一帧都不再产生）
  var powerSave = false; // 用户手动开的省电模式：没它就别自动醒
  var lastMoveActivity = 0;

  function idleSleepMs() {
    var ms = config && config.timing ? Number(config.timing.idleSleepMs) : TIMING_DEFAULT.idleSleepMs;
    return isFinite(ms) && ms >= 0 ? ms : TIMING_DEFAULT.idleSleepMs;
  }

  /** 睡：所有宠物冻在当前帧。
   *  ⚠️ 不因为「已经 asleep」就早退：省电模式下新加一只宠物时，它照样得冻住
   *  （PetCard.sleep/wake 自己幂等，这里只是多走一遍）。
   */
  function goSleep() {
    asleep = true;
    for (var i = 0; i < pets.length; i++) {
      if (pets[i] && typeof pets[i].sleep === "function") pets[i].sleep();
    }
  }

  /** 醒：接着当前这一帧往下放（pause/play 不改 currentTime，不会跳回第一帧）。 */
  function goWake() {
    asleep = false;
    for (var i = 0; i < pets.length; i++) {
      if (pets[i] && typeof pets[i].wake === "function") pets[i].wake();
    }
  }

/** 有活动了：先醒，再把空闲计时器推后。窗里所有的用户输入/事件入口都走这里。 */
  function noteActivity() {
    if (asleep && !powerSave) goWake();
    armIdle();
  }

  /** 指针是不是真落在宠物（含它的气泡/输入框）上。
   *  ⚠️ 这扇窗是 setIgnoreMouseEvents(true, { forward: true })：整个窗的 mousemove
   *  都会被转发到渲染进程（包括宠物以外的整块屏幕）。照单全收的话，用户随便动一下
   *  鼠标就永远睡不着了（等于没做）。所以必须问一句「指针真在宠物身上吗」。
   */
  function pointerOnPet(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el || !el.closest) return false;
    return !!el.closest(".pet-hit, .pet-bubble");
  }

  /** 重排「多久没动静就睡」。省电模式 = 立刻睡，且只有用户自己能让它醒。 */
  function armIdle() {
    if (sleepTimer) {
      clearTimeout(sleepTimer);
      sleepTimer = null;
    }
    if (powerSave) {
      goSleep();
      return;
    }
    var ms = idleSleepMs();
    if (!(ms > 0) || !pets.length) return;
    sleepTimer = setTimeout(function () {
      sleepTimer = null;
      if (powerSave || !pets.length) return;
      goSleep();
    }, ms);
  }

  // ========================================================================
  // 5. PetCard class (port of pet.ts PetCard component)
  // ========================================================================

  /** Shared config (loaded from /config.jsonc + WebSocket update) */
  var config = null;

  function PetCard(cfg, rootEl) {
    var self = this;
    this.cfg = cfg;
    this.size = cfg.size;
    this.facing = "left";
    this.facingRef = "left";

    // ---- Derived ----
    var halfW = this.size / 2;
    var halfH = (this.size * 9) / 16 / 2;

    /**
     * 把容器位置夹回屏幕内。不夹的话宠物能被拖到只剩半个身子在屏幕里（头顶的气泡
     * 跟着出屏，再被主进程的 SetWindowRgn 裁一刀，看着就像「气泡被切了一半」）。
     * extraBottom = 舞台额外的下移量（站位对齐脚底用的），算下边界时算进去。
     */
    function clampPos(left, top, extraBottom) {
      var maxLeft = Math.max(0, window.innerWidth - halfW * 2);
      var maxTop = Math.max(0, window.innerHeight - halfH * 2 - (extraBottom || 0));
      return {
        left: Math.min(Math.max(left, 0), maxLeft),
        top: Math.min(Math.max(top, 0), maxTop),
      };
    }

    // ---- State ----
    this.anim = "";
    this.once = true;
    this.seq = 0;
    this.customPos = null; // {rx, ry}
    this.id = cfg.id;       // 位置记忆的键（和宿主 home/positions.json 对齐）
    this.movedLocally = false; // 本次运行里用户自己拖过：之后就别再用宿主补发的位置覆盖它
    this.dragging = false;
    this.overrideAnim = null;  // WS-driven temporary override
    this.overrideTimer = null;
    this.currentOverrideAnim = null; // Name of active WS override (for click-during-override)
    this.overrideActive = null;     // Name currently looping as override (anti-replay)
    this.clickFromOverride = false;  // flag: click happened during override
    this.hovering = false;           // 鼠标是否在命中框里
    this.hoverAnim = "";             // 本次 hover 放的动画名
    // 节奏三件套：playing=屏幕上真正在放的那一段，playedAt=它开始播的时刻。
    // ⚠️ 判定「屏幕上是什么」一律用 playing，别用 self.anim —— anim 是**链子刚决定**的名字，
    // 切换被门禁挡下来的时候两者会差一段（那时 anim 已经是下一个了，屏幕还在放上一个）。
    this.playing = "";               // 正在显示的动画名
    this.playedAt = 0;               // playing 开始播放的时刻（0 = 还没播过）
    this.queued = null;              // 被最小播放时长挡下来的切换请求 {anim, once}
    this.queuedTimer = null;
    this.dwellTimer = null;          // 待机停留计时器
    this.destroyed = false;
    this.asleep = false;             // 冻住（见 4.7）
    this.asleepNext = null;          // 冻住期间「该演哪一段」，醒来补上

    // ---- Refs ----
    this.gen = 0;
    this.pending = null;   // {anim, once, gen}
    this.frontIdx = 0;     // 0 or 1
    this.moveRef = null;
    this.moveToken = 0;
    this.pendingMove = null;
    this.justDragged = false;

    var dragState = { active: false, dragging: false, sx: 0, sy: 0, offX: 0, offY: 0 };

    // ---- Build DOM ----
    var container = document.createElement("div");
    container.className = "pet-container";
    container.setAttribute("data-pet-id", cfg.id);

    var stage = document.createElement("div");
    stage.className = "pet-stage";

    var videoA = document.createElement("video");
    videoA.className = "pet-video is-front";
    videoA.muted = true;
    videoA.playsInline = true;

    var videoB = document.createElement("video");
    videoB.className = "pet-video";
    videoB.muted = true;
    videoB.playsInline = true;

    var hit = document.createElement("div");
    hit.className = "pet-hit";

    stage.appendChild(videoA);
    stage.appendChild(videoB);
    stage.appendChild(hit);

    container.appendChild(stage);
    rootEl.appendChild(container);
    self.el = container; // 定位/漫游时用来量包围盒
    self.hitEl = hit; // 命中区上报用真正能点的那块（见 4.5）

    // ---- Position (corner-based initial) ----
    applyPosition();
    pushHitRegion();
    window.addEventListener("resize", function () {
      noteActivity(); // resize = 用户动了窗
      if (self.customPos) applyPosition();
      pushHitRegion();
    });

    function applyPosition() {
      if (self.customPos) {
        var cp = self.customPos;
        var left = Math.min(Math.max(cp.rx * window.innerWidth - halfW, 0), window.innerWidth - self.size);
        var top = Math.min(Math.max(cp.ry * window.innerHeight - halfH, 0), window.innerHeight - (self.size * 9) / 16);
        container.style.left = left + "px";
        container.style.top = top + "px";
        container.style.right = "auto";
        container.style.bottom = "auto";
        return;
      }
      container.style.removeProperty("top");
      container.style.removeProperty("bottom");
      container.style.removeProperty("left");
      container.style.removeProperty("right");
      var corner = cfg.position.corner;
      if (corner === "bottom-right") { container.style.right = cfg.position.marginX + "px"; container.style.bottom = cfg.position.marginY + "px"; }
      else if (corner === "bottom-left") { container.style.left = cfg.position.marginX + "px"; container.style.bottom = cfg.position.marginY + "px"; }
      else if (corner === "top-right") { container.style.right = cfg.position.marginX + "px"; container.style.top = cfg.position.marginY + "px"; }
      else if (corner === "top-left") { container.style.left = cfg.position.marginX + "px"; container.style.top = cfg.position.marginY + "px"; }
    }
    self.applyPosition = applyPosition; // 位置记忆套用时要重新贴位（见 4.6）

    // ---- Stage size ----
    stage.style.width = this.size + "px";
    stage.style.height = (this.size * 9) / 16 + "px";

    // ---- Floor alignment ----
    var bottomPad = (this.size * (9 / 16) * (CANVAS_H - FEET_Y)) / CANVAS_H;
    stage.style.transform = "translateY(" + bottomPad + "px)";

    // ---- Hit area ----
    hit.style.left = (HIT_BOX.x0 / 640) * 100 + "%";
    hit.style.top = (HIT_BOX.y0 / 360) * 100 + "%";
    hit.style.width = ((HIT_BOX.x1 - HIT_BOX.x0) / 640) * 100 + "%";
    hit.style.height = ((HIT_BOX.y1 - HIT_BOX.y0) / 360) * 100 + "%";

    // ---- Electron mouse passthrough ----
    // 正常路径：主进程用 setShape 把命中区裁到宠物身上，这里不用管穿透。
    // 老 Electron（没有 setShape）才走开关式：进命中框收事件、离开穿回去。
    var passthrough = true;
    function setPassthrough(on) {
      if (passthrough === on) return;
      passthrough = on;
      if (window.__petElectron__) {
        window.__petElectron__.setPassthrough(on);
      }
    }

    /**
     * 鼠标移入 = 打招呼（hover 动画），移出 = 收回。
     * 不打断：拖拽中 / 正在响应 agent（override）/ 正在放点击回应。
     *
     * ⚠️ 移入是**用户自己动的**，立刻播（不然打招呼要等两秒才反应过来）；
     * 移出是**被动**的，走门禁 —— 不许把屏幕上正演到一半的动作砍掉（老实现就是
     * 一移出鼠标立刻换回待机动画，动画没演完就被切掉，观感上就是「待机太短」）。
     */
    this.setHover = function (on) {
      if (self.hovering === on) return;
      self.hovering = on;
      var hover = config.animations.hover;
      if (!hover || !hover.length) return;

      if (on) {
        if (dragState.active || self.dragging || self.currentOverrideAnim || self.clickFromOverride) return;
        if (config.animations.clicks.indexOf(self.playing) >= 0 || hover.indexOf(self.playing) >= 0) return;
        self.stopDwell();
        self.stopMove();
        self.hoverAnim = pick(hover, self.anim);
        self.anim = self.hoverAnim;
        // once=false：hover 不算「一次性反应动画」，所以不会把左键点击也一并禁掉
        self.once = false;
        self.seq++;
        self.switchTo(self.hoverAnim, true, { force: true }); // 播一遍就好，不循环
      } else {
        // 还在放 hover 就回待机，但**别从中间砍**：门禁会等这一段放完再换
        if (self.hoverAnim && self.playing === self.hoverAnim && !self.currentOverrideAnim && !dragState.active) {
          self.hoverAnim = "";
          if (config.animations.idle.length) {
            self.anim = pick(config.animations.idle, self.anim);
            self.once = true;
            self.seq++;
            self.switchTo(self.anim, true);
          }
        }
      }
    };

    hit.addEventListener("mouseenter", function () {
      noteActivity(); // 鼠标碰到宠物 = 有活动（冻着的宠物靠这个醒，见 4.7）
      setPassthrough(false);
      hit.style.cursor = "grab";
      self.setHover(true);
    });
    hit.addEventListener("mouseleave", function () {
      noteActivity();
      setPassthrough(true);
      hit.style.cursor = "";
      self.setHover(false);
    });

    // ---- Right-click → menu ----
    // The menu itself is native (built in the main process) because the window is a
    // transparent click-through overlay — an in-page menu would fight the passthrough.
    // It only needs to say "what state am I in"; every action goes through the host's
    // control API, so the menu and pi/dsh/curl all drive the same state owner.
    hit.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      noteActivity(); // 右键菜单也总是「有人在看」
      if (!window.__petElectron__ || !window.__petElectron__.openMenu) return;
      bubbleTarget = self;
      window.__petElectron__.openMenu({
        state: describeState(self),
        size: self.size,
        facing: self.facing,
        pets: pets.length,
      });
    });

    // ---- Speech bubble + manual input ----
    // The bubble hangs above the pet and is reused for every message (state text and
    // anything a human types). It is NOT part of the v1 wire format: the host sends
    // {"type":"bubble",...} and we only render it, so an old window ignores the frame.
    var bubble = document.createElement("div");
    bubble.className = "pet-bubble";
    bubble.style.display = "none";
    // 文案单独占一个节点：直接 bubble.textContent = 文案 会把同级的输入框节点一起删掉
    // （之后 askSay 拿到的就是个脱离 DOM 的 input，「说点什么…」框永远出不来）。
    var bubbleText = document.createElement("span");
    bubbleText.className = "pet-bubble-text";
    bubble.appendChild(bubbleText);
    container.appendChild(bubble);
    self.bubbleEl = bubble; // 命中区要把头顶的气泡算进去

    var bubbleTimer = null;

    /** 气泡贴到屏幕边（宠物拖到边角）时把它挪回来，不然半边在屏幕外 = 看着被切了一半。
        偏移走 left/bottom（不在 transition 里，改完立刻到位，不会一边补一边抖）。 */
    self.clampBubble = function () {
      if (!bubble.classList.contains("show")) return;
      var r = bubble.getBoundingClientRect();
      if (!r || !(r.width > 0) || !(r.height > 0)) return;
      var W = window.innerWidth;
      var H = window.innerHeight;
      var dx = 0;
      var dy = 0;
      if (r.left < 8) dx = 8 - r.left;
      else if (r.right > W - 8) dx = W - 8 - r.right;
      if (r.top < 8) dy = 8 - r.top;
      else if (r.bottom > H - 8) dy = H - 8 - r.bottom;
      // 写一样的值没有代价，但每帧都写新值会让浏览器白排一次版
      if (!dx) bubble.style.removeProperty("left");
      else bubble.style.left = "calc(50% + " + Math.round(dx) + "px)";
      // bottom 越大越靠上，所以往下挪是减
      if (!dy) bubble.style.removeProperty("bottom");
      else bubble.style.bottom = "calc(100% - " + Math.round(dy) + "px)";
    };

    self.showBubble = function (text, opts) {
      opts = opts || {};
      var t = String(text == null ? "" : text);
      if (!t) return;
      noteActivity(); // 有话说 = 有活动（气泡靠这个醒）
      if (bubbleText.textContent !== t) bubbleText.textContent = t;
      bubble.classList.add("show");
      bubble.classList.toggle("sticky", opts.sticky === true);
      bubble.style.display = "";
      self.clampBubble();
      pushHitRegion(); // 气泡会改变命中区（它在宠物头顶）
      if (bubbleTimer) clearTimeout(bubbleTimer);
      var ms = Number(opts.ms) || 0;
      // sticky = 状态还在：不清计时器，靠宿主每 10s 的续期帧接着
      if (!opts.sticky && ms > 0) {
        bubbleTimer = setTimeout(function () {
          bubble.classList.remove("show");
          bubbleTimer = null;
        }, ms);
      }
    };
    self.hideBubble = function () {
      if (bubbleTimer) clearTimeout(bubbleTimer);
      bubbleTimer = null;
      bubble.classList.remove("show");
      pushHitRegion();
    };

    // 「说点什么…」：输入框就长在气泡里。Enter 提交，Esc 取消。
    // 提交走主进程 → 宿主 /control（只有主进程手里有 token）。
    var input = document.createElement("input");
    input.className = "pet-bubble-input";
    input.type = "text";
    input.maxLength = 80;
    input.placeholder = "说点什么…（Enter 发送）";
    // 亮不亮全看 class：写内联 display:none 的话优先级压过 .on{display:block}，框永远出不来
    input.classList.remove("on");
    bubble.appendChild(input);
    bubble.classList.add("has-input");

    /** 输入框开着？（主进程靠这个决定要不要把窗切成可聚焦） */
    var inputOpen = false;

    /** 收工：清框、藏气泡、告诉主进程把键盘焦点还给下面的窗口。所有关闭路径都走这里。 */
    function closeInput() {
      if (!inputOpen) return;
      inputOpen = false;
      input.value = "";
      input.classList.remove("on");
      bubble.classList.remove("with-input");
      self.hideBubble();
      if (window.__petElectron__ && window.__petElectron__.sayInputEnd) window.__petElectron__.sayInputEnd();
    }

    /** 焦点要等主进程把窗切成可聚焦才留得住，所以补几遍（第一下常常被系统吐掉）。
        补到最后一遍还没拿到焦点 = 这扇窗根本激活不了（少见，但以前就是这么变成
        「框挂在屏幕上打不进字也关不掉」的）→ 干脆收框，把键盘还给用户。 */
    var FOCUS_LADDER = [0, 40, 120, 300, 600, 1200];
    function focusInput() {
      if (!inputOpen) return;
      FOCUS_LADDER.forEach(function (ms, idx) {
        setTimeout(function () {
          if (!inputOpen) return;
          try { input.focus(); } catch { /* ignore */ }
          var last = idx === FOCUS_LADDER.length - 1;
          if (last && document.activeElement !== input) closeInput();
        }, ms);
      });
      // 立刻也要一下：主进程已经把窗激活时，同帧 focus() 就够（input.select 只补选中态）
      try { input.select(); } catch { /* ignore */ }
    }

    function submitInput() {
      var v = input.value.trim();
      closeInput();
      if (!v) return;
      if (window.__petElectron__ && window.__petElectron__.say) window.__petElectron__.say(v);
      else self.showBubble(v, { ms: 5000 });
    }

    self.askSay = function () {
      inputOpen = true;
      noteActivity(); // 输入框开着期间不许睡（不然打字时宠物是冻着的）
      bubble.classList.add("show");
      bubble.classList.add("with-input");
      input.classList.add("on"); // ⚠️ 不能写 style.display = ""：样式表里的 display:none
      //    优先级更高，空的内联样式等于「按样式表来」，框还是出不来
      bubble.style.display = "";
      self.clampBubble();
      pushHitRegion();
      focusInput();
    };
    input.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Enter") submitInput();
      else if (e.key === "Escape") closeInput();
    });
    // 点输入框时别触发宠物的点击/拖拽逻辑
    input.addEventListener("mousedown", function (e) { e.stopPropagation(); });
    input.addEventListener("click", function (e) { e.stopPropagation(); });
    // 鼠标落回框上时再要一次焦点（Windows 上第一次点击往往只是把窗激活）
    input.addEventListener("mouseup", function () { focusInput(); });
    // 点宠物身上 = 「不说了」：顺便把焦点还给下面的窗口
    input.addEventListener("blur", function () {
      setTimeout(function () {
        if (inputOpen && document.activeElement !== input) closeInput();
      }, 120);
    });
    self.closeInput = closeInput;

    // 右键菜单里的「说点什么…」→ 主进程叫这一声
    if (window.__petElectron__ && window.__petElectron__.onAskSay) {
      window.__petElectron__.onAskSay(function () { self.askSay(); });
    }
    // 主进程强制收（失焦 / 开了菜单）：别让框赖在屏幕上不走
    if (window.__petElectron__ && window.__petElectron__.onSayCancel) {
      window.__petElectron__.onSayCancel(function () { closeInput(); });
    }

    // ---- Switch to animation (dual buffer crossfade) ----
    //
    // ⚠️ 门禁：一段动画**没播够 minPlayMs 就不许被别人切走**（用户自己动手除外）。
    // 待机时把一段动作从中间砍掉的全是**被动**切换 —— 鼠标扫过宠物（hover 移出就回待机）、
    // 拖拽落点回待机、待机链重抽。老实现直接换 src，正在播的那段当场消失，屏幕上就是
    // 「动画还没执行完就跳下一个」。现在这些请求先排队（queueSwitch），等当前这段播完
    // （ended）或播够 minPlayMs 再切；只有用户自己的动作（点一下 / 拖起来 / 拖完落回待机）
    // 和状态驱动的 override 才立刻打断 —— 打断本来就是它们的本意。
    this.switchTo = function (next, nextOnce, opts) {
      if (!next) return;
      // 冻住时**连 src 都不换**（换 src = 解码首帧 + 一次重绘，那正是要省掉的开销）。
      // 只记下该演哪一段，醒来（wake）再补上。
      if (self.asleep) {
        self.asleepNext = { anim: next, once: nextOnce };
        return;
      }
      var force = !!(opts && opts.force);
      if (!force && !self.canInterrupt()) {
        self.queueSwitch(next, nextOnce);
        return;
      }
      // 同一段还在放 → 别从头重播（重播 = 跳回第一帧，看着就是「闪了一下」）。
      // ⚠️ 只对**一次性**动画生效：循环中的（override / 待机停留）跳过一次就会永远卡在
      // 那一条里 —— 它的 onended 是 null，链子再也接不上（宠物再也不动了）。
      if (!force && next === self.playing && !self.pending) {
        var cur = self.frontIdx === 0 ? videoA : videoB;
        if (!cur.ended && !cur.loop) return;
      }
      self.clearQueue();
      var pending = self.pending;
      if (pending && pending.anim === next && pending.once === nextOnce) return;
      var gen = ++self.gen;
      self.pending = { anim: next, once: nextOnce, gen: gen };
      var target = self.frontIdx === 0 ? videoB : videoA;
      target.src = "/thumb/" + encodeURIComponent(next) + ".webm";
      target.loop = !nextOnce;
      target.onended = nextOnce ? handleEnded : null;

      var onReady = function () {
        target.removeEventListener("loadeddata", onReady);
        if (self.pending && self.pending.gen !== gen) return;
        var old = self.frontIdx === 0 ? videoA : videoB;
        target.classList.add("is-front");
        old.classList.remove("is-front");
        self.frontIdx = self.frontIdx === 0 ? 1 : 0;
        self.pending = null;
        self.playing = next;   // 屏幕上真正在放的（判定「演到哪了」只看它）
        self.playedAt = Date.now();
        target.style.transform = self.facingRef === "right" ? "scaleX(-1)" : "";
        if (!self.asleep) target.play().catch(function () {});
        if (self.pendingMove && !self.asleep) self.startMoveDrive(target);
      };
      target.addEventListener("loadeddata", onReady);
      if (target.readyState >= 2) onReady();
    };

    /** 现在允许把屏幕上这一段切走吗？ */
    this.canInterrupt = function () {
      if (!self.playing || !self.playedAt) return true; // 还没开始播 / 什么都没播
      if (self.currentOverrideAnim) return true; // 状态帧驱动的 override 必须立刻响应
      if (dragState.active || self.dragging) return true; // 拖拽要跟手
      if (self.dwellTimer) return true; // 待机停留中：这一轮本来就播完了
      var front = self.frontIdx === 0 ? videoA : videoB;
      if (front.ended) return true; // 已经放完，正等着切下一个
      return Date.now() - self.playedAt >= minPlayMs();
    };

    /** 切不动就先记着：等当前这段放完（或播够 minPlayMs）再切，不打断它。 */
    this.queueSwitch = function (anim, once) {
      if (self.destroyed) return;
      if (self.queued && self.queued.anim === anim && self.queued.once === once) {
        if (self.queuedTimer) return;
      } else {
        self.queued = { anim: anim, once: once };
      }
      if (self.queuedTimer) clearTimeout(self.queuedTimer);
      var left = Math.max(16, minPlayMs() - (Date.now() - self.playedAt));
      self.queuedTimer = setTimeout(function () {
        self.queuedTimer = null;
        var q = self.queued;
        self.queued = null;
        if (!q || self.destroyed) return;
        if (dragState.active || self.dragging || self.currentOverrideAnim) return; // 期间被别的事接管了，丢弃
        self.switchTo(q.anim, q.once);
      }, left);
    };

    this.clearQueue = function () {
      self.queued = null;
      if (self.queuedTimer) {
        clearTimeout(self.queuedTimer);
        self.queuedTimer = null;
      }
    };

    // ---- 待机停留：待机段放完之后别急着抽下一个 ----
    // 链子的权重是 idle 10 / turn 5 / move 5 / action 80（见 assets/config.jsonc），
    // 也就是「一段待机呼吸刚结束就有 90% 概率跳去演随机动作」—— 屏幕上的宠物几乎
    // 没有真正停下来的时候，观感就是「待机时间太短」。这里让待机那一段原地续播
    // idleDwellMs 再往下走；期间用户一动（点/拖/状态帧）立刻收摊。
    this.canDwell = function (name) {
      if (self.currentOverrideAnim || dragState.active || self.dragging) return false;
      if (idleDwellMs() <= 0) return false;
      return config.animations.idle.indexOf(name) >= 0;
    };

    this.startDwell = function (name) {
      if (self.destroyed) return;
      if (self.dwellTimer) clearTimeout(self.dwellTimer);
      self.anim = name;
      self.once = false; // 停留期间循环放
      // 直接让**当前这一条**视频继续循环，不换 src —— 换 src 会从第一帧重来，
      // 那又是一次「跳回去」。待机呼吸这类素材本来就是循环片，续播看不出接缝。
      var front = self.frontIdx === 0 ? videoA : videoB;
      try {
        front.loop = true;
        front.onended = null;
        // 冻住时别偷跑：不然待机停留会把暂停的视频重新放起来（等于没睡）
        if (!self.asleep) {
          var p = front.play();
          if (p && p.catch) p.catch(function () {});
        }
      } catch (e) {
        /* 续播失败也别把链子卡住：下面的计时器照样接上 */
      }
      self.playedAt = Date.now();
      self.dwellTimer = setTimeout(function () {
        self.dwellTimer = null;
        if (self.destroyed || self.currentOverrideAnim || dragState.active || self.dragging) return;
        self.once = true;
        self.seq++;
        self.pickNext();
      }, idleDwellMs());
    };

    this.stopDwell = function () {
      if (!self.dwellTimer) return;
      clearTimeout(self.dwellTimer);
      self.dwellTimer = null;
    };

    // ---- Animation chain: pick next ----
    this.pickNext = function () {
      var anims = config.animations;
      var weights = config.animationWeights;
      var roll = Math.random();
      var k = rollKind(roll, weights);
      var kind, next;
      if (k === "idle") {
        kind = "IDLE";
        next = pick(anims.idle, self.anim);
        self.anim = next;
      } else if (k === "turn") {
        kind = "TURN";
        next = pick(anims.turn, self.anim);
        self.anim = next;
      } else if (k === "move") {
        if (!self.tryMove()) {
          var act = pickCategoryAction(anims.categories, anims.idle, self.facingRef, self.anim);
          kind = act.id;
          next = act.name;
          self.anim = next;
        } else {
          kind = "MOVE";
          next = "(move)";
        }
      } else {
        var act2 = pickCategoryAction(anims.categories, anims.idle, self.facingRef, self.anim);
        kind = act2.id;
        next = act2.name;
        self.anim = next;
      }
      self.once = true;
      self.seq++;
      self.switchTo(next, true);
    };

    var handleEnded = function () {
      var anims = config.animations;
      if (dragState.active) return;
      // 屏幕上真正放完的那一段（self.anim 可能已经被门禁挡下的请求改掉了）
      var endedAnim = self.playing || self.anim;
      // Turn anims flip facing on end
      if (anims.turn.indexOf(endedAnim) >= 0) {
        var nextF = self.facing === "left" ? "right" : "left";
        self.facing = nextF;
        self.facingRef = nextF;
      }
      // Drag/click anims → return to idle (or re-enter override if click was during override)
      if (anims.drag.indexOf(endedAnim) >= 0 || anims.clicks.indexOf(endedAnim) >= 0) {
        if (self.clickFromOverride && self.currentOverrideAnim) {
          self.clickFromOverride = false;
          self.playOverride(self.currentOverrideAnim, OVERRIDE_DURATION_MS);
          return;
        }
        if (anims.idle.length) self.anim = pick(anims.idle, endedAnim);
        self.once = true;
        self.seq++;
        self.switchTo(self.anim, true);
        return;
      }
      // 待机段放完 → 原地续播一小会儿（默认 6s），别一口气接着演
      if (self.canDwell(endedAnim)) {
        self.startDwell(endedAnim);
        return;
      }
      self.pickNext();
    };

    // ---- Movement system ----
    this.currentCenterX = function () {
      if (self.customPos) return self.customPos.rx * window.innerWidth;
      var r = container.getBoundingClientRect();
      return r.left + halfW;
    };
    this.currentCenterY = function () {
      if (self.customPos) return self.customPos.ry * window.innerHeight;
      var r = container.getBoundingClientRect();
      return r.top + halfH;
    };

    this.startMoveDrive = function (el) {
      var pm = self.pendingMove;
      if (!pm || self.moveRef !== null) return;
      self.pendingMove = null;
      var startRatio = pm.startRatio, startYRatio = pm.startYRatio, targetRatio = pm.targetRatio;
      var dir = pm.dir, totalRatio = pm.totalRatio, leadSec = pm.leadSec, tailSec = pm.tailSec;
      var duration = (isFinite(el.duration) && el.duration > 0) ? el.duration : 10.09;
      var travelWindow = Math.max(0.1, duration - leadSec - tailSec);
      var token = ++self.moveToken;
      // 漫游的位移写样式 + 上报命中区是这一段最贵的两步（见 4.7）：
      // 全屏透明窗每改一次样式就要重合成一次，所以这里把帧率封在 30fps ——
      // 观感上看不出（漫游本来就慢），合成压力直接砍半。
      var lastWrite = 0;

      var step = function () {
        if (self.moveToken !== token) return;
        var t = el.currentTime || 0;
        var W = window.innerWidth;
        var H = window.innerHeight;
        var ratioX;
        if (t <= leadSec) ratioX = startRatio;
        else if (t >= duration - tailSec) ratioX = targetRatio;
        else ratioX = startRatio + dir * totalRatio * ((t - leadSec) / travelWindow);
        var px = ratioX * W;
        var py = startYRatio * H;
        var last = t >= duration - tailSec;
        var now = Date.now();
        // 最后一帧必须写进去（否则会停在倒数第二帧的位置上）
        if (last || now - lastWrite >= MOVE_FRAME_MS) {
          lastWrite = now;
          var mp = clampPos(px - halfW, py - halfH, bottomPad);
          container.style.left = mp.left + "px";
          container.style.top = mp.top + "px";
          container.style.right = "auto";
          container.style.bottom = "auto";
          // 漫游中每一帧位置都在变：命中区必须跟着走，否则形状留在出发点，
          // 宠物移到哪儿就点不到了（旧位置还会留一块点不动的「鬼影」区）
          pushHitRegion();
        }
        if (!last) self.moveRef = requestAnimationFrame(step);
        else {
          self.moveRef = null;
          // 存**实际落点**而不是计划点：贴边时 clampPos 会把宠物夹回屏内，
          // 存计划点的话下次 resize 一下宠物就又飞到屏外去了
          var done = container.getBoundingClientRect();
          self.customPos = { rx: (done.left + halfW) / W, ry: (done.top + halfH) / H };
        }
      };
      self.moveRef = requestAnimationFrame(step);
    };

    this.tryMove = function () {
      if (self.moveRef !== null || self.pendingMove) return true;
      var moves = config.animations.moves;
      var actions = moves.actions;
      if (!actions.length) return false;
      var chosen = actions[Math.floor(Math.random() * actions.length)];
      var mp = Object.assign({}, moves.default, chosen.params || {});
      var dir = (self.facingRef === "right") !== (config.animations.turn.indexOf(self.playing || self.anim) >= 0) ? 1 : -1;
      var W = window.innerWidth;
      var plan = planMove({
        cx: self.currentCenterX(),
        cy: self.currentCenterY(),
        W: W,
        H: window.innerHeight,
        dir: dir,
        minDist: mp.minDist,
        maxDist: mp.maxDist,
        margin: mp.margin,
        halfW: halfW,
      });
      if (!plan) return false;
      self.pendingMove = Object.assign({}, plan, { dir: dir, leadSec: mp.leadSec, tailSec: mp.tailSec });
      self.once = true;
      self.anim = chosen.name;
      // force：漫游的落点/相位是按这一段动画的计划算的，晚切一步就会在原地先愣一下
      self.switchTo(chosen.name, true, { force: true });
      return true;
    };

    this.stopMove = function () {
      self.pendingMove = null;
      self.moveToken++;
      if (self.moveRef !== null) {
        cancelAnimationFrame(self.moveRef);
        self.moveRef = null;
      }
    };

    // ---- Pointer events (click vs drag) ----
    hit.addEventListener("pointerdown", function (e) {
      e.currentTarget.classList.add("dragging");
      // 输入框开着的时候点宠物 = 「不说了」：先收掉，别把焦点一直扣在透明窗上
      if (self.closeInput) self.closeInput();
      self.stopDwell(); // 用户上手了，待机停留立刻收摊
      self.stopMove();
      setPassthrough(false); // capture during drag
      e.currentTarget.setPointerCapture(e.pointerId);
      var r = container.getBoundingClientRect();
      dragState = {
        active: true,
        dragging: false,
        sx: e.clientX,
        sy: e.clientY,
        offX: e.clientX - (r.left + r.width / 2),
        offY: e.clientY - (r.top + r.height / 2),
      };
    });

    hit.addEventListener("pointermove", function (e) {
      if (!dragState.active) return;
      noteActivity(); // 拖拽中也得盯着：不然拖到一半睡了就“松手了它不动”
      var dx = e.clientX - dragState.sx;
      var dy = e.clientY - dragState.sy;
      if (!dragState.dragging) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        dragState.dragging = true;
        self.dragging = true;
        self.once = true;
        if (config.animations.drag.length) {
          self.anim = pick(config.animations.drag);
          self.switchTo(self.anim, true, { force: true }); // 拖起来了就得立刻换姿势
        }
      }
      // 拖拽也要夹在屏幕内（舞台的下移量这时是 none，所以按 halfH 算下边界）
      var dp = clampPos(e.clientX - dragState.offX - halfW, e.clientY - dragState.offY - halfH, 0);
      container.style.left = dp.left + "px";
      container.style.top = dp.top + "px";
      container.style.right = "auto";
      container.style.bottom = "auto";
      stage.style.transform = "none";
      pushHitRegion(); // 拖到哪儿，命中区就到哪儿（不然半路就「松手」了）
    });

    hit.addEventListener("pointerup", function (e) {
      var wasDragging = dragState.dragging;
      dragState.active = false;
      dragState.dragging = false;
      e.currentTarget.classList.remove("dragging");
      // Restore passthrough if mouse has already left the hitbox
      if (passthrough === false) {
        var r = hit.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
          setPassthrough(true);
        }
      }
      if (wasDragging) {
        self.justDragged = true;
        setTimeout(function () { self.justDragged = false; }, 100);
        self.dragging = false;
        self.customPos = { rx: (e.clientX - dragState.offX) / window.innerWidth, ry: (e.clientY - dragState.offY) / window.innerHeight };
        self.movedLocally = true;
        savePosition(self); // 记住落点：下次启动还在这儿（宿主落盘，比例坐标）
        stage.style.transform = "translateY(" + bottomPad + "px)";
        pushHitRegion(); // 落点定死，再报一次（节流可能刚好把最后一下挡掉了）
        if (config.animations.idle.length) self.anim = pick(config.animations.idle, self.anim);
        self.once = false;
        self.switchTo(self.anim, false, { force: true }); // 落回待机是拖拽的一部分，跟着手
      }
    });

    hit.addEventListener("pointercancel", function (e) {
      hit.dispatchEvent(new PointerEvent("pointerup", e));
    });

    hit.addEventListener("click", function () {
      if (dragState.active || dragState.dragging || self.justDragged) return;
      if (self.once && config.animations.idle.indexOf(self.playing) < 0) return;
      self.stopDwell();
      self.stopMove();

      // Click during WS override (thinking/coding): cancel timer,
      // play 傲娇生气, then re-enter override on end
      if (self.currentOverrideAnim) {
        if (self.overrideTimer) clearTimeout(self.overrideTimer);
        self.overrideTimer = null;
        self.clickFromOverride = true;
        self.anim = "点击回应-傲娇生气";
        self.once = true;
        self.seq++;
        self.switchTo(self.anim, true, { force: true });
        return;
      }

      self.once = true;
      if (config.animations.clicks.length) {
        self.anim = pick(config.animations.clicks);
        self.switchTo(self.anim, true, { force: true });
      }
    });

    // ---- Override: WebSocket forces a specific animation ----
    this.playOverride = function (animName, durationMs) {
      self.stopDwell(); // 状态帧来了：待机停留让位
      self.stopMove();
      if (self.overrideTimer) clearTimeout(self.overrideTimer);
      self.currentOverrideAnim = animName; // always update so re-entry picks latest state
      // Don't interrupt a click-response that's playing during override
      if (self.clickFromOverride) return;
      // Same animation already looping → **don't replay it**. Producers keep saying
      // "still thinking" (every 2s); restarting the video each time looks like a stutter.
      // The override animation loops by itself, so all we do here is extend the timer.
      if (self.overrideActive === animName) {
        if (durationMs && durationMs > 0 && isFinite(durationMs)) {
          self.overrideTimer = setTimeout(function () { resetToChain(); }, durationMs);
        }
        return;
      }
      self.overrideActive = animName;
      self.anim = animName;
      self.once = false; // loop while override active
      self.seq++;
      self.switchTo(animName, false, { force: true }); // 状态必须立刻反映到屏幕上
      if (durationMs && durationMs > 0 && isFinite(durationMs)) {
        self.overrideTimer = setTimeout(function () {
          resetToChain();
        }, durationMs);
      }
    };

    function resetToChain() {
      if (self.overrideTimer) clearTimeout(self.overrideTimer);
      self.overrideTimer = null;
      self.currentOverrideAnim = null;
      self.overrideActive = null;
      self.clickFromOverride = false;
      self.stopMove();
      // Return to idle, then pickNext will fire on ended
      if (config.animations.idle.length) {
        self.anim = pick(config.animations.idle);
        self.once = true;
        self.seq++;
        self.switchTo(self.anim, true, { force: true });
      }
    }

    this.destroy = function () {
      self.destroyed = true;
      self.stopDwell();
      self.clearQueue();
      self.stopMove();
      if (self.overrideTimer) clearTimeout(self.overrideTimer);
      container.remove();
      // force：睡着了也要报（不然形状留在已经删掉的宠物老地方，那儿会点不动也点不出东西）
      pushHitRegion(true);
    };

    // ---- 睡 / 醒（见 4.7） ----
    //
    // 睡 = 「一帧都不再产生」：视频暂停（不 pause 的话播放引擎还在出帧，
    // 全屏透明窗每一帧都要 DWM 重合成，于是变成跟别的窗口抢渲染预算）。
    // 定时器/状态机都不动 —— 醒来时宠物还站在原地、还接着放，逻辑没丢。
    this.sleep = function () {
      if (self.asleep || self.destroyed) return;
      self.asleep = true;
      // 漫游的 rAF 是 60fps 写样式 —— 睡前必须停，否则「静止」还在烧 CPU
      if (self.moveRef !== null) {
        cancelAnimationFrame(self.moveRef);
        self.moveRef = null;
      }
      self.pendingMove = null;
      try {
        videoA.pause();
        videoB.pause();
      } catch (e) {
        /* pause 失败也别把逻辑卡住 */
      }
    };

    this.wake = function () {
      if (!self.asleep || self.destroyed) return;
      self.asleep = false;
      // 睡着时排队的「该演哪一段」现在补上；没有就接着当前这一帧往下放
      // （pause/play 不改 currentTime，不会跳回第一帧）。
      var q = self.asleepNext;
      self.asleepNext = null;
      if (q) {
        self.switchTo(q.anim, q.once, { force: true });
        return;
      }
      var front = self.frontIdx === 0 ? videoA : videoB;
      try {
        var p = front.play();
        if (p && p.catch) p.catch(function () {});
      } catch (e) {
        /* 续播失败就当没醒：下个事件还会再试 */
      }
    };

    // ---- Start playing ----
    // Don't start until config is loaded (handled by init below)
    this.init = function () {
      if (config.animations.idle.length) {
        self.anim = pick(config.animations.idle);
        self.once = true;
        self.switchTo(self.anim, true);
      }
    };
  }

  // ========================================================================
  // 6. WebSocket event mapping
  // ========================================================================

  /** Maps WebSocket events to pet override animations */
  var EVENT_ANIM_MAP = {
    "agent_start": "深度思考碎碎念",
    "thinking": "深度思考碎碎念",
  };

  /** Tool name → animation mapping */
  var TOOL_ANIM_MAP = {
    "bash": "写代码",
    "code": "写代码",
    "grep": "搜寻中",    // fallback
    "read": "写代码",
    "edit": "写代码",
    "write": "写代码",
    "find": "搜寻中",
  };

  /** How long overrides stay before returning to normal chain */
  var OVERRIDE_DURATION_MS = 5000;

  /** Menu labels: animation name → what the user sees in the right-click menu */
  var STATE_LABEL = {
    "深度思考碎碎念": "思考中",
    "写代码": "写代码中",
    "搜寻中": "搜索中",
  };

  /** Human-readable current state (for the right-click menu) */
  function describeState(pet) {
    var anim = pet && pet.currentOverrideAnim;
    if (!anim) return "待机（随机动画）";
    return STATE_LABEL[anim] || anim;
  }

  var pets = []; // PetCard instances
  var addPetSeq = 0; // counter for auto-generated pet ids
  var bubbleTarget = null; // 最近一次被右键的宠物：手动输入与气泡优先出现在它头上

/** Maps size arg to px width.
      ⚠️ 最小档别再往小了：气泡是 16:9 舞台头顶的 max-content 块（最宽 420px），舞台太窄时
      气泡和动画一起被挤到屏幕边上，看着像「被裁了一半」。380 起。 */
  var SIZE_MAP = { small: 380, normal: 400, large: 540 };

  /** Create a new pet at a random corner (called on /pet when window already running) */
  function addPet(sizeArg) {
    if (!config) return;
    sizeArg = sizeArg || "normal";
    addPetSeq++;
    var corners = ["top-left", "top-right", "bottom-left", "bottom-right"];
    var corner = corners[Math.floor(Math.random() * corners.length)];
    var size = SIZE_MAP[sizeArg] || SIZE_MAP.normal;
    var cfg = {
      id: "auto-" + addPetSeq,
      size: size,
      position: { corner: corner, marginX: 30 + Math.floor(Math.random() * 60), marginY: 30 + Math.floor(Math.random() * 120) }
    };
    var root = document.getElementById("pet-root");
    var pet = new PetCard(cfg, root);
    pets.push(pet);
    pet.init();
    // 新宠物进屋：既重新起计空闲计时器，醒来晚了也得马上把它冻住
    //（省电模式下 init() 会 play()，不补这一下新来的就在满速放）
    if (asleep) pet.sleep();
    noteActivity();
    applySavedPositions(); // 新加的这只也认得「上次的位置」（id 认不出就单只借位，见 4.6）
    pushHitRegion(); // 进了 pets 才量得到它（构造时它还没进数组）
  }

  /** Apply an event override to all pets */
  function applyEventOverride(anim) {
    pets.forEach(function (pet) {
      pet.playOverride(anim, OVERRIDE_DURATION_MS);
    });
  }

  /** Show a bubble (state text or a typed message) on the pet the user is talking to. */
  function applyBubble(obj) {
    if (!pets.length) return;
    var target = bubbleTarget && bubbleTarget.showBubble ? bubbleTarget : pets[0];
    if (obj.sticky !== true && !(Number(obj.ms) > 0)) obj.ms = 5000;
    target.showBubble(obj.text, { ms: obj.ms, sticky: obj.sticky === true });
  }

/**
   * 省电帧（v1.3，见 4.7）：on = 冻住动画（气泡文字照常更新）。
   * 用户手动开的省电模式**不会自己醒** —— 只有关掉省电才醒（不然一动鼠标
   * 就又满速解码了，那还不如不开）。
   */
  function applyPowerFrame(on) {
    powerSave = on === true;
    if (powerSave) goSleep();
    else {
      goWake();
      armIdle();
    }
  }

  /** Apply a tool override */
  function applyToolOverride(toolName) {
    var anim = TOOL_ANIM_MAP[toolName];
    if (anim) {
      pets.forEach(function (pet) {
        pet.playOverride(anim, OVERRIDE_DURATION_MS);
      });
    } else {
      // Unknown tool: pick a random action
      if (config && config.animations.categories.length) {
        var act = pickCategoryAction(config.animations.categories, config.animations.idle, "left", "");
        pets.forEach(function (pet) {
          pet.playOverride(act.name, OVERRIDE_DURATION_MS);
        });
      }
    }
  }

  // ========================================================================
  // 7. WebSocket connection
  // ========================================================================

  var ws = null;
  var reconnectTimer = null;
  var reconnectAttempts = 0;
  var MAX_RECONNECT_ATTEMPTS = 5;
  var DISCONNECT_BANNER_ID = "disconnected-banner";

  function connectWs() {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var url = proto + "//" + location.host + "/ws";
    ws = new WebSocket(url);

    ws.onopen = function () {
      console.log("[pi-dsh-pet] WebSocket connected");
      reconnectAttempts = 0;
      noteActivity();
      var banner = document.getElementById(DISCONNECT_BANNER_ID);
      if (banner) banner.classList.remove("show");
      pushHitRegion(); // 提示条没了，命中区跟着收回来
    };

    ws.onmessage = function (event) {
      var msg = event.data;
      // Try JSON first
      try {
        var obj = JSON.parse(msg);
        if (obj.type === "power") {
          // v1.3: 省电开关（老窗不认识这帧，无害）
          applyPowerFrame(obj.sleep === true);
          return;
        }
        if (obj.type === "tool_call") {
          applyToolOverride(obj.tool);
          return;
        }
        if (obj.type === "bubble") {
          // v1.1: state text and anything a human typed. Old windows ignore this frame.
          applyBubble(obj);
          return;
        }
        if (obj.type === "positions") {
          // v1.2: 上次拖到哪儿（老窗不认识这帧，当普通字符串事件也无害）
          noteActivity(); // 位置帧会让宠物挪窝，得先醒（不然报告的形状停在老地方）
          savedPositions = obj.map && typeof obj.map === "object" ? obj.map : {};
          applySavedPositions();
          return;
        }
      } catch (_) { /* plain string */ }

      // Plain string events
      noteActivity(); // 宿主来了消息 = 有人在用（agent 干活时宠物该一直醒着）
      var anim = EVENT_ANIM_MAP[msg];
      if (anim) {
        applyEventOverride(anim);
      } else if (msg === "agent_idle") {
        // pets return to chain naturally via override timeout
      } else if (msg === "add_pet") {
        addPet();
      } else if (msg.startsWith("add_pet:")) {
        addPet(msg.slice("add_pet:".length));
      } else if (msg === "shutdown") {
        if (window.__petElectron__ && window.__petElectron__.closeWindow) {
          window.__petElectron__.closeWindow();
        }
        return;
      }
    };

    ws.onclose = function () {
      console.log("[pi-dsh-pet] WebSocket disconnected");
      noteActivity(); // 掉线提示条要能显示出来（睡着的窗不更新形状，提示条会被裁掉）
      var banner = document.getElementById(DISCONNECT_BANNER_ID);
      if (banner) banner.classList.add("show");
      pushHitRegion(); // 提示条在屏幕右上角，得留在命中区里（它要能被点到/看到）
      reconnectAttempts++;
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.log("[pi-dsh-pet] Max reconnect attempts reached, closing window");
        if (window.__petElectron__ && window.__petElectron__.closeWindow) {
          window.__petElectron__.closeWindow();
        }
        return;
      }
      reconnectTimer = setTimeout(connectWs, 3000);
    };

    ws.onerror = function () {
      // ws.onclose will fire after this
    };
  }

  // ========================================================================
  // 8. Init: load config → create pets → connect WS → start
  // ========================================================================

  async function init() {
    // Fetch config
    var resp = await fetch("/config.jsonc");
    if (!resp.ok) throw new Error("Failed to load config.jsonc: " + resp.status);
    var text = await resp.text();
    var raw = JSON.parse(stripJsonc(text));
    config = assertClientConfig(raw);

    // Create pet instances
    var root = document.getElementById("pet-root");
    config.pets.forEach(function (cfg) {
      var pet = new PetCard(cfg, root);
      pets.push(pet);
    });

    // 首次上报命中区。必须在这里发：构造期那只宠物还没进 pets，量不出矩形，
    // 而主进程起步只给 1×1 的命中点 —— 不发的话宠物出生后长时间点不到
    //（要等它漫游或冒气泡才会补上）。
    pushHitRegion();

    // Start all pets
    pets.forEach(function (pet) { pet.init(); });

    // ---- 睡 / 醒 的另外两个开关（见 4.7） ----
    //
    // ① 主进程：窗看不见的时候（最小化 / 屏保锁屏 / 挂起）喊我们冻住。
    //    这时候没人看，可满速解码 WebM 纯粹是把别人的合成预算抢走。
    if (window.__petElectron__ && window.__petElectron__.onPower) {
      window.__petElectron__.onPower(function (sleep) {
        if (sleep) goSleep();
        else {
          goWake();
          armIdle();
        }
      });
    }
    // ② 页签本身被切走（浏览器里打开的宠物页同理）：一样别产生帧
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) goSleep();
      else {
        goWake();
        armIdle();
      }
    });
// ③ 全局活动：指针真的落在宠物身上、或者按键/滚轮 → 有活动。
    //    mousemove 在漫游/拖拽时能到每秒 60 次，所以自己限流（1s 一次就够续命了）。
    //    ⚠️ 穿透窗会把**整个窗**的 mousemove 都转发过来（见 pointerOnPet），
    //    不查「指针在不在宠物上」的话，用户动一下鼠标就永远不睡了。
    document.addEventListener(
      "mousemove",
      function (e) {
        var now = Date.now();
        if (now - lastMoveActivity < 1000) return;
        lastMoveActivity = now;
        if (!pointerOnPet(e.clientX, e.clientY)) return;
        noteActivity();
      },
      { passive: true }
    );
    ["keydown", "wheel"].forEach(function (ev) {
      document.addEventListener(ev, noteActivity, { passive: true });
    });

    // 从这儿开始计时：开播前就空转计时器等于白算一次
    armIdle();

    // Connect WebSocket
    connectWs();
  }

  // ---- Start when DOM ready ----
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();