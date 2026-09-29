"""
Make small test IFC models for SightLine.

Two single-room buildings face each other across a 12 m gap. Each room is
4 m wide, 5 m deep and 2.6 m high, with a 1.2 m x 1.4 m window (cill at
0.9 m) in the middle of its front wall. Every element and space has a
fixed GlobalId, so the variants below share GlobalIds and can be used as
a model and its uploaded comparison.

    python tools/make_test_ifc.py            # writes into test-models/

Needs ifcopenshell (pip install ifcopenshell). Variants written:

    base.ifc        the two buildings, square on
    screen.ifc      base plus a 2 m high privacy screen (IfcMember) halfway between
    oblique.ifc     building 2 moved 2.5 m sideways
    deep_reveal.ifc building 2's front wall 0.6 m thick instead of 0.3 m
    new_window.ifc  base with window 2 replaced by a new element (new GlobalId)
"""

import os
import sys
import uuid

import numpy as np
import ifcopenshell
import ifcopenshell.api
import ifcopenshell.api.project
import ifcopenshell.api.geometry
import ifcopenshell.guid

run = ifcopenshell.api.run

ROOM_W, ROOM_D, ROOM_H = 4.0, 5.0, 2.6
WALL_T = 0.3
GAP = 12.0                     # outer face of wall 1 (y=0.3) to outer face of wall 2
WIN_X0, WIN_X1 = 1.4, 2.6      # window across the front wall, from the room's left edge
WIN_Z0, WIN_Z1 = 0.9, 2.3


def gid(key):
    return ifcopenshell.guid.compress(uuid.uuid5(uuid.NAMESPACE_URL, 'sightline/' + key).hex)


class Builder:
    def __init__(self):
        f = ifcopenshell.api.project.create_file(version='IFC4')
        self.f = f
        self.project = run('root.create_entity', f, ifc_class='IfcProject', name='SightLine test')
        f.by_type('IfcProject')[0].GlobalId = gid('project')
        metre = run('unit.add_si_unit', f, unit_type='LENGTHUNIT')
        run('unit.assign_unit', f, units=[metre])
        model = run('context.add_context', f, context_type='Model')
        self.body = run('context.add_context', f, context_type='Model', context_identifier='Body',
                        target_view='MODEL_VIEW', parent=model)
        self.site = self.entity('IfcSite', 'Site', 'site')
        run('aggregate.assign_object', f, products=[self.site], relating_object=self.project)

    def entity(self, cls, name, key):
        e = run('root.create_entity', self.f, ifc_class=cls, name=name)
        e.GlobalId = gid(key)
        return e

    def box(self, product, x0, y0, z0, x1, y1, z1):
        """Give product an axis-aligned box body from (x0,y0,z0) to (x1,y1,z1), metres, Z up."""
        rep = ifcopenshell.api.geometry.add_wall_representation(
            self.f, context=self.body, length=x1 - x0, thickness=y1 - y0, height=z1 - z0)
        run('geometry.assign_representation', self.f, product=product, representation=rep)
        m = np.eye(4)
        m[0, 3], m[1, 3], m[2, 3] = x0, y0, z0
        run('geometry.edit_object_placement', self.f, product=product, matrix=m, is_si=True)

    def storey(self, key, name):
        building = self.entity('IfcBuilding', name, key)
        run('aggregate.assign_object', self.f, products=[building], relating_object=self.site)
        storey = self.entity('IfcBuildingStorey', name + ' ground', key + '/storey')
        run('aggregate.assign_object', self.f, products=[storey], relating_object=building)
        return storey

    def element(self, storey, cls, name, key, *bounds):
        e = self.entity(cls, name, key)
        self.box(e, *bounds)
        if cls == 'IfcSpace':
            run('aggregate.assign_object', self.f, products=[e], relating_object=storey)
        else:
            run('spatial.assign_container', self.f, products=[e], relating_structure=storey)
        return e


def add_building(b, n, x0, front_y, facing, wall_t, window_key='window'):
    """One room. front_y is the outer face of the front wall; facing +1 means the
    room lies at larger y than the front wall, -1 at smaller y."""
    st = b.storey('b%d' % n, 'Building %d' % n)
    k = 'b%d/' % n
    if facing > 0:
        fy0, fy1 = front_y, front_y + wall_t
        ry0, ry1 = fy1, fy1 + ROOM_D
        by0, by1 = ry1, ry1 + WALL_T
    else:
        fy0, fy1 = front_y - wall_t, front_y
        ry0, ry1 = fy0 - ROOM_D, fy0
        by0, by1 = ry0 - WALL_T, ry0
    oy0, oy1 = min(fy0, by0), max(fy1, by1)
    X0, X1 = x0, x0 + ROOM_W
    wx0, wx1 = x0 + WIN_X0, x0 + WIN_X1
    # Front wall, built round the opening so its reveals are real faces.
    b.element(st, 'IfcWall', 'Front wall left', k + 'fl', X0, fy0, 0, wx0, fy1, ROOM_H)
    b.element(st, 'IfcWall', 'Front wall right', k + 'fr', wx1, fy0, 0, X1, fy1, ROOM_H)
    b.element(st, 'IfcWall', 'Front wall below', k + 'fb', wx0, fy0, 0, wx1, fy1, WIN_Z0)
    b.element(st, 'IfcWall', 'Front wall above', k + 'fa', wx0, fy0, WIN_Z1, wx1, fy1, ROOM_H)
    b.element(st, 'IfcWall', 'Back wall', k + 'bw', X0, by0, 0, X1, by1, ROOM_H)
    b.element(st, 'IfcWall', 'Side wall L', k + 'sl', X0 - WALL_T, oy0, 0, X0, oy1, ROOM_H)
    b.element(st, 'IfcWall', 'Side wall R', k + 'sr', X1, oy0, 0, X1 + WALL_T, oy1, ROOM_H)
    b.element(st, 'IfcSlab', 'Floor', k + 'floor', X0 - WALL_T, oy0, -0.3, X1 + WALL_T, oy1, 0)
    b.element(st, 'IfcSlab', 'Roof', k + 'roof', X0 - WALL_T, oy0, ROOM_H, X1 + WALL_T, oy1, ROOM_H + 0.3)
    mid = (fy0 + fy1) / 2
    b.element(st, 'IfcWindow', 'Window %d' % n, k + window_key, wx0, mid - 0.035, WIN_Z0, wx1, mid + 0.035, WIN_Z1)
    sp = b.element(st, 'IfcSpace', 'R%d' % n, k + 'space', X0, ry0, 0, X1, ry1, ROOM_H)
    sp.LongName = 'Room %d' % n


def make(path, shift2=0.0, wall2_t=WALL_T, screen=False, window2_key='window'):
    b = Builder()
    add_building(b, 1, 0.0, WALL_T, -1, WALL_T)          # room at y < 0, outer face y = 0.3
    add_building(b, 2, shift2, WALL_T + GAP, +1, wall2_t, window2_key)
    if screen:
        st = b.f.by_type('IfcBuildingStorey')[0]
        b.element(st, 'IfcMember', 'Privacy screen', 'screen', -2.0, 6.1, -0.3, 6.0, 6.2, 2.0)
    b.f.write(path)


def main(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    make(os.path.join(out_dir, 'base.ifc'))
    make(os.path.join(out_dir, 'screen.ifc'), screen=True)
    make(os.path.join(out_dir, 'oblique.ifc'), shift2=2.5)
    make(os.path.join(out_dir, 'deep_reveal.ifc'), wall2_t=0.6)
    make(os.path.join(out_dir, 'new_window.ifc'), window2_key='window-new')
    print('Written to', out_dir)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'test-models'))
