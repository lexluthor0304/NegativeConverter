import copy
import datetime
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("ios_package", Path(__file__).with_name("verify-ios-package.py"))
ios = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ios)


class DistributionValidation(unittest.TestCase):
    def setUp(self):
        self.profile = {
            "TeamIdentifier": [ios.TEAM_ID], "Platform": ["iOS"],
            "ExpirationDate": datetime.datetime(2027, 1, 1),
            "Entitlements": {"application-identifier": f"{ios.TEAM_ID}.{ios.BUNDLE_ID}", "get-task-allow": False}
        }
        self.now = datetime.datetime(2026, 10, 19, tzinfo=datetime.timezone.utc)

    def test_store_profile(self):
        self.assertEqual(ios.validate_profile(self.profile, self.now)["bundleId"], ios.BUNDLE_ID)

    def test_wrong_profile_types_and_expiration(self):
        for field, value in [("Platform", ["OSX"]), ("TeamIdentifier", ["OTHERTEAM"]),
                             ("ProvisionedDevices", []), ("ProvisionsAllDevices", True),
                             ("ExpirationDate", datetime.datetime(2026, 1, 1))]:
            with self.subTest(field=field):
                changed = {**self.profile, field: value}
                with self.assertRaises(ValueError):
                    ios.validate_profile(changed, self.now)

    def test_wrong_application_or_debug_entitlement(self):
        for field, value in [("application-identifier", f"{ios.TEAM_ID}.*"), ("get-task-allow", True)]:
            changed = copy.deepcopy(self.profile)
            changed["Entitlements"][field] = value
            with self.assertRaises(ValueError):
                ios.validate_profile(changed, self.now)

    def test_signer_must_belong_to_profile(self):
        profile = {"DeveloperCertificates": [b"permitted-certificate"]}
        ios.validate_signing_certificate(b"permitted-certificate", profile)
        for certificate in [b"another-certificate", b""]:
            with self.assertRaises(ValueError):
                ios.validate_signing_certificate(certificate, profile)
        with self.assertRaises(ValueError):
            ios.validate_signing_certificate(b"permitted-certificate", {})

    def test_ipa_identity_and_both_families(self):
        info = {"CFBundleIdentifier": ios.BUNDLE_ID, "CFBundleShortVersionString": "1.0.0",
                "CFBundleVersion": "1.1", "UIDeviceFamily": [1, 2],
                "CFBundleSupportedPlatforms": ["iPhoneOS"], "MinimumOSVersion": "17.0"}
        ios.validate_info(info, "1.0.0", "1.1")
        for field, value in [("CFBundleIdentifier", "other.app"), ("CFBundleShortVersionString", "1.0.12"),
                             ("CFBundleVersion", "100001200"), ("UIDeviceFamily", [1]),
                             ("CFBundleSupportedPlatforms", ["iPhoneSimulator"]), ("MinimumOSVersion", "18.0")]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                ios.validate_info({**info, field: value}, "1.0.0", "1.1")


if __name__ == "__main__":
    unittest.main()
