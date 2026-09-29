// Browser test: drives SightLine in Chromium through Playwright on the test
// models from tools/make_test_ifc.py, clicking the real windows on the canvas.
//
//   python tools/make_test_ifc.py          # writes test-models/
//   python -m http.server 8080 &           # from the repo root (or python app.py)
//   node tests/e2e.js
//
// VENDOR_DIR (where the CDNs are unreachable) serves the libraries from local
// copies: <dir>/web-ifc/* and <dir>/three/{build,examples} (for example an
// npm install of web-ifc@0.0.77 and three@0.128.0, pointing at node_modules).
// PLAYWRIGHT_MODULE overrides where playwright is required from.
// SHOTS=<dir> saves screenshots.

const path = require('path');
const fs = require('fs');
const assert = require('assert/strict');

const URL_ = process.env.SIGHTLINE_URL || 'http://127.0.0.1:8080/';
const MODELS = path.join(__dirname, '..', 'test-models');
const shots = process.env.SHOTS;
const logs = [];

async function main() {
    const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
    const browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
    const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
    const vendor = process.env.VENDOR_DIR;
    if (vendor) {
        const mime = { js: 'application/javascript', wasm: 'application/wasm' };
        const map = [
            [/^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/three\.js\/r128\/three\.min\.js$/, () => path.join(vendor, 'three', 'build', 'three.min.js')],
            [/^https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.128\.0\/(.+)$/, m => path.join(vendor, 'three', m[1])],
            [/^https:\/\/cdn\.jsdelivr\.net\/npm\/web-ifc@[\d.]+\/(.+)$/, m => path.join(vendor, 'web-ifc', m[1])],
        ];
        await page.route(/^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)\//, route => {
            const url = route.request().url().split('?')[0];
            for (const [re, fn] of map) {
                const m = url.match(re);
                if (!m) continue;
                const file = fn(m);
                if (!fs.existsSync(file)) { logs.push('vendor miss: ' + url); return route.fulfill({ status: 404, body: '' }); }
                return route.fulfill({ path: file, contentType: mime[file.split('.').pop()] || 'application/octet-stream' });
            }
            logs.push('unmapped cdn: ' + url);
            return route.fulfill({ status: 404, body: '' });
        });
    }
    page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.type() + ': ' + m.text().slice(0, 300)); });
    page.on('pageerror', e => logs.push('pageerror: ' + e.message));
    page.on('dialog', d => d.accept());
    await page.goto(URL_, { waitUntil: 'load' });
    const shot = async (name) => { if (shots) await page.screenshot({ path: path.join(shots, name + '.png') }); };

    const state = (fn) => page.evaluate(fn);
    async function loadModel(file) {
        const seq = await state(() => SightLine.state.base ? SightLine.state.base.seq : 0);
        await page.setInputFiles('#ifc-file', path.join(MODELS, file));
        await page.waitForFunction(s => SightLine.state.base && SightLine.state.base.seq !== s, seq, { timeout: 60000 });
    }
    async function loadComparison(file) {
        await page.setInputFiles('#cmp-file', path.join(MODELS, file));
        await page.waitForFunction(f => SightLine.state.cmp && SightLine.state.cmp.fileName === f, file, { timeout: 60000 });
    }
    // Look at a window from outside, then click the middle of it on the canvas.
    async function clickElement(name, model = 'base') {
        const pt = await page.evaluate(([name, model]) => {
            const m = SightLine.state[model];
            const el = [...m.elements.values()].find(e => e.name === name);
            const bb = new THREE.Box3().setFromObject(el.mesh);
            const c = bb.getCenter(new THREE.Vector3());
            const out = el.isWindow ? SightLine.analysePicks(m) : null;
            // Out along the window's thin axis, on the side away from its own building.
            const size = bb.getSize(new THREE.Vector3());
            const n = size.x < size.z ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
            const toMid = new THREE.Vector3().sub(c);   // the gap is around the origin
            if (n.dot(toMid) < 0) n.negate();
            const cam = SightLine.camera, ctl = SightLine.controls;
            cam.position.copy(c.clone().addScaledVector(n, 3).add(new THREE.Vector3(0.3, 0.2, 0)));
            ctl.target.copy(c); ctl.update();
            cam.updateMatrixWorld();
            const p = c.clone().project(cam);
            const r = SightLine.renderer.domElement.getBoundingClientRect();
            return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height };
        }, [name, model]);
        await page.mouse.click(pt.x, pt.y);
    }
    async function run() {
        await page.click('#run-btn');
        await page.waitForFunction(() => !document.getElementById('progress-modal').classList.contains('visible')
            && (SightLine.state.results || document.querySelector('#results-body .notice.err')), null, { timeout: 180000 });
        const err = await state(() => { const e = document.querySelector('#results-body .notice.err'); return e ? e.textContent : null; });
        if (err) throw new Error('Run failed: ' + err);
    }
    const figures = () => state(() => SightLine.state.results.scenarios.map(r => ({
        key: r.key, stopped: r.stopped,
        dirs: r.dirs.map(d => ({ total: d.summary.visible.total, floor: d.summary.visible.floor, walls: d.summary.visible.walls,
            ceiling: d.summary.visible.ceiling, any: d.summary.personAny.area, head: d.summary.personHead.area,
            whole: d.summary.personWhole.area, weighted: d.summary.weighted.total, worst: d.summary.worst ? d.summary.worst.length : 0,
            kind: d.summary.worst ? d.summary.worst.kind : 'none', dist: d.summary.centreDist })),
    })));

    await page.waitForFunction(() => window.SightLine && window.WebIFC, null, { timeout: 60000 });
    await page.waitForTimeout(1500);   // web-ifc Init

    // ── 1. Model, picks, run ──
    await loadModel('base.ifc');
    const info = await page.textContent('#model-info');
    console.log('model:', info);
    // The site-wide IfcSpatialZone is hidden and out of the elements (so it can't block);
    // IfcSpaces are rooms, never elements.
    assert.match(info, /Also hidden and ignored: 1 IfcSpatialZone/);
    assert.deepEqual(await state(() => [...SightLine.state.base.elements.values()].filter(e => /space|zone/i.test(e.typeName)).length), 0);
    assert.equal(await state(() => SightLine.state.base.spaces.length), 2);
    await page.click('#pick-w1-btn');
    await clickElement('Window 1');
    assert.equal(await state(() => SightLine.state.mode), 'pick-w2', 'moves on to Window 2');
    await clickElement('Window 2');
    const w1 = await page.textContent('#w1-detail'), w2 = await page.textContent('#w2-detail');
    console.log('W1:', w1, '\nW2:', w2);
    assert.match(w1, /Room: R1 Room 1/); assert.match(w2, /Room: R2 Room 2/);
    await shot('1-picked');
    // Picked-room ghosts can be switched off.
    const ghosts = () => page.evaluate(() => { let n = 0; SightLine.scene.traverse(o => { if (o.visible && o.isMesh && o.material && o.material.opacity === 0.14) n++; }); return n; });
    assert.equal(await ghosts(), 2);
    await page.click('#tg-rooms-setup');
    assert.equal(await ghosts(), 0);
    await page.click('#tg-rooms-setup');
    await run();
    const base = await figures();
    console.log('model run:', JSON.stringify(base[0].dirs));
    assert.ok(Math.abs(base[0].dirs[0].dist - 12.3) < 1e-3);
    assert.ok(base[0].dirs[0].total > 5 && base[0].dirs[1].total > 5);
    await shot('2-results');

    // ── 2. Uploaded comparison with a screen: GlobalIds match, every figure drops ──
    await loadComparison('screen.ifc');
    const match = await page.textContent('#cmp-match');
    console.log('match:', match);
    assert.match(match, /Window 1 found by GlobalId/); assert.match(match, /Window 2 found by GlobalId/);
    await run();
    const up = await figures();
    assert.deepEqual(up.map(r => r.key), ['A', 'B']);
    assert.deepEqual(up[0].dirs, base[0].dirs, 'A is the model');
    for (const d of [0, 1]) for (const k of ['total', 'walls', 'ceiling', 'any', 'head', 'worst']) {
        assert.ok(up[1].dirs[d][k] < up[0].dirs[d][k], `screen reduces ${k} in dir ${d}`);
    }
    console.log('upload B:', JSON.stringify(up[1].dirs));
    const table = await page.textContent('#results-body');
    assert.match(table, /Change \(B against A\)/);
    // Lock and fade
    await page.click('#suggest-btn');
    await page.waitForTimeout(800);
    await page.click('#lock-btn');
    assert.ok(await page.isVisible('#fade-bar'), 'fade bar shows once locked');
    await shot('3-A-locked');
    await page.click('#fade-once-btn');
    await page.waitForTimeout(500);
    await shot('4-mid-fade');
    await page.waitForTimeout(900);
    assert.ok(await state(() => SightLine.state.fadeT) > 0.99, 'faded to B');
    assert.equal(await page.textContent('#showing-badge'), 'B: With intervention');
    assert.equal(await state(() => document.querySelector('table.nums td.showing').dataset.key), 'B', 'numbers follow');
    await shot('5-B');
    await page.click('#lock-btn');   // unlock

    // The screen is in the way: its lines are counted, and there is no "not in the way" notice.
    assert.match(table, /Stopped by the changed elements/);
    assert.doesNotMatch(table, /stop none of the lines/);
    assert.ok(await state(() => SightLine.state.results.scenarios[1].dirs[0].summary.changedBlocked) > 20, 'the screen stops a good share of the lines');

    // ── 2b. A pergola overhead is not in the way: the tool says so, and nothing changes ──
    await page.click('#cmp-remove-btn');
    await loadComparison('shade.ifc');
    await run();
    const sh = await figures();
    assert.deepEqual(sh[1].dirs, sh[0].dirs, 'an overhead shade changes no figure');
    const shText = await page.textContent('#results-body');
    assert.match(shText, /stop none of the lines between the two windows/);
    assert.equal(await state(() => SightLine.state.results.scenarios[1].dirs[0].summary.changedBlocked), 0);
    console.log('shade: not in the way, reported');

    // ── 3. A comparison whose window 2 has a new GlobalId: reported, then re-picked ──
    await page.click('#cmp-remove-btn');
    await loadComparison('new_window.ifc');
    const miss = await page.textContent('#cmp-match');
    console.log('missing:', miss);
    assert.match(miss, /Window 2 not found by GlobalId/);
    await page.click('#cmp-match [data-cmppick="w2"]');
    assert.equal(await state(() => SightLine.state.mode), 'pick-cmp-w2');
    await clickElement('Window 2', 'cmp');
    assert.match(await page.textContent('#cmp-match'), /Window 2 found \(picked in the comparison\)/);
    await run();
    const nw = await figures();
    assert.deepEqual(nw[1].dirs, nw[0].dirs, 'same geometry, same figures');

    // ── 4. Omit route: model with the screen, omit it ──
    await loadModel('screen.ifc');
    await page.click('#pick-w1-btn');
    await clickElement('Window 1');
    await clickElement('Window 2');
    await page.click('#cmp-omit-link');
    assert.equal(await state(() => SightLine.state.mode), 'omit');
    const scr = await page.evaluate(() => {
        const el = [...SightLine.state.base.elements.values()].find(e => e.name === 'Privacy screen');
        const c = new THREE.Box3().setFromObject(el.mesh).getCenter(new THREE.Vector3());
        SightLine.camera.position.copy(c).add(new THREE.Vector3(9, 0.5, 3));
        SightLine.controls.target.copy(c); SightLine.controls.update();
        SightLine.camera.updateMatrixWorld();
        const p = c.clone().project(SightLine.camera);
        const r = SightLine.renderer.domElement.getBoundingClientRect();
        return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height };
    });
    await page.mouse.click(scr.x, scr.y);
    const list = await page.textContent('#cmp-box .omit-list');
    console.log('omit list:', list);
    assert.match(list, /IfcMember · Privacy screen/);
    await shot('6-omit');
    await page.click('#omit-done-btn');
    await run();
    const om = await figures();
    assert.deepEqual(om[0].dirs, base[0].dirs, 'A (screen omitted) equals the model without a screen');
    assert.deepEqual(om[1].dirs, up[1].dirs, 'B (as uploaded) equals the uploaded screen comparison');
    for (const d of [0, 1]) for (const k of ['total', 'any', 'worst']) assert.ok(om[0].dirs[d][k] > om[1].dirs[d][k], 'omitting increases ' + k);
    await page.click('#omit-clear-btn');
    await run();
    const cl = await figures();
    assert.deepEqual(cl[0].dirs, cl[1].dirs, 'clearing the omit list makes the two identical');

    // ── 4a. Session round trip ──
    const sess = await state(() => SightLine.sessionObject());
    assert.equal(sess.picks.w1.globalId, '05KFQBigzUcxbqSNDBc$MN');
    assert.equal(sess.comparison.route, 'omit');

    // ── 4b. No IfcSpaces at all: same surfaces, same figures, no room-based percentages ──
    await loadModel('no_spaces.ifc');
    assert.equal(await state(() => SightLine.state.base.spaces.length), 0);
    await page.click('#pick-w1-btn');
    await clickElement('Window 1');
    await clickElement('Window 2');
    assert.match(await page.textContent('#w1-detail'), /No IfcSpace behind this window/);
    await run();
    const ns = await figures();
    assert.deepEqual(ns[0].dirs, base[0].dirs, 'the surfaces come from the sight lines, so the figures are the same');
    const nsText = await page.textContent('#results-body');
    assert.doesNotMatch(nsText, /of floor/);
    console.log('no spaces: ok');

    // ── 5. Deadline 0 ──
    await page.click('details.settings summary');
    await page.fill('#set-deadline', '0');
    await page.dispatchEvent('#set-deadline', 'change');
    await run();
    const dl = await page.textContent('#results-body');
    assert.match(dl, /stopped at the 0 s deadline/);
    console.log('deadline:', dl.slice(0, 200));

    const bad = logs.filter(l => !/GPU stall|swiftshader|WebGL/i.test(l));
    if (bad.length) { console.log('browser log:\n' + bad.join('\n')); }
    assert.ok(!bad.some(l => l.startsWith('pageerror')), 'no page errors');
    await browser.close();
    console.log('E2E OK');
}

main().catch(e => { console.error(e); console.log(logs.join('\n')); process.exit(1); });
