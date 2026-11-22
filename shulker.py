"""Shulker, a Windows terminal storage explorer."""

import argparse
import ctypes
import json
import os
import stat
import subprocess
import sys
import uuid
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class Rule:
    level: str
    name: str
    evidence: str
    effect: str


@dataclass
class Folder:
    path: Path
    parent: "Folder | None"
    children: list = field(default_factory=list)
    files: set = field(default_factory=set)
    bytes: int = 0
    skipped: int = 0
    identity: tuple = ()
    rule: Rule | None = None


def linked(info):
    return bool(info.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def protected(path):
    for variable in ("SystemRoot", "ProgramFiles", "ProgramFiles(x86)",
                     "ProgramData", "APPDATA", "LOCALAPPDATA"):
        value = os.environ.get(variable)
        if value and path.is_relative_to(Path(value)):
            return True
    return any(part.casefold() in {"$recycle.bin", "system volume information"}
               for part in path.parts)


def classify(folder):
    if folder.parent is None or folder.skipped or protected(folder.path):
        return None
    name = folder.path.name.casefold()
    markers = folder.parent.files
    if "pyvenv.cfg" in folder.files:
        return Rule("Review", "Python environment", "Contains pyvenv.cfg.",
                    "Installed packages and local changes may need manual recovery.")
    if name == "node_modules" and "package.json" in markers:
        return Rule("Rebuildable", "Node dependencies", "Beside package.json.",
                    "Reinstall dependencies with the project's package manager.")
    if name == "target" and "cargo.toml" in markers and (
            {"cachedir.tag", ".rustc_info.json"} & folder.files):
        return Rule("Rebuildable", "Cargo build output",
                    "Beside Cargo.toml and contains a Cargo build marker.",
                    "Cargo regenerates build output on the next build.")
    if name == "__pycache__" and folder.files and not folder.children:
        if all(file.endswith(".pyc") for file in folder.files):
            return Rule("Rebuildable", "Python bytecode", "Contains only .pyc files.",
                        "Python can regenerate bytecode from the source.")
    return None


def scan(path):
    root = Folder(path, None)
    pending = [root]
    folders = []
    while pending:
        folder = pending.pop()
        folders.append(folder)
        try:
            info = folder.path.lstat()
            if linked(info) or not stat.S_ISDIR(info.st_mode):
                folder.skipped += 1
                continue
            folder.identity = (info.st_dev, info.st_ino)
            with os.scandir(folder.path) as entries:
                for entry in entries:
                    try:
                        info = entry.stat(follow_symlinks=False)
                        if linked(info):
                            folder.skipped += 1
                        elif stat.S_ISDIR(info.st_mode):
                            child = Folder(Path(entry.path), folder)
                            folder.children.append(child)
                            pending.append(child)
                        elif stat.S_ISREG(info.st_mode):
                            folder.files.add(entry.name.casefold())
                            folder.bytes += info.st_size
                    except OSError:
                        folder.skipped += 1
        except OSError:
            folder.skipped += 1
    for folder in reversed(folders):
        folder.children.sort(key=lambda child: (-child.bytes, str(child.path).casefold()))
        if folder.parent:
            folder.parent.bytes += folder.bytes
            folder.parent.skipped += folder.skipped
        folder.rule = classify(folder)
    # Prefer the outer candidate when its contents match additional rules.
    candidates = []
    pending = list(root.children)
    while pending:
        folder = pending.pop()
        if folder.rule:
            candidates.append(folder)
        else:
            pending.extend(folder.children)
    candidates.sort(key=lambda folder: (-folder.bytes, str(folder.path).casefold()))
    return root, candidates


def recycle_path(path):
    """Ask Windows Shell to recycle a single item."""
    ole = ctypes.OleDLL("ole32")
    shell = ctypes.OleDLL("shell32")
    pointer = ctypes.c_void_p
    result = ctypes.c_long

    def guid(value):
        return ctypes.create_string_buffer(uuid.UUID(value).bytes_le)

    def method(obj, index, return_type, *types):
        table = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(pointer)))[0]
        return ctypes.WINFUNCTYPE(return_type, pointer, *types)(table[index])

    def check(code):
        if code < 0:
            raise OSError(f"Windows Shell error 0x{code & 0xffffffff:08X}")

    ole.CoInitializeEx.argtypes = (pointer, ctypes.c_uint)
    ole.CoCreateInstance.argtypes = (pointer, pointer, ctypes.c_uint, pointer,
                                    ctypes.POINTER(pointer))
    shell.SHCreateItemFromParsingName.argtypes = (ctypes.c_wchar_p, pointer, pointer,
                                                 ctypes.POINTER(pointer))
    operation, item = pointer(), pointer()
    ole.CoInitializeEx(None, 2)
    try:
        ole.CoCreateInstance(guid("3ad05575-8857-4850-9277-11b85bdb8e09"), None, 1,
                             guid("947aab5f-0a5c-4c13-b4d6-4bf7836fc9f8"),
                             ctypes.byref(operation))
        shell.SHCreateItemFromParsingName(str(path), None,
                                          guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"),
                                          ctypes.byref(item))
        recycle_on_delete = 0x00080000
        warn_on_permanent_delete = 0x4000
        add_undo_record = 0x20000000
        check(method(operation, 5, result, ctypes.c_uint)(
            operation, recycle_on_delete | warn_on_permanent_delete | add_undo_record))
        check(method(operation, 18, result, pointer, pointer)(operation, item, None))
        check(method(operation, 21, result)(operation))
        aborted = ctypes.c_int()
        check(method(operation, 22, result, ctypes.POINTER(ctypes.c_int))(
            operation, ctypes.byref(aborted)))
        return not aborted.value and not os.path.lexists(path)
    finally:
        for obj in (item, operation):
            if obj:
                method(obj, 2, ctypes.c_ulong)(obj)
        ole.CoUninitialize()


def verify_candidate(folder):
    for path in (folder.path, *folder.path.parents):
        info = path.lstat()
        if linked(info) or not stat.S_ISDIR(info.st_mode):
            raise OSError("The path contains a link or has changed.")
    latest, _ = scan(folder.path)
    parent = Folder(folder.path.parent, None)
    with os.scandir(parent.path) as entries:
        for entry in entries:
            if entry.name.casefold() in {"cargo.toml", "package.json"}:
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISREG(info.st_mode) and not linked(info):
                    parent.files.add(entry.name.casefold())
    latest.parent = parent
    if (latest.identity != folder.identity or latest.bytes != folder.bytes
            or classify(latest) != folder.rule):
        raise OSError("The candidate changed. Rescan and review it again.")


def size(value):
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if value < 1024 or unit == "TiB":
            return f"{value:.1f} {unit}" if unit != "B" else f"{value} B"
        value /= 1024


def terminal_text(value, width):
    return "".join(char if char.isprintable() else "?" for char in str(value))[:width]


def tui(path):
    import msvcrt
    import shutil

    mode = ctypes.c_uint()
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetStdHandle.restype = ctypes.c_void_p
    kernel.GetConsoleMode.argtypes = (ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint))
    kernel.SetConsoleMode.argtypes = (ctypes.c_void_p, ctypes.c_uint)
    output = kernel.GetStdHandle(-11)
    if not kernel.GetConsoleMode(output, ctypes.byref(mode)):
        raise OSError("Open a Windows terminal or use --report.")
    if not kernel.SetConsoleMode(output, mode.value | 4):
        raise OSError("Could not enable terminal rendering. Use --report.")

    def write(value):
        print(value, end="", flush=True)

    def key():
        char = msvcrt.getwch()
        if char in ("\x00", "\xe0"):
            return {"H": "up", "P": "down"}.get(msvcrt.getwch(), "")
        return char.lower()

    def refresh():
        write("\x1b[H\x1b[2JScanning " + terminal_text(path, 120) + " …")
        return scan(path)

    write("\x1b[?1049h\x1b[?25l")
    try:
        root, candidates = refresh()
        current, view, selected, status = root, "cleanup", 0, ""
        while True:
            columns, height = shutil.get_terminal_size((80, 24))
            width = max(1, columns - 1)
            rows = candidates if view == "cleanup" else current.children
            selected = max(0, min(selected, len(rows) - 1))
            chosen = rows[selected] if rows else None
            scope = root if view == "cleanup" else current
            available = max(1, min(16, height - 12))
            start = max(0, selected - available + 1)
            mapped = candidates if view == "cleanup" else scope.children
            mapped_bytes = sum(item.bytes for item in mapped)
            denominator = scope.bytes or 1
            dots = max(1, min(width, 56))
            filled = min(dots, round(dots * mapped_bytes / denominator))
            map_label = "candidates" if view == "cleanup" else "in subfolders"
            cyan, muted, reset = "\x1b[96m", "\x1b[90m", "\x1b[0m"
            lines = [
                cyan + terminal_text("SHULKER  /  " + view.upper(), width) + reset,
                terminal_text(scope.path, width),
                cyan + "●" * filled + muted + "·" * (dots - filled) + reset,
                terminal_text(f"{size(scope.bytes)} scanned   {size(mapped_bytes)} {map_label}"
                              f"   {scope.skipped} skipped", width),
                "",
            ]
            for index, folder in enumerate(rows[start:start + available], start):
                label = (folder.rule.level + "  " if view == "cleanup" else "")
                location = folder.path.relative_to(scope.path)
                line = terminal_text(f"{size(folder.bytes):>10}  {label}{location}", width - 2)
                lines.append((cyan + "› " + line + reset) if index == selected else "  " + line)
            if not rows:
                lines.append(terminal_text("No cleanup candidates." if view == "cleanup"
                                           else "No scanned subfolders.", width))
            lines.append("")
            if chosen and chosen.rule:
                rule = chosen.rule
                lines.extend(terminal_text(line, width) for line in (
                    f"{rule.name} — {rule.evidence}", rule.effect,
                    "Logical file size. Recycling keeps the data on disk."))
            elif chosen:
                lines.append(terminal_text(chosen.path, width))
            lines.append(terminal_text(status, width))
            lines.append(terminal_text("↑↓ Move  Enter Drill down  B Back  Tab Switch view", width))
            lines.append(terminal_text("L Largest  O Explorer  X Recycle  R Scan  Q Quit", width))
            write("\x1b[H\x1b[2J" + "\n".join(lines[:height]))
            action = key()
            status = ""
            if action in ("q", "\x1b", "\x03"):
                return
            if action in ("up", "k"):
                selected -= 1
            elif action in ("down", "j"):
                selected += 1
            elif action == "\t":
                view = "folders" if view == "cleanup" else "cleanup"
                selected = 0
            elif action == "l":
                view, current, selected = "folders", root, 0
            elif action in ("b", "\b") and view == "folders" and current.parent:
                current, selected = current.parent, 0
            elif action == "\r" and chosen:
                view, current, selected = "folders", chosen, 0
            elif action == "o":
                try:
                    subprocess.Popen(["explorer.exe", str(chosen.path if chosen else current.path)])
                except OSError as error:
                    status = str(error)
            elif action == "r":
                root, candidates = refresh()
                current, selected = root, 0
            elif action == "x" and chosen and view == "cleanup":
                message = (f"Recycle {chosen.path}?\n"
                           "Cancel if Windows offers permanent deletion.\n"
                           "Press Y to confirm, any other key to cancel.")
                write("\x1b[H\x1b[2J" + "\n".join(
                    terminal_text(line, 4096) for line in message.splitlines()))
                if key() != "y":
                    status = "Cancelled."
                    continue
                try:
                    verify_candidate(chosen)
                    recycled = recycle_path(chosen.path)
                    root, candidates = refresh()
                    current, selected = root, 0
                    status = ("Windows completed the operation. Check the Recycle Bin."
                              if recycled else "Windows did not complete the operation.")
                except OSError as error:
                    status = str(error)
    finally:
        write("\x1b[0m\x1b[?25h\x1b[?1049l")
        kernel.SetConsoleMode(output, mode.value)


def main():
    parser = argparse.ArgumentParser(description="Shulker explores storage and finds cleanup candidates.")
    parser.add_argument("folder", nargs="?", type=Path, default=Path.home())
    parser.add_argument("--report", action="store_true", help="Write a read-only JSON report.")
    args = parser.parse_args()
    try:
        path = Path(os.path.abspath(args.folder))
        if os.name != "nt":
            parser.error("This app requires Windows.")
        for part in (path, *path.parents):
            info = part.lstat()
            if linked(info) or not stat.S_ISDIR(info.st_mode):
                parser.error("Choose a directory whose path contains no junctions or links.")
        if args.report:
            root, candidates = scan(path)
            print(json.dumps({
                "root": str(path),
                "logical_bytes": root.bytes,
                "skipped": root.skipped,
                "largest_folders": [
                    {"path": str(folder.path), "logical_bytes": folder.bytes}
                    for folder in root.children[:10]
                ],
                "candidates": [
                    {"path": str(folder.path), "logical_bytes": folder.bytes,
                     "level": folder.rule.level, "evidence": folder.rule.evidence,
                     "effect": folder.rule.effect}
                    for folder in candidates
                ],
            }, indent=2))
        else:
            tui(path)
    except OSError as error:
        parser.exit(1, f"Shulker: {error}\n")


if __name__ == "__main__":
    main()
