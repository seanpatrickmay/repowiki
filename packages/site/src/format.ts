const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * "2026-03-10T16:30:00+01:00" -> "10 March 2026". Reads the calendar date as written, in the
 * committer's own offset, so output never depends on the build machine's time zone.
 */
export function formatDate(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split("-").map(Number);
  return `${day} ${MONTHS[(month ?? 1) - 1]} ${year}`;
}

const NUMBER = new Intl.NumberFormat("en-US");

export function formatNumber(n: number): string {
  return NUMBER.format(n);
}

export const shortSha = (sha: string): string => sha.slice(0, 7);
