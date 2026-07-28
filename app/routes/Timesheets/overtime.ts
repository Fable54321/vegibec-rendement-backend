const REGULAR_WEEK_MINUTES = 40 * 60;

type DailyDurationRow = {
  day: string | Date;
  net_minutes: string | number;
  [key: string]: unknown;
};

const getDayKey = (day: string | Date) => {
  if (day instanceof Date) {
    return day.toISOString().slice(0, 10);
  }

  return day.slice(0, 10);
};

const getWeekKey = (day: string | Date) => {
  const [year, month, date] = getDayKey(day).split("-").map(Number);
  const utcDate = new Date(Date.UTC(year, month - 1, date));
  const daysSinceMonday = (utcDate.getUTCDay() + 6) % 7;
  utcDate.setUTCDate(utcDate.getUTCDate() - daysSinceMonday);

  return utcDate.toISOString().slice(0, 10);
};

export const addOvertimeTotals = <T extends DailyDurationRow>(rows: T[]) => {
  const weeklyTotals = new Map<string, number>();

  rows.forEach((row) => {
    const weekKey = getWeekKey(row.day);
    weeklyTotals.set(
      weekKey,
      (weeklyTotals.get(weekKey) ?? 0) + Number(row.net_minutes ?? 0),
    );
  });

  const weeklyOvertime = new Map(
    Array.from(weeklyTotals, ([weekKey, minutes]) => [
      weekKey,
      Math.max(0, minutes - REGULAR_WEEK_MINUTES),
    ]),
  );

  const total_overtime_minutes = Array.from(weeklyOvertime.values()).reduce(
    (total, minutes) => total + minutes,
    0,
  );

  return rows.map((row) => ({
    ...row,
    weekly_overtime_minutes: weeklyOvertime.get(getWeekKey(row.day)) ?? 0,
    total_overtime_minutes,
  }));
};
