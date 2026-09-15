const DEFAULT_TIMEZONE = "Asia/Karachi";

function partsFor(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      parts[part.type] = part.value;
    }
  }

  return parts;
}

function resolveDate(value) {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "number") {
    return new Date(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return new Date();
}

function getTimeContext(value, timeZone = DEFAULT_TIMEZONE) {
  const date = resolveDate(value);
  const parts = partsFor(date, timeZone);
  const hour = parts.hour === "24" ? "00" : parts.hour;

  return {
    date,
    timeZone,
    operationalDate: `${parts.year}-${parts.month}-${parts.day}`,
    timeHm: `${hour}:${parts.minute}`,
    iso: date.toISOString(),
  };
}

function formatDisplayDateTime(value, timeZone = DEFAULT_TIMEZONE) {
  const date = resolveDate(value);
  const parts = {};

  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      parts[part.type] = part.value;
    }
  }

  const dayPeriod = String(parts.dayPeriod || "").replace(/\./g, "").toUpperCase();
  return `${parts.day}-${parts.month}-${parts.year} ${parts.hour}:${parts.minute} ${dayPeriod}`.trim();
}

function isTimeBetween(current, start, end) {
  if (!current || !start || !end) {
    return false;
  }

  if (start <= end) {
    return current >= start && current <= end;
  }

  return current >= start || current <= end;
}

module.exports = {
  DEFAULT_TIMEZONE,
  getTimeContext,
  formatDisplayDateTime,
  isTimeBetween,
  resolveDate,
};
