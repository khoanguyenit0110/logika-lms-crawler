/* eslint-disable no-console */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const readline = require("readline");
const AdmZip = require("adm-zip");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const URLS_FILE = path.join(ROOT, "urls.txt");
const OUTPUT_DIR = path.join(ROOT, "output");
const PROFILE_DIR = process.env.PROFILE_DIR
  ? path.resolve(process.env.PROFILE_DIR)
  : path.join(ROOT, ".playwright-profile");

const VERSION = "playwright-crawler-v1.2-modal-continue-click";
const LMS_HOME = "https://lms.logikaschool.com/";

const ASSET_FETCH_TIMEOUT_MS = Number(process.env.ASSET_FETCH_TIMEOUT_MS || 5000);
const ASSET_STABLE_WAIT_ROUNDS = Number(process.env.ASSET_STABLE_WAIT_ROUNDS || 30);
const ASSET_STABLE_WAIT_INTERVAL_MS = Number(process.env.ASSET_STABLE_WAIT_INTERVAL_MS || 300);
const LEVEL_WAIT_TIMEOUT_MS = Number(process.env.LEVEL_WAIT_TIMEOUT_MS || 20000);

const HEADLESS = String(process.env.HEADLESS || "false").toLowerCase() === "true";
const VIEWPORT_WIDTH = Number(process.env.VIEWPORT_WIDTH || 1600);
const VIEWPORT_HEIGHT = Number(process.env.VIEWPORT_HEIGHT || 900);
const FULL_PAGE_SCREENSHOT = String(process.env.FULL_PAGE_SCREENSHOT || "false").toLowerCase() === "true";

const HANDLE_TUTORIAL_MODALS = String(process.env.HANDLE_TUTORIAL_MODALS || "true").toLowerCase() === "true";
const MAX_MODAL_STEPS = Number(process.env.MAX_MODAL_STEPS || 5);
const MODAL_AFTER_CLICK_WAIT_MS = Number(process.env.MODAL_AFTER_CLICK_WAIT_MS || 900);

function clean(s) {
  return String(s || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeFilePart(s) {
  const v = clean(s)
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 90);
  return v || "asset";
}

function escapeRegexText(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function envInfo() {
  return {
    VERSION,
    HEADLESS,
    VIEWPORT_WIDTH,
    VIEWPORT_HEIGHT,
    FULL_PAGE_SCREENSHOT,
    HANDLE_TUTORIAL_MODALS,
    MAX_MODAL_STEPS,
    MODAL_AFTER_CLICK_WAIT_MS,
    ASSET_FETCH_TIMEOUT_MS,
    ASSET_STABLE_WAIT_ROUNDS,
    ASSET_STABLE_WAIT_INTERVAL_MS,
    LEVEL_WAIT_TIMEOUT_MS,
    PROFILE_DIR,
  };
}

async function ensureDirs() {
  await fsp.mkdir(OUTPUT_DIR, { recursive: true });
  await fsp.mkdir(PROFILE_DIR, { recursive: true });
}

function askEnter(promptText) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    rl.question(promptText, () => {
      rl.close();
      resolve();
    });
  });
}

async function launchContext() {
  await ensureDirs();

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    viewport: {
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
    },
    deviceScaleFactor: 1,
    acceptDownloads: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=Translate",
    ],
  });

  context.setDefaultTimeout(10000);
  context.setDefaultNavigationTimeout(30000);

  return context;
}

async function login() {
  console.log("[login] Opening LMS with persistent browser profile...");
  console.log(`[login] Profile dir: ${PROFILE_DIR}`);

  const context = await launchContext();
  const page = context.pages()[0] || (await context.newPage());

  await page.goto(LMS_HOME, { waitUntil: "domcontentloaded" }).catch(() => {});

  console.log("\nLogin to LMS in the opened browser window.");
  console.log("After login succeeds, return to this terminal and press Enter.\n");

  await askEnter("Press Enter after login is done... ");

  await context.close();

  console.log("[login] Session saved.");
}

function readUrlsFromFile() {
  if (!fs.existsSync(URLS_FILE)) {
    throw new Error(`urls.txt not found: ${URLS_FILE}`);
  }

  const lines = fs.readFileSync(URLS_FILE, "utf8").split(/\r?\n/);

  return lines
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => !x.startsWith("#"));
}

function getUrlParams(url) {
  try {
    const u = new URL(url);
    const p = u.searchParams;

    return {
      taskId: p.get("task") || "",
      level: p.get("level") || "",
      track: p.get("track") || "",
      moduleId: p.get("module") || "",
      lessonId: p.get("lesson") || "",
      position: p.get("position") || "",
      previewId: (u.pathname.match(/task-preview\/([^/?#]+)/) || [])[1] || "",
    };
  } catch {
    return {
      taskId: "",
      level: "",
      track: "",
      moduleId: "",
      lessonId: "",
      position: "",
      previewId: "",
    };
  }
}

function zipNameForUrl(url, levelsCount, skippedRatingCount) {
  const p = getUrlParams(url);

  const parts = [
    "logika-capture",
    p.taskId ? `task-${p.taskId}` : "",
    p.lessonId ? `lesson-${p.lessonId}` : "",
    !p.taskId && !p.lessonId && p.previewId ? `preview-${p.previewId}` : "",
    `levels-${levelsCount}`,
    skippedRatingCount ? `rating-skipped-${skippedRatingCount}` : "",
    new Date().toISOString().replace(/[:.]/g, "-"),
  ].filter(Boolean);

  return `${parts.map(sanitizeFilePart).join("_")}.zip`;
}

async function waitForBasicLoad(page) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(700);
}

async function discoverTopRow(page) {
  return await page.evaluate(() => {
    const clean = (s) =>
      String(s || "")
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const all = (s, doc = document) => Array.from(doc.querySelectorAll(s));

    const visible = (el) => {
      try {
        if (!el || !document.body.contains(el)) return false;

        const st = getComputedStyle(el);
        const r = el.getBoundingClientRect();

        return (
          st.display !== "none" &&
          st.visibility !== "hidden" &&
          Number.isFinite(r.width) &&
          Number.isFinite(r.height) &&
          r.width > 3 &&
          r.height > 3
        );
      } catch {
        return false;
      }
    };

    const clickable = (el) => {
      let c = el;

      for (let i = 0; c && i < 10; i += 1, c = c.parentElement) {
        if (c.matches?.("button,a,[role='button'],[role='tab'],[tabindex]")) {
          return c;
        }
      }

      return el;
    };

    const getText = (el) =>
      clean(
        (el?.innerText || el?.textContent || "") +
          " " +
          (el?.getAttribute?.("aria-label") || "") +
          " " +
          (el?.title || "")
      );

    const addCandidate = (raw, el) => {
      try {
        const t = clickable(el);

        if (!t || !visible(t) || !document.body.contains(t)) return;

        const r = t.getBoundingClientRect();
        const text = getText(t);
        const inner = clean(t.innerText || t.textContent || "");
        const isNum = /^\d+$/.test(inner);
        const hasSvg = !!t.querySelector?.("svg") || t.tagName.toLowerCase() === "svg";
        const hasIcon = /[★☆✦✧✪✩✕✖☺☹☻🙂🙁😐]/.test(text);

        const square =
          r.width >= 20 &&
          r.height >= 20 &&
          r.width <= 95 &&
          r.height <= 95 &&
          Math.abs(r.width - r.height) <= 32;

        const top = r.y >= 0 && r.y <= 120;

        const bad =
          /html|css|javascript|python|hint|run|check|next|back|submit|answer|console|preview|content plan|tasks will be checked|download|project files|save|show solution/i.test(
            text
          );

        if (top && square && !bad && (isNum || hasSvg || hasIcon)) {
          raw.push({
            text: inner || text,
            isNum,
            x: Math.round(r.x),
            y: Math.round(r.y),
            width: Math.round(r.width),
            height: Math.round(r.height),
            cx: Math.round(r.x + r.width / 2),
            cy: Math.round(r.y + r.height / 2),
            area: r.width * r.height,
          });
        }
      } catch {}
    };

    const raw = [];

    all("button,a,[role='button'],[role='tab'],[tabindex],div,span,li,svg,path")
      .filter(visible)
      .forEach((el) => addCandidate(raw, el));

    for (let y = 5; y <= 115; y += 8) {
      for (let x = 20; x <= window.innerWidth - 20; x += 12) {
        try {
          document
            .elementsFromPoint(x, y)
            .slice(0, 6)
            .forEach((el) => addCandidate(raw, el));
        } catch {}
      }
    }

    const unique = [];

    for (const i of raw.sort((a, b) => b.area - a.area)) {
      if (
        !unique.some(
          (u) => Math.abs(u.cx - i.cx) < 10 && Math.abs(u.cy - i.cy) < 10
        )
      ) {
        unique.push(i);
      }
    }

    const clusters = [];

    for (const item of unique.sort((a, b) => a.cx - b.cx)) {
      let added = false;

      for (const cl of clusters) {
        if (
          Math.abs(cl[0].cy - item.cy) <= 22 &&
          item.cx - cl[cl.length - 1].cx <= 85
        ) {
          cl.push(item);
          added = true;
          break;
        }
      }

      if (!added) {
        clusters.push([item]);
      }
    }

    clusters.forEach((cl) => cl.sort((a, b) => a.cx - b.cx));

    let best =
      clusters
        .filter((cl) => cl.length >= 1 && cl.some((x) => x.isNum))
        .sort((a, b) => b.length - a.length)[0] ||
      clusters.sort((a, b) => b.length - a.length)[0] ||
      [];

    best = best.filter(
      (x) => x.cx > window.innerWidth * 0.08 && x.cx < window.innerWidth * 0.92
    );

    return best.map((item, i) => ({
      slot: i + 1,
      levelNo: i + 1,
      label: item.isNum ? clean(item.text) : `icon_${i + 1}`,
      kind: item.isNum ? "number" : "icon",
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      cx: item.cx,
      cy: item.cy,
    }));
  });
}

async function pageSignals(page) {
  return await page.evaluate(() => {
    const clean = (s) =>
      String(s || "")
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const all = (s, doc = document) => Array.from(doc.querySelectorAll(s));
    const bodyText = () => (document.body ? document.body.innerText : "");

    const visible = (el) => {
      try {
        if (!el || !document.body.contains(el)) return false;

        const st = getComputedStyle(el);
        const r = el.getBoundingClientRect();

        return (
          st.display !== "none" &&
          st.visibility !== "hidden" &&
          Number.isFinite(r.width) &&
          Number.isFinite(r.height) &&
          r.width > 3 &&
          r.height > 3
        );
      } catch {
        return false;
      }
    };

    const txt = clean(bodyText());
    const compact = txt.toLowerCase().replace(/\s+/g, " ");

    const isFeedbackPage = (() => {
      if (/did\s+you\s+like\s+the\s+(task|lesson|exercise|activity|project)\??/i.test(compact)) return true;
      if (/do\s+you\s+like\s+the\s+(task|lesson|exercise|activity|project)\??/i.test(compact)) return true;
      if (/how\s+was\s+the\s+(task|lesson|exercise|activity|project)\??/i.test(compact)) return true;
      if (/rate\s+the\s+(task|lesson|exercise|activity|project)/i.test(compact)) return true;

      const hasLikeQuestion =
        /did\s+you\s+like/i.test(compact) ||
        /do\s+you\s+like/i.test(compact) ||
        /how\s+was/i.test(compact) ||
        /rate\s+this/i.test(compact);

      return hasLikeQuestion && compact.length > 10 && compact.length < 500;
    })();

    const hasLoadedVisibleImage = all("img")
      .filter(visible)
      .some((img) => {
        try {
          const r = img.getBoundingClientRect();
          return r.width >= 80 && r.height >= 80 && img.complete && img.naturalWidth > 0;
        } catch {
          return false;
        }
      });

    const hasNextButton = all("button,[role='button'],a,div,span")
      .filter(visible)
      .some((el) => clean(el.innerText || el.textContent).toLowerCase() === "next");

    const hasLoadedVisibleImagePage = hasLoadedVisibleImage && hasNextButton;

    const lines = String(txt || "")
      .split(/\n+/)
      .map(clean)
      .filter(Boolean);

    const rest = lines.filter((x) => !/^\d+$/.test(x)).join(" ");
    const meaningful = rest.length > 25 || isFeedbackPage || hasLoadedVisibleImagePage;

    const hasRadioOrCheckbox =
      all("input[type='radio'],input[type='checkbox'],[role='radio'],[role='checkbox']")
        .filter(visible).length > 0;

    const hasAnswerLikeButton = all("button,[role='button'],a,div,span")
      .filter(visible)
      .some((el) => {
        const t = clean(el.innerText || el.textContent || "").toLowerCase();
        return /^(answer|check|submit|run|show solution|try again)$/i.test(t);
      });

    const hasScratchEditor =
      /show solution/i.test(txt) ||
      /last save by student/i.test(txt) ||
      /tasks with automatic check/i.test(txt) ||
      /tasks will be checked by the teacher/i.test(txt) ||
      /motion\s+looks\s+events/i.test(compact) ||
      /sprite\s+x\s+y\s+show\s+size\s+direction/i.test(compact) ||
      /costumes\s+sounds/i.test(compact);

    const hasCodeEditor =
      !!window.monaco?.editor ||
      all(".ace_editor,.CodeMirror,.cm-content,textarea,pre,code").filter(visible).length > 0;

    const hasQuizText =
      /no correct answer/i.test(txt) ||
      /what\s+.*\?/i.test(txt) ||
      /choose\s+the\s+correct/i.test(compact) ||
      /select\s+the\s+correct/i.test(compact);

    let pageType = "static";

    if (isFeedbackPage) {
      pageType = "feedback";
    } else if (hasLoadedVisibleImagePage) {
      pageType = "static_image";
    } else if (
      hasRadioOrCheckbox ||
      hasAnswerLikeButton ||
      hasScratchEditor ||
      hasCodeEditor ||
      hasQuizText
    ) {
      pageType = "activity";
    }

    return {
      text: txt,
      compactText: compact,
      title: document.title || "",
      url: location.href,
      isFeedbackPage,
      hasLoadedVisibleImagePage,
      meaningful,
      pageType,
      visibleImages: all("img").filter(visible).length,
    };
  });
}

async function waitLoaded(page) {
  const start = Date.now();
  let last = "";
  let same = 0;
  let lastSignals = null;

  while (Date.now() - start < LEVEL_WAIT_TIMEOUT_MS) {
    await page.waitForTimeout(250);

    const sig = await pageSignals(page);
    lastSignals = sig;

    if (sig.isFeedbackPage) {
      return {
        loaded: true,
        reason: "rating_page_detected_skip",
        signals: sig,
      };
    }

    if (sig.hasLoadedVisibleImagePage) {
      return {
        loaded: true,
        reason: "static_image_page_detected",
        signals: sig,
      };
    }

    if (sig.meaningful) {
      if (clean(sig.text) === clean(last)) {
        same += 1;
      } else {
        same = 0;
      }

      if (same >= 4) {
        return {
          loaded: true,
          reason: "content_stable",
          signals: sig,
        };
      }

      last = sig.text;
    } else {
      last = sig.text;
      same = 0;
    }
  }

  const finalSignals = lastSignals || (await pageSignals(page));

  return {
    loaded:
      finalSignals.meaningful ||
      finalSignals.isFeedbackPage ||
      finalSignals.hasLoadedVisibleImagePage,
    reason: finalSignals.isFeedbackPage
      ? "rating_page_detected_after_wait_skip"
      : finalSignals.hasLoadedVisibleImagePage
      ? "static_image_page_detected_after_wait"
      : "timeout",
    signals: finalSignals,
  };
}

async function clickSlot(page, slot, frozenRow) {
  let liveRow = [];

  try {
    liveRow = await discoverTopRow(page);
  } catch {}

  const live = liveRow[slot - 1] || frozenRow[slot - 1];

  if (!live) {
    return {
      clicked: false,
      loaded: false,
      reason: "slot_not_found",
    };
  }

  await page.mouse.click(live.cx, live.cy);

  let loadResult = await waitLoaded(page);

  if (!loadResult.loaded) {
    try {
      liveRow = await discoverTopRow(page);
      const retryLive = liveRow[slot - 1] || live;
      await page.mouse.click(retryLive.cx, retryLive.cy);
      loadResult = await waitLoaded(page);
    } catch {}
  }

  const sig = await pageSignals(page);

  if (!sig.isFeedbackPage) {
    await page.waitForTimeout(500);
  }

  return {
    clicked: true,
    loaded: loadResult.loaded,
    reason: loadResult.reason,
    clickedAt: {
      x: live.cx,
      y: live.cy,
    },
  };
}

async function countRelativeAssetsInDom(page) {
  return await page.evaluate(() => {
    const found = new Set();

    const isRelativeUrl = (url) => {
      const u = String(url || "").trim();

      if (!u) return false;
      if (u.startsWith("data:")) return true;
      if (u.startsWith("blob:")) return false;
      if (u.startsWith("http://")) return false;
      if (u.startsWith("https://")) return false;
      if (u.startsWith("//")) return false;
      if (u.startsWith("#")) return false;
      if (u.startsWith("mailto:")) return false;
      if (u.startsWith("tel:")) return false;
      if (u.startsWith("javascript:")) return false;

      return true;
    };

    const add = (raw) => {
      raw = String(raw || "").trim();

      if (!raw) return;
      if (!isRelativeUrl(raw)) return;

      found.add(raw);
    };

    try {
      const srcElements = Array.from(
        document.querySelectorAll(
          "img,source,video,audio,track,iframe,embed,object,input[type='image']"
        )
      );

      for (const el of srcElements) {
        ["src", "data", "data-src", "data-original", "data-lazy-src", "poster"].forEach(
          (attr) => add(el.getAttribute?.(attr))
        );

        const srcset = el.getAttribute?.("srcset");

        if (srcset) {
          srcset
            .split(",")
            .map((x) => x.trim().split(/\s+/)[0])
            .forEach(add);
        }
      }
    } catch {}

    try {
      const visible = (el) => {
        try {
          const st = getComputedStyle(el);
          const r = el.getBoundingClientRect();

          return (
            st.display !== "none" &&
            st.visibility !== "hidden" &&
            r.width > 3 &&
            r.height > 3
          );
        } catch {
          return false;
        }
      };

      const cssElements = Array.from(document.querySelectorAll("*")).filter(visible);

      for (const el of cssElements) {
        const st = getComputedStyle(el);

        [st.backgroundImage, st.borderImageSource, st.listStyleImage, st.content].forEach(
          (value) => {
            const re = /url\((["']?)(.*?)\1\)/g;
            let m;

            while ((m = re.exec(String(value || "")))) {
              add(m[2]);
            }
          }
        );
      }
    } catch {}

    return found.size;
  });
}

async function waitAssetsStable(page) {
  const sig = await pageSignals(page);

  if (sig.isFeedbackPage) {
    return {
      stable: true,
      assetCount: 0,
      reason: "rating_page_skip_no_asset_wait",
    };
  }

  let lastCount = -1;
  let stable = 0;
  let visibleImages = 0;

  for (let i = 0; i < ASSET_STABLE_WAIT_ROUNDS; i += 1) {
    await page.waitForTimeout(ASSET_STABLE_WAIT_INTERVAL_MS);

    const result = await page.evaluate(() => {
      const visible = (el) => {
        try {
          const st = getComputedStyle(el);
          const r = el.getBoundingClientRect();

          return (
            st.display !== "none" &&
            st.visibility !== "hidden" &&
            r.width > 3 &&
            r.height > 3
          );
        } catch {
          return false;
        }
      };

      const images = Array.from(document.querySelectorAll("img")).filter(visible);

      const imagesDone = images.every((img) => {
        try {
          return img.complete && img.naturalWidth > 0;
        } catch {
          return true;
        }
      });

      return {
        visibleImages: images.length,
        imagesDone,
      };
    });

    const currentCount = await countRelativeAssetsInDom(page);
    visibleImages = result.visibleImages;

    if (currentCount === lastCount && result.imagesDone) {
      stable += 1;
    } else {
      stable = 0;
    }

    if (stable >= 3) {
      return {
        stable: true,
        assetCount: currentCount,
        visibleImages,
        reason: "assets_stable",
      };
    }

    lastCount = currentCount;
  }

  return {
    stable: false,
    assetCount: await countRelativeAssetsInDom(page),
    visibleImages,
    reason: "assets_wait_timeout",
  };
}

function isRelativeUrl(raw) {
  const u = String(raw || "").trim();

  if (!u) return false;
  if (u.startsWith("data:")) return true;
  if (u.startsWith("blob:")) return false;
  if (u.startsWith("http://")) return false;
  if (u.startsWith("https://")) return false;
  if (u.startsWith("//")) return false;
  if (u.startsWith("#")) return false;
  if (u.startsWith("mailto:")) return false;
  if (u.startsWith("tel:")) return false;
  if (u.startsWith("javascript:")) return false;

  return true;
}

function normalizeUrl(raw, baseUrl) {
  const u = String(raw || "").trim().replace(/^["']|["']$/g, "");

  if (!u) return "";
  if (u.startsWith("data:")) return u;
  if (u.startsWith("blob:")) return "";

  try {
    return new URL(u, baseUrl).href;
  } catch {
    return "";
  }
}

function extFromMimeOrUrl(mime, url) {
  const m = String(mime || "").toLowerCase();

  if (m.includes("png")) return "png";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("svg")) return "svg";
  if (m.includes("mp4")) return "mp4";
  if (m.includes("mpeg")) return "mp3";
  if (m.includes("wav")) return "wav";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("json")) return "json";
  if (m.includes("javascript")) return "js";
  if (m.includes("css")) return "css";
  if (m.includes("html")) return "html";
  if (m.includes("pdf")) return "pdf";

  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const ext = pathname.split(".").pop();

    if (ext && /^[a-z0-9]{1,8}$/.test(ext)) {
      return ext === "jpeg" ? "jpg" : ext;
    }
  } catch {}

  return "bin";
}

function filenameBaseFromUrl(url, fallback = "asset") {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
    const noExt = last.replace(/\.[a-z0-9]{1,8}$/i, "");

    return noExt || fallback;
  } catch {
    return fallback;
  }
}

function dataUrlToBuffer(dataUrl) {
  const text = String(dataUrl || "");
  const m = text.match(/^data:([^;,]*)(;base64)?,(.*)$/i);

  if (!m) {
    return {
      buffer: Buffer.alloc(0),
      mime: "",
    };
  }

  const mime = m[1] || "";
  const isBase64 = !!m[2];
  const data = m[3] || "";

  if (isBase64) {
    return {
      buffer: Buffer.from(data, "base64"),
      mime,
    };
  }

  return {
    buffer: Buffer.from(decodeURIComponent(data), "utf8"),
    mime,
  };
}

async function collectAssetCandidates(page) {
  return await page.evaluate(() => {
    const clean = (s) =>
      String(s || "")
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const visible = (el) => {
      try {
        if (!el || !document.body.contains(el)) return false;

        const st = getComputedStyle(el);
        const r = el.getBoundingClientRect();

        return (
          st.display !== "none" &&
          st.visibility !== "hidden" &&
          Number.isFinite(r.width) &&
          Number.isFinite(r.height) &&
          r.width > 3 &&
          r.height > 3
        );
      } catch {
        return false;
      }
    };

    const rectOf = (el) => {
      try {
        const r = el.getBoundingClientRect();

        return {
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      } catch {
        return null;
      }
    };

    const isRelativeUrl = (url) => {
      const u = String(url || "").trim();

      if (!u) return false;
      if (u.startsWith("data:")) return true;
      if (u.startsWith("blob:")) return false;
      if (u.startsWith("http://")) return false;
      if (u.startsWith("https://")) return false;
      if (u.startsWith("//")) return false;
      if (u.startsWith("#")) return false;
      if (u.startsWith("mailto:")) return false;
      if (u.startsWith("tel:")) return false;
      if (u.startsWith("javascript:")) return false;

      return true;
    };

    const out = [];

    const add = ({ rawSource, sourceKind, element, filenameBase }) => {
      const raw = String(rawSource || "").trim();

      if (!raw || !isRelativeUrl(raw)) return;

      out.push({
        rawSource: raw,
        sourceKind,
        filenameBase: clean(filenameBase || sourceKind || "asset"),
        rect: element && visible(element) ? rectOf(element) : null,
      });
    };

    try {
      const els = Array.from(
        document.querySelectorAll(
          "img,source,video,audio,track,iframe,embed,object,input[type='image']"
        )
      );

      for (const el of els) {
        const tag = el.tagName.toLowerCase();

        for (const attr of ["src", "data", "data-src", "data-original", "data-lazy-src", "poster"]) {
          const raw = el.getAttribute?.(attr);

          if (!raw) continue;

          add({
            rawSource: raw,
            sourceKind: `${tag}_${attr}`,
            element: el,
            filenameBase:
              el.getAttribute?.("alt") ||
              el.getAttribute?.("title") ||
              `${tag}_${attr}`,
          });
        }

        const srcset = el.getAttribute?.("srcset");

        if (srcset) {
          for (const part of String(srcset).split(",").map((x) => x.trim()).filter(Boolean)) {
            const rawUrl = part.split(/\s+/)[0];

            add({
              rawSource: rawUrl,
              sourceKind: `${tag}_srcset`,
              element: el,
              filenameBase: "srcset",
            });
          }
        }
      }
    } catch {}

    try {
      const extractCssUrls = (value) => {
        const urls = [];
        const re = /url\((["']?)(.*?)\1\)/g;
        let m;

        while ((m = re.exec(String(value || "")))) {
          urls.push(String(m[2] || "").trim());
        }

        return urls;
      };

      const cssEls = Array.from(document.querySelectorAll("*")).filter(visible);

      for (const el of cssEls) {
        const st = getComputedStyle(el);

        const urls = [
          ...extractCssUrls(st.backgroundImage),
          ...extractCssUrls(st.borderImageSource),
          ...extractCssUrls(st.listStyleImage),
          ...extractCssUrls(st.content),
        ];

        for (const raw of urls) {
          add({
            rawSource: raw,
            sourceKind: "css_relative_url",
            element: el,
            filenameBase: "css",
          });
        }
      }
    } catch {}

    return out;
  });
}

async function fetchAssets(page, levelTag, zip) {
  const candidates = await collectAssetCandidates(page);
  const seen = new Set();
  const assets = [];
  let index = 0;

  for (const c of candidates) {
    const raw = c.rawSource;

    if (!raw || !isRelativeUrl(raw)) continue;

    let sourceUrl = "";
    let buffer = null;
    let mime = "";
    let error = "";

    try {
      if (raw.startsWith("data:")) {
        const parsed = dataUrlToBuffer(raw);
        buffer = parsed.buffer;
        mime = parsed.mime;
        sourceUrl = "";
      } else {
        sourceUrl = normalizeUrl(raw, page.url());

        if (!sourceUrl) continue;
        if (seen.has(sourceUrl)) continue;

        seen.add(sourceUrl);

        const response = await page.request.get(sourceUrl, {
          timeout: ASSET_FETCH_TIMEOUT_MS,
        });

        if (!response.ok()) {
          error = `fetch_failed_${response.status()}`;
        } else {
          buffer = await response.body();
          mime = response.headers()["content-type"] || "";
        }
      }
    } catch (e) {
      error =
        e && e.name === "TimeoutError"
          ? `fetch_timeout_${ASSET_FETCH_TIMEOUT_MS}ms`
          : String(e && e.message ? e.message : e);
    }

    if (raw.startsWith("data:")) {
      const key = raw.slice(0, 300);

      if (seen.has(key)) continue;

      seen.add(key);
    }

    index += 1;

    const ext = extFromMimeOrUrl(mime, sourceUrl || raw);
    const base = sanitizeFilePart(c.filenameBase || filenameBaseFromUrl(sourceUrl || raw));
    const filename = `${sanitizeFilePart(levelTag)}_asset_${String(index).padStart(2, "0")}_${base}.${ext}`;
    const zipPath = `assets/${filename}`;

    const captured = !!buffer && !error;

    if (captured) {
      zip.addFile(zipPath, Buffer.from(buffer));
    }

    assets.push({
      index,
      sourceKind: c.sourceKind,
      rawSource: raw.startsWith("data:") ? "data:" : raw,
      sourceUrl,
      filename,
      zipPath,
      mime,
      extension: ext,
      sizeBytes: buffer ? buffer.length : 0,
      rect: c.rect,
      captured,
      error,
    });
  }

  return assets;
}

async function getEditors(page) {
  return await page.evaluate(() => {
    const out = [];

    const push = (type, value) => {
      value = String(value || "")
        .replace(/\u00a0/g, " ")
        .trim();

      if (value) {
        out.push({
          type,
          value,
        });
      }
    };

    try {
      if (window.monaco?.editor) {
        window.monaco.editor.getModels().forEach((m, i) => {
          push(`monaco_model_${i + 1}`, m.getValue());
        });
      }
    } catch {}

    try {
      if (window.ace) {
        Array.from(document.querySelectorAll(".ace_editor")).forEach((el, i) => {
          push(`ace_editor_${i + 1}`, window.ace.edit(el).getValue());
        });
      }
    } catch {}

    try {
      Array.from(document.querySelectorAll(".CodeMirror")).forEach((el, i) => {
        if (el.CodeMirror) {
          push(`codemirror5_${i + 1}`, el.CodeMirror.getValue());
        }
      });
    } catch {}

    try {
      Array.from(document.querySelectorAll(".cm-content")).forEach((el, i) => {
        push(`codemirror6_${i + 1}`, el.innerText);
      });
    } catch {}

    try {
      Array.from(document.querySelectorAll("textarea,input[type='text']")).forEach((el, i) => {
        push(`input_${i + 1}`, el.value);
      });
    } catch {}

    try {
      Array.from(document.querySelectorAll("pre,code")).forEach((el, i) => {
        push(`pre_code_${i + 1}`, el.innerText);
      });
    } catch {}

    return out;
  });
}

function extractInstruction(rawText) {
  const lines = String(rawText || "")
    .split(/\n+/)
    .map(clean)
    .filter(Boolean);

  return lines.slice(Math.max(0, lines.length - 60)).join("\n");
}

async function captureVisualState(page, zip, levelNo, stateNo, label, extra = {}) {
  const safeLabel = sanitizeFilePart(label || "state");
  const levelPart = String(levelNo).padStart(2, "0");
  const statePart = String(stateNo).padStart(2, "0");

  const screenshotPath = `screenshots/level_${levelPart}_state_${statePart}_${safeLabel}.png`;
  const htmlPath = `html/level_${levelPart}_state_${statePart}_${safeLabel}.html`;

  const screenshotBuffer = await page.screenshot({
    fullPage: FULL_PAGE_SCREENSHOT,
    animations: "disabled",
  });

  zip.addFile(screenshotPath, Buffer.from(screenshotBuffer));

  const html = await page.content();

  zip.addFile(htmlPath, Buffer.from(html, "utf8"));

  const signals = await pageSignals(page).catch(() => null);

  return {
    stateNo,
    stateLabel: label,
    screenshotPath,
    htmlPath,
    url: page.url(),
    title: signals?.title || "",
    pageType: signals?.pageType || "unknown",
    capturedAt: new Date().toISOString(),
    ...extra,
  };
}

async function findSafeModalTarget(page) {
  if (!HANDLE_TUTORIAL_MODALS) {
    return {
      found: false,
      reason: "modal_handling_disabled",
    };
  }

  const viewport = page.viewportSize() || {
    width: VIEWPORT_WIDTH,
    height: VIEWPORT_HEIGHT,
  };

  const safeTexts = [
    "Continue",
    "OK",
    "Okay",
    "Got it",
    "Start",
    "Begin",
    "Close",
  ];

  const hasDialogLike = await page
    .evaluate(() => {
      const all = (s, doc = document) => Array.from(doc.querySelectorAll(s));

      const visible = (el) => {
        try {
          if (!el || !document.body.contains(el)) return false;

          const st = getComputedStyle(el);
          const r = el.getBoundingClientRect();

          return (
            st.display !== "none" &&
            st.visibility !== "hidden" &&
            Number.isFinite(r.width) &&
            Number.isFinite(r.height) &&
            r.width > 8 &&
            r.height > 8
          );
        } catch {
          return false;
        }
      };

      try {
        const dialogSelectors = [
          "[role='dialog']",
          "[aria-modal='true']",
          ".modal",
          ".popup",
          ".dialog",
          ".overlay",
          ".tutorial",
          ".intro",
          ".tour",
        ];

        if (dialogSelectors.some((sel) => all(sel).some(visible))) {
          return true;
        }
      } catch {}

      try {
        const bodyText = String(document.body?.innerText || "").toLowerCase();

        if (
          /continue/i.test(bodyText) &&
          /lead the|come up with|your task|click|press|move|robot|sprite|mouse|keyboard|station/i.test(
            bodyText
          )
        ) {
          return true;
        }
      } catch {}

      try {
        const bigOverlay = all("*").some((el) => {
          if (!visible(el)) return false;

          const st = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          const pos = st.position;
          const bg = st.backgroundColor || "";

          const isBig =
            r.width >= window.innerWidth * 0.45 &&
            r.height >= window.innerHeight * 0.25;

          const isOverlayPosition = pos === "fixed" || pos === "absolute";

          const hasOverlayColor =
            /rgba\([^)]*,\s*0\.[2-9]/i.test(bg) ||
            /rgb\(0,\s*0,\s*0\)/i.test(bg);

          return isBig && isOverlayPosition && hasOverlayColor;
        });

        if (bigOverlay) return true;
      } catch {}

      return false;
    })
    .catch(() => false);

  const candidates = [];

  const addCandidateFromLocator = async (locator, wantedText, sourceKind, priority) => {
    const count = await locator.count().catch(() => 0);
    const max = Math.min(count, 10);

    for (let i = 0; i < max; i += 1) {
      const item = locator.nth(i);

      const isVisible = await item.isVisible().catch(() => false);

      if (!isVisible) continue;

      const box = await item.boundingBox().catch(() => null);

      if (!box) continue;
      if (box.width < 20 || box.height < 15) continue;
      if (box.width > 650 || box.height > 180) continue;

      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;

      const isTopLevelBar = cy < 120;

      if (isTopLevelBar) continue;

      const centralEnough =
        cx > viewport.width * 0.1 &&
        cx < viewport.width * 0.9 &&
        cy > viewport.height * 0.12 &&
        cy < viewport.height * 0.92;

      if (!centralEnough && !hasDialogLike) continue;

      const actualText = await item
        .evaluate((el) =>
          String(
            el.innerText ||
              el.textContent ||
              el.getAttribute("aria-label") ||
              el.title ||
              ""
          )
            .replace(/\u00a0/g, " ")
            .replace(/\s+/g, " ")
            .trim()
        )
        .catch(() => wantedText);

      const dangerous =
        /save|show solution|answer|submit|check|run|green flag|delete|export|download|try again|file|edit/i;

      if (dangerous.test(actualText)) continue;

      const centerPenalty =
        Math.abs(cx - viewport.width / 2) + Math.abs(cy - viewport.height / 2);

      candidates.push({
        locator: item,
        meta: {
          text: wantedText,
          actualText,
          sourceKind,
          priority,
          hasDialogLike,
          rect: {
            x: Math.round(box.x),
            y: Math.round(box.y),
            width: Math.round(box.width),
            height: Math.round(box.height),
            cx: Math.round(cx),
            cy: Math.round(cy),
          },
          centerPenalty: Math.round(centerPenalty),
        },
      });
    }
  };

  for (let textIndex = 0; textIndex < safeTexts.length; textIndex += 1) {
    const text = safeTexts[textIndex];
    const re = new RegExp(`^\\s*${escapeRegexText(text)}\\s*$`, "i");
    const priority = textIndex + 1;

    await addCandidateFromLocator(
      page.getByRole("button", { name: re }),
      text,
      "role_button_exact_text",
      priority
    );

    await addCandidateFromLocator(
      page.locator("button").filter({ hasText: re }),
      text,
      "button_has_text",
      priority + 10
    );

    await addCandidateFromLocator(
      page.locator("[role='button']").filter({ hasText: re }),
      text,
      "role_button_has_text",
      priority + 20
    );

    await addCandidateFromLocator(
      page.locator("a").filter({ hasText: re }),
      text,
      "a_has_text",
      priority + 30
    );

    await addCandidateFromLocator(
      page.getByText(re),
      text,
      "get_by_text_exact",
      priority + 40
    );
  }

  candidates.sort((a, b) => {
    return (
      a.meta.priority - b.meta.priority ||
      a.meta.centerPenalty - b.meta.centerPenalty
    );
  });

  if (!candidates.length) {
    return {
      found: false,
      reason: "no_safe_continue_modal_button_found",
      hasDialogLike,
    };
  }

  return {
    found: true,
    reason: "safe_continue_modal_button_found",
    locator: candidates[0].locator,
    target: candidates[0].meta,
    candidates: candidates.slice(0, 8).map((x) => x.meta),
  };
}

async function detectTutorialModal(page) {
  const target = await findSafeModalTarget(page);

  if (!target.found) {
    return {
      found: false,
      reason: target.reason,
      hasDialogLike: target.hasDialogLike || false,
    };
  }

  return {
    found: true,
    reason: target.reason,
    target: target.target,
    candidates: target.candidates || [],
  };
}

async function handleTutorialModals(page, levelNo, zip) {
  const states = [];

  if (!HANDLE_TUTORIAL_MODALS) {
    return {
      enabled: false,
      modalStepsClicked: 0,
      states,
      reason: "modal_handling_disabled",
    };
  }

  for (let step = 0; step < MAX_MODAL_STEPS; step += 1) {
    const modal = await findSafeModalTarget(page).catch((e) => ({
      found: false,
      reason: `find_modal_target_error: ${e && e.message ? e.message : e}`,
    }));

    if (!modal.found || !modal.locator || !modal.target?.rect) {
      return {
        enabled: true,
        modalStepsClicked: step,
        states,
        reason:
          step === 0
            ? modal.reason || "no_modal_found"
            : "modal_sequence_finished",
      };
    }

    const beforeState = await captureVisualState(
      page,
      zip,
      levelNo,
      states.length,
      `modal_${step + 1}_before_click`,
      {
        stateType: "modal_before_click",
        action: "screenshot_before_safe_modal_click",
        modalTarget: modal.target,
        modalCandidates: modal.candidates || [],
      }
    );

    states.push(beforeState);

    console.log(
      `[modal] Level ${levelNo}: clicking "${modal.target.actualText || modal.target.text}" at ${modal.target.rect.cx},${modal.target.rect.cy}`
    );

    let clicked = false;

    try {
      await modal.locator.click({
        timeout: 2500,
        force: true,
      });

      clicked = true;
    } catch (e) {
      console.log(
        `[modal] locator.click failed, fallback mouse.click: ${
          e && e.message ? e.message : e
        }`
      );
    }

    if (!clicked) {
      await page.mouse.click(modal.target.rect.cx, modal.target.rect.cy);
    }

    await page.waitForTimeout(MODAL_AFTER_CLICK_WAIT_MS);
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(300);

    const afterSignals = await pageSignals(page).catch(() => null);

    const afterState = await captureVisualState(
      page,
      zip,
      levelNo,
      states.length,
      `modal_${step + 1}_after_click`,
      {
        stateType: "modal_after_click",
        action: "screenshot_after_safe_modal_click",
        clickedTarget: modal.target,
        afterPageType: afterSignals?.pageType || "unknown",
      }
    );

    states.push(afterState);

    const nextModal = await findSafeModalTarget(page).catch(() => ({
      found: false,
    }));

    if (!nextModal.found) {
      return {
        enabled: true,
        modalStepsClicked: step + 1,
        states,
        reason: "modal_sequence_finished_after_successful_click",
      };
    }
  }

  return {
    enabled: true,
    modalStepsClicked: MAX_MODAL_STEPS,
    states,
    reason: "max_modal_steps_reached",
  };
}

async function captureCurrentAsLevel(page, levelNo, item, clickResult, zip, skippedRatingPages) {
  const signals = await pageSignals(page);

  if (signals.isFeedbackPage) {
    skippedRatingPages.push({
      slot: item.slot,
      levelNo: item.levelNo,
      levelLabel: item.label,
      levelKind: item.kind,
      reason: "rating_feedback_page_skipped",
      clickResult,
      url: signals.url,
      title: signals.title,
    });

    return null;
  }

  const modalHandling = await handleTutorialModals(page, levelNo, zip);
  const signalsAfterModal = await pageSignals(page);

  if (signalsAfterModal.isFeedbackPage) {
    skippedRatingPages.push({
      slot: item.slot,
      levelNo: item.levelNo,
      levelLabel: item.label,
      levelKind: item.kind,
      reason: "rating_feedback_page_skipped_after_modal_handling",
      clickResult,
      modalHandling,
      url: signalsAfterModal.url,
      title: signalsAfterModal.title,
    });

    return null;
  }

  const params = getUrlParams(signalsAfterModal.url);
  const assetWaitResult = await waitAssetsStable(page);
  const latestSignals = await pageSignals(page);
  const mainText = latestSignals.text;
  const editors = await getEditors(page);

  const levelTag = [
    "level",
    String(levelNo).padStart(2, "0"),
    params.taskId ? `task_${params.taskId}` : "",
    params.lessonId ? `lesson_${params.lessonId}` : "",
    params.level ? `actual_${params.level}` : "",
    latestSignals.pageType,
  ]
    .filter(Boolean)
    .join("_");

  const finalStateNo = modalHandling.states.length;

  const finalState = await captureVisualState(
    page,
    zip,
    levelNo,
    finalStateNo,
    "final",
    {
      stateType: "final",
      action: "final_state_after_modal_handling",
    }
  );

  const screenshotPath = finalState.screenshotPath;
  const htmlPath = finalState.htmlPath;
  const visualStates = [...modalHandling.states, finalState];

  const assets = await fetchAssets(page, levelTag, zip);

  return {
    slot: item.slot,
    levelNo: item.levelNo || levelNo,
    levelLabel: item.label,
    levelKind: item.kind,
    clickResult,
    modalHandling: {
      enabled: modalHandling.enabled,
      modalStepsClicked: modalHandling.modalStepsClicked,
      reason: modalHandling.reason,
    },
    visualStates,
    assetWaitResult,
    contentLooksLoaded: latestSignals.meaningful,
    pageType: latestSignals.pageType,
    isRatingPage: false,
    isActivityPage: latestSignals.pageType === "activity",
    isStaticPage:
      latestSignals.pageType === "static" || latestSignals.pageType === "static_image",
    screenshotPath,
    htmlPath,
    page: {
      url: latestSignals.url,
      title: latestSignals.title,
      ...params,
    },
    instruction: extractInstruction(mainText),
    raw: {
      bodyText: mainText,
    },
    editors,
    assets: {
      assetCaptureEnabled: true,
      assetFetchTimeoutMs: ASSET_FETCH_TIMEOUT_MS,
      assetStableWaitRounds: ASSET_STABLE_WAIT_ROUNDS,
      assetStableWaitIntervalMs: ASSET_STABLE_WAIT_INTERVAL_MS,
      assetCaptureRule:
        "Wait for relative assets to become stable, then capture relative src/srcset/data-src/poster/data/CSS url assets into ZIP assets/ folder.",
      assetsCaptured: assets.filter((x) => x.captured).length,
      assetsFailed: assets.filter((x) => !x.captured).length,
      files: assets,
    },
  };
}

async function captureUrl(context, inputUrl) {
  const page = await context.newPage();
  const zip = new AdmZip();
  const levels = [];
  const skippedRatingPages = [];
  let topRow = [];

  console.log(`\n[crawl] Opening: ${inputUrl}`);

  try {
    await page.goto(inputUrl, { waitUntil: "domcontentloaded" });
    await waitForBasicLoad(page);
    await waitLoaded(page);

    topRow = await discoverTopRow(page);

    if (!topRow.length) {
      console.log("[crawl] No level row found. Capturing current page as one level.");

      const item = {
        slot: 1,
        levelNo: 1,
        label: "current",
        kind: "current",
      };

      const current = await captureCurrentAsLevel(
        page,
        1,
        item,
        {
          clicked: false,
          loaded: true,
          reason: "no_top_row_capture_current",
        },
        zip,
        skippedRatingPages
      );

      if (current) {
        levels.push(current);
      }
    } else {
      console.log(`[crawl] Found ${topRow.length} top-level item(s).`);

      for (const item of topRow) {
        console.log(`[crawl] Level slot ${item.slot}/${topRow.length}: ${item.label}`);

        const clickResult = await clickSlot(page, item.slot, topRow);

        const captured = await captureCurrentAsLevel(
          page,
          levels.length + 1,
          item,
          clickResult,
          zip,
          skippedRatingPages
        );

        if (captured) {
          levels.push(captured);

          const capturedAssets = captured.assets?.assetsCaptured || 0;

          console.log(
            `[crawl]   captured pageType=${captured.pageType}, modalSteps=${captured.modalHandling?.modalStepsClicked || 0}, assets=${capturedAssets}`
          );
        } else {
          console.log("[crawl]   skipped rating page");
        }
      }
    }

    const result = {
      captureVersion: VERSION,
      crawlerConfig: envInfo(),
      sourcePlatform: new URL(inputUrl).hostname,
      capturedAt: new Date().toISOString(),
      studentVisibleOnly: true,
      originalUrl: inputUrl,
      ratingPageRule: {
        skipRatingPages: true,
        note:
          "Rating/feedback pages such as 'Did you like the lesson?' are not captured into levels and no assets/text are saved from those pages.",
        ratingPagesSkipped: skippedRatingPages.length,
        skippedRatingPages,
      },
      zipExport: {
        containsJson: "capture.json",
        assetsFolder: "assets/",
        screenshotsFolder: "screenshots/",
        htmlFolder: "html/",
        note:
          "Screenshot is the primary UI backup. If a tutorial/modal popup appears, crawler saves modal-before-click state and modal-after-click state after safe Continue/OK/Start click. JSON stores metadata. Asset files are stored separately in the ZIP.",
      },
      assetCapture: {
        rule:
          "Wait for assets to stabilize, then capture relative src/srcset/data-src/poster/data/CSS url assets from non-rating pages/levels.",
        assetFetchTimeoutMs: ASSET_FETCH_TIMEOUT_MS,
        assetStableWaitRounds: ASSET_STABLE_WAIT_ROUNDS,
        assetStableWaitIntervalMs: ASSET_STABLE_WAIT_INTERVAL_MS,
      },
      topLevelItemsDiscovered: topRow,
      levelsCaptured: levels.length,
      levels,
    };

    zip.addFile("capture.json", Buffer.from(JSON.stringify(result, null, 2), "utf8"));

    const filename = zipNameForUrl(inputUrl, levels.length, skippedRatingPages.length);
    const outputPath = path.join(OUTPUT_DIR, filename);

    zip.writeZip(outputPath);

    console.log(`[crawl] DONE: ${outputPath}`);

    return outputPath;
  } finally {
    await page.close().catch(() => {});
  }
}

async function crawlMany(urls) {
  if (!urls.length) {
    console.log("No URL found. Add URLs into urls.txt first.");
    return;
  }

  console.log("[config]", envInfo());

  const context = await launchContext();

  try {
    const outputs = [];

    for (const url of urls) {
      try {
        const out = await captureUrl(context, url);
        outputs.push(out);
      } catch (e) {
        console.error(`[crawl] FAILED URL: ${url}`);
        console.error(e && e.stack ? e.stack : e);
      }
    }

    console.log("\nAll done.");

    for (const out of outputs) {
      console.log(`- ${out}`);
    }
  } finally {
    await context.close();
  }
}

async function main() {
  const command = process.argv[2] || "crawl";

  if (command === "login") {
    await login();
    return;
  }

  if (command === "one") {
    const url = process.argv[3];

    if (!url) {
      console.error(
        'Usage: node src/crawler.js one "https://lms.logikaschool.com/task-preview/..."'
      );
      process.exit(1);
    }

    await crawlMany([url]);
    return;
  }

  if (command === "crawl") {
    const urls = readUrlsFromFile();
    await crawlMany(urls);
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error("Use: login | crawl | one");
  process.exit(1);
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});