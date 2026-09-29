// Tests for the SightLine core (section 10 of the requirements).
//
// The core is the <script id="sightline-core"> block in index.html. These
// tests read it straight out of the page, so they check the same code the
// browser and its Web Worker run.
//
// Run:  node --test tests/core.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const src = html.match(/<script id="sightline-core">([\s\S]*?)<\/script>/)[1];
const ctx = vm.createContext({});
vm.runInContext(src + `
;this.core = { BVH, apertureFromPoints, resolvePair, roomTotals, computeVisibility, summariseDirection,
  classifyPerson, sightBundle, trisBBox, discoverSurface };`, ctx);
const C = ctx.core;

// ── Synthetic scene, Y up, metres ─────────────────────────────────────────
// Two single-room buildings face each other across a 12 m gap between their
// front walls (12.3 m between the window centrelines). Room 1 lies at z > 0,
// room 2 at z < -12.3. Each room is 4 m wide (x 0..4, building 2 shifted by
// `shift2`), 5 m deep, 2.6 m high, with a window in the middle of a 300 mm
// front wall. Nothing here is an IfcSpace except b.space, which the tests
// only use for names and percentages: the surfaces come from the sight lines.

function boxTris(x0, y0, z0, x1, y1, z1) {
    const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]];
    return f.map(t => t.map(i => v[i]));
}

function building(x0, y0, frontZ, dir, wallT, win) {
    // frontZ: outer face of the front wall; dir -1 → room towards -z, +1 → +z.
    const W = 4, D = 5, H = 2.6;
    const fz = dir > 0 ? [frontZ, frontZ + wallT] : [frontZ - wallT, frontZ];
    const rz = dir > 0 ? [fz[1], fz[1] + D] : [fz[0] - D, fz[0]];
    const bz = dir > 0 ? [rz[1], rz[1] + 0.3] : [rz[0] - 0.3, rz[0]];
    const oz = [Math.min(fz[0], bz[0]), Math.max(fz[1], bz[1])];
    const wx = [x0 + 1.4, x0 + 2.6], wy = [y0 + win[0], y0 + win[1]];
    const solids = [
        [x0, y0, fz[0], wx[0], y0 + H, fz[1]], [wx[1], y0, fz[0], x0 + W, y0 + H, fz[1]],
        [wx[0], y0, fz[0], wx[1], wy[0], fz[1]], [wx[0], wy[1], fz[0], wx[1], y0 + H, fz[1]],
        [x0, y0, bz[0], x0 + W, y0 + H, bz[1]],
        [x0 - 0.3, y0, oz[0], x0, y0 + H, oz[1]], [x0 + W, y0, oz[0], x0 + W + 0.3, y0 + H, oz[1]],
        [x0 - 0.3, y0 - 0.3, oz[0], x0 + W + 0.3, y0, oz[1]], [x0 - 0.3, y0 + H, oz[0], x0 + W + 0.3, y0 + H + 0.3, oz[1]],
    ];
    const mid = (fz[0] + fz[1]) / 2;
    const windowPts = boxTris(wx[0], wy[0], mid - 0.035, wx[1], wy[1], mid + 0.035).flat().flat();
    const spaceTris = boxTris(x0, y0, rz[0], x0 + W, y0 + H, rz[1]);
    return { solids, windowPts, space: { tris: spaceTris, bbox: C.trisBBox(spaceTris) } };
}

function scene(o = {}) {
    const b1 = building(0, o.y1 || 0, 0, +1, 0.3, o.win1 || [0.9, 2.3]);
    const b2 = building(o.shift2 || 0, 0, -12.0, -1, o.wall2 || 0.3, o.win2 || [0.9, 2.3]);
    // Window 1 centreline z = 0.15, Window 2 centreline z = -12 - wall2/2.
    const solids = b1.solids.concat(b2.solids);
    // A screen across the gap, 2 m high, halfway between the buildings.
    if (o.screen) solids.push([-2, -0.3, -6.1, 6, 2.0, -6.0]);
    // Louvres: 100 mm slats with 100 mm gaps across the gap, 2 m high, halfway between the buildings.
    if (o.slats) for (let x = -2; x < 6; x += 0.2) solids.push([x, -0.3, -6.1, x + 0.1, 2.0, -6.0]);
    // A 1 m high block of furniture in the middle of room 2.
    if (o.block) solids.push([1.4, 0, -16.0, 2.6, 1.0, -15.0]);
    const tris = solids.flatMap(s => boxTris(...s));
    const pos = new Float32Array(tris.flat().flat());
    const idx = new Uint32Array(tris.length * 3).map((_, i) => i);
    return { pos, idx, b1, b2 };
}

const SETTINGS = { viewer: 0.1, target: 0.1, stand: 0.25, height: 1.7, hstep: 0.05 };

function run(sc, opts = {}) {
    const st = Object.assign({}, SETTINGS, opts);
    const spaces = opts.noSpaces ? [] : [sc.b1.space, sc.b2.space];
    const pair = C.resolvePair(C.apertureFromPoints(sc.b1.windowPts), C.apertureFromPoints(sc.b2.windowPts), spaces);
    if (!opts.noSpaces) assert.ok(pair.w1.room && pair.w2.room, 'both rooms found');
    const job = {
        blockPos: sc.pos, blockIdx: sc.idx, deadlineMs: opts.deadlineMs === undefined ? 1e9 : opts.deadlineMs,
        viewerStep: st.viewer, targetSub: st.target, standStep: st.stand, personHeight: st.height, hStep: st.hstep,
        dirs: [
            { name: 'd0', viewer: pair.w1.ap, target: pair.w2.ap },
            { name: 'd1', viewer: pair.w2.ap, target: pair.w1.ap },
        ],
    };
    const res = C.computeVisibility(job);
    const sum = (i, viewerAp, targetAp, room) => C.summariseDirection({
        surface: res.dirs[i].surface, fraction: res.dirs[i].fraction, personVis: res.dirs[i].personVis, personShare: res.dirs[i].personShare,
        standing: res.dirs[i].standing, nH: res.dirs[i].nH, hStep: res.dirs[i].hStep, standStep: st.stand,
        viewerAp, targetAp, totals: room ? C.roomTotals(room) : null });
    return {
        pair, res, job,
        s: [sum(0, pair.w1.ap, pair.w2.ap, pair.w2.room), sum(1, pair.w2.ap, pair.w1.ap, pair.w1.room)],
    };
}

// Painted points on room 2's back wall (normal pointing +z, towards the viewer).
function backWallPaint(r) {
    const s = r.res.dirs[0].surface, f = r.res.dirs[0].fraction;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, area = 0, cx = 0;
    for (let i = 0; i < s.vertexCount; i++) {
        if (s.normals[i * 3 + 2] < 0.9 || s.positions[i * 3 + 2] > -17.2 || !(f[i] > 0)) continue;
        const x = s.positions[i * 3], y = s.positions[i * 3 + 1];
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        area += s.areas[i]; cx += x * s.areas[i];
    }
    return { minX, maxX, minY, maxY, area, cx: cx / area };
}

const FIGURES = s => ({
    floor: s.visible.floor, walls: s.visible.walls, ceiling: s.visible.ceiling, total: s.visible.total,
    any: s.personAny.area, head: s.personHead.area, whole: s.personWhole.area, worst: s.worst ? s.worst.length : 0,
});

const baseScene = scene();
const base = run(baseScene);

test('apertures and rooms are found, normals face each other', () => {
    const { w1, w2 } = base.pair;
    assert.ok(Math.abs(w1.ap.w - 1.2) < 1e-6 && Math.abs(w1.ap.h - 1.4) < 1e-6);
    assert.ok(Math.abs(w1.ap.c[2] - 0.15) < 1e-6 && Math.abs(w2.ap.c[2] + 12.15) < 1e-6, 'aperture on the frame centreline');
    assert.ok(w1.ap.n[2] < -0.99 && w2.ap.n[2] > 0.99, 'normals point out of the rooms');
    assert.ok(Math.abs(base.s[0].centreDist - 12.3) < 1e-6);
    assert.ok(base.s[0].angleOffSquare < 0.01);
});

test('the surfaces are found by the sight lines, not from a room', () => {
    const d = base.res.dirs[0];
    // Painted points are all inside room 2 (beyond window 2's frame plane, in front of the back wall),
    // and none of them is the opening's own jamb, head or cill.
    let n = 0;
    for (let i = 0; i < d.surface.vertexCount; i++) {
        if (!(d.fraction[i] > 0)) continue;
        n++;
        const x = d.surface.positions[i * 3], y = d.surface.positions[i * 3 + 1], z = d.surface.positions[i * 3 + 2];
        assert.ok(z <= -12.3 + 0.03 && z >= -17.3 - 0.03 && x >= -0.03 && x <= 4.03 && y >= -0.03 && y <= 2.63,
            `painted point (${x}, ${y}, ${z}) is inside room 2`);
    }
    assert.ok(n > 500 && d.landed > 100 && d.surfaces >= 3 && d.standing.length > 0);
    assert.ok(Math.abs(d.revealDepth === undefined ? 0.15 : d.revealDepth - 0.15) < 0.01);
});

test('square on: painted area on the back wall matches the hand projection within one grid cell', () => {
    // By hand: a viewer anywhere on Aperture 1 (z 0.15). The steepest line
    // that still clears the opening in wall 2 passes one edge of Aperture 1
    // and the opposite edge of the opening at wall 2's inner face (z -12.3),
    // so on the back wall (z -17.3) distances scale by k = 17.45 / 12.45.
    const k = (0.15 + 17.3) / (0.15 + 12.3);
    const x0 = 2.6 - 1.2 * k, x1 = 1.4 + 1.2 * k;   // 0.918 .. 3.082
    const y0 = 2.3 - 1.4 * k;                        // 0.338
    const p = backWallPaint(base);
    const cell = SETTINGS.target;
    assert.ok(Math.abs(p.minX - x0) <= cell, `minX ${p.minX} vs ${x0}`);
    assert.ok(Math.abs(p.maxX - x1) <= cell, `maxX ${p.maxX} vs ${x1}`);
    assert.ok(Math.abs(p.minY - y0) <= cell, `minY ${p.minY} vs ${y0}`);
    assert.ok(Math.abs(p.maxY - 2.6) <= cell, 'reaches the ceiling');
    const expected = (x1 - x0) * (2.6 - y0);
    assert.ok(Math.abs(p.area - expected) <= cell * 2 * ((x1 - x0) + (2.6 - y0)), `area ${p.area} vs ${expected}`);
});

test('works without any IfcSpace: same figures, no room-based percentages', () => {
    const r = run(baseScene, { noSpaces: true });
    for (const d of [0, 1]) {
        assert.deepEqual(FIGURES(r.s[d]), FIGURES(base.s[d]));
        assert.equal(r.s[d].visiblePct.total, null);
        assert.equal(r.s[d].floorArea, null);
        assert.equal(r.s[d].personAny.pct, null);
        assert.ok(base.s[d].visiblePct.total > 0 && base.s[d].personAny.pct > 0, 'with a room the percentages are there');
    }
});

test('real surfaces are measured: furniture in the room is painted and shades what is behind it', () => {
    const r = run(scene({ block: true }));
    const s = r.res.dirs[0].surface, f = r.res.dirs[0].fraction;
    let blockFace = 0, blockTop = 0;
    for (let i = 0; i < s.vertexCount; i++) {
        if (!(f[i] > 0)) continue;
        const x = s.positions[i * 3], y = s.positions[i * 3 + 1], z = s.positions[i * 3 + 2];
        if (Math.abs(z + 15) < 1e-4 && s.normals[i * 3 + 2] > 0.9 && y <= 1.0 + 1e-6) blockFace++;
        if (Math.abs(y - 1.0) < 1e-4 && s.normals[i * 3 + 1] > 0.9 && z > -16 - 1e-6 && z < -15 + 1e-6) blockTop++;
    }
    assert.ok(blockFace > 20, `the block's face is painted (${blockFace} points)`);
    assert.ok(blockTop > 5, `the block's top is painted (${blockTop} points)`);
    assert.ok(backWallPaint(r).area < backWallPaint(base).area, 'the back wall is shaded by the block');
    // Up-facing surfaces count as floor: what is visible is the top of the block, 1.2 x 1.0 m.
    assert.ok(Math.abs(r.s[0].visible.floor - 1.2) < 0.15, `visible floor ${r.s[0].visible.floor}`);
});

test('the two directions are symmetric for a symmetric scene', () => {
    const a = FIGURES(base.s[0]), b = FIGURES(base.s[1]);
    // The standing grid is aligned to the world, so the two rooms' cells fall
    // slightly differently: allow a cell or two on the person figures.
    for (const k of Object.keys(a)) {
        const tol = ['any', 'head', 'whole'].includes(k) ? 0.08 : 0.02;
        assert.ok(Math.abs(a[k] - b[k]) <= tol * Math.max(1, a[k]), `${k}: ${a[k]} vs ${b[k]}`);
    }
});

test('oblique: moving one window sideways shrinks the painted area and shifts it', () => {
    const r = run(scene({ shift2: 2.5 }));
    const p0 = backWallPaint(base), p1 = backWallPaint(r);
    assert.ok(r.s[0].angleOffSquare > 10, 'reported off square');
    assert.ok(p1.area < p0.area, `less on the back wall: ${p1.area} vs ${p0.area}`);
    assert.ok(r.s[0].visible.ceiling < base.s[0].visible.ceiling, 'less on the ceiling');
    assert.ok(r.s[0].personAny.area < base.s[0].personAny.area, 'a person is visible over less of the floor');
    // Relative to its room (shifted 2.5 m) the patch moves further along +x.
    assert.ok(p1.cx - 2.5 > p0.cx + 0.5, `patch centre ${p1.cx - 2.5} vs ${p0.cx}`);
});

test('a screen between the windows reduces every visible figure', () => {
    const r = run(scene({ screen: true }));
    for (const d of [0, 1]) {
        const a = FIGURES(base.s[d]), b = FIGURES(r.s[d]);
        for (const k of Object.keys(a)) {
            if (a[k] === 0) assert.equal(b[k], 0, k);
            else assert.ok(b[k] < a[k], `dir ${d} ${k}: ${b[k]} not below ${a[k]}`);
        }
    }
});

test('a deeper reveal reduces the visible area (reveals block, the picked window does not)', () => {
    const r = run(scene({ wall2: 0.6 }));
    assert.ok(r.s[0].visible.total < base.s[0].visible.total);
    assert.ok(r.s[1].visible.total < base.s[1].visible.total);
    assert.ok(base.s[0].visible.total > 1, 'something is visible through the picked windows');
});

test('person measure: ceiling only gives head down, floor only feet up, both whole person', () => {
    const low = run(scene({ y1: -3 }));    // looking up into room 2: lines land on its ceiling
    assert.equal(low.s[0].worst.kind, 'head');
    assert.ok(low.s[0].personHead.area > 0 && low.s[0].personWhole.area === 0);
    // Looking down into a low window (cill 50 mm, head 1.5 m): the lines land
    // on the floor, reaching it before the first row of standing positions.
    const high = run(scene({ y1: 3, win2: [0.05, 1.5] }));
    assert.equal(high.s[0].worst.kind, 'feet');
    assert.ok(high.s[0].personHead.area === 0);
    const tall = run(scene({ win1: [0.1, 2.5], win2: [0.1, 2.5] }));   // full-height glazing
    assert.equal(tall.s[0].worst.kind, 'whole');
    assert.ok(Math.abs(tall.s[0].worst.length - 1.7) < 1e-9);
    assert.ok(tall.s[0].personWhole.area > 0);
});

test('classifyPerson kinds', () => {
    assert.deepEqual({ ...C.classifyPerson([0, 0, 1, 1], 0.05) }, { length: 0.1, kind: 'head' });
    assert.deepEqual({ ...C.classifyPerson([1, 1, 0, 0], 0.05) }, { length: 0.1, kind: 'feet' });
    assert.deepEqual({ ...C.classifyPerson([0, 1, 1, 0], 0.05) }, { length: 0.1, kind: 'middle' });
    assert.equal(C.classifyPerson([1, 1, 1, 1], 0.05).kind, 'whole');
    assert.equal(C.classifyPerson([0, 0, 0, 0], 0.05).kind, 'none');
    assert.equal(C.classifyPerson([1, 0, 1, 1], 0.05).kind, 'head');
});

test('omitting: leaving the screen out increases every visible figure; nothing omitted changes nothing', () => {
    const withScreen = scene({ screen: true });
    // The comparison made by omitting the screen: same geometry, screen left out of the BVH.
    const n = 12;
    const omitted = { pos: withScreen.pos.slice(0, withScreen.pos.length - n * 9), idx: withScreen.idx.slice(0, withScreen.idx.length - n * 3), b1: withScreen.b1, b2: withScreen.b2 };
    const a = run(omitted), b = run(withScreen);
    for (const d of [0, 1]) {
        assert.deepEqual(FIGURES(a.s[d]), FIGURES(base.s[d]), 'omitted = never there');
        const fa = FIGURES(a.s[d]), fb = FIGURES(b.s[d]);
        for (const k of Object.keys(fa)) if (fa[k] > 0) assert.ok(fa[k] > fb[k], `omitting the screen increases ${k}`);
    }
    assert.deepEqual(FIGURES(run(withScreen).s[0]), FIGURES(b.s[0]), 'an empty omit list gives the same figures');
});

test('deadline 0 returns straight away with the stop reported', () => {
    const t0 = Date.now();
    const r = run(scene(), { deadlineMs: 0 });
    assert.ok(Date.now() - t0 < 2000);
    assert.ok(r.res.stopped, 'stopped is reported');
    assert.equal(r.res.stopped.done, 0);
    assert.equal(r.s[0].targetsReached, 0);
});

test('sight-line bundle: 16 lines, each extended to the first surface it lands on in both rooms', () => {
    const bvh = new C.BVH(baseScene.pos, baseScene.idx);
    const b = C.sightBundle(base.pair.w1.ap, base.pair.w2.ap, bvh);
    assert.equal(b.lines.length, 16);
    for (const l of b.lines) {
        assert.ok(l.intoRoom2 && l.intoRoom1);
        assert.ok(l.intoRoom2[2] < -12.29 && l.intoRoom2[2] >= -17.3 - 1e-6, 'lands inside room 2');
        assert.ok(l.intoRoom1[2] > 0.29 && l.intoRoom1[2] <= 5.3 + 1e-6, 'lands inside room 1');
    }
    // A block in the way stops the lines that reach it, short of the back wall.
    const bs = scene({ block: true });
    const b2 = C.sightBundle(base.pair.w1.ap, base.pair.w2.ap, new C.BVH(bs.pos, bs.idx));
    assert.ok(b2.lines.some(l => l.intoRoom2 && l.intoRoom2[2] > -15 - 1e-6 && l.intoRoom2[2] < -12.3), 'some lines land on the block');
});

test('a hit-and-miss intervention: louvres barely change "visible from any point" but halve the weighted figures', () => {
    const r = run(scene({ slats: true }));
    for (const d of [0, 1]) {
        const a = base.s[d], b = r.s[d];
        // Some line still gets through everywhere, so the any-point figures hardly move...
        assert.ok(b.visible.total > 0.9 * a.visible.total, `any-point ${b.visible.total} vs ${a.visible.total}`);
        assert.equal(b.worst.length, a.worst.length);
        // ...while the weighted figures show the intervention.
        assert.ok(b.weighted.total < 0.7 * a.weighted.total, `weighted ${b.weighted.total} vs ${a.weighted.total}`);
        assert.ok(b.visibleHalf.total < 0.7 * a.visibleHalf.total, 'seen from half the window');
        assert.ok(b.personWeighted.area < 0.9 * a.personWeighted.area, `person ${b.personWeighted.area} vs ${a.personWeighted.area}`);
        assert.ok(b.worst.mean < 0.8 * a.worst.mean, `mean at the worst position ${b.worst.mean} vs ${a.worst.mean}`);
    }
});

test('weighted figures never exceed the any-point figures, and an unobstructed scene is well above zero', () => {
    for (const d of [0, 1]) {
        const s = base.s[d];
        assert.ok(s.weighted.total <= s.visible.total && s.visibleHalf.total <= s.visible.total);
        assert.ok(s.weighted.total > 0.2 * s.visible.total);
        assert.ok(s.worst.mean <= s.worst.length + 1e-9 && s.worst.mean > 0);
        assert.ok(s.personWeighted.area <= s.personAny.area + 1e-9);
    }
});
