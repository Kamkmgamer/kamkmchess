# KHA-34 connection evidence

## Scope

This publication contains the connection profile, local credential, disclosure, catalog and request-preparation module. It does not claim KHA-34 completion. The placeholder UI does not use the module, and the module does not send generation requests.

All 79 product acceptance cases remain `not_run`, including `CON-01` through `CON-08`, `DAT-03` and `DAT-08`. The focused deterministic fixtures and static build do not certify a user journey or product acceptance.

## Source and verification

The published branch starts from public PR8 commit `a886c7c787d38feba238010187a032bced8d2203`. Its connection source matches the accepted KHA-34 source commit `30ec162a4b3394065107c7f88076cb58ef5f0df8`. The branch changes add the connection source, its fixtures and support helper, the Node test TypeScript configuration, documentation and the build artifact. The existing controller, protocol, storage and graph modules remain from the public base.

The prior check on the same connection source passed 52 connection tests across seven files, both TypeScript projects, targeted ESLint, the production build and dependency notice generation. That run is reused as source evidence. This publication run did not repeat those tests or the full application suite.

The prior base and controller results were separate: 195 base tests are the 194-test full attempt plus one focused rerun; 26 controller tests were run separately. These results are not one 221-test run, and no single 273-test run is claimed. The focused standards review reported no documented breach. The focused specification corrections were checked with five offline canary probes; they used no fetch calls or real credentials.

The publication run used `npm ci` followed by `npm run build`. The build runs both TypeScript checks, Vite production compilation and dependency notice generation. The committed manifest records the source commit, the eight ZIP members, each member's size and SHA-256 digest, and the archive digest. The ZIP was reopened and its member list and bytes were checked against the build output before it was committed.

The archive was built from source commit `4980ad5cf048a155c553e9e1d82c4e6d70f8eeac`, based on public PR8 commit `a886c7c787d38feba238010187a032bced8d2203`. Its eight members are the static HTML, JavaScript, CSS, hosting headers and redirects, application license, third-party notices and dependency inventory. The archive SHA-256 is `a44a71cabcee1e333d65b7b6888a708a1eefaeff6093cd810ac0404749c8bb62`. See the [build ZIP](artifacts/KHA-34-static-build.zip) and [member SHA-256 manifest](artifacts/KHA-34-static-build.sha256.json).

## Limits and remaining work

Credential-name checks inspect names, not arbitrary values. A caller can still put a secret under an ordinary-looking name. A foreign catalog URL is accepted as a configured destination, bound to the credential assignment and named in the disclosure. Browser CSP and hosted egress policy remain separate; this build does not certify either one.

Successful local mutations revoke bindings only for the same persistence object in the same JavaScript runtime. Saving a profile revokes bindings conservatively even if its network configuration did not change; the caller must resolve the current binding again. Revocation does not cross tabs or separate persistence objects, and it cannot withdraw a prepared request, bytes handed to transport, or bytes already sent.

The account sign-out caller still needs to clear the departing account's local keys and fence requests (`DAT-03`). Sync/export callers still need allowlisted DTOs and recognized credential-echo blocking (`DAT-08`). The connection module does not implement either caller integration. Generation transport, account flows, the connection UI, browser/native/live/second-device runs, and deployed CSP/egress certification remain separate work.
