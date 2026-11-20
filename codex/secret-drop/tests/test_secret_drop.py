"""Safe fixture tests. Never use real credentials or GitHub network."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

guard = load("secret_drop_guard", ROOT / "hooks" / "prompt_guard.py")
helper = load("secret_drop_helper", ROOT / "bin" / "secret_drop.py")
server = load("secret_drop_mcp", ROOT / "server" / "mcp_server.py")


class GuardTests(unittest.TestCase):
    def test_recognizes_fake_formats(self):
        self.assertTrue(guard.contains_secret("key sk-proj-" + "x" * 40))
        self.assertTrue(guard.contains_secret("token: Zq81kLm02XpR7tYv9wQe"))
        self.assertTrue(guard.contains_secret("1234567890:AA" + "y" * 33))
        self.assertTrue(guard.contains_secret("-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----"))

    def test_ordinary_metadata_is_not_secret(self):
        for prompt in (
            "Use env var OPENAI_API_KEY without printing it",
            "key commit " + "3f2a9c1e5b7d4f6a8c0e2b4d6f8a1c3e5b7d9f0a",
            "voice uuAEb8aX4QXTwh8CAexT, key is in .env",
            "Search https://example.com/docs/api/key",
        ):
            self.assertFalse(guard.contains_secret(prompt))

    def test_hook_block_does_not_echo_secret(self):
        fake = "sk-ant-" + "a" * 35
        p = subprocess.run(
            [sys.executable, "-I", str(ROOT / "hooks" / "prompt_guard.py")],
            input=json.dumps({"prompt": "here: " + fake}),
            text=True, capture_output=True, check=True,
        )
        output = json.loads(p.stdout)
        self.assertEqual(output["decision"], "block")
        self.assertNotIn(fake, p.stdout + p.stderr)


class SecurityRegressionTests(unittest.TestCase):
    """Synthetic regression cases for trusted local writer boundaries."""

    def test_hardlinked_env_is_rejected_before_any_path_read(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td, "project")
            root.mkdir(mode=0o700)
            source = Path(td, "unrelated.env")
            source.write_text("UNRELATED=do-not-import\n")
            os.link(source, root / ".env")
            with mock.patch.object(Path, "read_text", side_effect=AssertionError("unsafe read")):
                with self.assertRaises(ValueError):
                    helper.write_env_batch(root, {"TEST_SECRET": "SyntheticOnly123"})
            self.assertEqual(source.read_text(), "UNRELATED=do-not-import\n")

    def test_group_writable_project_and_nested_parent_are_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td, "project")
            root.mkdir(mode=0o700)
            root.chmod(0o720)
            with self.assertRaises(ValueError):
                helper.write_env_batch(root, {"TEST_SECRET": "SyntheticOnly123"})
            root.chmod(0o700)
            nested = root / "config"
            nested.mkdir(mode=0o700)
            nested.chmod(0o720)
            with self.assertRaises(ValueError):
                helper.write_env_batch(
                    root, {"TEST_SECRET": "SyntheticOnly123"}, "config/.env.local"
                )

    def test_nested_env_uses_exact_ignore_rule_and_refuses_tracked_target(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            (root / "config").mkdir()
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            helper.write_env_batch(root, {"TEST_SECRET": "SyntheticOnly123"}, "config/.env.local")
            self.assertEqual((root / ".gitignore").read_text(), "/config/.env.local\n")
            ignored = subprocess.run(
                ["git", "check-ignore", "-q", "--", "config/.env.local"], cwd=root, check=False
            )
            self.assertEqual(ignored.returncode, 0)
            subprocess.run(["git", "add", "-f", "config/.env.local"], cwd=root, check=True)
            with self.assertRaises(ValueError):
                helper.write_env_batch(root, {"SECOND": "SyntheticOnly456"}, "config/.env.local")

    def test_github_environment_is_argv_and_value_stays_on_stdin(self):
        value = "SyntheticOnly123"
        proc = subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")
        with mock.patch.object(helper.subprocess, "run", return_value=proc) as ran:
            self.assertTrue(helper.write_github("TEST_SECRET", "example/demo", "staging", value))
        argv = ran.call_args.args[0]
        self.assertEqual(argv, ["gh", "secret", "set", "TEST_SECRET", "--repo", "example/demo", "--env", "staging"])
        self.assertEqual(ran.call_args.kwargs["input"], value)
        self.assertNotIn(value, argv)

    def test_env_file_rejects_git_globs_controls_metadata_and_non_dotenv_names(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            (root / "config").mkdir()
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            for env_file in (
                "config/.env[prod]", "config/.env*", "config/.env?",
                "config/.env\u202eprod", "config/.env\nprod", ".git/.env", "config/settings.env",
            ):
                with self.assertRaises(ValueError, msg=env_file):
                    helper.write_env_batch(root, {"TEST_SECRET": "SyntheticOnly123"}, env_file)
            self.assertFalse((root / ".gitignore").exists())

    def test_git_uses_literal_pathspec_for_nested_target_and_refuses_tracking(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            (root / "config").mkdir()
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            helper.write_env_batch(root, {"TEST_SECRET": "SyntheticOnly123"}, "config/.env.local")
            ignored = subprocess.run(
                ["git", "check-ignore", "-q", "--", "config/.env.local"],
                cwd=root, check=False,
            )
            self.assertEqual(ignored.returncode, 0)
            subprocess.run(
                ["git", "--literal-pathspecs", "add", "-f", "--", "config/.env.local"],
                cwd=root, check=True,
            )
            with self.assertRaises(ValueError):
                helper.write_env_batch(root, {"SECOND": "SyntheticOnly456"}, "config/.env.local")

    def test_hook_invalid_data_blocks(self):
        p = subprocess.run(
            [sys.executable, "-I", str(ROOT / "hooks" / "prompt_guard.py")],
            input="broken", text=True, capture_output=True, check=True,
        )
        self.assertEqual(json.loads(p.stdout)["decision"], "block")


class WriterTests(unittest.TestCase):
    def test_shell_env_quote_and_update(self):
        got = helper.patched_env("export DEMO=old\nOTHER=1\n", "DEMO", "abc$def")
        self.assertEqual(got, "export DEMO='abc$def'\nOTHER=1\n")
        with self.assertRaises(ValueError):
            helper.quote_env("two\nlines")
        with self.assertRaises(ValueError):
            helper.quote_env("a'b")

    def test_atomic_mode_and_no_symlink(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            helper.write_env(root, "FAKE_TOKEN", "Fixture1234")
            env = root / ".env"
            self.assertEqual(env.read_text(), "FAKE_TOKEN=Fixture1234\n")
            self.assertEqual(stat.S_IMODE(env.stat().st_mode), 0o600)
            helper.write_env(root, "FAKE_TOKEN", "UpdatedFake987")
            self.assertEqual(env.read_text(), "FAKE_TOKEN=UpdatedFake987\n")
            env.unlink()
            target = root / "target"
            target.write_text("keep")
            env.symlink_to(target)
            with self.assertRaises(ValueError):
                helper.write_env(root, "FAKE_TOKEN", "NOTWRITTEN")
            self.assertEqual(target.read_text(), "keep")

    def test_refuses_tracked_env(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            (root / ".env").write_text("FAKE_KEY=old\n")
            subprocess.run(["git", "-C", str(root), "add", ".env"], check=True)
            with self.assertRaises(ValueError):
                helper.write_env(root, "FAKE_KEY", "NEWFAKE")
            self.assertEqual((root / ".env").read_text(), "FAKE_KEY=old\n")


class NativeMcpTests(unittest.TestCase):
    def _fake_home(self, root):
        return mock.patch.object(server.Path, "home", return_value=root.parent)

    @staticmethod
    def _project(td):
        home = Path(td).resolve() / "home"
        root = home / "project"
        root.mkdir(parents=True, mode=0o700)
        home.chmod(0o700)
        root.chmod(0o700)
        return root

    @staticmethod
    def _response(values, github=False):
        return server.NativeResponse(values=values, destination_confirmed=True, github_confirmed=github)

    def test_trusted_project_checks_absolute_ancestry_from_home_not_cwd(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td).resolve()
            home = base / "home"
            one = home / "one"
            two = one / "two"
            root = two / "project"
            unrelated = base / "unrelated"
            root.mkdir(parents=True, mode=0o700)
            unrelated.mkdir(mode=0o700)
            for directory in (home, one, two, root):
                directory.chmod(0o700)
            previous_cwd = os.getcwd()
            try:
                os.chdir(unrelated)
                with mock.patch.object(server.Path, "home", return_value=home):
                    self.assertEqual(server.trusted_project(str(root)), root)
                    one.chmod(0o720)
                    with self.assertRaises(ValueError):
                        server.trusted_project(str(root))
                    one.chmod(0o700)
                    linked = home / "linked"
                    linked.symlink_to(one, target_is_directory=True)
                    with self.assertRaises(ValueError):
                        server.trusted_project(str(linked / "two" / "project"))
            finally:
                os.chdir(previous_cwd)

    def test_single_masked_gui_alias_saves_without_exposing_value(self):
        with tempfile.TemporaryDirectory() as td:
            root = self._project(td)
            with self._fake_home(root), \
                 mock.patch.object(server, "native_dialog",
                     return_value=self._response({"TEST_SECRET_DROP": "Fixture-Only-98765"})) as modal:
                result = server.request_secret({"name": "TEST_SECRET_DROP", "project_dir": str(root)})
            self.assertFalse(result["isError"])
            self.assertEqual(modal.call_args.args[0][0]["name"], "TEST_SECRET_DROP")
            self.assertIn(str(root / ".env"), modal.call_args.args[1])
            self.assertNotIn("Fixture-Only-98765", json.dumps(result))
            self.assertEqual((root / ".env").read_text(), "TEST_SECRET_DROP=Fixture-Only-98765\n")
            self.assertEqual(stat.S_IMODE((root / ".env").stat().st_mode), 0o600)

    def test_two_secrets_one_dialog_and_atomic_env(self):
        with tempfile.TemporaryDirectory() as td:
            root = self._project(td)
            fields = [{"name": "APP_KEY", "hint": "For test app"}, {"name": "SERVICE_TOKEN"}]
            values = {"APP_KEY": "FakeValue12", "SERVICE_TOKEN": "TestOnly345"}
            with self._fake_home(root), \
                 mock.patch.object(server, "native_dialog", return_value=self._response(values)) as modal:
                result = server.request_secret({"secrets": fields, "project_dir": str(root)})
            self.assertFalse(result["isError"])
            modal.assert_called_once()
            self.assertEqual(len(modal.call_args.args[0]), 2)
            self.assertEqual((root / ".env").read_text(), "APP_KEY=FakeValue12\nSERVICE_TOKEN=TestOnly345\n")
            self.assertEqual(stat.S_IMODE((root / ".env").stat().st_mode), 0o600)
            self.assertIn("APP_KEY, SERVICE_TOKEN", json.dumps(result))
            for value in values.values():
                self.assertNotIn(value, json.dumps(result))

    def test_batch_validation_failure_makes_no_partial_changes(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            file = root / ".env"
            file.write_text("KEEP=original\n")
            file.chmod(0o600)
            with self.assertRaises(ValueError):
                helper.write_env_batch(root, {"A": "Valid123", "B": "newline\nunsafe"})
            self.assertEqual(file.read_text(), "KEEP=original\n")

    def test_cancel_does_not_touch_project(self):
        with tempfile.TemporaryDirectory() as td:
            root = self._project(td)
            with self._fake_home(root), \
                 mock.patch.object(server, "native_dialog", side_effect=server.Cancelled):
                result = server.request_secret({"secrets": [{"name": "ONE"}, {"name": "TWO"}],
                                                "project_dir": str(root)})
            self.assertTrue(result["isError"])
            self.assertFalse((root / ".env").exists())

    def test_rejects_values_duplicate_names_and_conflicting_shapes_without_gui(self):
        with tempfile.TemporaryDirectory() as td:
            root = self._project(td)
            bad_payloads = [
                {"name": "A", "value": "FAKE_NOT_ALLOWED"},
                {"secrets": [{"name": "A", "value": "FAKE_NOT_ALLOWED"}]},
                {"secrets": [{"name": "A"}, {"name": "A"}]},
                {"secrets": [{"name": "A"}], "name": "B"},
                {"secrets": []},
                {"secrets": [{"name": "A"}] * 13},
            ]
            with self._fake_home(root), mock.patch.object(server, "native_dialog") as modal:
                for req in bad_payloads:
                    result = server.request_secret({**req, "project_dir": str(root)})
                    self.assertTrue(result["isError"], req)
                    self.assertNotIn("FAKE_NOT_ALLOWED", json.dumps(result))
                modal.assert_not_called()
            self.assertFalse((root / ".env").exists())

    def test_swift_gui_receives_only_variable_names_in_stdin_and_returns_values_locally(self):
        synthetic = {"status": "entered", "values": {"EXAMPLE_KEY": "FixtureOnly456", "SECOND": "AnotherFake99"}, "destination_confirmed": True, "github_confirmed": False}
        proc = subprocess.CompletedProcess(args=[], returncode=0, stdout=json.dumps(synthetic), stderr="")
        with mock.patch.object(server.platform, "system", return_value="Darwin"), \
             mock.patch.object(server, "dialog_binary", return_value=Path("/fake/native-dialog")), \
             mock.patch.object(server.subprocess, "run", return_value=proc) as runner:
            values = server.native_dialog([{"name": "EXAMPLE_KEY"}, {"name": "SECOND"}], "/tmp/test/.env", "", False)
        self.assertEqual(values.values, synthetic["values"])
        args, kwargs = runner.call_args
        self.assertEqual(args[0][0], "/fake/native-dialog")
        self.assertEqual(json.loads(kwargs["input"])["fields"][0]["name"], "EXAMPLE_KEY")
        self.assertNotIn("FixtureOnly456", json.dumps(args[0]))
        self.assertNotIn("FixtureOnly456", kwargs["input"])
        self.assertTrue(kwargs["capture_output"])

    def test_mcp_stdio_handshake_and_multi_schema(self):
        payload = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": "2025-06-18", "capabilities": {},
                "clientInfo": {"name": "synthetic-test", "version": "1.0"}
            }},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        ]
        reply = subprocess.run(
            [sys.executable, "-I", str(ROOT / "server" / "mcp_server.py")],
            input="\n".join(json.dumps(msg) for msg in payload) + "\n",
            capture_output=True, text=True, check=True, timeout=5,
        )
        lines = [json.loads(line) for line in reply.stdout.splitlines()]
        self.assertEqual(len(lines), 2, reply)
        self.assertEqual(lines[0]["result"]["serverInfo"]["name"], "secret-drop-local")
        self.assertEqual(lines[0]["result"]["serverInfo"]["version"], "0.6.0")
        schema = lines[1]["result"]["tools"][0]["inputSchema"]
        self.assertIn("secrets", schema["properties"])
        self.assertEqual(schema["properties"]["secrets"]["maxItems"], 12)
        self.assertNotIn("value", schema["properties"])
        self.assertEqual(reply.stderr, "")

    def test_reason_nested_file_and_environment_are_accepted_only_when_safe(self):
        with tempfile.TemporaryDirectory() as td:
            root = self._project(td)
            (root / "config").mkdir()
            reply = server.NativeResponse(
                values={"TEST_SECRET": "SyntheticOnly123"},
                destination_confirmed=True,
                github_confirmed=True,
            )
            with self._fake_home(root), \
                 mock.patch.object(server, "native_dialog", return_value=reply) as dialog, \
                 mock.patch.object(server, "write_github", return_value=True) as gh:
                result = server.request_secret({
                    "name": "TEST_SECRET",
                    "reason": "Needed for the synthetic test service.",
                    "project_dir": str(root),
                    "env_file": "config/.env.local",
                    "destination": "both",
                    "github_repo": "example/demo",
                    "github_environment": "staging",
                })
            self.assertFalse(result["isError"], result)
            self.assertTrue((root / "config" / ".env.local").exists())
            self.assertIn(str(root / "config" / ".env.local"), dialog.call_args.args[1])
            self.assertEqual(gh.call_args.args[:3], ("TEST_SECRET", "example/demo", "staging"))

    def test_nested_negated_gitignore_fails_closed_before_local_or_github_write(self):
        with tempfile.TemporaryDirectory() as td:
            root = self._project(td)
            config = root / "config"
            config.mkdir()
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            (config / ".gitignore").write_text("!.env.local\n")
            target = config / ".env.local"
            target.write_text("KEEP=existing\n")
            target.chmod(0o600)
            reply = self._response({"TEST_SECRET": "SyntheticOnly123"}, github=True)
            with self._fake_home(root), \
                 mock.patch.object(server, "native_dialog", return_value=reply), \
                 mock.patch.object(server, "write_github", return_value=True) as gh:
                result = server.request_secret({
                    "name": "TEST_SECRET",
                    "project_dir": str(root),
                    "env_file": "config/.env.local",
                    "destination": "both",
                    "github_repo": "example/demo",
                })
            self.assertTrue(result["isError"])
            self.assertEqual(target.read_text(), "KEEP=existing\n")
            gh.assert_not_called()
            ignored = subprocess.run(
                ["git", "check-ignore", "-q", "--", "config/.env.local"],
                cwd=root,
                check=False,
            )
            self.assertNotEqual(ignored.returncode, 0)

    def test_controls_and_path_escape_are_rejected_without_showing_dialog(self):
        with tempfile.TemporaryDirectory() as td:
            root = self._project(td)
            with self._fake_home(root), mock.patch.object(server, "native_dialog") as dialog:
                for request in (
                    {"name": "TEST_SECRET", "reason": "line one\nline two", "project_dir": str(root)},
                    {"secrets": [{"name": "TEST_SECRET", "hint": "unsafe\u202etext"}], "project_dir": str(root)},
                    {"name": "TEST_SECRET", "project_dir": str(root), "env_file": "../.env"},
                    {"name": "TEST_SECRET", "project_dir": str(root), "github_environment": "prod\nnow"},
                ):
                    self.assertTrue(server.request_secret(request)["isError"])
                dialog.assert_not_called()

    def test_unconfirmed_destinations_produce_no_local_or_github_write(self):
        with tempfile.TemporaryDirectory() as td:
            root = self._project(td)
            reply = server.NativeResponse(
                values={"TEST_SECRET": "SyntheticOnly123"},
                destination_confirmed=False,
                github_confirmed=False,
            )
            with self._fake_home(root), \
                 mock.patch.object(server, "native_dialog", return_value=reply), \
                 mock.patch.object(server, "write_env_batch") as write_env, \
                 mock.patch.object(server, "write_github") as github:
                result = server.request_secret({
                    "name": "TEST_SECRET", "project_dir": str(root), "destination": "both",
                    "github_repo": "example/demo", "github_environment": "production",
                })
            self.assertTrue(result["isError"])
            write_env.assert_not_called()
            github.assert_not_called()

    def test_github_only_multi_opt_in_does_not_write_env_or_leak(self):
        with tempfile.TemporaryDirectory() as td:
            root = self._project(td)
            fake_values = {"DEMO_KEY": "FakeNoNetwork123", "SECOND": "AnotherFixture456"}
            with self._fake_home(root), \
                 mock.patch.object(server, "native_dialog", return_value=self._response(fake_values, github=True)), \
                 mock.patch.object(server, "write_github", return_value=True) as gh:
                result = server.request_secret({
                    "secrets": [{"name": "DEMO_KEY"}, {"name": "SECOND"}],
                    "project_dir": str(root),
                    "destination": "github", "github_repo": "example/demo",
                })
            self.assertFalse(result["isError"])
            self.assertFalse((root / ".env").exists())
            self.assertEqual(gh.call_count, 2)
            self.assertEqual(gh.call_args_list[0].args[:2], ("DEMO_KEY", "example/demo"))
            for value in fake_values.values():
                self.assertNotIn(value, json.dumps(result))


    def test_partial_save_reports_each_unfilled_name(self):
        with tempfile.TemporaryDirectory() as td:
            root = self._project(td)
            fields = [{"name": "TEST_ONE"}, {"name": "TEST_TWO"}, {"name": "TEST_THREE"}]
            fake = "Dummy-Only-111"
            with self._fake_home(root), mock.patch.object(
                server, "native_dialog", return_value=self._response({"TEST_TWO": fake})
            ):
                output = server.request_secret({"secrets": fields, "project_dir": str(root)})
            self.assertFalse(output["isError"], output)
            self.assertEqual((root / ".env").read_text(), "TEST_TWO=Dummy-Only-111\n")
            self.assertEqual(stat.S_IMODE((root / ".env").stat().st_mode), 0o600)
            report = json.dumps(output)
            self.assertIn("TEST_TWO", report)
            self.assertIn("TEST_ONE", report)
            self.assertIn("TEST_THREE", report)
            self.assertIn("Skipped", report)
            self.assertNotIn(fake, report)

    def test_partial_save_preserves_previous_env_and_skipped_names(self):
        with tempfile.TemporaryDirectory() as td:
            root = self._project(td)
            (root / ".env").write_text("TEST_TWO=previous-fixture\nKEEP=untouched\n")
            (root / ".env").chmod(0o600)
            with self._fake_home(root), mock.patch.object(
                server, "native_dialog", return_value=self._response({"TEST_ONE": "New-Fake-123"})
            ):
                output = server.request_secret({
                    "secrets": [{"name": "TEST_ONE"}, {"name": "TEST_TWO"}],
                    "project_dir": str(root),
                })
            self.assertFalse(output["isError"])
            self.assertEqual(
                (root / ".env").read_text(),
                "TEST_TWO=previous-fixture\nKEEP=untouched\nTEST_ONE=New-Fake-123\n",
            )
            self.assertIn("TEST_TWO", json.dumps(output))
            self.assertIn("Skipped", json.dumps(output))

    def test_all_fields_left_blank_reports_no_save(self):
        with tempfile.TemporaryDirectory() as td:
            root = self._project(td)
            with self._fake_home(root), mock.patch.object(
                server, "native_dialog", return_value=self._response({})
            ):
                output = server.request_secret({
                    "secrets": [{"name": "TEST_ONE"}, {"name": "TEST_TWO"}],
                    "project_dir": str(root),
                })
            self.assertTrue(output["isError"])
            self.assertFalse((root / ".env").exists())
            self.assertIn("No values", json.dumps(output))
            self.assertIn("TEST_ONE", json.dumps(output))
            self.assertIn("TEST_TWO", json.dumps(output))

    def test_native_dialog_accepts_partial_subset_of_requested_fields(self):
        response = {"status": "entered", "values": {"TEST_TWO": "Only-Dummy-987"}, "destination_confirmed": True, "github_confirmed": False}
        proc = subprocess.CompletedProcess(args=[], returncode=0, stdout=json.dumps(response), stderr="")
        fields = [{"name": "TEST_ONE"}, {"name": "TEST_TWO"}]
        with mock.patch.object(server.platform, "system", return_value="Darwin"), \
             mock.patch.object(server, "dialog_binary", return_value=Path("/fake/native-dialog")), \
             mock.patch.object(server.subprocess, "run", return_value=proc):
            values = server.native_dialog(fields, "/tmp/test/.env", "", False)
        self.assertEqual(values.values, {"TEST_TWO": "Only-Dummy-987"})

    def test_native_dialog_rejects_unrequested_variable(self):
        response = {"status": "entered", "values": {"EVIL": "Only-Dummy-987"}, "destination_confirmed": True, "github_confirmed": False}
        proc = subprocess.CompletedProcess(args=[], returncode=0, stdout=json.dumps(response), stderr="")
        fields = [{"name": "TEST_ONE"}, {"name": "TEST_TWO"}]
        with mock.patch.object(server.platform, "system", return_value="Darwin"), \
             mock.patch.object(server, "dialog_binary", return_value=Path("/fake/native-dialog")), \
             mock.patch.object(server.subprocess, "run", return_value=proc):
            with self.assertRaises(server.Cancelled):
                server.native_dialog(fields, "/tmp/test/.env", "", False)

    def test_github_partial_save_skips_empty_fields_without_external_write(self):
        with tempfile.TemporaryDirectory() as td:
            root = self._project(td)
            with self._fake_home(root), \
                 mock.patch.object(server, "native_dialog", return_value=self._response({"TEST_ONE": "DummyOnly321"}, github=True)), \
                 mock.patch.object(server, "write_github", return_value=True) as gh:
                output = server.request_secret({
                    "secrets": [{"name": "TEST_ONE"}, {"name": "TEST_TWO"}],
                    "project_dir": str(root),
                    "destination": "github", "github_repo": "example/demo",
                })
            self.assertFalse(output["isError"])
            self.assertEqual(gh.call_count, 1)
            self.assertEqual(gh.call_args.args[:2], ("TEST_ONE", "example/demo"))
            self.assertIn("TEST_TWO", json.dumps(output))
            self.assertIn("Skipped", json.dumps(output))
            self.assertFalse((root / ".env").exists())
            self.assertNotIn("DummyOnly321", json.dumps(output))


    def test_local_saved_values_are_verified_by_helper_without_model_readback(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            values = {"TEST_ALPHA": "OnlySynthetic432", "TEST_BETA": "Fake-$-value"}
            helper.write_env_batch(root, values)
            status = helper.verify_env_written(root, values)
            self.assertEqual(status, {"TEST_ALPHA": True, "TEST_BETA": True})
            (root / ".env").write_text("TEST_ALPHA=changed\nTEST_BETA='Fake-$-value'\n")
            self.assertEqual(
                helper.verify_env_written(root, values),
                {"TEST_ALPHA": False, "TEST_BETA": True},
            )

    def test_local_verification_rejects_insecure_permissions(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            values = {"TEST_ALPHA": "DummyOnly987"}
            helper.write_env_batch(root, values)
            (root / ".env").chmod(0o644)
            self.assertEqual(helper.verify_env_written(root, values), {"TEST_ALPHA": False})

    def test_mcp_reports_local_verify_failure_without_secret_values(self):
        with tempfile.TemporaryDirectory() as td:
            root = self._project(td)
            with self._fake_home(root), \
                 mock.patch.object(server, "native_dialog",
                                   return_value=self._response({"TEST_ALPHA": "FixtureOnly123"})), \
                 mock.patch.object(server, "verify_env_written",
                                   return_value={"TEST_ALPHA": False}):
                response = server.request_secret({"name": "TEST_ALPHA", "project_dir": str(root)})
            self.assertTrue(response["isError"])
            self.assertIn("not verified", json.dumps(response).lower())
            self.assertNotIn("FixtureOnly123", json.dumps(response))

    def test_partial_save_verification_distinguishes_skipped_and_confirmed(self):
        with tempfile.TemporaryDirectory() as td:
            root = self._project(td)
            with self._fake_home(root), mock.patch.object(
                server, "native_dialog", return_value=self._response({"TEST_ALPHA": "FakeOnly321"})
            ):
                response = server.request_secret({
                    "secrets": [{"name": "TEST_ALPHA"}, {"name": "TEST_BETA"}],
                    "project_dir": str(root),
                })
            self.assertFalse(response["isError"], response)
            report = json.dumps(response)
            self.assertIn("verified", report.lower())
            self.assertIn("TEST_ALPHA", report)
            self.assertIn("TEST_BETA", report)
            self.assertIn("Skipped", report)
            self.assertNotIn("FakeOnly321", report)


if __name__ == "__main__":
    unittest.main()
