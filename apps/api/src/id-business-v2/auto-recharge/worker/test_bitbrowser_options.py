import unittest
from unittest.mock import patch

import bitbrowser_connector as connector
from bitbrowser_options import DEFAULTS, profile_options
from checkout_core import Stop
from test_bitbrowser_connector import payload


class BrowserOptionsTests(unittest.TestCase):
    def test_custom_dynamic_settings_reach_actual_create_request(self):
        settings = payload()["bitBrowser"]
        settings["browserOptions"] = {
            **DEFAULTS, "os": "Win32", "dynamicProvider": "rola", "refreshIp": False,
            "ipCheckService": "luminati", "language": "en-US", "displayLanguage": "ja-JP",
            "languageFromIp": True, "displayLanguageFromIp": True,
            "timezoneFromIp": False, "timezone": "Asia/Kuala_Lumpur",
            "positionFromIp": False, "latitude": 3.1, "longitude": 101.7, "accuracy": 50,
            "syncTabs": False, "syncCookies": False, "syncLocalStorage": False,
        }
        client = connector.BitBrowserClient(settings["localApiUrl"], settings["localApiToken"])
        catalog = {"groups": [{"id": "a" * 32, "name": settings["groupName"]}],
                   "tags": [{"id": "b" * 32, "name": settings["tagName"]}]}
        with patch.object(connector.bitbrowser_catalog, "read_catalog", return_value=catalog), \
                patch.object(client, "post", return_value={"id": "c" * 32}) as post:
            client.create_profile(settings, "配置测试")
        body = post.call_args_list[0].args[1]
        self.assertEqual(body["proxyMethod"], 3)
        self.assertEqual(body["dynamicIpChannel"], "rola")
        self.assertFalse(body["isDynamicIpChangeIp"])
        self.assertEqual(body["ipCheckService"], "luminati")
        for key in ("syncTabs", "syncCookies", "syncLocalStorage", "credentialsEnableService"):
            self.assertFalse(body[key])
        self.assertEqual(body["browserFingerPrint"], {
            "ostype": "PC", "os": "Win32", "isIpCreateTimeZone": False,
            "isIpCreatePosition": False, "isIpCreateLanguage": True, "languages": "en-US",
            "isIpCreateDisplayLanguage": True, "displayLanguages": "ja-JP",
            "timeZone": "Asia/Kuala_Lumpur", "timeZoneOffset": 28800,
            "position": "1", "lat": "3.1", "lng": "101.7", "precisionData": "50",
        })

    def test_static_proxy_supports_optional_auth_and_omits_dynamic_fields(self):
        value = payload()
        settings = value["bitBrowser"]
        settings.pop("dynamicProxyUrl")
        settings["browserOptions"] = {**DEFAULTS, "proxyMode": "static",
                                      "staticHost": "203.0.113.10", "staticPort": 1080}
        connector.validate_payload(value)
        result = profile_options(settings)
        self.assertEqual(result["proxyMethod"], 2)
        self.assertEqual(result["host"], "203.0.113.10")
        self.assertEqual(result["port"], 1080)
        self.assertEqual(result["proxyPassword"], "")
        self.assertNotIn("dynamicIpUrl", result)
        self.assertNotIn("timeZone", result["browserFingerPrint"])
        self.assertNotIn("lat", result["browserFingerPrint"])
        settings["staticProxyCredentials"] = {"username": "fixture-user", "password": "fixture-password"}
        self.assertEqual(profile_options(settings)["proxyPassword"], "fixture-password")

    def test_legacy_options_receive_session_defaults_and_bounds_are_enforced(self):
        from bitbrowser_options import validate_options
        legacy = {key: value for key, value in DEFAULTS.items() if key not in {'sessionWaitMinutes', 'sessionRetryLimit'}}
        self.assertEqual(validate_options(legacy), DEFAULTS)
        for changes in ({'sessionWaitMinutes': 0}, {'sessionWaitMinutes': 11},
                        {'sessionWaitMinutes': 1.5}, {'sessionRetryLimit': -1},
                        {'sessionRetryLimit': 3}, {'sessionRetryLimit': True}):
            with self.subTest(changes=changes), self.assertRaises(Stop):
                validate_options({**DEFAULTS, **changes})

    def test_old_sync_settings_cannot_enable_login_state_upload(self):
        value = payload()
        value['bitBrowser']['browserOptions'] = {**DEFAULTS, 'syncTabs': True,
                                                 'syncCookies': True, 'syncLocalStorage': True}
        result = profile_options(value['bitBrowser'])
        for key in ('syncTabs', 'syncCookies', 'syncLocalStorage', 'syncIndexedDb', 'syncAuthorization'):
            self.assertIs(result[key], False)

    def test_invalid_options_are_rejected_before_any_api_request(self):
        for changes in ({"staticPort": True}, {"staticPort": 65536}, {"latitude": float("nan")},
                        {"longitude": 181}, {"os": "Android"}, {"timezone": "Invalid/Zone"},
                        {"syncTabs": "false"}, {"extra": True},
                        {"proxyMode": "static", "staticHost": "http://proxy.example"}):
            with self.subTest(changes=changes):
                value = payload()
                value["bitBrowser"]["browserOptions"] = {**DEFAULTS, **changes}
                with self.assertRaises(Stop):
                    connector.validate_payload(value)
                client = connector.BitBrowserClient("http://127.0.0.1:54345", "b" * 32)
                with patch.object(client, "post") as post, self.assertRaises(Stop):
                    client.create_profile(value["bitBrowser"], "配置测试")
                post.assert_not_called()


if __name__ == "__main__":
    unittest.main()
