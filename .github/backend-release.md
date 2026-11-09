# Source compatibility declarations

Automated staging consumes `backend-release.json` from each exact merged source tree. Missing or invalid declarations wait; they are not assumed independent. The declaration does not replace normal tests of the actual combined sources.

Use `{"schema":1,"mode":"independent"}` for an independent change. For a change that depends on a companion source change, use `{"schema":1,"mode":"paired","group":"a-new-unique-group"}` in both source PRs. Use a fresh group for every new dependent change: staging waits until both merged trees declare that group. Do not put credentials, environment addresses or private source contents here.

The initial declaration bootstraps a shared group. It changes no runtime code, schema, test expectation or installed version. Source merges do not authorize a production release.
