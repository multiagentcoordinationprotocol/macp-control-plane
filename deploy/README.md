# Production deployment (single VM, Docker Compose)

Deploys the control plane from GHCR images built by the [release workflow](../.github/workflows/release.yml). Everything runs on one VM: postgres (persistent volume), a one-shot migration job, and the app.

## VM prerequisites

- Docker Engine with Compose v2 (`docker compose version`)
- GHCR pull access: `docker login ghcr.io -u <github-user>` with a classic PAT that has `read:packages`
- This `deploy/` directory copied to the VM (convention: `/opt/macp`)

## First-time setup

```bash
cd /opt/macp
cp .env.prod.example .env.prod
vi .env.prod        # set POSTGRES_PASSWORD, DATABASE_URL, AUTH_API_KEYS, RUNTIME_ADDRESS, ...
chmod +x deploy.sh
```

`.env.prod` is gitignored; every value marked REQUIRED must be set or the app refuses to start (production config validation).

## Deploy / rollback / status

```bash
./deploy.sh deploy v0.5.1    # pull → migrate → up -d → wait for /healthz
./deploy.sh status           # compose ps + current/previous tag
./deploy.sh rollback         # re-deploy the previous tag
```

- `deploy` records the tag in `.current_tag` (and the prior one in `.previous_tag`) only after the app reports healthy. On failure it prints the log and rollback commands and exits non-zero — **it never auto-rolls-back**, because migrations are forward-only.
- `rollback` swaps the app image only. It is safe only across releases that did not change the database schema.

## Remote deploys from GitHub Actions (optional)

`.github/workflows/deploy.yml` is a `workflow_dispatch` job that SSHes into the VM and runs `./deploy.sh deploy <tag>`. It stays dormant until these Actions secrets exist:

| Secret | Value |
|---|---|
| `DEPLOY_SSH_HOST` | VM hostname/IP |
| `DEPLOY_SSH_USER` | SSH user with docker access |
| `DEPLOY_SSH_KEY` | Private key for that user |

## Operations

```bash
TAG=$(cat .current_tag) docker compose -f docker-compose.prod.yml --env-file .env.prod logs -f app
docker volume ls | grep pgdata     # postgres data volume — back this up
```

Back up the `pgdata` volume (e.g. `docker run --rm -v deploy_pgdata:/data -v "$PWD:/backup" alpine tar czf /backup/pgdata.tgz /data`) before major upgrades.
