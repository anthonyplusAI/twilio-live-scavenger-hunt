# CI and deployment checks

The repository has one reusable CI workflow and one Azure release workflow.
They share a single gate named **`Validate`**.

## Pull requests

`.github/workflows/ci.yml` runs on pull requests to `main`. Its **Build and
test** job installs the locked npm dependencies under Node.js 26 and runs
`npm run check`, which builds the Twilio Video browser bundle, runs the server
and Blob lease tests, and checks README image and local links. It also checks deployment shell
syntax. In parallel, **Container build and startup** builds the production
Dockerfile, checks the bundled Litestream version, launches a rehearsal
container with a throwaway admin password, and probes `/health`. The final
`Validate` job fails unless both jobs succeed. CI uses only source code and
test fixtures; it receives no Azure, Twilio, OpenAI, or lead data credentials.

Run the same gate locally before opening a PR:

```sh
npm ci
npm run check
bash -n scripts/provision-azure.sh scripts/deploy-azure.sh scripts/start.sh
```

The script syntax check validates parsing and the container smoke verifies the
image's first boot. A real Azure rollout is still required to prove registry
access, identity permissions, Blob restore, and public ingress.

## Main branch deployment

`.github/workflows/deploy.yml` runs on a `main` push or manual dispatch. Its
first job calls the reusable CI workflow without forwarding secrets. Only a
successful CI result permits the OIDC-authenticated ACR build and the
Container Apps rollout. The image tag identifies the source commit; the
workflow does not reuse a mutable `latest` tag. Deployment concurrency queues
runs rather than cancelling a rollout halfway through.

GitHub's OIDC token can be exchanged only by the dedicated Entra application
that trusts `repo:anthonyplusAI/twilio-live-scavenger-hunt:ref:refs/heads/main`.
The service principal can push to this app's ACR and update only its resource
group. The app has its own managed identity for image pull and Blob backup.
See [infrastructure setup](INFRA_SETUP.md) for the exact roles and GitHub
variables, and [deployment](DEPLOYMENT.md) for release and rollback steps.

Check a run with `gh run list --workflow deploy.yml` and `gh run watch <run-id>
--exit-status`. A green workflow means the candidate revision passed its
health smoke and public traffic was switched; confirm the operator and player
journeys before using the site at an event.
