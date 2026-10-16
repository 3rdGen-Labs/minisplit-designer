"""Procedural unit icons for zonespec, rendered headless with Blender 4.5.

Our own generic models of each unit *style* (no logos, no Mitsubishi artwork).
Usage:
  blender -b -P design/blender/units.py -- <unit|all> <out_dir> [size_px]
Writes <out_dir>/<unit>.png (transparent) and <out_dir>/<unit>.glb.
"""
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

IN = 0.0254  # model in inches, Blender works in meters

# ---------------------------------------------------------------- helpers


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


_mats = {}


def mat(name, color, rough=0.4, metal=0.0, coat=0.0, emit=None):
    if name in _mats:
        return _mats[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    b.inputs["Coat Weight"].default_value = coat
    if emit:
        b.inputs["Emission Color"].default_value = (*emit, 1)
        b.inputs["Emission Strength"].default_value = 3.0
    _mats[name] = m
    return m


def white():
    return mat("white_plastic", (0.91, 0.915, 0.91), rough=0.3, coat=0.2)


def warm_white():
    return mat("odu_body", (0.80, 0.79, 0.75), rough=0.45)


def dark():
    return mat("dark_plastic", (0.035, 0.037, 0.04), rough=0.55)


def mid_grey():
    return mat("grey_plastic", (0.32, 0.33, 0.34), rough=0.5)


def galvanized():
    return mat("galvanized", (0.62, 0.64, 0.66), rough=0.42, metal=0.85)


def copper():
    return mat("copper", (0.80, 0.42, 0.25), rough=0.3, metal=1.0)


def brass():
    return mat("brass", (0.78, 0.62, 0.30), rough=0.3, metal=1.0)


def _finish(o, material, bevel, segments, smooth=True):
    if bevel:
        m = o.modifiers.new("bevel", "BEVEL")
        m.width = bevel
        m.segments = segments
        m.limit_method = "ANGLE"
    o.data.materials.append(material)
    if smooth:
        bpy.context.view_layer.objects.active = o
        o.select_set(True)
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(35))
        o.select_set(False)
    return o


def box(size, loc, material, bevel=0.15, segments=3, rot=(0, 0, 0)):
    """size and loc in inches."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=Vector(loc) * IN, rotation=rot)
    o = bpy.context.object
    o.scale = Vector(size) * IN
    bpy.ops.object.transform_apply(scale=True)
    return _finish(o, material, bevel * IN, segments)


def box_cut(size, loc, material, cut_size, cut_loc, bevel=0.3, segments=4):
    """A box with a box-shaped pocket cut out (one seamless solid), bevelled after the cut."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=Vector(cut_loc) * IN)
    cutter = bpy.context.object
    cutter.scale = Vector(cut_size) * IN
    bpy.ops.object.transform_apply(scale=True)
    cutter["stage"] = True
    cutter.hide_render = True
    cutter.hide_viewport = True
    bpy.ops.mesh.primitive_cube_add(size=1, location=Vector(loc) * IN)
    o = bpy.context.object
    o.scale = Vector(size) * IN
    bpy.ops.object.transform_apply(scale=True)
    b = o.modifiers.new("cut", "BOOLEAN")
    b.operation, b.object, b.solver = "DIFFERENCE", cutter, "EXACT"
    return _finish(o, material, bevel * IN, segments)


def cyl(radius, depth, loc, material, rot=(0, 0, 0), verts=48, bevel=0.0):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius * IN, depth=depth * IN, location=Vector(loc) * IN, rotation=rot)
    return _finish(bpy.context.object, material, bevel * IN, 2)


def torus(major, minor, loc, material, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(major_radius=major * IN, minor_radius=minor * IN, location=Vector(loc) * IN, rotation=rot, major_segments=72, minor_segments=10)
    return _finish(bpy.context.object, material, 0, 0)


def profile(points, width, material, x=0.0, bevel=0.6, segments=5):
    """Extrude a closed side profile (list of (y, z) in inches) along X, centred on x."""
    import bmesh

    me = bpy.data.meshes.new("profile")
    bm = bmesh.new()
    left = [bm.verts.new(((x - width / 2) * IN, y * IN, z * IN)) for y, z in points]
    right = [bm.verts.new(((x + width / 2) * IN, y * IN, z * IN)) for y, z in points]
    bm.faces.new(left[::-1])
    bm.faces.new(right)
    n = len(points)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((left[i], left[j], right[j], right[i]))
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new("profile", me)
    bpy.context.scene.collection.objects.link(o)
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    return _finish(o, material, bevel * IN, segments)


def arc(cy, cz, r, a0, a1, steps=10):
    """Points on an arc in the YZ plane, angles in degrees (0 = +Y, 90 = +Z)."""
    return [(cy + r * math.cos(math.radians(a0 + (a1 - a0) * t / steps)), cz + r * math.sin(math.radians(a0 + (a1 - a0) * t / steps))) for t in range(steps + 1)]


XROT = (math.pi / 2, 0, 0)  # cylinder axis -> Y (pointing at the viewer)
YROT = (0, math.pi / 2, 0)  # cylinder axis -> X


def screws(points, y, material, r=0.16, rot=XROT):
    for x, z in points:
        cyl(r, 0.12, (x, y, z), material, rot=rot, verts=16, bevel=0.04)


# ---------------------------------------------------------------- units
# Coordinates: X = width, -Y = front (toward camera), Z = up. Inches.
# Models are built at real size so the .glb files work for AR at 1:1.


def wall_premium():
    """Premium flat-panel wall unit (GX / FX style): crisp box, full flat front, wide bottom outlet with
    sectioned vertical vanes and a hanging louver, sensor module at bottom right. No badge."""
    W, D, H = 31.5, 9.2, 11.6
    front = -D / 2
    panel_bottom = 2.5  # front panel stops here; the outlet sits below it
    # body: full depth above the outlet band; below it only the back part, leaving the outlet open at the front
    OUT = 4.2  # outlet depth from the front face
    ox0, ox1 = -W / 2 + 1.0, W / 2 - 5.3  # outlet span; the sensor module takes the right end
    body = box_cut((W, D, H), (0, 0, H / 2), white(), (ox1 - ox0, OUT * 2, panel_bottom * 2), ((ox0 + ox1) / 2, front, 0), bevel=0.35)
    body.name = "body"
    # full-width flat front panel, inset a hair from the sides so the seam reads
    box((W - 0.5, 0.35, H - panel_bottom - 0.25), (0, front - 0.12, panel_bottom + (H - panel_bottom - 0.25) / 2), white(), bevel=0.18, segments=4)
    # top intake: fine slots across the top
    for i in range(60):
        x = -W / 2 + 1.4 + i * (W - 2.8) / 59
        box((0.16, D - 3.4, 0.12), (x, 0.8, H + 0.01), dark(), bevel=0.03, segments=1)

    # sensor module, bottom right (blank face, round motion sensor)
    mx0, mx1 = W / 2 - 5.0, W / 2 - 0.25
    module = mat("module", (0.80, 0.81, 0.81), rough=0.38, coat=0.1)
    box((mx1 - mx0, 1.6, panel_bottom - 0.2), ((mx0 + mx1) / 2, front + 0.55, panel_bottom / 2 + 0.05), module, bevel=0.15)
    cyl(0.55, 0.3, (mx1 - 1.3, front - 0.3, 1.15), mid_grey(), rot=XROT, verts=32, bevel=0.08)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.42 * IN, location=Vector((mx1 - 1.3, front - 0.45, 1.15)) * IN)
    _finish(bpy.context.object, mat("sensor", (0.06, 0.06, 0.07), rough=0.1, coat=0.8), 0, 0)
    box((0.9, 0.1, 0.35), (mx1 - 3.0, front - 0.25, 1.15), mat("smoked", (0.05, 0.06, 0.07), rough=0.15, coat=0.6), bevel=0.1)

    # outlet: dark lining inside the pocket
    ow, oc = ox1 - ox0, (ox0 + ox1) / 2
    box((ow, 0.3, panel_bottom), (oc, front + OUT - 0.15, panel_bottom / 2), dark(), bevel=0.05)  # back wall of the outlet
    box((ow, OUT, 0.3), (oc, front + OUT / 2, panel_bottom - 0.05), dark(), bevel=0.05)  # roof of the outlet
    # upper flap (thin white lip under the front panel)
    box((ow, 0.9, 0.14), (oc, front + 0.35, panel_bottom - 0.25), white(), bevel=0.05, segments=2, rot=(math.radians(-8), 0, 0))
    # vertical vanes in four sections, each with a white linkage bar and clips on top
    vane = mat("vane", (0.22, 0.23, 0.24), rough=0.45)
    sections = 4
    for sct in range(sections):
        sx0 = ox0 + 0.6 + sct * (ow - 1.2) / sections
        sx1 = sx0 + (ow - 1.2) / sections - 0.5
        for i in range(9):
            x = sx0 + i * (sx1 - sx0) / 8
            box((0.1, 2.4, 1.6), (x, front + 2.4, 1.3), vane, bevel=0.03, segments=1, rot=(0, 0, math.radians(8)))
        box((sx1 - sx0, 0.25, 0.18), ((sx0 + sx1) / 2, front + 0.75, 1.75), white(), bevel=0.05, segments=1)
        for x in (sx0 + 0.3, sx1 - 0.3):
            box((0.45, 0.6, 0.45), (x, front + 0.6, 1.85), white(), bevel=0.12, segments=2)
    # main louver hanging below the outlet, angled down
    louver = box((ow - 0.3, 3.0, 0.16), (oc, front + 1.35, -0.3), white(), bevel=0.07, segments=3, rot=(math.radians(-20), 0, 0))
    louver.name = "louver"
    for x in (ox0 + 0.3, ox1 - 0.3):
        box((0.25, 1.4, 0.3), (x, front + 2.3, 0.05), white(), bevel=0.08, rot=(math.radians(-20), 0, 0))

def cassette_4way():
    """4-way ceiling cassette seen from below: lattice return grille over a filter, four louvred outlets, corner covers."""
    P, T = 37.0, 1.4
    # chassis above the ceiling line, with hanger brackets and pipe stubs
    C = 33.0
    box((C, C, 9.5), (0, 0, T + 4.75), galvanized(), bevel=0.3)
    for sx in (-1, 1):
        for sy in (-1, 1):
            box((2.4, 0.25, 2.2), (sx * (C / 2 - 3.0), sy * (C / 2 + 0.12), T + 7.0), galvanized(), bevel=0.06)
            cyl(0.32, 0.4, (sx * (C / 2 - 3.0), sy * (C / 2 + 0.4), T + 7.4), dark(), rot=XROT, verts=16)
    for x, r in ((C / 2 - 4.0, 0.22), (C / 2 - 5.4, 0.33)):
        cyl(r, 2.5, (x, C / 2 + 1.2, T + 6.0), copper(), rot=XROT, verts=24)
    cyl(0.5, 2.0, (-C / 2 + 4.0, C / 2 + 1.0, T + 3.0), mat("drain", (0.85, 0.85, 0.85), rough=0.5), rot=XROT, verts=24)
    # panel with corner covers
    box((P, P, T), (0, 0, T / 2), white(), bevel=0.6, segments=5)
    for sx in (-1, 1):
        for sy in (-1, 1):
            box((5.2, 5.2, 0.3), (sx * (P / 2 - 3.0), sy * (P / 2 - 3.0), -0.08), white(), bevel=0.35, segments=4)
    # return grille: frame, dark filter behind, lattice in front
    G = 21.0
    box((G + 1.2, G + 1.2, 0.35), (0, 0, -0.05), white(), bevel=0.25)
    box((G - 0.6, G - 0.6, 0.2), (0, 0, -0.08), mat("filter", (0.25, 0.26, 0.27), rough=0.8), bevel=0.05, segments=1)
    for i in range(1, 22):
        t = -G / 2 + i * G / 22
        box((0.18, G - 0.4, 0.25), (t, 0, -0.3), white(), bevel=0.04, segments=1)
        box((G - 0.4, 0.18, 0.25), (0, t, -0.32), white(), bevel=0.04, segments=1)
    # outlets: build one along +Y (dark slot, two louvres tilted outward), then turn copies about Z
    s = (P + G) / 4 + 0.3
    for k in range(4):
        parts = [
            box((G + 3.0, 2.8, 0.5), (0, s, -0.1), dark(), bevel=0.25),
            box((G + 2.4, 1.1, 0.16), (0, s + 0.55, -0.45), white(), bevel=0.06, rot=(math.radians(-30), 0, 0)),
            box((G + 2.4, 1.1, 0.16), (0, s - 0.6, -0.42), white(), bevel=0.06, rot=(math.radians(-30), 0, 0)),
        ]
        turn = Matrix.Rotation(k * math.pi / 2, 4, "Z")
        for o in parts:
            o.matrix_world = turn @ o.matrix_world
    # occupancy sensor dome in one corner cover
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.9 * IN, location=Vector((P / 2 - 3.0, -(P / 2 - 3.0), -0.2)) * IN)
    _finish(bpy.context.object, mat("sensor", (0.08, 0.08, 0.09), rough=0.1, coat=0.8), 0, 0)


def outdoor(W, D, H, fans=1, R=10.4):
    """Side-discharge outdoor unit, any size: guarded fan(s) stacked on the left, service panel and handle,
    blank rating plate, pipe cover and valves, wire coil guard on the side, slotted feet."""
    body = warm_white()
    z0 = 1.4
    box((W, D, H - 0.2), (0, 0, z0 + (H - 0.2) / 2), body, bevel=0.5, segments=4)
    box((W, D, 0.8), (0, 0, z0 + H + 0.2), body, bevel=0.3, segments=3)  # top cover, flush with the sides
    px = W / 2 - 3.7  # service panel centre
    box((0.12, 0.1, H - 1.2), (px - 3.7, -D / 2 - 0.02, z0 + H / 2), dark(), bevel=0.02, segments=1)
    box((W - 1.0, 0.1, 0.12), (0, -D / 2 - 0.02, z0 + H - 0.9), dark(), bevel=0.02, segments=1)
    fx = -W / 2 + (px - 3.7 + W / 2) / 2  # fan column centred in the space left of the service panel
    blade = mat("blade", (0.18, 0.19, 0.2), rough=0.45)
    for f in range(fans):
        fz = z0 + H * (f + 0.5) / fans - (0.4 if fans == 1 else 0)
        cyl(R + 0.9, 0.7, (fx, -D / 2 - 0.1, fz), body, rot=XROT, bevel=0.35)
        cyl(R, 1.0, (fx, -D / 2 - 0.2, fz), dark(), rot=XROT)
        for i in range(3):
            a = i * 2 * math.pi / 3 + f * 0.6
            for j in range(5):  # stepped segments give a swept blade
                r = R * (0.21 + j * 0.149)
                ang = a + j * 0.13
                box((R * 0.16, 0.2, R * (0.365 - j * 0.034)), (fx + math.cos(ang) * r, -D / 2 + 0.5 + j * 0.12, fz + math.sin(ang) * r), blade, bevel=0.08, segments=2, rot=(math.radians(25), ang + math.pi / 2, 0))
        cyl(R * 0.17, 1.4, (fx, -D / 2 - 0.1, fz), blade, rot=XROT, bevel=0.3)
        for k in range(1, 9):
            torus(R * k / 8.6, 0.13, (fx, -D / 2 - 1.0, fz), body, rot=XROT)
        for i in range(8):
            box((2 * R * 0.98, 0.32, 0.28), (fx, -D / 2 - 1.0, fz), body, bevel=0.08, segments=1, rot=(0, i * math.pi / 8, 0))
        cyl(0.9, 0.5, (fx, -D / 2 - 1.1, fz), body, rot=XROT, bevel=0.15)
    # service panel, recessed handle, blank rating plate, screws
    box((6.8, 0.3, H - 3.0), (px, -D / 2 - 0.12, z0 + H / 2 - 0.4), body, bevel=0.15)
    box((3.4, 0.5, 1.0), (px, -D / 2 - 0.2, z0 + H - 4.8), dark(), bevel=0.4)
    box((4.2, 0.12, 2.6), (px, -D / 2 - 0.3, z0 + 7.0), mat("plate", (0.70, 0.71, 0.72), rough=0.35, metal=0.6), bevel=0.1)
    screws([(px - 3.0, z0 + 2.0), (px + 3.0, z0 + 2.0), (px - 3.0, z0 + H - 2.5), (px + 3.0, z0 + H - 2.5)], -D / 2 - 0.3, mid_grey())
    # pipe cover on the right side, with the service valves under it
    box((0.5, 5.5, 7.0), (W / 2 + 0.25, -0.5, z0 + 4.5), body, bevel=0.2)
    cyl(0.5, 1.4, (W / 2 + 1.0, -2.2, z0 + 2.2), brass(), rot=YROT, verts=6)
    cyl(0.7, 1.4, (W / 2 + 1.0, 1.0, z0 + 2.2), brass(), rot=YROT, verts=6)
    # coil guard on the left side: dark coil behind a wire grid
    box((0.25, D - 1.4, H - 2.4), (-W / 2 - 0.08, 0, z0 + H / 2), dark(), bevel=0.05, segments=1)
    wire = mat("wire", (0.75, 0.75, 0.72), rough=0.5)
    rows = max(8, int(H / 2))
    for i in range(rows):
        cyl(0.07, D - 1.6, (-W / 2 - 0.3, 0, z0 + 1.8 + i * (H - 3.6) / (rows - 1)), wire, rot=XROT, verts=8)
    for i in range(6):
        cyl(0.07, H - 3.0, (-W / 2 - 0.36, -D / 2 + 1.2 + i * (D - 2.4) / 5, z0 + H / 2), wire, verts=8)
    # mounting feet with slotted holes
    for x in (-W / 2 + 3.8, W / 2 - 3.8):
        box((3.2, D + 1.6, 1.3), (x, 0, 0.65), mid_grey(), bevel=0.15)
        for y in (-D / 2 - 0.3, D / 2 + 0.3):
            box((0.5, 1.0, 0.4), (x, y, 1.32), dark(), bevel=0.2)


def outdoor_single_fan():
    outdoor(31.5, 11.5, 28.0)


def outdoor_compact():
    """Small single-zone condenser (9-15k)."""
    outdoor(31.5, 11.0, 21.6, R=8.4)


def outdoor_dual_fan():
    """Tall two-fan cabinet: large multi-zone, Smart Multi 1-phase, big P-Series."""
    outdoor(41.3, 13.0, 52.0, fans=2, R=10.8)


def branch_box(ports):
    """Branch box: galvanized casing, flanges, screws, electrical box with knockouts, pipe pairs per port."""
    W, D, H = (17.75 if ports == 5 else 14.2), 11.0, 6.7
    g = galvanized()
    box((W, D, H), (0, 0, H / 2), g, bevel=0.25)
    box((W + 0.1, D + 0.1, 0.1), (0, 0, H - 0.5), mat("seam", (0.35, 0.36, 0.37), rough=0.5, metal=0.5), bevel=0.02, segments=1)
    for sx in (-1, 1):
        box((1.6, D - 2.0, 0.12), (sx * (W / 2 + 0.8), 0, 0.3), g, bevel=0.05)
        for y in (-D / 2 + 2.2, D / 2 - 2.2):
            cyl(0.28, 0.2, (sx * (W / 2 + 1.0), y, 0.3), dark(), verts=16)
    screws([(x, H - 0.25) for x in (-W / 2 + 0.8, -W / 4, 0, W / 4, W / 2 - 0.8)], -D / 2 - 0.02, mid_grey(), r=0.14)
    ex = W / 2 - 4.2
    box((6.5, D - 2.0, 0.6), (ex, 0, H + 0.3), g, bevel=0.12)
    for i in range(2):
        cyl(0.42, 0.12, (W / 2 - 0.02, -1.6 + i * 3.2, H - 1.4), mid_grey(), rot=YROT, verts=24)
    box((3.0, 0.1, 1.4), (-W / 2 + 3.6, -D / 2 - 0.02, H - 2.0), mat("label", (0.92, 0.92, 0.9), rough=0.6), bevel=0.05, segments=1)
    for i in range(ports):
        x = -W / 2 + 2.6 + i * (W - 5.2) / (ports - 1)
        for z, r in ((H * 0.30, 0.2), (H * 0.58, 0.3)):
            cyl(r + 0.25, 0.25, (x, -D / 2 - 0.12, z), g, rot=XROT, verts=24)
            cyl(r, 1.6, (x, -D / 2 - 0.8, z), copper(), rot=XROT, verts=24)
            cyl(r + 0.3, 0.7, (x, -D / 2 - 1.7, z), brass(), rot=XROT, verts=6, bevel=0.05)
    for x, r in ((-1.5, 0.26), (1.5, 0.38)):
        cyl(r, 1.8, (x, D / 2 + 0.9, H * 0.5), copper(), rot=XROT, verts=24)
        cyl(r + 0.3, 0.7, (x, D / 2 + 1.9, H * 0.5), brass(), rot=XROT, verts=6, bevel=0.05)


def branch_box_5():
    branch_box(5)


def branch_box_3():
    branch_box(3)


def hanger_brackets(W, D, z, material):
    for sx in (-1, 1):
        for sy in (-1, 1):
            box((2.2, 0.25, 2.0), (sx * (W / 2 - 2.5), sy * (D / 2 + 0.12), z), material, bevel=0.06)
            cyl(0.3, 0.4, (sx * (W / 2 - 2.5), sy * (D / 2 + 0.4), z + 0.3), dark(), rot=XROT, verts=16)


def pipe_stubs(x, y, z, axis_rot, step=(0, 1.6, 0)):
    """A liquid + gas copper pair with flare nuts, and a white condensate drain stub."""
    for i, r in enumerate((0.22, 0.32)):
        p = (x + step[0] * i, y + step[1] * i, z + step[2] * i)
        cyl(r, 2.4, p, copper(), rot=axis_rot, verts=24)
    cyl(0.5, 1.8, (x + step[0] * 2.6, y + step[1] * 2.6, z - 1.0), mat("drain", (0.88, 0.88, 0.86), rough=0.5), rot=axis_rot, verts=24)


def ducted():
    """Mid-static ducted unit (PEAD / SEZ): galvanized box, rear return with filter rail, front supply collar,
    electrical box and pipe stubs on the side, hanger brackets."""
    W, D, H = 35.4, 24.0, 9.9
    g = galvanized()
    box((W, D, H), (0, 0, H / 2), g, bevel=0.2)
    hanger_brackets(W, D, H - 1.6, g)
    # supply collar on the front, with flange
    box((W - 6.0, 0.4, H - 2.4), (0, -D / 2 - 0.2, H / 2), g, bevel=0.1)
    box((W - 8.0, 1.6, H - 3.6), (0, -D / 2 - 1.0, H / 2), dark(), bevel=0.1)
    for i in range(14):
        x = -(W - 9.0) / 2 + i * (W - 9.0) / 13
        box((0.12, 1.8, H - 3.8), (x, -D / 2 - 1.1, H / 2), mid_grey(), bevel=0.03, segments=1)
    # rear return: filter rail and opening
    box((W - 4.0, 0.6, H - 1.6), (0, D / 2 + 0.3, H / 2), g, bevel=0.1)
    box((W - 5.0, 0.4, H - 2.6), (0, D / 2 + 0.6, H / 2), mat("filter", (0.25, 0.26, 0.27), rough=0.8), bevel=0.05, segments=1)
    # electrical box + pipe stubs on the right side
    box((0.8, 7.0, 6.0), (W / 2 + 0.4, -D / 2 + 6.0, H / 2), g, bevel=0.1)
    box((0.1, 2.6, 1.4), (W / 2 + 0.85, -D / 2 + 6.0, H / 2 + 1.2), mat("label", (0.92, 0.92, 0.9), rough=0.6), bevel=0.04, segments=1)
    pipe_stubs(W / 2 + 1.2, 2.0, H / 2 + 0.6, YROT)
    screws([(x, H - 0.4) for x in (-W / 2 + 1.0, -W / 4, 0, W / 4, W / 2 - 1.0)], -D / 2 - 0.02, mid_grey(), r=0.14)


def air_handler():
    """Upright multi-position air handler (SVZ / PVA / PVFY): painted cabinet, two front access panels,
    top supply flange, side pipe connections."""
    W, D, H = 21.0, 21.75, 48.0
    paint = mat("ahu_paint", (0.78, 0.79, 0.79), rough=0.42, metal=0.15)
    box((W, D, H), (0, 0, H / 2), paint, bevel=0.3)
    # two access panels with seams and screws
    for z0, h in ((1.0, 21.0), (23.0, 23.5)):
        box((W - 1.2, 0.2, h), (0, -D / 2 - 0.08, z0 + h / 2), paint, bevel=0.12)
        screws([(x, z) for x in (-W / 2 + 1.2, W / 2 - 1.2) for z in (z0 + 1.2, z0 + h - 1.2)], -D / 2 - 0.2, mid_grey())
    box((4.2, 0.12, 2.6), (W / 2 - 4.0, -D / 2 - 0.22, 40.0), mat("plate", (0.70, 0.71, 0.72), rough=0.35, metal=0.6), bevel=0.1)
    # top supply flange
    box((W - 2.0, D - 2.0, 0.8), (0, 0, H + 0.4), paint, bevel=0.1)
    box((W - 4.0, D - 4.0, 0.4), (0, 0, H + 0.9), dark(), bevel=0.1)
    # pipe and drain connections on the left side
    pipe_stubs(-W / 2 - 1.2, -4.0, 18.0, YROT)
    box((0.3, 6.0, 4.0), (-W / 2 - 0.15, 5.0, 36.0), mat("ahu_dark", (0.3, 0.31, 0.32), rough=0.5), bevel=0.08)  # electrical knockout plate


def cased_coil():
    """Cased A-coil (PAA): painted cabinet with top and bottom duct flanges, front access panel, drains."""
    W, D, H = 21.0, 21.0, 22.0
    paint = mat("coil_paint", (0.80, 0.80, 0.79), rough=0.42, metal=0.1)
    box((W, D, H), (0, 0, H / 2 + 0.6), paint, bevel=0.25)
    for z in (0.3, H + 0.9):
        box((W + 0.6, D + 0.6, 0.6), (0, 0, z), paint, bevel=0.1)
    box((W - 2.0, 0.2, H - 4.0), (0, -D / 2 - 0.08, H / 2 + 0.6), paint, bevel=0.12)
    screws([(x, z) for x in (-W / 2 + 1.6, W / 2 - 1.6) for z in (3.0, H - 1.6)], -D / 2 - 0.2, mid_grey())
    box((4.2, 0.12, 2.0), (0, -D / 2 - 0.22, H - 3.0), mat("plate", (0.70, 0.71, 0.72), rough=0.35, metal=0.6), bevel=0.1)
    pipe_stubs(-W / 2 - 1.2, -3.0, 9.0, YROT)
    cyl(0.5, 1.8, (W / 2 + 0.9, -6.0, 3.0), mat("drain", (0.88, 0.88, 0.86), rough=0.5), rot=YROT, verts=24)


def floor_console():
    """Floor console (MFZ): white cabinet, flat front panel, top discharge louver, bottom intake slots, display."""
    W, D, H = 27.6, 8.5, 23.6
    box((W, D, H), (0, 0, H / 2), white(), bevel=0.8, segments=5)
    box((W - 1.2, 0.3, H - 7.0), (0, -D / 2 - 0.1, H / 2 + 0.8), white(), bevel=0.3, segments=4)
    # top discharge with louver
    box((W - 4.0, 3.2, 0.5), (0, -0.6, H + 0.02), dark(), bevel=0.2)
    box((W - 4.6, 2.4, 0.18), (0, -1.0, H + 0.35), white(), bevel=0.06, rot=(math.radians(-25), 0, 0))
    # bottom intake slots
    for i in range(24):
        x = -W / 2 + 2.2 + i * (W - 4.4) / 23
        box((0.25, 0.3, 2.6), (x, -D / 2 - 0.05, 2.4), dark(), bevel=0.05, segments=1)
    box((2.4, 0.12, 0.6), (W / 2 - 3.6, -D / 2 - 0.28, H - 4.0), mat("smoked", (0.05, 0.06, 0.07), rough=0.15, coat=0.6), bevel=0.15)
    cyl(0.12, 0.15, (W / 2 - 4.2, -D / 2 - 0.36, H - 4.0), mat("led", (0.2, 0.5, 1.0), emit=(0.25, 0.6, 1.0)), rot=XROT, verts=16)


def ceiling_suspended():
    """Ceiling-suspended unit (PCA), seen from below: wide slim body, rounded front edge, front discharge
    with a long louver, intake grille on the underside."""
    W, D, H = 50.0, 26.8, 9.1
    top = 0.0  # ceiling plane at z = 0, unit hangs below
    pts = [(D / 2, top), (D / 2, -H + 1.0)]
    pts += arc(D / 2 - 1.0, -H + 1.0, 1.0, 0, -90, 4)[1:]
    pts += [(-D / 2 + 3.0, -H)]
    pts += arc(-D / 2 + 3.0, -H + 3.0, 3.0, -90, -180, 8)[1:]
    pts += [(-D / 2, top)]
    profile(pts, W, white(), bevel=0.9, segments=5)
    # intake grille on the underside (rear half)
    box((W - 6.0, D / 2 - 1.5, 0.15), (0, D / 4 - 0.5, -H - 0.02), mat("filter", (0.25, 0.26, 0.27), rough=0.8), bevel=0.05, segments=1)
    for i in range(30):
        x = -(W - 7.0) / 2 + i * (W - 7.0) / 29
        box((0.25, D / 2 - 2.2, 0.3), (x, D / 4 - 0.5, -H - 0.15), white(), bevel=0.05, segments=1)
    # front discharge and louver
    box((W - 6.0, 0.6, 2.6), (0, -D / 2 - 0.05, -H + 3.2), dark(), bevel=0.2)
    box((W - 6.6, 3.0, 0.2), (0, -D / 2 - 0.6, -H + 2.0), white(), bevel=0.07, rot=(math.radians(30), 0, 0))


def cassette_1way():
    """1-way ceiling cassette (MLZ), seen from below: slim rectangular panel, linear discharge with louver,
    intake grille, body hidden above the ceiling."""
    W, D, T = 42.5, 15.7, 1.2
    box((W - 2.0, D - 2.0, 7.0), (0, 0, T + 3.5), galvanized(), bevel=0.25)
    box((W, D, T), (0, 0, T / 2), white(), bevel=0.5, segments=4)
    # intake grille (back half)
    box((W - 4.0, D / 2 - 1.5, 0.2), (0, D / 4 - 0.3, -0.02), mat("filter", (0.25, 0.26, 0.27), rough=0.8), bevel=0.05, segments=1)
    for i in range(36):
        x = -(W - 5.0) / 2 + i * (W - 5.0) / 35
        box((0.2, D / 2 - 2.0, 0.25), (x, D / 4 - 0.3, -0.2), white(), bevel=0.04, segments=1)
    # discharge slot (front) with louver
    box((W - 5.0, 2.6, 0.5), (0, -D / 4 + 0.2, -0.1), dark(), bevel=0.2)
    box((W - 5.6, 2.0, 0.16), (0, -D / 4, -0.5), white(), bevel=0.06, rot=(math.radians(-28), 0, 0))
    hanger_brackets(W - 2.0, D - 2.0, T + 5.0, galvanized())


# name: (builder, (camera elevation deg, camera azimuth deg, floor shadow))
# Wall and ceiling units are seen from below, the way you see them installed.
UNITS = {
    "wall-premium": (wall_premium, (-9, -34, False)),
    "cassette-4way": (cassette_4way, (-30, 32, False)),
    "cassette-1way": (cassette_1way, (-30, 32, False)),
    "ceiling-suspended": (ceiling_suspended, (-18, 32, False)),
    "ducted": (ducted, (24, 32, False)),
    "air-handler": (air_handler, (18, 32, True)),
    "cased-coil": (cased_coil, (20, 32, True)),
    "floor-console": (floor_console, (16, 32, True)),
    "outdoor-1fan": (outdoor_single_fan, (24, 32, True)),
    "outdoor-compact": (outdoor_compact, (24, 32, True)),
    "outdoor-2fan": (outdoor_dual_fan, (20, 32, True)),
    "branch-box-5": (branch_box_5, (24, 32, True)),
    "branch-box-3": (branch_box_3, (24, 32, True)),
}

# ---------------------------------------------------------------- staging


def unit_objects():
    return [o for o in bpy.context.scene.objects if o.type == "MESH" and not o.get("stage")]


def stage(view, size):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 96
    scene.cycles.use_denoising = True
    scene.render.film_transparent = True
    scene.render.resolution_x = scene.render.resolution_y = size
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = 0.55

    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.9, 0.92, 0.95, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.35
    scene.world = world

    objs = unit_objects()
    pts = [o.matrix_world @ v.co for o in objs for v in o.data.vertices]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    centre = (lo + hi) / 2
    radius = (hi - lo).length / 2

    # Same three-quarter view for every unit: from the front-right, above (or below for ceiling units).
    elev_deg, az_deg, floor_shadow = view
    elev, az = math.radians(elev_deg), math.radians(az_deg)
    direction = Vector((math.sin(az) * math.cos(elev), -math.cos(az) * math.cos(elev), math.sin(elev)))
    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = "ORTHO"
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    cam.location = centre + direction * radius * 6
    cam.rotation_euler = (-direction).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam

    # Fit the ortho frame to the projected bounds.
    bpy.context.view_layer.update()
    inv = cam.matrix_world.inverted()
    proj = [inv @ p for p in pts]
    xs, ys = [p.x for p in proj], [p.y for p in proj]
    cam_data.ortho_scale = max(max(xs) - min(xs), max(ys) - min(ys)) * 1.12
    cam_data.shift_x = (max(xs) + min(xs)) / 2 / cam_data.ortho_scale
    cam_data.shift_y = (max(ys) + min(ys)) / 2 / cam_data.ortho_scale

    def light(name, power, loc, size_m, color=(1, 1, 1)):
        # power is irradiance-ish: scale by distance squared so every unit is lit the same.
        d = bpy.data.lights.new(name, "AREA")
        dist = Vector(loc).length * radius
        d.energy, d.size, d.color = power * dist * dist, size_m, color
        o = bpy.data.objects.new(name, d)
        o.location = centre + Vector(loc) * radius
        o.rotation_euler = (centre - o.location).to_track_quat("-Z", "Y").to_euler()
        scene.collection.objects.link(o)

    s = 1 if elev_deg >= -15 else -1  # room light comes from above unless we're looking straight up at a ceiling unit
    side = 1 if az_deg >= 0 else -1
    light("key", 9.0, (-2.5 * side, -3.0, 4.0 * s), radius * 2.5)
    light("fill", 2.6, (3.5 * side, -2.0, 1.2 * s), radius * 3.0, (0.92, 0.96, 1.0))
    light("rim", 4.5, (1.5 * side, 4.0, 3.0 * s), radius * 2.0)
    # soft front light from just above the camera, like room light falling on the face of the unit
    light("front", 4.0, (direction.x * 4.0, direction.y * 4.0, 1.5 * s), radius * 4.0)

    if floor_shadow:
        bpy.ops.mesh.primitive_plane_add(size=radius * 12, location=(centre.x, centre.y, lo.z))
        floor = bpy.context.object
        floor["stage"] = True
        floor.is_shadow_catcher = True


def export(name, out_dir):
    bpy.ops.object.select_all(action="DESELECT")
    for o in unit_objects():
        o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=os.path.join(out_dir, f"{name}.glb"), use_selection=True, export_apply=True)


def build(name, out_dir, size):
    reset()
    _mats.clear()
    fn, view = UNITS[name]
    fn()
    export(name, out_dir)
    stage(view, size)
    bpy.context.scene.render.filepath = os.path.join(out_dir, f"{name}.png")
    bpy.ops.render.render(write_still=True)


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    which = argv[0] if argv else "all"
    out_dir = os.path.abspath(argv[1] if len(argv) > 1 else "renders")
    size = int(argv[2]) if len(argv) > 2 else 512
    os.makedirs(out_dir, exist_ok=True)
    for name in UNITS if which == "all" else [which]:
        build(name, out_dir, size)
        print(f"rendered {name}")


main()
