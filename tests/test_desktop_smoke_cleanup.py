"""Regressions for the Windows CI WebView2 profile-release race."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location(
    "desktop_smoke", Path(__file__).resolve().parents[1] / "packaging" / "smoke_test_desktop_instance.py")
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class DesktopSmokeCleanupTests(unittest.TestCase):
    def test_profile_lock_is_retried_then_cleanup_completes(self):
        directory = Mock()
        directory.cleanup.side_effect = [PermissionError("WebView2 lock"), PermissionError("WebView2 lock"), None]
        with patch.object(smoke.time, "sleep") as sleep:
            smoke.cleanup_workspace(directory)
        self.assertEqual(directory.cleanup.call_count, 3)
        self.assertEqual(sleep.call_count, 2)
        sleep.assert_called_with(0.25)

    def test_persistent_lock_still_fails_after_bounded_wait(self):
        directory = Mock()
        directory.cleanup.side_effect = PermissionError("still locked")
        with patch.object(smoke.time, "sleep") as sleep:
            with self.assertRaisesRegex(PermissionError, "still locked"):
                smoke.cleanup_workspace(directory)
        self.assertEqual(directory.cleanup.call_count, 60)
        self.assertEqual(sleep.call_count, 59)

    def test_unrelated_cleanup_error_is_not_retried(self):
        directory = Mock()
        directory.cleanup.side_effect = OSError("disk error")
        with patch.object(smoke.time, "sleep") as sleep:
            with self.assertRaisesRegex(OSError, "disk error"):
                smoke.cleanup_workspace(directory)
        sleep.assert_not_called()

    def test_real_smoke_assertion_is_not_masked_by_cleanup(self):
        directory = Mock(name="isolated_directory")
        directory.name = "isolated-profile"
        original = RuntimeError("agent remained running")
        with patch.object(smoke.tempfile, "TemporaryDirectory", return_value=directory), \
             patch.object(smoke, "cleanup_workspace", side_effect=PermissionError("profile locked")):
            with self.assertRaises(RuntimeError) as caught:
                with smoke.smoke_workspace():
                    raise original
        self.assertIs(caught.exception, original)
        self.assertIn("profile locked", original.__notes__[0])

    def test_success_requires_profile_cleanup(self):
        directory = Mock()
        directory.name = "isolated-profile"
        with patch.object(smoke.tempfile, "TemporaryDirectory", return_value=directory), \
             patch.object(smoke, "cleanup_workspace", side_effect=PermissionError("profile locked")):
            with self.assertRaises(PermissionError):
                with smoke.smoke_workspace() as path:
                    self.assertEqual(path, "isolated-profile")


if __name__ == "__main__":
    unittest.main()
