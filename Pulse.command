#!/bin/bash
#
# Pulse — launch the game client.
#
# Double-click this. It runs the ClassicUO binary directly and skips the
# bundled `ClassicUO` wrapper script, which on every single launch does a
# Homebrew version check and then walks every dylib with install_name_tool and
# otool. All of that was one-time setup; your files were patched months ago and
# there is nothing left for it to do. On macOS 27 any of it can stall or fail
# quietly, and then the icon bounces and nothing happens.
#
# Put this anywhere — Desktop, Dock, wherever. It finds the client by absolute
# path, so it does not care where it is launched from.

CLIENT="$HOME/Code/ClassicUO"
BIN="$CLIENT/ClassicUO.bin.osx"

if [ ! -x "$BIN" ]; then
    echo "Can't find the client at:"
    echo "    $BIN"
    echo
    echo "If you've moved ~/Code/ClassicUO, edit the CLIENT line in this file."
    echo
    read -r -p "Press return to close."
    exit 1
fi

cd "$CLIENT" || exit 1

# Logged rather than thrown away, so that when something does go wrong there is
# something to read. Overwritten each launch; it is a last-run log, not history.
exec ./ClassicUO.bin.osx "$@" > /tmp/pulse-client.log 2>&1
