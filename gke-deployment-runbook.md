# GKE Service Deployment Runbook

End-to-end guide for deploying AutoShip to a GKE cluster with CI/CD via GitHub Actions and ArgoCD.

> **Note**: This runbook is a generic template. Replace all placeholder values with your own infrastructure details.

---

## Infrastructure Overview

| Component | Detail |
|-----------|--------|
| **GCP Project** | `your-gcp-project-id` |
| **GKE Cluster** | Your GKE cluster (recommended: `us-central1`) |
| **Namespace** | Your Kubernetes namespace |
| **Docker Registry** | `us-central1-docker.pkg.dev/your-project/autoship` |
| **Ingress Controller** | Traefik / Nginx (your choice) |
| **SSL** | Wildcard cert or Let's Encrypt |
| **DNS** | Your DNS provider |
| **Database** | Cloud SQL PostgreSQL (via Auth Proxy sidecar) or self-hosted |

---

## Deployment Steps

### 1. Create Artifact Registry

```bash
gcloud artifacts repositories create autoship \
  --repository-format=docker \
  --location=us-central1 \
  --project=your-gcp-project-id
```

### 2. Create Kubernetes Secrets

```bash
# Application secrets
kubectl create secret generic autoship-secret \
  -n your-namespace \
  --from-literal=DATABASE_URL='postgresql://user:pass@localhost:5432/dbname' \
  --from-literal=ANTHROPIC_API_KEY='sk-ant-xxx' \
  --from-literal=GITHUB_TOKEN='ghp_xxx' \
  --from-literal=CLICKUP_API_TOKEN='pk_xxx' \
  # ... add all env vars from .env.example
```

> Use `localhost` for DB host if using Cloud SQL Auth Proxy sidecar.

### 3. Create Helm Chart (argo-deployment branch)

See `helm/` directory for the chart structure. Key files:
- `Chart.yaml` — chart metadata
- `dev-values.yaml` — values file (CI updates image tag here)
- `templates/` — deployment, service, ingress templates

### 4. Set Up ArgoCD Application

Create an ArgoCD Application pointing to your `argo-deployment` branch's `helm/` path.

### 5. Configure DNS

Point your domain (e.g., `autoship.your-domain.com`) to the load balancer IP.

### 6. Verify

```bash
curl https://autoship.your-domain.com/health
```

---

## CI/CD Flow

```
Push to dev branch
       │
       ▼
GitHub Actions
  ├─ Build: Docker build (amd64) → push to Artifact Registry
  └─ Deploy: Update image tag in helm/dev-values.yaml → push to argo-deployment
       │
       ▼
ArgoCD (auto-sync)
  └─ Deploys to GKE cluster
       │
       ▼
Traffic Path
  DNS → Load Balancer → Ingress Controller → Service → Pod
```

### Required GitHub Secrets

| Secret | Purpose |
|--------|---------|
| `GKE_REGISTRY_KEY` | GCP service account key JSON for Artifact Registry |
| `GH_ACCESS_TOKEN` | GitHub PAT with `repo` + `workflow` scopes |

### Required GitHub Variables

| Variable | Purpose |
|----------|---------|
| `GCP_PROJECT_ID` | Your GCP project ID |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `exec format error` | Rebuild Docker image with `--platform linux/amd64` |
| ArgoCD auth error | Check repo secret, force hard refresh |
| Cloud SQL connection refused | Check Auth Proxy sidecar logs, verify instance connection name |
| Pipeline stuck | Check self-hosted runner status |
