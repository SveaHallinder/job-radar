const STOCKHOLM_TIME_ZONE = "Europe/Stockholm";
const RUN_HOURS = new Set([8, 16]);
const formatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: STOCKHOLM_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function stockholmHourAndMinute(date: Date): { hour: number; minute: number } {
  const parts = formatter.formatToParts(date);
  return {
    hour: Number(parts.find((part) => part.type === "hour")?.value),
    minute: Number(parts.find((part) => part.type === "minute")?.value),
  };
}

export function getNextStockholmRun(now: Date): Date {
  const minuteStart = new Date(now);
  minuteStart.setUTCSeconds(0, 0);

  for (let minuteOffset = 1; minuteOffset <= 1_500; minuteOffset += 1) {
    const candidate = new Date(minuteStart.getTime() + minuteOffset * 60_000);
    const local = stockholmHourAndMinute(candidate);
    if (local.minute === 0 && RUN_HOURS.has(local.hour)) {
      return candidate;
    }
  }

  throw new Error("[job radar] Could not calculate the next Stockholm sync time");
}
