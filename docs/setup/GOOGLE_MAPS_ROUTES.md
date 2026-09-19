# Google Maps route setup

This guide enables the optional current-location ETA path. It is separate from
Google Calendar OAuth: Calendar uses an OAuth client and refresh token; routing
uses a dedicated server-side Google Maps Platform API key.

## What the application does

For a question such as “如果我现在去 West Des Moines Costco 需要多久？”:

1. Luna classifies the route intent and extracts destination/travel mode. It does
   not receive the phone coordinates.
2. The authenticated WSS session asks the SDK client for one location fix. The
   client tries at most three times: high accuracy for 7 seconds, high for 5, then
   medium for 3. A fix weaker than 100 metres is not used.
3. Before the first successful fix, the glasses warn that the phone may show a
   system permission prompt. The current SDK returns a location or `null`; it does
   not expose whether that OS dialog is visible, so the notice is pre-emptive.
4. The backend uses Places Text Search (New) to obtain a bounded candidate set
   together with place type, rating and rating count, then
   sends at most three candidates to one Routes Compute Route Matrix request.
   A nearby/category search starts with a 20 km distance bias and widens once to
   50 km only when empty. A named destination uses Google's maximum legal 50 km
   **soft bias** and relevance ranking: this is not a route limit or geographic
   restriction, and an explicit locality such as `O'Hare Airport, Chicago` can
   override it. The old 100 km circle was invalid for Text Search (New).
   Parking areas, transit stops, pharmacies and store departments are retained:
   each can be the user's intended destination. Driving uses `TRAFFIC_AWARE`;
   walking and cycling never claim live driving traffic.
5. If the candidates represent materially different purposes, Luna receives only
   bounded public place metadata—never the location fix—and either selects the
   type already explicit in the user's request or asks one short clarification.
   Different branches of the same type do not trigger this question. The answer
   is converted into a self-contained query such as `Target parking lot`, obtains
   the newest fresh-enough session fix, and continues the route flow. If this model check fails,
   the assistant asks a conservative bounded question rather than guessing.
   Conversational references follow the same rule: an explicit ordinal/name or a
   single labelled recommendation may resolve a place, while “那个 / that one”
   after multiple unselected candidates must ask and never defaults to item one.
6. If Places genuinely cannot resolve a named temporary event, the API channel
   may spend one call from the existing OpenAI web-search ledger to identify its
   public venue. Luna receives only the bounded query and recent text context,
   never GPS coordinates. A resolved venue is sent back through Places before
   Routes; web text is never trusted directly as a waypoint. Ambiguous evidence
   produces one clarification, and quota/search failure falls back to asking for
   the venue or address.
7. The glasses show at most two useful candidates, ETA/distance, rating evidence,
   traffic delay when applicable, and one concise recommendation. The ranking uses
   a confidence-adjusted rating so one five-star review cannot dominate a
   well-reviewed location; a very low rating with enough reviews is treated as an
   experience risk. It does not scrape or claim to count all negative reviews.
   When multiple candidates have the same display name, a compact address locality
   is appended (for example `Target · Waukee`) and reused in the recommendation.
   Durations below one hour use minutes; longer durations use hours plus remaining
   minutes. Every route shows both imperial and metric distance, with the local
   convention first (for example `329.3 mi (530 km)` in a US timezone).
8. The default mode is driving. Explicit spoken requests for walking/cycling and
   the companion selector override it for the session. A follow-up such as “那走路
   呢？” reuses the recent Place IDs for up to ten minutes but applies walking only
   to that route thread; an unrelated route after a plan/city/topic change returns
   to driving. The companion's explicit selector remains the persistent session
   preference. Each recomputation uses the newest session fix when it is no more
   than two minutes old, otherwise it requests a fresh fix, then recomputes the
   route matrix. Transit is intentionally deferred.
9. For Calendar phrases such as “从现在开始” and relative local dates, the
   backend resolves the newest fresh session coordinates to an IANA timezone through Google
   Time Zone API. Google is the primary authority and receives at most three
   bounded attempts for retryable failures. If it remains unavailable, Luna gets
   only the bounded recent conversation and the phone's validated IANA timezone
   **hint**, never coordinates. It uses an explicit current-location statement
   first, then an established current origin, then the non-conflicting device
   hint. A destination, hotel or future-trip city is not treated as the current
   location. Luna must return a strict structured IANA zone or ask exactly one
   short city/region question; it has no tools or web search in this fallback and
   the request is not stored. The resolved zone name may remain in memory for the
   session; exact coordinates do not. Development presets provide a reviewed
   IANA hint so Los Angeles/New York tests do not inherit the workstation zone.
10. Only bounded place data and route results reach the dialogue. Exact coordinates
   remain only in volatile memory for the connected session, refresh at most every
   10 seconds, become unusable as current after two minutes, and are cleared on
   explicit stop, disconnect or session exit. They are not copied into model input,
   history, logs, analytics, exports or the recent-place cache.
11. If all location attempts fail, the assistant asks for a spoken or typed start
   address. The pending fallback expires after ten minutes. If Maps fails, it offers
   a retry or a clearly non-live web estimate rather than fabricating traffic.

The manual once/continuous buttons remain development diagnostics. After the first
automatic permission-backed fix, the client starts SDK updates for the active app
session at a requested 10-second interval. This is not durable background tracking
and stops when the connection/app session exits.

For an optional live model-only policy check (no Maps call, coordinates, web
search, or real user data), run `npm run route:clarifier:check`. The fixture covers
an umbrella brand, explicit parking, same-purpose branches, hospital/ER/parking,
a geographic qualifier, an explicit bus stop, ordinal reference, unique
recommendation, and ambiguous “that one”. It consumes normal model tokens.

For an optional fallback check, run `npm run route:venue:check`. It uses one
quota-accounted OpenAI web search against a public synthetic event query, passes
no coordinates or private origin, and succeeds only when it returns a bounded
public venue query. Do not run either live check in CI.

## Billing and security prerequisites

Use a dedicated Google Cloud project with billing enabled. The project currently
keeps this reviewed business allowlist enabled:

- Active now: **Places API (New)**, **Routes API**, **Time Zone API**,
  **Weather API**, **Air Quality API**, and **Pollen API**.
- Enabled at project level but not granted to this runtime key: **Geocoding API**.

All other Google Maps Platform products should remain disabled until code that
needs them has passed local review. Google-managed infrastructure services may
also appear in the project's enabled-service list. Do not force-disable a core
service merely because it is not an application API; some are dependencies of
the Google Cloud control plane.

Create a new key only for this backend. Do not reuse the Calendar OAuth secret or a
browser/mobile Maps key. Before any live test, apply both restrictions:

- Application restriction: **IP addresses**. During local testing, authorize only
  the current trusted public egress IP; before Linux deployment, replace/add the
  Lightsail static public egress IP. Remove obsolete IPs after cutover.
- API restrictions: exactly **Places API (New)**, **Routes API**, **Time Zone
  API**, **Weather API**, **Air Quality API**, and **Pollen API**. The fact that
  Geocoding is enabled at project level does not grant this runtime key access.

The project currently reuses one server-only key for these six reviewed APIs so
that route and environment calls share the same two explicit egress-IP
restrictions. A future service must not be added to this allowlist until its
code, quota and privacy behavior have passed review. Splitting services across
multiple restricted keys remains a valid later hardening option.

For local provider smoke tests, keep secrets only in private `.env` and set:

```dotenv
GOOGLE_MAPS_ENABLED=true
GOOGLE_ENVIRONMENT_ENABLED=true
EVEN_CONDITIONAL_TASKS_ENABLED=false
```

Run `npm run environment:check` before starting the simulator. It calls all
three environment services concurrently using a public fixed test point and
prints normalized evidence only. It never prints the API key, request URL,
coordinates, provider prose, or user preferences. A missing Pollen index may be
a valid unavailable result; an HTTP rejection makes the smoke fail.

Also set conservative Google Cloud quotas and billing alerts. Google quotas/alerts
are separate from the application's OpenAI search ledger and from the OpenAI
project hard spend limit. An unrestricted Maps key can incur charges even if this
application is stopped.

Never place the key in `clients/even/`, `app.json`, a WebView bundle, an `.ehpk`,
source control, a command-line argument, a screenshot or an issue. Store it only in
the local `.env` for development and `/etc/even-agent.env` (mode `0600`) on Linux.

Official references:

- [Routes API](https://developers.google.com/maps/documentation/routes)
- [Traffic quality versus latency](https://developers.google.com/maps/documentation/routes/config_trade_offs)
- [Places Text Search (New)](https://developers.google.com/maps/documentation/places/web-service/text-search)
- [Places fields and billing tiers](https://developers.google.com/maps/documentation/places/web-service/data-fields)
- [Places display and caching policies](https://developers.google.com/maps/documentation/places/web-service/policies)
- [Compute Route Matrix](https://developers.google.com/maps/documentation/routes/compute_route_matrix)
- [Time Zone API request and response](https://developers.google.com/maps/documentation/timezone/requests-timezone)
- [Google Maps Platform API key security](https://developers.google.com/maps/api-security-best-practices)
- [Google Maps Platform pricing](https://developers.google.com/maps/billing-and-pricing/pricing)

## Local configuration

Do not overwrite an existing `.env`. Add these values locally:

```dotenv
GOOGLE_MAPS_ENABLED=true
GOOGLE_MAPS_API_KEY=replace-with-the-restricted-server-key
```

Keep the feature disabled when the key has not been created and restricted. The
server intentionally refuses to start if `GOOGLE_MAPS_ENABLED=true` but the key is
missing.

Run the offline gate first; it uses fakes and does not call Google:

```powershell
npm run typecheck
npm test
npm run build:server
Set-Location clients/even
npm test
npm run build
```

`npm run build` only verifies the SDK web bundle. Do not run `pack:hub` at this
stage. Return to the repository root and start the local backend/client/simulator
only after the key restrictions are visible in Google Cloud.

Before testing a relative Calendar time, verify the sixth allowlisted API with
one public, fixed Los Angeles point. The script prints only normalized status and
the IANA zone—never the key, request URL, or coordinates:

```powershell
npm run timezone:check
```

A `REQUEST_DENIED`/403-style failure means Time Zone API is not enabled or not
selected in this server key's API restrictions. Keep the IP restriction; add only
Time Zone API to the reviewed API allowlist.

To validate the model fallback separately with synthetic public context, run:

```powershell
npm run timezone:fallback:check
```

This makes one normal OpenAI API request. It sends a synthetic Los Angeles
sentence and an IANA device hint, but no coordinates, Calendar data, tools, web
search or real user conversation. It does not test or mutate Google Calendar.

After the offline gate, make one low-volume live call from the authorized machine.
Use a broad city, never a home address; the script prints no key or coordinates:

```powershell
npm run maps:check -- "West Des Moines, Iowa" "Target"
npm run maps:check -- "Des Moines, Iowa" "O'Hare International Airport, Chicago, Illinois" destination
```

The optional third argument selects named-destination relevance instead of nearby
distance ranking. These commands check Places API (New) and Routes Compute Route
Matrix together. A 403 means
the key's API or source-IP restriction does not match; fix the restriction rather
than removing it. Do not run this live script in CI.

Safe diagnostic reasons include:

- `API_KEY_IP_ADDRESS_BLOCKED`: the machine's current public egress IPv4 is not in
  the key allowlist. During this explicit local-acceptance window, add only that
  single `/32` address beside the Lightsail static IP. Do not add a broad CIDR or
  remove application restrictions. Remove the workstation IP after local testing;
  a dynamic ISP address requires a later explicit update.
- an API/service restriction reason: confirm that both Places API (New) and Routes
  API are enabled in the project and selected on this key.

Before Linux deployment, keep the production key limited to the Lightsail static
egress IP. Remove any temporary workstation address from that key after local
acceptance, or keep workstation and production keys separate.

## Local acceptance matrix

The user, not only automated tests, must verify these before Linux deployment:

| Case | Expected result |
| --- | --- |
| First route question | Glasses show permission guidance; phone owns the actual OS prompt |
| Permission allowed | One fix, brief locating/routing feedback, compact ETA/distance |
| Permission denied/null | Up to three bounded attempts, then asks for start address |
| Typed start address | Resumes the exact pending destination without requesting GPS again |
| Interruption/cancel/exit | Late SDK result is ignored and location is cleared |

### Local simulated-location matrix

The Vite development companion includes a memory-only simulated-location panel
with six public city/landmark approximations and a random-selection button. It
lets a stationary developer repeat the same route question from Des Moines,
Waukee, West Des Moines, Los Angeles, and New York test points. A selected point
remains active for follow-up comparisons such as walking versus driving until
**Real SDK location** is selected again.

This is a development fixture, not location spoofing in a release build:

- it is loaded only under `import.meta.env.DEV`;
- its labels and coordinates are rejected by the production build audit if they
  appear in `dist`;
- it is never stored in browser storage, conversation history, model context,
  logs, or exported Markdown;
- the server keeps it only in volatile session memory and clears it at stop,
  disconnect or session exit;
- it validates Places/Routes behavior but cannot validate real-device GPS,
  movement, permission prompts, phone backgrounding, or accuracy.
| Low accuracy | Rejected; no coordinate appears in answer/history/log/export |
| Nearby category/chain | At most three candidates are matrixed; glasses show at most two plus a concise recommendation |
| Nearby search outside 20 km | One bounded retry widens the soft bias to 50 km |
| Named destination in another city | Explicit locality can override the 50 km soft bias; Place ID then feeds the long-distance route matrix |
| Temporary event missing from Places | At most one quota-accounted web resolution; result must be revalidated by Places and receives no GPS |
| Duplicate place names | Each duplicate gets a compact city/locality label in both the list and recommendation |
| Long route | `288 minutes` is rendered as `4 hours 48 minutes`; miles and kilometres are both present |
| Rating confidence | Tiny review samples are shrunk toward neutral; established very-low ratings can outweigh a large ETA advantage |
| Drive | Defaults to drive and shows traffic delay only when route data supports it |
| Walk/bicycle | Explicit mode or companion selector recomputes without a live-driving-traffic claim |
| New plan after spoken walk | Old spoken mode is discarded; the independent route defaults to driving |
| Follow-up “那走路呢” | Reuses bounded recent Place IDs and the newest fresh session fix, and skips a second Places search |
| Transit | Treated as unsupported in this POC; it must not silently fall back to driving |
| Maps 429/5xx/network failure | At most three provider attempts, then concise fallback |
| Time Zone API unavailable | Luna uses recent dialogue + validated device-zone hint, without coordinates; conflicting or insufficient evidence asks one city/region question |
| Several matching branches | Assistant compares them rather than silently routing to the first result |

The simulator can validate protocol and UI behavior, but real GPS permission,
accuracy, phone locking/backgrounding and regional service coverage require the
physical phone/G2 gate.

## Linux gate (only after local acceptance)

1. Add the restricted key to `/etc/even-agent.env` using the secure file-transfer
   and `sudo install` procedure from the Linux guide; never paste it into shell
   history.
2. Set `GOOGLE_MAPS_ENABLED=true`.
3. Confirm the key's IP restriction includes the Lightsail static egress IP and no
   broad CIDR range.
4. Deploy only the server-only build and restart through the documented release
   workflow. Do not upload the repository, local `.env`, simulator or SDK source.
5. Run one destination-resolution and one traffic-aware route smoke test. Check
   that application logs contain statuses/error codes but no latitude/longitude or
   API key.
6. Run the post-deployment security checklist: public ports, loopback binding,
   HTTPS/WSS, Origin/token rejection, secret permissions, service sandbox, firewall,
   Maps key/API/IP restrictions, quota/alerts and backup exclusions.

Do not build a new `.ehpk` just for each backend update. Once local, Linux and
security gates pass, perform one final SDK build/package for Even Hub Private
Testing and then validate the real permission/lifecycle behavior.

## Current release gate

- [x] Server/client protocol and route provider implemented.
- [x] Mocked unit/integration tests added.
- [x] Places candidate/rating + Route Matrix, confidence ranking, follow-up reuse and manual modes pass local back-tests.
- [x] Restricted Google Maps key created; server IP and Places/Routes restrictions checked.
- [x] Time Zone API live smoke returned `America/Los_Angeles`; the same server-only key is restricted to exactly six reviewed route/environment/time APIs and trusted egress IPs.
- [x] Unused Maps APIs disabled; project business allowlist reviewed.
- [ ] Maps quotas and Google Cloud billing alerts checked.
- [ ] User local simulator acceptance completed.
- [ ] Linux deployment and live route smoke test completed.
- [ ] Post-deployment security review completed.
- [ ] Physical phone/G2 permission and lifecycle acceptance completed.
- [ ] Final `.ehpk` rebuilt only after all preceding gates are ready.

Weather, Air Quality, and Pollen are optional read-only evidence providers for
the general planning tool loop. Each requires mocked contract coverage and a
successful restricted-key live smoke before its output may affect simulator
acceptance. Provider failure may fall back to bounded public research; missing
data remains unknown and Calendar/Email never inherit this fallback policy.
