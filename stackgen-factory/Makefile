SHELL := /bin/bash
.DEFAULT_GOAL := help

.PHONY: help up down airflow-install airflow-up airflow-bg airflow-down airflow-clean \
	kind-up kind-down kind-start kind-stop opa-up opa-down identity-up identity-down \
	control-plane-up control-plane-down policy-test test

help:  ## show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

up: kind-start identity-up opa-up airflow-bg control-plane-up  ## start everything, in dependency order

down: control-plane-down airflow-down opa-down identity-down kind-stop  ## stop everything, in reverse

airflow-install:  ## install airflow into .venv-airflow (no docker), one time
	@./scripts/airflow-install.sh

airflow-up:  ## start airflow standalone with low-cpu settings
	@./scripts/airflow-up.sh

airflow-bg:
	@if lsof -ti tcp:8080 >/dev/null 2>&1; then \
	   echo "airflow already running on :8080"; \
	 else \
	   mkdir -p var; \
	   nohup ./scripts/airflow-up.sh >var/airflow.log 2>&1 & \
	   echo "airflow starting on http://localhost:8080 (log: var/airflow.log)"; \
	 fi

airflow-down:  ## stop airflow standalone and the processes it started
	@pkill -f "airflow standalone" 2>/dev/null && echo "airflow stopped" || echo "airflow was not running"
	@sleep 3; lsof -ti tcp:8080 | xargs kill 2>/dev/null || true

airflow-clean:  ## remove airflow home and venv
	@rm -rf airflow-home .venv-airflow
	@echo "removed airflow-home and .venv-airflow"

kind-up:  ## create the kind cluster with staging and production namespaces
	@kind get clusters 2>/dev/null | grep -qx factory || kind create cluster --name factory
	@kubectl --context kind-factory create namespace staging --dry-run=client -o yaml | kubectl --context kind-factory apply -f -
	@kubectl --context kind-factory create namespace production --dry-run=client -o yaml | kubectl --context kind-factory apply -f -
	@kubectl --context kind-factory get namespaces

kind-down:  ## delete the kind cluster
	@kind delete cluster --name factory

kind-start:  ## start the stopped kind node, or create the cluster
	@if docker inspect factory-control-plane >/dev/null 2>&1; then \
	   docker start factory-control-plane >/dev/null && echo "kind node started"; \
	 else \
	   $(MAKE) --no-print-directory kind-up; \
	 fi

kind-stop:  ## stop the kind node, keeping the cluster
	@docker stop factory-control-plane >/dev/null 2>&1 && echo "kind node stopped" || echo "kind node was not running"

identity-up:  ## run the mock identity provider (signs the tokens the control plane verifies)
	@if lsof -ti tcp:4010 >/dev/null 2>&1; then \
	   echo "identity already running on :4010"; \
	 else \
	   mkdir -p var; \
	   nohup node identity/server.js >var/identity.log 2>&1 & \
	   sleep 2; \
	   echo "identity listening on http://127.0.0.1:4010 (log: var/identity.log)"; \
	 fi

identity-down:  ## stop the identity provider
	@lsof -ti tcp:4010 | xargs kill 2>/dev/null && echo "identity stopped" || echo "identity was not running"

opa-up:  ## run the policy engine (the control plane loads rules and facts into it)
	@if pgrep -f "opa run --server" >/dev/null; then \
	   echo "opa already running on :8181"; \
	 else \
	   mkdir -p var; \
	   nohup opa run --server --addr localhost:8181 --log-level error \
	     >var/opa.log 2>&1 & \
	   sleep 1; \
	   echo "opa listening on http://localhost:8181 (log: var/opa.log)"; \
	 fi

opa-down:  ## stop the policy engine
	@pkill -f "opa run --server" 2>/dev/null && echo "opa stopped" || echo "opa was not running"

control-plane-up:  ## run the control plane (needs opa and identity up)
	@if lsof -ti tcp:4000 >/dev/null 2>&1; then \
	   echo "control plane already running on :4000"; \
	 else \
	   mkdir -p var; \
	   cd control-plane && nohup node src/server.js >../var/control-plane.log 2>&1 & \
	   sleep 2; \
	   echo "control plane listening on http://localhost:4000 (log: var/control-plane.log)"; \
	 fi

control-plane-down:  ## stop the control plane
	@lsof -ti tcp:4000 | xargs kill 2>/dev/null && echo "control plane stopped" || echo "control plane was not running"

policy-test:  ## run the rego tests
	@opa test policies/ -v

test:  ## run every test suite
	@echo "--- policy ---"   && opa test policies/
	@echo "--- control plane ---" && cd control-plane && npm test --silent 2>&1 | tail -6
	@echo "--- orchestrator ---"  && ./.venv-airflow/bin/python -m unittest discover -s orchestrator/test 2>&1 | tail -3
