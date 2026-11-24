"""Windows CI-only smoke test: launching Malenia twice activates one desktop instance."""
from __future__ import annotations

import ctypes
from contextlib import contextmanager
from ctypes import wintypes
import os
import json
from urllib.request import urlopen
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def visible_window(process_id: int, close: bool = False) -> bool:
    user32 = ctypes.WinDLL('user32', use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.GetWindowThreadProcessId.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.DWORD))
    user32.IsWindowVisible.argtypes = (wintypes.HWND,)
    user32.PostMessageW.argtypes = (wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)
    user32.PostMessageW.restype = wintypes.BOOL
    user32.GetWindowTextW.argtypes = (wintypes.HWND, wintypes.LPWSTR, ctypes.c_int)
    user32.EnumWindows.argtypes = (callback_type, wintypes.LPARAM)
    found = False

    @callback_type
    def visit(window, _):
        nonlocal found
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(window, ctypes.byref(owner))
        if owner.value == process_id and user32.IsWindowVisible(window):
            title = ctypes.create_unicode_buffer(256)
            user32.GetWindowTextW(window, title, 256)
            if 'Malenia' in title.value:
                found = True
                if close:
                    user32.PostMessageW(window, 0x0010, 0, 0)
        return True

    user32.EnumWindows(visit, 0)
    return found


def stop_owned(process: subprocess.Popen) -> None:
    if process.poll() is None:
        visible_window(process.pid, close=True)
    if process.poll() is None:
        process.kill()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def cleanup_workspace(directory: tempfile.TemporaryDirectory, attempts: int = 60) -> None:
    """Wait at most 15s for WebView2 to release its profile after window close.

    Use TemporaryDirectory's normal cleanup (including read-only handling). Never
    suppress a persistent lock or delete any other browser profile/process.
    """
    for attempt in range(attempts):
        try:
            directory.cleanup()
            return
        except PermissionError:
            if attempt == attempts - 1:
                raise
            time.sleep(0.25)


@contextmanager
def smoke_workspace():
    directory = tempfile.TemporaryDirectory(prefix='malenia-desktop-smoke-')
    try:
        yield directory.name
    except BaseException as primary:
        try:
            cleanup_workspace(directory)
        except OSError as cleanup_error:
            # Keep a real lifecycle failure visible instead of masking it with
            # a secondary profile-cleanup exception during stack unwinding.
            primary.add_note(f'Temporary profile cleanup also failed: {cleanup_error}')
        raise
    else:
        cleanup_workspace(directory)


def main() -> int:
    if sys.platform != 'win32' or os.environ.get('GITHUB_ACTIONS') != 'true':
        raise RuntimeError('Desktop instance smoke test runs only on an isolated Windows CI runner')
    executable = Path(sys.argv[1]).resolve()
    if not executable.is_file():
        raise RuntimeError('Malenia desktop executable is missing')
    with smoke_workspace() as temporary:
        environment = os.environ.copy()
        environment['LOCALAPPDATA'] = temporary
        environment['APPDATA'] = temporary
        environment['WEBVIEW2_USER_DATA_FOLDER'] = str(Path(temporary) / 'webview-test')
        first = subprocess.Popen([str(executable)], env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        second = None
        try:
            for _ in range(150):
                if first.poll() is not None:
                    raise RuntimeError('Malenia desktop exited before opening its window')
                if visible_window(first.pid):
                    break
                time.sleep(0.1)
            else:
                raise RuntimeError('Malenia window did not appear')
            second = subprocess.Popen([str(executable)], env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if second.wait(timeout=15) != 0:
                raise RuntimeError('Second desktop launch did not exit successfully')
            if first.poll() is not None or not visible_window(first.pid):
                raise RuntimeError('Original Malenia window was not retained')
            for _ in range(150):
                try:
                    with urlopen('http://127.0.0.1:8765/health', timeout=1) as response:
                        health = json.load(response)
                    if health.get('service') == 'malenia-agent':
                        break
                except OSError:
                    pass
                time.sleep(0.1)
            else:
                raise RuntimeError('Desktop did not automatically start its bundled agent')
            # Closing the window keeps Malenia in the tray; "--quit" really exits.
            visible_window(first.pid, close=True)
            time.sleep(2)
            if first.poll() is not None:
                raise RuntimeError('Closing the window must keep Malenia running in the tray')
            if visible_window(first.pid):
                raise RuntimeError('Closed window is still visible')
            quitter = subprocess.Popen([str(executable), '--quit'], env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            quitter.wait(timeout=15)
            first.wait(timeout=15)
            for _ in range(50):
                try:
                    urlopen('http://127.0.0.1:8765/health', timeout=1).close()
                except OSError:
                    break
                time.sleep(0.1)
            else:
                raise RuntimeError('Agent remained running after closing the desktop window')
        finally:
            if second is not None:
                stop_owned(second)
            stop_owned(first)
    print('PASS: single desktop instance, automatic agent start, close-to-tray, and agent stops on --quit.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
