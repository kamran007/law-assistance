/** Today's date in Asia/Dhaka as YYYY-MM-DD (dates are shown in Dhaka time, TRD §4 conventions). */
export function dhakaToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
