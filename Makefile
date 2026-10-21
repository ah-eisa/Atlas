# ATLAS — common tasks.
#
# Everything here is a thin wrapper around the underlying commands, which are
# spelled out in the README for anyone who would rather not use make.

PYTHON ?= python3
VENV   := .venv
PY     := $(VENV)/bin/python
PIP    := $(VENV)/bin/pip

.DEFAULT_GOAL := help
.PHONY: help setup holdings holdings-csv snapshot api dev build test lint clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-14s\033[0m %s\n", $$1, $$2}'

setup: ## Install backend and frontend dependencies (run this first)
	$(PYTHON) -m venv $(VENV)
	$(PIP) install --quiet --upgrade pip
	$(PIP) install --quiet -r backend/requirements.txt
	cd frontend && npm install
	@echo
	@echo "Done. Next:  make dev   (start the dashboard)"

holdings: ## Enter your positions interactively
	cd backend && ../$(PY) setup_holdings.py

holdings-csv: ## Import positions from CSV: make holdings-csv FILE=mine.csv
	@test -n "$(FILE)" || (echo "Usage: make holdings-csv FILE=path/to/mine.csv"; exit 1)
	cd backend && ../$(PY) setup_holdings.py --csv "$(CURDIR)/$(FILE)"

snapshot: ## Fetch prices and compute everything into snapshot.json
	cd backend && ../$(PY) generate_snapshot.py

api: ## Serve the live API on :8000
	cd backend && ../$(VENV)/bin/uvicorn app.api:app --reload --port 8000

dev: ## Run the dashboard on :5173
	cd frontend && npm run dev

build: ## Produce a static build in frontend/dist
	cd frontend && npm run build

test: ## Run the backend test suite
	$(PY) -m pytest

lint: ## Lint the frontend
	cd frontend && npx oxlint src

docker: ## Build and run the whole stack on :8080
	docker compose up --build

clean: ## Remove the price cache, the database and build output
	rm -rf backend/.cache backend/data frontend/dist
	find . -name __pycache__ -type d -prune -exec rm -rf {} +
