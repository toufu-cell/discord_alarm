import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { nextOccurrence, parseAlarmTime } from "../src/time.ts";
import { normalizeYouTubeUrl } from "../src/youtube.ts";

test("翌朝、同じ分の翌日、夏時間の欠落と重複を正しく算出する", () => {
    assert.equal(
        nextOccurrence("07:30", "Asia/Tokyo", Date.parse("2026-09-19T14:00:00Z")),
        Date.parse("2026-09-19T22:30:00Z"),
    );
    assert.equal(
        nextOccurrence("07:30", "Asia/Tokyo", Date.parse("2026-09-18T22:30:00Z")),
        Date.parse("2026-09-19T22:30:00Z"),
    );
    assert.equal(
        nextOccurrence("02:30", "America/New_York", Date.parse("2026-03-08T06:00:00Z")),
        Date.parse("2026-03-09T06:30:00Z"),
    );
    assert.equal(
        nextOccurrence("01:30", "America/New_York", Date.parse("2026-11-01T04:00:00Z")),
        Date.parse("2026-11-01T05:30:00Z"),
    );
    assert.equal(
        nextOccurrence("01:30", "America/New_York", Date.parse("2026-11-01T05:45:00Z")),
        Date.parse("2026-11-01T06:30:00Z"),
    );
    assert.throws(() => parseAlarmTime("25:00"), /HH:mm/);
});

test("設定値の範囲とYouTube動画IDを検証する", () => {
    const config = loadConfig({}, { requireDiscord: false });
    assert.equal(config.volumePercent, 35);
    assert.equal(config.snoozeLimit, 3);
    assert.equal(config.previewSeconds, 30);
    assert.throws(() => loadConfig({ ALARM_VOLUME_PERCENT: "101" }, { requireDiscord: false }), /ALARM_VOLUME_PERCENT/);
    assert.throws(() => loadConfig({ ALARM_TIME_ZONE: "Invalid/Zone" }, { requireDiscord: false }), /ALARM_TIME_ZONE/);
    assert.equal(
        normalizeYouTubeUrl("https://youtu.be/BaW_jenozKc?si=tracking").canonicalUrl,
        "https://www.youtube.com/watch?v=BaW_jenozKc",
    );
    for (const value of [
        "http://www.youtube.com/watch?v=BaW_jenozKc",
        "https://youtube.com.evil.test/watch?v=BaW_jenozKc",
        "https://www.youtube.com/playlist?list=BaW_jenozKc",
        "https://www.youtube.com/watch?v=BaW_jenozKc&list=PL123",
        "https://youtu.be/BaW_jenozKc/other",
    ]) assert.throws(() => normalizeYouTubeUrl(value));
});
