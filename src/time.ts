interface LocalParts {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
    let formatter = FORMATTERS.get(timeZone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat("en-CA", {
            timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23",
        });
        FORMATTERS.set(timeZone, formatter);
    }
    return formatter;
}

function localParts(epochMs: number, timeZone: string): LocalParts {
    const values = Object.fromEntries(
        formatterFor(timeZone)
            .formatToParts(epochMs)
            .filter((part) => part.type !== "literal")
            .map((part) => [part.type, Number(part.value)]),
    );
    return {
        year: values.year,
        month: values.month,
        day: values.day,
        hour: values.hour,
        minute: values.minute,
    };
}

function addCalendarDays(parts: LocalParts, days: number): LocalParts {
    const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
    return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hour: parts.hour,
        minute: parts.minute,
    };
}

function findEpochForLocal(parts: LocalParts, timeZone: string, afterMs: number): number | null {
    const wallClockMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const possibleOffsets = new Set<number>();
    for (const delta of [-86_400_000, 0, 86_400_000]) {
        const sample = wallClockMs + delta;
        const local = localParts(sample, timeZone);
        const representedLocalMs = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
        possibleOffsets.add(representedLocalMs - Math.floor(sample / 60_000) * 60_000);
    }

    const candidates = [...possibleOffsets]
        .map((offset) => wallClockMs - offset)
        .filter((candidate) => {
            if (candidate <= afterMs) return false;
            const actual = localParts(candidate, timeZone);
            return actual.year === parts.year
                && actual.month === parts.month
                && actual.day === parts.day
                && actual.hour === parts.hour
                && actual.minute === parts.minute;
        });
    return candidates.length > 0 ? Math.min(...candidates) : null;
}

export function parseAlarmTime(value: string): { hour: number; minute: number } {
    const match = /^(?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d)$/.exec(value);
    if (!match?.groups) {
        throw new Error("時刻はHH:mm形式で指定してください。例: 07:30");
    }
    return { hour: Number(match.groups.hour), minute: Number(match.groups.minute) };
}

export function nextOccurrence(value: string, timeZone: string, nowMs: number): number {
    const requested = parseAlarmTime(value);
    const nowLocal = localParts(nowMs, timeZone);
    for (let extraDays = 0; extraDays < 3; extraDays += 1) {
        const target = addCalendarDays({ ...nowLocal, ...requested }, extraDays);
        const epochMs = findEpochForLocal(target, timeZone, nowMs);
        if (epochMs !== null) return epochMs;
    }
    throw new Error("指定時刻をタイムゾーン上の日時へ変換できませんでした。");
}

export function explicitOccurrence(value: string, timeZone: string, nowMs: number): number {
    const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
    if (!match) throw new Error("日時はYYYY-MM-DDTHH:mm形式で指定してください。");
    const [, year, month, day, hour, minute] = match;
    const parts = {
        year: Number(year), month: Number(month), day: Number(day),
        hour: Number(hour), minute: Number(minute),
    };
    const calendar = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    if (calendar.getUTCFullYear() !== parts.year || calendar.getUTCMonth() + 1 !== parts.month
        || calendar.getUTCDate() !== parts.day) throw new Error("指定日付が存在しません。");
    const epoch = findEpochForLocal(parts, timeZone, nowMs);
    if (epoch === null) throw new Error("指定日時は過去か、タイムゾーン上に存在しません。");
    return epoch;
}

export function formatAlarmDate(epochMs: number, timeZone: string): string {
    return new Intl.DateTimeFormat("ja-JP", {
        timeZone,
        dateStyle: "full",
        timeStyle: "short",
    }).format(epochMs);
}
