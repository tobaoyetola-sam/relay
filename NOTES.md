SHIP WITH CONDITIONS

# relay: production readiness notes

**Short version.** The service itself is now ready for 400 req/s. It holds that
rate on 3 pods with no errors, and it survives a full rollout under load with no
errors. What is **not** ready is the path around it: leaked credentials,
no TLS, no way for prod to get its database secret, and Terraform that has
never been applied (and would not have worked). I would ship Friday only if
the conditions in section 3 are met by Thursday noon. If they aren't, it's a no.

Final load test (400 req/s, 5 min, 8 KB payloads, 5% replays; README peak, not the handoff's 150):

```
total: sent=119996 status[201:114050 409:5946] errors[-] p50=8ms p95=14ms p99=61ms
```

Raw output for every run is in `docs/loadtests/`.

| Run | Result |
|---|---|
| As received, after the start-up fixes only, 150 req/s | `total: sent=44997 status[201:41281 409:2108 500:70] errors[ECONNRESET:1028 TIMEOUT:510]`, pod **OOMKilled twice** |
| All fixes, 400 req/s, 5 min | 0 errors, 0 restarts (above) |
| All fixes, 400 req/s, `rollout restart` mid-run | 19 ECONNRESET, then fixed: **0 errors** in 47,989 requests |

**Decisions I made where the brief was ambiguous**
- Peak load: the handoff says 150 req/s, the README says 400. I sized and tested for 400.
- I treated archiving to S3 as best effort (see item 2 below) because the event is already durably stored in Postgres.

## 1. What I changed, in the order I'd defend it

1. **Made `make up` work** (`b1568fd`). There were four separate failures, each seen: `npm ci` with no lockfile; `ErrImagePull` (a `:latest` tag means pull policy Always); secret key `database-url` vs `DATABASE_URL`; app listening on 8080 while the probe and Service used 3000, so liveness restarted it in a loop. It now uses 8080 everywhere, per the platform rule.
2. **Idempotency moved into Postgres** (`7672782`). This is the most important change. Deduplication lived in a per-pod Map, so a replay that reached a different pod, or any pod after a restart, hit the unique index and got a **500 instead of 409**. The baseline run shows 70 of these right after each OOM restart. The same Map held every payload forever, which caused the OOMs (and explains "a couple of OOM restarts in staging" that went away only because staging traffic is tiny). The fix is `INSERT ... ON CONFLICT DO NOTHING`, then returning the original id. I verified 201 then 409 ×5, served by different pods.
3. **Database connection budget** (`2b3396f`). The old config allowed 25 per pod × 10 pods = 250, against a hard cap of 100. It's now 8 × 10 = 80, plus room for rollout surge and the migrator; the arithmetic is written down in `k8s/configmap.yaml`. At 400 req/s, inserts take about 8 ms, so each pod needs about 1 to 2 connections; 8 is generous.
4. **Safe deploys** (`7672782`, `d89c708`, `1a3d487`, `2b3396f`). "Zero-downtime" in the handoff wasn't true: there was no readiness probe, `sh` and `npm` swallowed SIGTERM, and liveness checked the database, so one DB blip would restart every pod at once. Changes:
   - separate `/livez` (process only) and `/readyz` (includes the DB)
   - graceful drain, with `Connection: close` while draining
   - node runs as PID 1
   - `maxUnavailable: 0`, a PDB, and min 3 replicas spread across zones
   - migrations moved to an init container with an advisory lock and one transaction per migration (previously concurrent starts raced; I verified 3 pods starting at once, one applies, two wait)
5. **CI would have broken prod** (`66485b4`). `kubectl apply -f k8s/` deployed `postgres.yaml` (an emptyDir database) and the local `secret.yaml` to production. Now:
   - the deploy applies an explicit list of manifests
   - a check job runs first
   - image tags are the commit SHA, not `latest`
   - AWS access uses OIDC, not static keys
   - actions are pinned to versions, not `@master`
   - the deploy waits for `rollout status` and rolls back automatically if the rollout fails
6. **Secrets out of the image and repo** (`1a3d487`). `app/.env` contained the staging DB password and signing secret, and `RUN rm -f .env` still left the file inside an image layer. Now there's a `.dockerignore` and a `.env.example`; the image is slim and runs as non-root with a read-only root filesystem. Memory: Node heap 320 MB inside a 512Mi limit (it was a 512 MB heap inside a 256Mi limit).
7. **Terraform** (`f5e9f33`, validate only, never applied). The ALB targets the NodePort (30080), but the node security group only allowed **8080**, so every target would have been unhealthy and prod would have served nothing. Also fixed:
   - node group was in one AZ only; now both
   - node role had `s3:*`/`secretsmanager:*` on `*`; scoped down to what relay uses
   - IMDSv2 required; EBS volumes encrypted
   - SSH open to the world on nodes and bastion; closed
   - bastion AMI was a us-east-2 id that doesn't exist in eu-west-1
   - committed production DB password removed from the code
   - S3 bucket: public access blocked, encrypted, versioned
   - ALB health check moved to `/livez`; provider versions pinned
8. **Small correctness fixes**: 415 for non-JSON bodies (these used to be stored as `{}` with a 201); 404 for non-uuid ids (used to be a 500); access logs go to stdout (they went to a file in the container that nothing collected and nothing rotated).

## 2. Found and deliberately left

- **No authentication at all.** The ALB is public and anyone can POST events or `GET /events/:id` and read a payload. This is a product/security decision, not a Friday code change. **This is a launch condition.**
- **No TLS.** The ALB listens on HTTP:80 only. It needs a domain and an ACM certificate. Launch condition.
- **Prod has no path for `relay-secrets`.** Terraform puts the DB URL in Secrets Manager, but nothing syncs it into the cluster, and CI (correctly) no longer applies the local Secret. Without it, pods fail with `CreateContainerConfigError`. This needs External Secrets or the Secrets Store CSI driver from the platform team.
- **Credentials already leaked in git history**: staging DB password, staging signing secret, prod DB password (`variables.tf`). Removing them from HEAD doesn't help; **they must be rotated.** The prod password also ends up in Terraform state through `aws_secretsmanager_secret_version`; better to let RDS manage the password.
- **Archive is best effort.** If S3 fails after the insert, I log the id and return 201 (a 500 would make the client retry, get 409, and the archive is lost anyway). The proper fix is an outbox table plus a worker. **Not tested locally** (no bucket).
- **Node-role credentials.** Every pod on a node gets the archive permissions. Move to IRSA or EKS Pod Identity for the relay service account, then set the IMDS hop limit to 1.
- **Database growth.** Locally, 205k events took 1.76 GB. At sustained peak that's about **300 GB/day**, with no retention or partitioning. The data team needs to know before launch.
- **Autoscaling not exercised locally.** kind has no metrics-server, and installing it needs kubelet TLS checks turned off, so I left it as an optional `make metrics-server`. Three pods handled 400 req/s without scaling.
- Terraform also has: nodes in public subnets with public IPs; EKS API open to `0.0.0.0/0`; no remote state backend; no EKS control-plane logging; no secrets encryption; no WAF. All written up, none changed.
- No dashboards or alerts, as the handoff says. The minimum before launch: 5xx rate, p99, pod restarts, DB connections in use.
- Future migrations should use `CREATE INDEX CONCURRENTLY`; migration 3's non-concurrent index is only fine on an empty prod table.
- The load tests ran on a laptop against a local database, so prod latency to managed Postgres will differ.

## 3. Friday

**Ship with conditions.** The service code and manifests are ready. These must be done by Thursday noon, or **do not ship**:

1. **Data team:** rotate the prod and staging DB passwords and the signing secret. Confirm the 80-connection budget and the storage growth.
2. **Platform:** provide a mechanism to deliver `relay-secrets` from Secrets Manager. Confirm the "8080 only" policy allows the ALB to reach NodePort 30080 (or move to the AWS Load Balancer Controller in IP mode, which targets pods on 8080 directly and removes that conflict).
3. **Security/product:** decide on authentication. Provide a domain and certificate for HTTPS.
4. **Us:** run `terraform plan` (and ideally an apply to a non-prod account) before Friday, since it has never been applied. Repeat the 400 req/s test against real infrastructure. Set up the four alerts above.

## 4. Questions I'd have asked

- Is the peak 150 or 400 req/s, and is that sustained or bursty?
- Should idempotency keys be unique globally or per client? Today two clients sending the same key collide, and the second gets the first one's event id. Same key with a different payload also returns 409 silently; should that be 422?
- Is the S3 archive a compliance requirement (must never be missed) or a convenience? That decides whether an outbox is needed before launch.
- How long must events stay in Postgres if they're archived to S3?
- Who is on call for relay after Friday, and where do alerts go?
