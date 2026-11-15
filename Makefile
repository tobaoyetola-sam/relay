CLUSTER := relay
# Unique tag per build so a rebuild actually rolls out (relay:latest +
# IfNotPresent would keep running the old image).
TAG     := $(shell git rev-parse --short HEAD 2>/dev/null || echo dev)-$(shell date +%s)
IMAGE   := relay:$(TAG)
URL     := http://localhost:8080
METRICS_SERVER := https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.7.2/components.yaml

.PHONY: cluster metrics-server build load deploy up status logs loadtest clean

cluster:
	kind create cluster --config kind-config.yaml

# Optional: kind has no metrics-server, so the HPA shows cpu: <unknown> and
# never scales. Run this to try autoscaling locally (disables kubelet TLS checks).
metrics-server:
	kubectl apply -f $(METRICS_SERVER)
	kubectl -n kube-system patch deploy metrics-server --type=json \
	  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'

build:
	docker build -t $(IMAGE) app
	echo $(IMAGE) > .image

load:
	kind load docker-image $$(cat .image) --name $(CLUSTER)

# Same split as CI: the app's manifests with the built image, plus the local
# stand-ins (postgres, secret) that must never be applied to production.
deploy:
	kubectl apply -f k8s/00-namespace.yaml
	kubectl apply -f k8s/postgres.yaml -f k8s/secret.yaml
	kubectl apply -f k8s/configmap.yaml -f k8s/service.yaml -f k8s/pdb.yaml -f k8s/hpa.yaml
	sed "s#image: relay:latest#image: $$(cat .image)#" k8s/deployment.yaml | kubectl apply -f -
	kubectl -n relay rollout status deploy/relay --timeout=180s

up: cluster build load deploy

status:
	kubectl -n relay get deploy,pods,svc,hpa,pdb -o wide

logs:
	kubectl -n relay logs -l app=relay --tail=100 --prefix

# make loadtest RPS=150 DURATION=300
RPS      ?= 150
DURATION ?= 300
loadtest:
	node tools/load.js --url $(URL) --rps $(RPS) --duration $(DURATION)

clean:
	kind delete cluster --name $(CLUSTER)
