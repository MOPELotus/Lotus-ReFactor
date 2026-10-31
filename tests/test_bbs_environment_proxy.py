"""Exercise real HTTPX routing without contacting Mihoyo or using credentials."""
import importlib.util
import os
from pathlib import Path
import sys
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import httpx

spec = importlib.util.spec_from_file_location(
    "lotus_bbs_runner", Path(__file__).resolve().parents[1] / "python/lotus_bbs_runner.py"
)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"proxy" if self.path.startswith("http://") else b"direct"
        self.send_response(200)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


class ProxyRoutingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.address = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.module = types.ModuleType("request")
        self.module.get_new_session = lambda **kw: httpx.Client(
            transport=httpx.HTTPTransport(retries=10), **kw
        )
        self.module.http = self.module.get_new_session()
        self.modules = patch.dict(sys.modules, {"request": self.module})
        self.modules.start()

    def tearDown(self):
        self.module.http.close()
        self.modules.stop()

    def test_global_and_future_clients_use_proxy(self):
        with patch.dict(os.environ, {"HTTP_PROXY": self.address}, clear=True):
            runner.configure_bbstools_environment_proxy()
            self.assertEqual(self.module.http.get("http://proxy-check.invalid/").text, "proxy")
            with self.module.get_new_session() as client:
                self.assertEqual(client.get("http://proxy-check.invalid/").text, "proxy")

    def test_no_proxy_is_respected(self):
        env = {"HTTP_PROXY": self.address, "NO_PROXY": "127.0.0.1"}
        with patch.dict(os.environ, env, clear=True):
            runner.configure_bbstools_environment_proxy()
            self.assertEqual(self.module.http.get(self.address).text, "direct")

    def test_without_proxy_leaves_upstream_client_unchanged(self):
        previous = self.module.http
        with patch.dict(os.environ, {}, clear=True):
            runner.configure_bbstools_environment_proxy()
        self.assertIs(self.module.http, previous)


if __name__ == "__main__":
    unittest.main()
