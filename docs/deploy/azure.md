# Deploying to Azure Container Apps

file-storage runs as an Azure Container App on the Consumption plan: it scales to zero when idle,
and every push to `main` builds the `Dockerfile` and rolls out a new revision
(`.github/workflows/deploy-azure.yml`). The database stays on Neon and the files stay in R2; no data moves.

The daily cleanup that Vercel Cron used to call (`vercel.json`) becomes a scheduled
Container Apps Job that calls `GET /cron/cleanup` with the cron secret (step 3).

The commands below use the Azure CLI (`az`). Run `az login` first. Names in `<angle brackets>` are yours to choose;
the rest can be copied as is.

## 1. Shared setup (once for all services)

Skip this section if audit-logs or auth already created these.

```sh
RG=brenraphaels-rg
LOCATION=southeastasia            # Singapore, next to Vercel's sin1 and Neon
ENV=brenraphaels-env
ACR=<globally-unique-lowercase-name>   # e.g. brenraphaelsacr

az provider register -n Microsoft.App --wait
az provider register -n Microsoft.OperationalInsights --wait

az group create -n $RG -l $LOCATION
az acr create -g $RG -n $ACR --sku Basic --admin-enabled true
az containerapp env create -g $RG -n $ENV -l $LOCATION
```

Create the identity GitHub Actions deploys with. Copy the whole JSON it prints.

```sh
SUB=$(az account show --query id -o tsv)
az ad sp create-for-rbac --name gh-brenraphaels-deploy --role contributor \
  --scopes /subscriptions/$SUB/resourceGroups/$RG --json-auth
```

Then in the Azure portal, open **Cost Management → Budgets** and add a budget with alerts at 50%, 75% and 90%,
so the student credit cannot run out unnoticed.

## 2. Create the container app

Use the same values as the Vercel project's production environment variables.

```sh
az containerapp create -g $RG -n file-storage --environment $ENV \
  --image mcr.microsoft.com/k8se/quickstart:latest \
  --ingress external --target-port 3000 \
  --min-replicas 0 --max-replicas 2 --cpu 0.5 --memory 1Gi \
  --secrets \
    database-url='<DATABASE_URL>' \
    r2-access-key-id='<R2_ACCESS_KEY_ID>' \
    r2-secret-access-key='<R2_SECRET_ACCESS_KEY>' \
    cron-secret='<CRON_SECRET>' \
    gateway-secret='<GATEWAY_SECRET>' \
  --env-vars \
    PORT=3000 \
    DATABASE_URL=secretref:database-url \
    R2_ACCOUNT_ID='<R2_ACCOUNT_ID>' \
    R2_ACCESS_KEY_ID=secretref:r2-access-key-id \
    R2_SECRET_ACCESS_KEY=secretref:r2-secret-access-key \
    R2_PUBLIC_BUCKET='<R2_PUBLIC_BUCKET>' \
    R2_PRIVATE_BUCKET='<R2_PRIVATE_BUCKET>' \
    R2_PUBLIC_BASE_URL='<R2_PUBLIC_BASE_URL>' \
    CRON_SECRET=secretref:cron-secret \
    GATEWAY_SECRET=secretref:gateway-secret
```

It gets 0.5 vCPU and 1 GiB rather than the smallest size because `sharp` builds image variants in memory.
Add any other variable the Vercel project sets the same way. To change them later, use
`az containerapp secret set` and `az containerapp update --set-env-vars`.

The placeholder image does not listen on port 3000, so the app reports unhealthy until the first deploy.

## 3. Schedule the daily cleanup

Same schedule as `vercel.json`: 03:00 UTC (11:00 in Manila).

The job is defined in YAML because the CLI's `--args` flag cannot take a value that starts with `-`.
The file holds the cron secret, so it goes to `/tmp` and is deleted afterwards; never commit it.
The `\$` escapes are deliberate: those variables are read inside the job, not by your shell.

```sh
URL=https://$(az containerapp show -g $RG -n file-storage --query properties.configuration.ingress.fqdn -o tsv)
ENV_ID=$(az containerapp env show -g $RG -n $ENV --query id -o tsv)

cat > /tmp/cleanup-job.yaml <<EOF
location: $LOCATION
properties:
  environmentId: $ENV_ID
  configuration:
    triggerType: Schedule
    replicaTimeout: 300
    replicaRetryLimit: 1
    scheduleTriggerConfig:
      cronExpression: "0 3 * * *"
      parallelism: 1
      replicaCompletionCount: 1
    secrets:
      - name: cron-secret
        value: "<CRON_SECRET>"
  template:
    containers:
      - name: cleanup
        image: docker.io/curlimages/curl:latest
        resources:
          cpu: 0.25
          memory: 0.5Gi
        env:
          - name: CRON_SECRET
            secretRef: cron-secret
          - name: CLEANUP_URL
            value: "$URL/cron/cleanup"
        command: ["/bin/sh", "-c"]
        args: ['curl -fsS -H "Authorization: Bearer \$CRON_SECRET" "\$CLEANUP_URL"']
EOF

az containerapp job create -g $RG -n file-storage-cleanup --yaml /tmp/cleanup-job.yaml
rm /tmp/cleanup-job.yaml
```

To try it immediately: `az containerapp job start -g $RG -n file-storage-cleanup`, then check
**Execution history** on the job in the portal.

## 4. Connect GitHub Actions

In the GitHub repository, **Settings → Secrets and variables → Actions**:

| Kind | Name | Value |
|---|---|---|
| Secret | `AZURE_CREDENTIALS` | the JSON from `az ad sp create-for-rbac` |
| Variable | `AZURE_RESOURCE_GROUP` | `brenraphaels-rg` |
| Variable | `AZURE_ACR_NAME` | your `$ACR` |
| Variable | `AZURE_CONTAINER_APP` | `file-storage` |

Run the **Deploy to Azure Container Apps** workflow once from the Actions tab (or push to `main`).

## 5. Check it and switch callers over

```sh
curl $URL/health      # {"status":"ok"}
```

Then point every caller at `$URL` instead of the old `*.vercel.app` address:

- the API gateway (brenraphaels-proxy), which routes `/files` here
- any app configured with the file-storage URL directly

Once traffic has moved, remove or disconnect the Vercel project so it stops deploying, and with it the Vercel cron.

## Costs

- The app and the job draw on the Consumption plan's monthly free grant first
  (180,000 vCPU-seconds, 360,000 GiB-seconds and 2 million requests per subscription).
- Azure Container Registry Basic is billed per day (about USD 5 a month), shared by all services.
- The environment's Log Analytics workspace bills for log ingestion beyond its free allowance.
