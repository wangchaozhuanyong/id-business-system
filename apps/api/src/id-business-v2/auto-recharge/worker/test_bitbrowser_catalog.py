import io
import json
import unittest
from unittest.mock import MagicMock, patch

import bitbrowser_catalog as catalog
import bitbrowser_connector as connector
from checkout_core import Stop


class BitBrowserCatalogTests(unittest.TestCase):
    def test_groups_are_paginated_and_only_option_metadata_is_returned(self):
        client = MagicMock()
        rows = [{"id": f"group_{i:08}", "groupName": f"分组{i}", "password": "fixture"} for i in range(101)]
        client.post.side_effect = [{"list": rows[:100]}, {"list": rows[100:]}]
        result = catalog.list_groups(client)
        self.assertEqual(len(result), 101)
        self.assertEqual(result[-1], {"id": "group_00000100", "name": "分组100"})
        self.assertEqual(client.post.call_args.args, ("/group/list", {"page": 1, "pageSize": 100, "all": True}))

    def test_tags_support_the_local_api_nested_envelope_and_empty_list(self):
        client = MagicMock()
        client.post.return_value = {"success": True, "data": [{"id": "a" * 32, "tagName": "已有标签"}]}
        self.assertEqual(catalog.list_tags(client), [{"id": "a" * 32, "name": "已有标签"}])
        client.post.return_value = []
        self.assertEqual(catalog.list_tags(client), [])

    def test_malformed_and_repeated_pages_are_rejected(self):
        for value in ({}, {"success": False, "data": []}, [{"id": "bad", "tagName": "标签"}]):
            with self.subTest(value=value), self.assertRaises(Stop):
                catalog.list_tags(MagicMock(post=MagicMock(return_value=value)))
        row = {"id": "group_00000001", "groupName": "分组"}
        with self.assertRaises(Stop):
            catalog.choices([row, row], "groupName")

    def test_missing_or_ambiguous_choices_never_create_a_group_or_window(self):
        for groups, tags in [([], [{"id": "a" * 32, "name": "标签"}]),
                             ([{"id": "b" * 32, "name": "分组"}], []),
                             ([{"id": "b" * 32, "name": "分组"}, {"id": "c" * 32, "name": "分组"}], [])]:
            client = connector.BitBrowserClient("http://127.0.0.1:54345", "b" * 32)
            client.post = MagicMock()
            with patch.object(catalog, "read_catalog", return_value={"groups": groups, "tags": tags}), self.assertRaises(Stop):
                client.create_profile({"groupName": "分组", "tagName": "标签", "proxyType": "http", "dynamicProxyUrl": "https://proxy.example/extract"}, "窗口")
            client.post.assert_not_called()

    def test_catalog_http_route_only_reads_lists(self):
        handler = object.__new__(connector.Handler)
        payload = {"localApiUrl": "http://127.0.0.1:54345", "localApiToken": "b" * 32}
        encoded = json.dumps(payload).encode()
        handler.path = "/browser/catalog"
        handler.headers = {"Content-Length": str(len(encoded))}
        handler.rfile = io.BytesIO(encoded)
        handler.allowed_origin = MagicMock(return_value="https://admin.example")
        handler.authorized = MagicMock(return_value=True)
        handler.reply = MagicMock()
        with patch.object(connector.BitBrowserClient, "post", side_effect=[{"list": []}, []]) as post, patch.object(connector.REGISTRY, "start") as start:
            handler.do_POST()
            self.assertEqual([call.args[0] for call in post.call_args_list], ["/group/list", "/browserTag/list"])
            start.assert_not_called()
            handler.reply.assert_called_once_with(200, {"ok": True, "groups": [], "tags": []})
        handler.authorized.return_value = False
        handler.reply.reset_mock()
        with patch.object(connector.BitBrowserClient, "post") as post:
            handler.do_POST()
            post.assert_not_called()
            handler.reply.assert_called_once_with(403, {"ok": False, "reason": "connector_token_invalid"})

    def test_tag_binding_failure_keeps_created_window_id_and_does_not_open(self):
        client = connector.BitBrowserClient("http://127.0.0.1:54345", "b" * 32)
        def post(path, body):
            if path == "/browser/update":
                return {"id": "c" * 32}
            if path == "/browserTag/updateRelation":
                raise Stop("bitbrowser_local_api_rejected")
            self.fail("unexpected side effect")
        client.post = MagicMock(side_effect=post)
        settings = {"groupName": "分组", "tagName": "标签", "proxyType": "http", "dynamicProxyUrl": "https://proxy.example/extract"}
        entries = {"groups": [{"id": "a" * 32, "name": "分组"}], "tags": [{"id": "b" * 32, "name": "标签"}]}
        with patch.object(catalog, "read_catalog", return_value=entries), self.assertRaises(Stop) as stopped:
            client.create_profile(settings, "窗口")
        self.assertEqual(stopped.exception.report["reason"], "bitbrowser_tag_binding_failed")
        self.assertEqual(stopped.exception.report["browser_profile_id"], "c" * 32)
        self.assertEqual([call.args[0] for call in client.post.call_args_list], ["/browser/update", "/browserTag/updateRelation"])


if __name__ == "__main__":
    unittest.main()
