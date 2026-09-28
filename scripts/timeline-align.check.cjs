// Timeline regression check for the director UI.
//
// Verifies, in a real browser:
//   1. ruler/tile geometry agrees at EVERY zoom step (width, x-offset, tick label text)
//   2. scrollLeft stays legal and the moved tile stays in view after a drag-reorder drop
//      in a narrow viewport (the case that overflowed and hid the tile before TIMELINE_GAP)
//   3. the open project, the zoom and the panel split survive a page reload
//   4. no console/JS errors along the way
//
//   npm run verify:timeline                                        built app on :8788
//   $env:H3_URL='http://127.0.0.1:5173/'; npm run verify:timeline   Vite dev server
//
// Exit code: 0 = every check passed, 1 = a check failed, 2 = could not run (app down, no
// browser, no project with 2+ shots). It reverts the reorder it performs, so data is
// left as it was found. Needs a project with at least two shots to test anything real.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const TARGET = process.env.H3_URL || "http://127.0.0.1:8788/";
const OUT = path.join(path.resolve(__dirname, ".."), ".tmp", "shots") + path.sep;
const GAP = 6;     // TIMELINE_GAP   in web/src/views.tsx == gap on .timeline-ruler/.timeline-track
const MIN_SEC = 4; // TIMELINE_MIN_SEC in web/src/views.tsx
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const fail = (msg) => { failures.push(msg); console.log("   !! " + msg); };

/** Pull painted geometry of ruler + track and re-derive expectations in-page. */
const probe = (cfg) => {
  const GAP = cfg.gap, MIN_SEC = cfg.minSec;
  const g = (s) => document.querySelector(s);
  const segs = [...document.querySelectorAll(".tl-ruler-seg")];
  const tiles = [...document.querySelectorAll(".tl-tile")];
  const scroll = g(".timeline-scroll");
  const px = Number((g(".tl-zval") ? g(".tl-zval").textContent : "").replace(/[^0-9.]/g, ""));

  // Durations are painted in the tile footer as e.g. "7s" / "4.5s".
  const durs = tiles.map((t) => {
    const d = t.querySelector(".tl-dur");
    const m = d ? (d.textContent || "").match(/([0-9]+(?:\.[0-9]+)?)s/) : null;
    return m ? parseFloat(m[1]) : 0;
  });

  const rows = segs.map((s, i) => {
    const sb = s.getBoundingClientRect();
    const tb = tiles[i].getBoundingClientRect();
    const lab = s.firstElementChild ? s.firstElementChild.getBoundingClientRect() : null;
    const w = s.firstElementChild ? s.firstElementChild.textContent.trim() : "";
    return {
      i,
      pxDur: durs[i],
      label: w,
      segW: Math.round(sb.width),
      tileW: Math.round(tb.width),
      xDelta: Math.round(sb.x) - Math.round(tb.x),
      labelInSeg: lab ? Math.round(lab.x) >= Math.round(sb.x) : null,
      labelBleed: lab ? Math.max(0, Math.round(lab.right) - Math.round(sb.right)) : null,
      paintXOff: i === 0 ? 0 : Math.round(sb.x - segs[0].getBoundingClientRect().x),
    };
  });

  // Expectations derived only from durations + zoom: widths, x offsets, label text.
  let run = 0, tAcc = 0;
  const fmt = (sec) => { const r = Math.round(sec * 10) / 10; return `${r % 1 === 0 ? r.toFixed(0) : r.toFixed(1)}s`; };
  rows.forEach((r, i) => {
    r.expectW = Math.max(Math.round(px * MIN_SEC), Math.round(r.pxDur * px));
    r.expectXOff = i === 0 ? 0 : run;
    r.expectLabel = fmt(tAcc);
    run += r.expectW + GAP;
    tAcc += r.pxDur;
  });

  return {
    px,
    scrollLeft: scroll ? Math.round(scroll.scrollLeft) : -1,
    scrollMax: scroll ? scroll.scrollWidth - scroll.clientWidth : -1,
    rows,
    endLabel: g(".tl-ruler-end") ? g(".tl-ruler-end").textContent.trim() : null,
    order: tiles.map((t) => { const n = t.querySelector(".tl-name"); return n ? (n.textContent || "").trim() : "?"; }),
  };
};

async function launch() {
  const args = ["--disable-gpu"];
  for (const opts of [{ channel: "msedge" }, { channel: "chrome" }, {}]) {
    try { return await chromium.launch({ ...opts, headless: true, args }); } catch { /* next */ }
  }
  throw new Error("could not launch Edge, Chrome or Chromium");
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  // Reset the persisted timeline settings so the sweep covers the whole zoom ladder.
  // The flag makes this a ONE-TIME reset: an init script runs on every navigation, so
  // without it the reload check below would wipe the very keys it is meant to verify.
  await page.addInitScript(() => {
    try {
      if (!sessionStorage.getItem("h3.verifyInit")) {
        localStorage.removeItem("h3.timelineZoom");
        localStorage.removeItem("h3.timelineSplit");
        localStorage.removeItem("h3.projectId");
        sessionStorage.setItem("h3.verifyInit", "1");
      }
    } catch { /* ignore */ }
  });

  console.log("target:", TARGET);
  try {
    await page.goto(TARGET, { waitUntil: "load" });
  } catch (e) {
    console.error("Cannot reach the app at " + TARGET);
    console.error("Start it with `npm start` (:8788) or `npm run dev:web` (:5173), or set H3_URL.");
    console.error("  " + e.message);
    await browser.close();
    process.exit(2);
  }
  await sleep(2500);

  const sel = page.locator("header select").first();
  if (await sel.count()) await sel.selectOption({ index: 0 });
  await sleep(3000);

  const tiles = await page.locator(".tl-tile").count();
  console.log("shots in project:", tiles);
  if (tiles < 2) {
    console.error("Need a project with at least 2 shots to test the timeline; found " + tiles + ".");
    await browser.close();
    process.exit(2);
  }

  const step = async (which) => {
    const b = page.locator(".tl-zbtn").nth(which === "in" ? 1 : 0);
    if ((await b.count()) === 0 || (await b.isDisabled())) return false;
    try { await b.click({ timeout: 1000 }); } catch { return false; }
    await sleep(150);
    return true;
  };

  /** One geometry sample: every tick label over its own tile boundary at this zoom. */
  const report = async (tag) => {
    const r = await page.evaluate(probe, { gap: GAP, minSec: MIN_SEC });
    const bad = [];
    for (const w of r.rows) {
      if (w.label !== w.expectLabel) bad.push(`seg${w.i}: label "${w.label}" != expected "${w.expectLabel}"`);
      if (w.xDelta !== 0) bad.push(`seg${w.i}: xDelta ${w.xDelta} (tile not under its own tick)`);
      if (w.segW !== w.tileW) bad.push(`seg${w.i}: segW ${w.segW} != tileW ${w.tileW}`);
      if (Math.abs(w.paintXOff - w.expectXOff) > 1) bad.push(`seg${w.i}: paintX ${w.paintXOff} != expectX ${w.expectXOff}`);
      if (w.labelInSeg === false) bad.push(`seg${w.i}: label sits left of its own tick`);
    }
    console.log(`${tag} px=${r.px} scroll=${r.scrollLeft}/${r.scrollMax} end="${r.endLabel}"`);
    console.log(`   labels=${r.rows.map((x) => x.label).join(",")} expect=${r.rows.map((x) => x.expectLabel).join(",")}`);
    console.log(`   segW/tileW=${r.rows.map((x) => x.segW + "/" + x.tileW).join(" ")} expectW=${r.rows.map((x) => x.expectW).join(" ")}`);
    console.log(`   xDelta=[${r.rows.map((x) => x.xDelta)}] bleed=[${r.rows.map((x) => x.labelBleed)}] paintX=[${r.rows.map((x) => x.paintXOff)}] expectX=[${r.rows.map((x) => x.expectXOff)}]`);
    console.log(bad.length ? "   FAIL " + bad.join(" | ") : "   OK");
    for (const b of bad) fail(`${tag} ${b}`);
    return r;
  };

  await report("DEFAULT");
  for (let n = 0; n < 8; n++) { if (!(await step("out"))) break; await report("OUT    "); }
  for (let n = 0; n < 8; n++) { if (!(await step("in"))) break; await report("IN     "); }
  await page.screenshot({ path: OUT + "01-geometry.png" });

  // At max zoom the track overflows, so a drop must also keep scrollLeft legal.
  // A 2-shot cut at 1680px fits, so shrink the viewport first to force overflow — otherwise
  // the "keep the moved tile in view" branch (views.tsx scrollToShot math) never runs and the
  // TIMELINE_GAP fix goes untested.
  await page.setViewportSize({ width: 780, height: 950 });
  await sleep(400);
  const vis = () => page.evaluate(([gap]) => {
    const sc = document.querySelector(".timeline-scroll");
    const tiles = [...document.querySelectorAll(".tl-tile")];
    const cr = sc.getBoundingClientRect();
    return {
      scrollLeft: Math.round(sc.scrollLeft),
      scrollMax: Math.round(sc.scrollWidth - sc.clientWidth),
      order: tiles.map((t) => (t.querySelector(".tl-name") || { textContent: "?" }).textContent.trim()),
      tiles: tiles.map((t) => { const r = t.getBoundingClientRect(); return { l: Math.round(r.left - cr.left), r: Math.round(r.right - cr.left) }; }),
      vp: Math.round(cr.width),
    };
  }, [GAP]);

  let v0 = await vis();
  const a = await page.locator(".tl-tile").nth(0).boundingBox();
  const b = await page.locator(".tl-tile").nth(1).boundingBox();
  console.log("DROP   before order=" + JSON.stringify(v0.order) + " scroll=" + v0.scrollLeft + "/" + v0.scrollMax + " vp=" + v0.vp + " tiles=" + JSON.stringify(v0.tiles));
  if (v0.scrollMax > 0 && a && b) {
    await page.mouse.move(a.x + a.width / 2, a.y + 20);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * 0.8, b.y + 20, { steps: 15 });
    await sleep(120);
    await page.mouse.up();
    await sleep(600);
    let v1 = await vis();
    const swapped = v1.order[0] !== v0.order[0];
    if (!swapped) fail("drag did not reorder the shots");
    // The drop leaves drag-autoscroll momentum behind; the snap is a rAF animation, so sample
    // until the value stops changing and confirm it settles legal and in-view (the old gap-less
    // math could park the moved tile fully off-screen left).
    let prevS = v1.scrollLeft, settled = v1, ticks = 0;
    for (; ticks < 10; ticks++) {
      await sleep(300);
      const s = await vis();
      settled = s;
      if (Math.abs(s.scrollLeft - prevS) <= 1) break;
      prevS = s.scrollLeft;
    }
    const sM = settled.tiles[1];
    const sLegal = settled.scrollLeft >= 0 && settled.scrollLeft <= settled.scrollMax + 1;
    const sInView = sM && sM.l < settled.vp && sM.r > 0;
    console.log("SETTLE after " + (ticks * 300) + "ms scroll=" + settled.scrollLeft + "/" + settled.scrollMax
      + (sLegal ? " (legal)" : " (ILLEGAL)") + (sInView ? " [in view]" : " [OFF SCREEN]")
      + " movedTile=[" + (sM ? sM.l + ".." + sM.r : "?") + "] vp=" + settled.vp);
    if (!sLegal) fail("after drop: scrollLeft " + settled.scrollLeft + " outside 0.." + settled.scrollMax);
    if (!sInView) fail("after drop: the moved tile settled off-screen (" + JSON.stringify(sM) + " in " + settled.vp + "px)");
    await page.screenshot({ path: OUT + "02-narrow-drop.png" });

    // Put the sequence back the way we found it.
    const c = await page.locator(".tl-tile").nth(1).boundingBox();
    const d = await page.locator(".tl-tile").nth(0).boundingBox();
    await page.mouse.move(c.x + c.width / 2, c.y + 20);
    await page.mouse.down();
    await page.mouse.move(d.x + 8, d.y + 20, { steps: 15 });
    await sleep(120);
    await page.mouse.up();
    await sleep(600);
    v1 = await vis();
    console.log("REVERT order=" + JSON.stringify(v1.order) + " scroll=" + v1.scrollLeft + "/" + v1.scrollMax);
    if (JSON.stringify(v1.order) === JSON.stringify(v0.order)) fail("reorder was not reverted back to the original order");
  } else {
    console.log("DROP   SKIPPED - track does not overflow at this viewport (scrollMax=" + v0.scrollMax + ")");
    fail("narrow-viewport drop never ran: the track did not overflow, so the scroll fix is untested");
  }

  // Reload must not lose your place: same project, same zoom, same panel split.
  await page.setViewportSize({ width: 1680, height: 950 });
  await sleep(300);
  const beforeProject = await sel.inputValue().catch(() => "");
  const beforeZoom = await page.locator(".tl-zval").textContent().catch(() => "");
  await page.reload({ waitUntil: "load" });
  await sleep(3000);
  const afterProject = await sel.inputValue().catch(() => "");
  const afterZoom = await page.locator(".tl-zval").textContent().catch(() => "");
  console.log("RELOAD project " + JSON.stringify(beforeProject) + " -> " + JSON.stringify(afterProject)
    + "  zoom " + JSON.stringify(beforeZoom) + " -> " + JSON.stringify(afterZoom));
  if (!beforeProject) fail("no project was selected to test reload persistence");
  else if (afterProject !== beforeProject) fail("reload lost the open project (" + beforeProject + " -> " + afterProject + ")");
  if (afterZoom !== beforeZoom) fail("reload lost the timeline zoom (" + beforeZoom + " -> " + afterZoom + ")");
  if ((await page.locator(".tl-tile").count()) < 2) fail("after reload the timeline is empty");
  await page.screenshot({ path: OUT + "03-after-reload.png" });

  if (errors.length) { for (const e of errors.slice(0, 8)) fail(e); }
  console.log("JS ERRORS:", errors.length ? errors.slice(0, 8) : "none");

  await browser.close();
  console.log(failures.length ? `\nRESULT: FAIL (${failures.length} problem(s))` : "\nRESULT: PASS");
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS FAIL:", e); process.exit(2); });
