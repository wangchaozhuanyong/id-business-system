"""Offline compatibility tests for the patched F2 dependency set."""
import os
import unittest
from unittest.mock import patch


class RuntimeTests(unittest.TestCase):
    def test_douyin_entrypoints_and_request_model(self):
        from f2.apps.douyin.utils import TokenManager
        # F2 eagerly fetches a public platform token while importing its models.
        # Keep that network request outside the dependency compatibility check.
        with patch.object(TokenManager, "gen_real_msToken", return_value="local-test-fixture"):
            from f2.apps.douyin.crawler import DouyinCrawler
            from f2.apps.douyin.filter import PostDetailFilter
            from f2.apps.douyin.model import PostDetail
            from f2.apps.douyin.utils import AwemeIdFetcher, ClientConfManager, VerifyFpManager
            self.assertEqual(PostDetail(aweme_id="1234567890123456789").aweme_id, "1234567890123456789")
            self.assertTrue(all((DouyinCrawler, PostDetailFilter, AwemeIdFetcher,
                                 ClientConfManager, VerifyFpManager)))

    def test_f2_aes_round_trips(self):
        from f2.utils.utils import AESEncryptionUtils
        for mode in ("GCM", "CBC", "ECB"):
            helper = AESEncryptionUtils(os.urandom(32), mode=mode,
                                        iv=os.urandom(16) if mode == "CBC" else None)
            with self.subTest(mode=mode):
                self.assertEqual(helper.aes_decrypt(helper.aes_encrypt(b"fixture"), iv=helper.iv), b"fixture")

    def test_f2_rsa_round_trips(self):
        from cryptography.hazmat.primitives.asymmetric import rsa
        from f2.utils.utils import RSAEncryptionUtils
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        for padding in ("pkcs1", "oaep"):
            helper = RSAEncryptionUtils(key, key.public_key(), padding_scheme=padding)
            with self.subTest(padding=padding):
                self.assertEqual(helper.rsa_decrypt(helper.rsa_encrypt(b"fixture")), b"fixture")

    def test_protobuf_json_round_trip(self):
        from google.protobuf import json_format
        from google.protobuf.struct_pb2 import Struct
        message = Struct()
        json_format.ParseDict({"fixture": "ok"}, message)
        self.assertEqual(json_format.MessageToDict(message), {"fixture": "ok"})


if __name__ == "__main__":
    unittest.main()
