"""Finder drag-to-install layout, written directly to the image's .DS_Store."""
from pathlib import Path

app = Path(defines["app"])
files = [str(app)]
symlinks = {"Applications": "/Applications"}
# SetFile's extension-hiding flag would attach FinderInfo to the signed app.
# Leave the app's metadata intact so strict codesign verification still passes.
hide_extensions = []
icon = str(app / "Contents/Resources/icon.icns")
background = defines["background"]  # dmgbuild includes background@2x.png as well.
format = "UDZO"
filesystem = "HFS+"
# Finder includes its 32 pt title bar in the stored window bounds.
window_rect = ((200, 160), (660, 452))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
include_icon_view_settings = True
include_list_view_settings = False
arrange_by = None
grid_spacing = 70
scroll_position = (0, 0)
label_pos = "bottom"
text_size = 13
icon_size = 96
icon_locations = {
    app.name: (170, 200),
    "Applications": (490, 200),
    # Keep supporting files outside the installation area even when a user's
    # Finder is configured to show hidden files. Do not change that preference.
    ".background.tiff": (170, 600),
    ".VolumeIcon.icns": (490, 600),
    ".fseventsd": (170, 760),
}
