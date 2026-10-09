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
            "coreProduct": "chrome", "coreVersion": "152", "version": "152", "userAgent": "",
            "ostype": "PC", "os": "Win32", "osVersion": "11", "openWidth": 1600, "openHeight": 1000,
            "isIpCreateTimeZone": False,
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

    def test_legacy_mac_settings_use_windows_11_without_changing_proxy_or_region(self):
        from bitbrowser_options import validate_options, PROFILE_KEYS
        legacy = {key: value for key, value in DEFAULTS.items() if key not in PROFILE_KEYS}
        legacy.update(os="MacIntel", language="en-US", staticHost="proxy.example")
        original = dict(legacy)
        result = validate_options(legacy)
        self.assertEqual(result["os"], "Win32")
        self.assertEqual(result["osVersion"], "11")
        self.assertEqual(result["coreVersion"], "152")
        self.assertEqual(result["language"], "en-US")
        self.assertEqual(result["staticHost"], "proxy.example")
        self.assertEqual(legacy, original)

    def test_explicit_new_mac_or_linux_and_editable_kernel_dimensions_are_preserved(self):
        for os in ("MacIntel", "Linux x86_64"):
            settings = payload()["bitBrowser"]
            settings["browserOptions"] = {**DEFAULTS, "os": os, "osVersion": "",
                                          "coreVersion": "150", "openWidth": 1800, "openHeight": 1100}
            fingerprint = profile_options(settings)["browserFingerPrint"]
            self.assertEqual(fingerprint["os"], os)
            self.assertEqual(fingerprint["coreVersion"], "150")
            self.assertEqual(fingerprint["version"], "150")
            self.assertEqual(fingerprint["userAgent"], "")
            self.assertEqual(fingerprint["openWidth"], 1800)
            self.assertEqual(fingerprint["openHeight"], 1100)

    def test_invalid_profile_fields_fail_before_any_external_request(self):
        for changes in ({"coreVersion": "latest"}, {"coreVersion": 152}, {"coreVersion": "95"},
                        {"osVersion": "11,10"}, {"osVersion": []}, {"osVersion": ""},
                        {"openWidth": True}, {"openWidth": 799}, {"openWidth": 1600.5},
                        {"openHeight": 599}, {"openHeight": 4321}):
            settings = payload()["bitBrowser"]
            settings["browserOptions"] = {**DEFAULTS, **changes}
            client = connector.BitBrowserClient(settings["localApiUrl"], settings["localApiToken"])
            with self.subTest(changes=changes), patch.object(client, "post") as post:
                with self.assertRaises(Stop):
                    client.create_profile(settings, "配置测试")
                post.assert_not_called()

    def test_readback_checks_only_reported_fields_and_rejects_a_different_opened_kernel(self):
        from bitbrowser_options import verify_profile_configuration
        expected = profile_options(payload()["bitBrowser"])["browserFingerPrint"]
        verify_profile_configuration({}, expected)
        verify_profile_configuration({"browserFingerPrint": {}}, expected, {})
        verify_profile_configuration({"browserFingerPrint": expected}, expected, {"coreVersion": "152.0.0"})
        verify_profile_configuration({"browserFingerPrint": {"coreVersion": "152.0.0",
                                     "version": "152.0.0.0"}}, expected)
        for detail, opened in (({"browserFingerPrint": {"osVersion": "10"}}, None),
                               ({"browserFingerPrint": {"openWidth": 1280}}, None),
                               ({"browserFingerPrint": {"userAgent": "Mozilla/5.0 Chrome/130.0.0.0"}}, None),
                               ({}, {"coreVersion": "130"})):
            with self.subTest(detail=detail, opened=opened), self.assertRaises(Stop):
                verify_profile_configuration(detail, expected, opened)

    def test_new_profiles_verify_saved_fingerprint_before_open_and_kernel_after_open(self):
        settings = payload()["bitBrowser"]
        client = connector.BitBrowserClient(settings["localApiUrl"], settings["localApiToken"])
        profile_id = "c" * 32
        catalog = {"groups": [{"id": "a" * 32, "name": settings["groupName"]}],
                   "tags": [{"id": "b" * 32, "name": settings["tagName"]}]}
        safe = {"id": profile_id, **dict.fromkeys(("syncTabs", "syncCookies",
                "syncLocalStorage", "syncIndexedDb", "syncAuthorization"), False)}
        with patch.object(connector.bitbrowser_catalog, "read_catalog", return_value=catalog), \
                patch.object(client, "post", side_effect=[{"id": profile_id}, {}]):
            self.assertEqual(client.create_profile(settings, "配置测试"), profile_id)
        with patch.object(client, "post", return_value={**safe, "browserFingerPrint": {
                "osVersion": "10"}}) as post, self.assertRaises(Stop):
            client.open_profile(profile_id)
        post.assert_called_once_with("/browser/detail", {"id": profile_id})
        with patch.object(client, "post", side_effect=[safe, {"coreVersion": "130",
                "ws": "ws://127.0.0.1:9222/devtools/browser/test"}]) as post, self.assertRaises(Stop):
            client.open_profile(profile_id)
        self.assertEqual(post.call_count, 2)

    def test_explicit_other_platform_accepts_client_generated_system_version(self):
        from bitbrowser_options import verify_profile_configuration
        settings = payload()["bitBrowser"]
        settings["browserOptions"] = {**DEFAULTS, "os": "MacIntel", "osVersion": ""}
        expected = profile_options(settings)["browserFingerPrint"]
        verify_profile_configuration({"browserFingerPrint": {"os": "MacIntel",
                                     "osVersion": "14.4"}}, expected)

    def test_legacy_options_receive_session_defaults_and_bounds_are_enforced(self):
        from bitbrowser_options import validate_options
        legacy = {key: value for key, value in DEFAULTS.items() if key not in {'sessionWaitMinutes', 'sessionRetryLimit'}}
        self.assertEqual(validate_options(legacy), DEFAULTS)
        for changes in ({'sessionWaitMinutes': 0}, {'sessionWaitMinutes': 11},
                        {'sessionWaitMinutes': 1.5}, {'sessionRetryLimit': -1},
                        {'sessionRetryLimit': 10}, {'sessionRetryLimit': True}):
            with self.subTest(changes=changes), self.assertRaises(Stop):
                validate_options({**DEFAULTS, **changes})

    def test_retry_limit_defaults_to_ten_attempts_and_preserves_explicit_saved_limit(self):
        from bitbrowser_options import validate_options
        self.assertEqual(validate_options(None)['sessionRetryLimit'], 9)
        self.assertEqual(validate_options({**DEFAULTS, 'sessionRetryLimit': 2})['sessionRetryLimit'], 2)
        for limit in (0, 9):
            self.assertEqual(validate_options({**DEFAULTS, 'sessionRetryLimit': limit})['sessionRetryLimit'], limit)

    def test_expected_country_is_optional_and_never_uses_billing_country(self):
        value = payload()
        connector.validate_payload(value)
        value['bitBrowser']['expectedCountryCode'] = 'PH'
        connector.validate_payload(value)
        for country in ('ph', 'Philippines', '', 123):
            value['bitBrowser']['expectedCountryCode'] = country
            with self.subTest(country=country), self.assertRaises(Stop):
                connector.validate_payload(value)

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
