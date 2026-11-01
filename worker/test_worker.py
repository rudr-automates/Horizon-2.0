import unittest

from whisper_worker import normalize_whisper_json, parse_timestamp


class TimestampTests(unittest.TestCase):
    def test_whisper_json_normalizes_segment_timestamps(self):
        result = normalize_whisper_json({"transcription": [{
            "timestamps": {"from": "00:00:00,000", "to": "00:00:01,250"},
            "text": "  hello world  ",
        }]}, 2.0)
        self.assertEqual(result, [{"start": 0.0, "end": 1.25, "text": "hello world"}])

    def test_invalid_or_out_of_duration_segment_is_rejected(self):
        with self.assertRaises(ValueError):
            normalize_whisper_json({"transcription": [{
                "timestamps": {"from": "00:00:02,000", "to": "00:00:03,000"}, "text": "late",
            }]}, 2.0)

    def test_out_of_order_segments_are_rejected(self):
        with self.assertRaises(ValueError):
            normalize_whisper_json({"transcription": [
                {"timestamps": {"from": "00:00:01,000", "to": "00:00:02,000"}, "text": "first"},
                {"timestamps": {"from": "00:00:00,500", "to": "00:00:01,500"}, "text": "second"},
            ]}, 4.0)

    def test_bad_timestamp_format_is_rejected(self):
        with self.assertRaises(ValueError):
            parse_timestamp("NaN")


if __name__ == "__main__":
    unittest.main()
