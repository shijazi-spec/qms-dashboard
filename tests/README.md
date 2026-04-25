# tests/

This directory holds the project's test suite. Most files are run by the
Vitest configuration in `tests/vitest/`; a handful of stand-alone load tests
(prefixed `testRateLimiter*.ts`) are run directly with
`npx tsx tests/<file>.ts` because they fire real HTTP at the dev server.

## Forging X-Forwarded-For headers in load tests

Several rate-limiter tests need to forge `X-Forwarded-For` so each scenario
gets its own bucket on the server. **Always use `uniqueXff()` from
`tests/_helpers/testIpRanges.ts`.** That helper is the single source of
truth for which IP ranges are safe to use as synthetic test traffic.

The helper picks addresses from RFC 5737's `198.51.100.0/24` (TEST-NET-2)
and `203.0.113.0/24` (TEST-NET-3) blocks. Those blocks are reserved for
documentation and example code and cannot appear on the public internet,
so the rate-limit bucket key derived from them
(`ip:<addr>:...` inside the middleware) cannot collide with a bucket
belonging to a real user.

> Do not hand-roll a new XFF generator with literal IPs, and do not swap
> in a non-RFC-5737 range. A test that bursts 100+ requests/min using a
> real, routable IP will eat that user's rate-limit quota and can trigger
> 429s for them on production-shaped traffic.

If you add a new HTTP-level rate-limiter test, import the helper:

```ts
import { uniqueXff } from './_helpers/testIpRanges';

const xff = uniqueXff('my-new-scenario');
// → "198.51.100.<L>,203.0.113.<R>" — safe, scenario-unique, parseable
```

The header parser the middleware uses (`parseClientIp`) reads the
**rightmost** entry when `TRUST_PROXY_HOPS=0` (the dev/CI default), so
that octet is what determines the bucket key. The leftmost entry is just
there to mimic the realistic shape of a request that has crossed a proxy.

Files that already use the helper:

- `tests/testRateLimiterHttp.ts`
- `tests/testRateLimiterPerUserHttp.ts`
