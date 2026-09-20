# Monthly provider cost controls

This deployment uses one persistent application-layer ledger for OpenAI,
Soniox and the Google Maps Platform services used by the assistant. It is a
defence-in-depth control, not a replacement for provider budgets, billing
alerts or API quotas.

## Default monthly plan

| Provider | Application cap | What is counted |
| --- | ---: | --- |
| OpenAI | $50 | Responses input/cached/cache-write/output tokens and web-search calls |
| Soniox | $20 | Estimated streaming audio, context and returned transcript tokens |
| Google | $10 | Paid use above each active SKU's monthly free allowance |
| **All providers** | **$80** | Shared hard cap across the three rows |

Lightsail, snapshots, DNS/domain registration and network egress are separate
infrastructure costs. They are not included in the $80 provider cap.

The values are configured with `COST_TOTAL_MONTHLY_USD`,
`COST_OPENAI_MONTHLY_USD`, `COST_SONIOX_MONTHLY_USD` and
`COST_GOOGLE_MONTHLY_USD`. The provider caps must not add up to more than the
shared cap. The service refuses to start if this configuration or the durable
ledger is invalid.

## Google SKU plan

The implementation follows the current Google Maps Platform per-SKU monthly
free allowances and resets the local accounting month at midnight US Pacific
time on the first day of each month.

| Active SKU | Free events/month | First paid rate | Email alert |
| --- | ---: | ---: | --- |
| Places Text Search Enterprise | 1,000 requests | $35 / 1,000 | 50%, 95% |
| Routes Compute Route Matrix Pro | 5,000 elements | $10 / 1,000 | 95% |
| Routes Compute Route Matrix Essentials | 10,000 elements | $5 / 1,000 | 95% |
| Time Zone | 10,000 requests | $5 / 1,000 | 95% |
| Weather | 10,000 requests | $0.15 / 1,000 | 95% |
| Air Quality | 10,000 requests | $5 / 1,000 | 95% |
| Pollen | 5,000 requests | $10 / 1,000 | 95% |

Route Matrix is counted by returned route element, not by HTTP request. A
successful retry is another billable event. An uncertain timeout keeps its
pessimistic reservation so a provider outage cannot make the ledger
optimistically undercount. Known unsuccessful responses release their local
reservation.

Threshold mail goes only to the fixed `EMAIL_TO` recipient using the existing
restricted Gmail SMTP account. It is sent once per SKU/threshold/month and is
not shown on the glasses. Delivery state is persisted, so a restart does not
repeat an accepted alert; a failed/unknown SMTP result stays pending and is
retried after 15 minutes and again after restart. The message contains only the month, SKU, count,
allowance and threshold—never coordinates, conversation content, Calendar
data, audio or credentials.

## Storage and privacy

The ledger is `${EVEN_DATA_DIR}/cost-ledger.json` (normally
`.local/cost-ledger.json`) with owner-only permissions where the platform
supports them. It stores only:

- month key;
- provider cost in integer nano-US-dollars;
- Google SKU unit counts;
- pending/sent alert markers.

Do not delete or manually edit it while the service is running. Back it up with
the rest of `EVEN_DATA_DIR`. A corrupt or unwritable ledger fails closed.

## Accuracy boundaries

- OpenAI defaults match `gpt-5.6-luna` Standard pricing checked on 2026-09-19.
  When the model or service tier changes, update the five `OPENAI_*_USD_*`
  values from official pricing before deployment.
- The retained `gpt-live-transcribe` fallback uses
  `OPENAI_TRANSCRIBE_USD_PER_MINUTE` (default `$0.017` checked on
  2026-09-19) and is charged to the OpenAI allocation.
- Soniox is estimated from audio duration and returned text because the live
  WebSocket result does not carry a final invoice. The reservation is
  deliberately conservative. Provider usage logs remain authoritative.
- Google local counts cover this service only. Google free allowances and
  charges can aggregate across projects attached to the same billing account;
  Cloud Billing is authoritative.
- Provider-side budgets, API restrictions and billing alerts must remain on.
  The application cap cannot stop charges made with the same credentials by a
  different program or a compromised account.

## Operator checks

1. Confirm `.env` has the four monthly caps and current OpenAI unit prices.
2. Confirm SMTP is enabled and `EMAIL_TO` is the fixed owner address.
3. Confirm `.local/cost-ledger.json` is excluded from Git and included in the
   encrypted server backup.
4. Run `npm test` and `npm run audit:public` before deployment.
5. Keep Google Cloud budgets/alerts and API-key IP/API restrictions enabled.

Official references:

- [Google Maps Platform pay-as-you-go and monthly reset](https://developers.google.com/maps/billing-and-pricing/pay-as-you-go)
- [Google Maps Platform pricing](https://developers.google.com/maps/billing-and-pricing/pricing)
- [Google Maps Platform SKU details](https://developers.google.com/maps/billing-and-pricing/sku-details)
- [OpenAI API pricing](https://developers.openai.com/api/docs/pricing)
- [GPT-5.6 Luna model pricing](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
- [Soniox pricing](https://soniox.com/pricing)
