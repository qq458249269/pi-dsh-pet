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

    return { pets: pets, animations: a, animationWeights: w };
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
  var regionQueued = false;
  var regionTimer = null;
  var lastRegionKey = "";
  var lastRegionAt = 0;

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
        x: box.left,
        y: box.top,
        width: box.right - box.left,
        height: box.bottom - box.top,
      });
    }
    // 「掉线了」提示条长在屏幕右上角，不在宠物身上，一并算进去免得被裁掉
    var banner = document.getElementById(DISCONNECT_BANNER_ID);
    if (banner && banner.classList && banner.classList.contains("show")) {
      var rr = banner.getBoundingClientRect();
      if (rr && rr.width > 0) {
        out.push({ x: rr.left - 4, y: rr.top - 4, width: rr.width + 8, height: rr.height + 8 });
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
   */
  function pushHitRegion() {
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
    this.dragging = false;
    this.overrideAnim = null;  // WS-driven temporary override
    this.overrideTimer = null;
    this.currentOverrideAnim = null; // Name of active WS override (for click-during-override)
    this.overrideActive = null;     // Name currently looping as override (anti-replay)
    this.clickFromOverride = false;  // flag: click happened during override
    this.hovering = false;           // 鼠标是否在命中框里
    this.hoverAnim = "";             // 本次 hover 放的动画名

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
     */
    this.setHover = function (on) {
      if (self.hovering === on) return;
      self.hovering = on;
      var hover = config.animations.hover;
      if (!hover || !hover.length) return;

      if (on) {
        if (dragState.active || self.dragging || self.currentOverrideAnim || self.clickFromOverride) return;
        if (config.animations.clicks.indexOf(self.anim) >= 0 || hover.indexOf(self.anim) >= 0) return;
        self.stopMove();
        self.hoverAnim = pick(hover, self.anim);
        self.anim = self.hoverAnim;
        // once=false：hover 不算「一次性反应动画」，所以不会把左键点击也一并禁掉
        self.once = false;
        self.seq++;
        self.switchTo(self.hoverAnim, true); // 播一遍就好，不循环
      } else {
        // 还在放 hover 就立刻回待机，别让打完招呼的姿势挂在屏幕上
        if (self.hoverAnim && self.anim === self.hoverAnim && !self.currentOverrideAnim && !dragState.active) {
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
      setPassthrough(false);
      hit.style.cursor = "grab";
      self.setHover(true);
    });
    hit.addEventListener("mouseleave", function () {
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

    /** 焦点要等主进程把窗切成可聚焦才留得住，所以补两下（第一下常常被系统吐掉）。 */
    function focusInput() {
      if (!inputOpen) return;
      input.focus();
      input.select();
      requestAnimationFrame(function () { if (inputOpen) input.focus(); });
      setTimeout(function () { if (inputOpen) input.focus(); }, 60);
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
    this.switchTo = function (next, nextOnce) {
      if (!next) return;
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
        target.style.transform = self.facingRef === "right" ? "scaleX(-1)" : "";
        target.play().catch(function () {});
        if (self.pendingMove) self.startMoveDrive(target);
      };
      target.addEventListener("loadeddata", onReady);
      if (target.readyState >= 2) onReady();
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
      // Turn anims flip facing on end
      if (anims.turn.indexOf(self.anim) >= 0) {
        var nextF = self.facing === "left" ? "right" : "left";
        self.facing = nextF;
        self.facingRef = nextF;
      }
      // Drag/click anims → return to idle (or re-enter override if click was during override)
      if (anims.drag.indexOf(self.anim) >= 0 || anims.clicks.indexOf(self.anim) >= 0) {
        if (self.clickFromOverride && self.currentOverrideAnim) {
          self.clickFromOverride = false;
          self.playOverride(self.currentOverrideAnim, OVERRIDE_DURATION_MS);
          return;
        }
        if (anims.idle.length) self.anim = pick(anims.idle, self.anim);
        self.once = true;
        self.seq++;
        self.switchTo(self.anim, true);
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
        var mp = clampPos(px - halfW, py - halfH, bottomPad);
        container.style.left = mp.left + "px";
        container.style.top = mp.top + "px";
        container.style.right = "auto";
        container.style.bottom = "auto";
        // 漫游中每一帧位置都在变：命中区必须跟着走，否则形状留在出发点，
        // 宠物移到哪儿就点不到了（旧位置还会留一块点不动的「鬼影」区）
        pushHitRegion();
        if (t < duration - tailSec) self.moveRef = requestAnimationFrame(step);
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
      var dir = (self.facingRef === "right") !== (config.animations.turn.indexOf(self.anim) >= 0) ? 1 : -1;
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
      self.switchTo(chosen.name, true);
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
      var dx = e.clientX - dragState.sx;
      var dy = e.clientY - dragState.sy;
      if (!dragState.dragging) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        dragState.dragging = true;
        self.dragging = true;
        self.once = true;
        if (config.animations.drag.length) {
          self.anim = pick(config.animations.drag);
          self.switchTo(self.anim, true);
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
        stage.style.transform = "translateY(" + bottomPad + "px)";
        pushHitRegion(); // 落点定死，再报一次（节流可能刚好把最后一下挡掉了）
        if (config.animations.idle.length) self.anim = pick(config.animations.idle, self.anim);
        self.once = false;
        self.switchTo(self.anim, false);
      }
    });

    hit.addEventListener("pointercancel", function (e) {
      hit.dispatchEvent(new PointerEvent("pointerup", e));
    });

    hit.addEventListener("click", function () {
      if (dragState.active || dragState.dragging || self.justDragged) return;
      if (self.once && config.animations.idle.indexOf(self.anim) < 0) return;
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
        self.switchTo(self.anim, true);
        return;
      }

      self.once = true;
      if (config.animations.clicks.length) {
        self.anim = pick(config.animations.clicks);
        self.switchTo(self.anim, true);
      }
    });

    // ---- Override: WebSocket forces a specific animation ----
    this.playOverride = function (animName, durationMs) {
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
      self.switchTo(animName, false);
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
        self.switchTo(self.anim, true);
      }
    }

    this.destroy = function () {
      self.stopMove();
      if (self.overrideTimer) clearTimeout(self.overrideTimer);
      container.remove();
      pushHitRegion(); // 别把已经删掉的宠物的位置留在命中区里
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

  /** Maps size arg to px width */
  var SIZE_MAP = { small: 260, normal: 400, large: 540 };

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
      var banner = document.getElementById(DISCONNECT_BANNER_ID);
      if (banner) banner.classList.remove("show");
      pushHitRegion(); // 提示条没了，命中区跟着收回来
    };

    ws.onmessage = function (event) {
      var msg = event.data;
      // Try JSON first
      try {
        var obj = JSON.parse(msg);
        if (obj.type === "tool_call") {
          applyToolOverride(obj.tool);
          return;
        }
        if (obj.type === "bubble") {
          // v1.1: state text and anything a human typed. Old windows ignore this frame.
          applyBubble(obj);
          return;
        }
      } catch (_) { /* plain string */ }

      // Plain string events
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