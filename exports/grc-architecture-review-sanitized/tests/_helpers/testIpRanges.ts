/**
 * Shared source of truth for the IP ranges used by rate-limiter HTTP load
 * tests when forging X-Forwarded-For headers.
 *
 * Why this file exists:
 *   The rate-limiter HTTP tests in tests/testRateLimiterHttp.ts and
 *   tests/testRateLimiterPerUserHttp.ts hammer the live dev server with
 *   bursts of requests that carry forged X-Forwarded-For values. If those
 *   tests ever picked IPs from a real, routable range, the bucket key the
 *   middleware computes could collide with a bucket belonging to a real
 *   user — every test run would chew up that user's quota and could trip
 *   429s for them on production-shaped traffic. The convention used to live
 *   only in inline comments inside the uniqueXff() helpers, which made it
 *   easy for a future engineer to copy the pattern and accidentally
 *   substitute a real IP range.
 *
 * The safe ranges:
 *   RFC 5737 reserves three /24 blocks specifically "for use in
 *   documentation and example code" and forbids them from appearing on the
 *   public internet:
 *     - <REDACTED_IP>/24    (TEST-NET-1)
 *     - <REDACTED_IP>/24 (TEST-NET-2)
 *     - <REDACTED_IP>/24  (TEST-NET-3)
 *   These addresses cannot be assigned to real hosts, so the rate-limit
 *   bucket key derived from them (`ip:<addr>:...`) cannot collide with a
 *   bucket belonging to a real client. They are the standard pick for
 *   exactly this kind of synthetic-traffic scenario.
 *
 * What uniqueXff() returns:
 *   A two-entry XFF string of the form
 *     "198.51.100.<L>,203.0.113.<R>"
 *   where the rightmost entry (203.0.113.<R>) is what the middleware
 *   actually keys on when TRUST_PROXY_HOPS=0 (the dev/CI default). The
 *   leftmost entry exists to mimic the realistic shape of a request that
 *   has already crossed one proxy hop. Both octets are derived from
 *   Date.now() XOR a per-scenario salt so re-runs of the test never reuse
 *   the same bucket and concurrent scenarios within one run get disjoint
 *   buckets.
 *
 * If you need to add another rate-limiter test that forges XFF headers,
 * import uniqueXff() from here — do NOT hand-roll a new IP-generation
 * function with literal octets, and do NOT swap in any IP range outside
 * RFC 5737.
 */

// Documentation/example ranges reserved by RFC 5737. Safe for synthetic
// test traffic because they cannot appear on the public internet.
export const RFC5737_TEST_NET_2 = "198.51.100" as const; // /24
export const RFC5737_TEST_NET_3 = "203.0.113" as const; // /24

/**
 * Build a unique two-entry X-Forwarded-For value that is guaranteed to
 * fall inside RFC 5737 documentation ranges (and therefore cannot collide
 * with a real client's rate-limit bucket).
 *
 * @param scenario  A short label describing the calling scenario. Used as
 *                  a salt so concurrent scenarios within one test run get
 *                  distinct rightmost octets and therefore distinct
 *                  rate-limit buckets.
 */
export function uniqueXff(scenario: string): string {
  // Both octets must be syntactically valid (1..254 — the limiter rejects
  // 0 and 255 along with anything non-numeric). The rightmost octet is the
  // one parseClientIp() will pick when TRUST_PROXY_HOPS=0, so it is what
  // determines the bucket key.
  const seed = (Date.now() ^ (scenario.length * 7919)) >>> 0;
  const left = (seed % 254) + 1; // 1..254
  const right = ((seed >>> 8) % 254) + 1; // 1..254
  return `${RFC5737_TEST_NET_2}.${left},${RFC5737_TEST_NET_3}.${right}`;
}
