# Viking Context Service — Task Runner
# Usage: just <recipe> [args]
# Run `just` or `just --list` to see available recipes

set dotenv-load
set shell := ["bash", "-cu"]

# AWS Configuration
AWS_PROFILE := env_var_or_default("AWS_PROFILE", "test1")
AWS_REGION := env_var_or_default("AWS_REGION", "ap-southeast-2")
CDK_REQUIRE_APPROVAL := env_var_or_default("CDK_REQUIRE_APPROVAL", "broadening")

# Default recipe - show help
[private]
default:
    @just --list

# ─────────────────────────────────────────────────────────────────────────────
# Setup
# ─────────────────────────────────────────────────────────────────────────────

# Install all dependencies
[group('setup')]
install:
    npm install

# Full setup: install deps + bootstrap CDK
[group('setup')]
[doc('One-command project setup: npm install + cdk bootstrap')]
setup: install bootstrap
    @echo "Setup complete. Run: just deploy"

# ─────────────────────────────────────────────────────────────────────────────
# CDK Commands
# ─────────────────────────────────────────────────────────────────────────────

# Bootstrap CDK for the configured account/region
[group('cdk')]
bootstrap:
    npx cdk bootstrap \
        --profile {{ AWS_PROFILE }}

# Synthesize CloudFormation templates
[group('cdk')]
synth *STACKS:
    npx cdk synth {{ STACKS }} \
        --profile {{ AWS_PROFILE }}

# Show differences between deployed and local stacks
[group('cdk')]
diff *STACKS:
    npx cdk diff {{ STACKS }} \
        --profile {{ AWS_PROFILE }}

# Deploy stacks
[group('cdk')]
deploy *STACKS:
    #!/usr/bin/env bash
    STACKS_ARG="{{ STACKS }}"
    if [ -z "$STACKS_ARG" ]; then
        STACKS_ARG="--all"
    fi
    npx cdk deploy $STACKS_ARG \
        --profile {{ AWS_PROFILE }} \
        --require-approval {{ CDK_REQUIRE_APPROVAL }}

# Deploy without approval prompts (CI/CD)
[group('cdk')]
deploy-ci *STACKS:
    #!/usr/bin/env bash
    STACKS_ARG="{{ STACKS }}"
    if [ -z "$STACKS_ARG" ]; then
        STACKS_ARG="--all"
    fi
    npx cdk deploy $STACKS_ARG \
        --profile {{ AWS_PROFILE }} \
        --require-approval never \
        --ci

# Destroy stacks
[group('cdk')]
[confirm('This will DESTROY deployed stacks. Are you sure?')]
destroy +STACKS:
    npx cdk destroy {{ STACKS }} \
        --profile {{ AWS_PROFILE }} \
        --force

# List all stacks in the CDK app
[group('cdk')]
ls:
    npx cdk ls --profile {{ AWS_PROFILE }}

# Show CDK doctor diagnostics
[group('cdk')]
doctor:
    npx cdk doctor

# ─────────────────────────────────────────────────────────────────────────────
# Development
# ─────────────────────────────────────────────────────────────────────────────

# Run all tests
[group('dev')]
test *ARGS:
    npx vitest run --reporter=verbose {{ ARGS }}

# Run tests with coverage
[group('dev')]
test-cov:
    npx vitest run --coverage

# Run CDK assertion tests only
[group('dev')]
test-cdk:
    npx vitest run tests/cdk/ --reporter=verbose

# Run unit tests only
[group('dev')]
test-unit:
    npx vitest run tests/unit/ --reporter=verbose

# Type check
[group('dev')]
typecheck:
    npx tsc --noEmit

# Lint
[group('dev')]
lint:
    npx eslint . --ext .ts

# Build
[group('dev')]
build:
    npx tsc

# ─────────────────────────────────────────────────────────────────────────────
# Operations
# ─────────────────────────────────────────────────────────────────────────────

# Show current AWS identity
[group('ops')]
whoami:
    @echo "Profile: {{ AWS_PROFILE }}"
    @echo "Region:  {{ AWS_REGION }}"
    @aws sts get-caller-identity --profile {{ AWS_PROFILE }} --region {{ AWS_REGION }}

# Show CloudFormation stacks
[group('ops')]
stacks:
    aws cloudformation list-stacks \
        --profile {{ AWS_PROFILE }} \
        --region {{ AWS_REGION }} \
        --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
        --query 'StackSummaries[].{Name:StackName,Status:StackStatus,Updated:LastUpdatedTime}' \
        --output table

# Open AWS Console for the current region
[group('ops')]
console:
    open "https://{{ AWS_REGION }}.console.aws.amazon.com/console/home?region={{ AWS_REGION }}"

# ─────────────────────────────────────────────────────────────────────────────
# Showcase & Data
# ─────────────────────────────────────────────────────────────────────────────

# Run all showcase tests
[group('test')]
showcase:
    #!/usr/bin/env bash
    source .env 2>/dev/null || true
    VCS_API_URL="${VCS_API_URL:?Set VCS_API_URL}" VCS_API_KEY="${VCS_API_KEY:?Set VCS_API_KEY}" \
      bash tests/showcase/run-all.sh

# Seed stress-test data (5 docs, 5 sessions)
[group('test')]
seed:
    #!/usr/bin/env bash
    source .env 2>/dev/null || true
    VCS_API_URL="${VCS_API_URL:?Set VCS_API_URL}" VCS_API_KEY="${VCS_API_KEY:?Set VCS_API_KEY}" \
      bash tests/showcase/08-seed-stress-data.sh

# Purge all VCS data (DynamoDB, S3, S3 Vectors)
[group('ops')]
[confirm('This will DELETE ALL VCS data. Are you sure?')]
purge:
    bash tests/showcase/purge-all-data.sh --profile {{ AWS_PROFILE }} --region {{ AWS_REGION }}

# ─────────────────────────────────────────────────────────────────────────────
# Wiki
# ─────────────────────────────────────────────────────────────────────────────

# Seed wiki namespace with templates, conventions, index, and log
[group('wiki')]
seed-wiki:
    #!/usr/bin/env bash
    source .env 2>/dev/null || true
    VCS_API_URL="${VCS_API_URL:?Set VCS_API_URL}" VCS_API_KEY="${VCS_API_KEY:?Set VCS_API_KEY}" \
      npx tsx scripts/seed-wiki.ts

# Wipe all wiki pages, logs, and reset index (clean slate for recompilation)
[group('wiki')]
[confirm('This will DELETE all wiki pages and logs. Are you sure?')]
wipe-wiki:
    #!/usr/bin/env bash
    source .env 2>/dev/null || true
    VCS_API_URL="${VCS_API_URL:?Set VCS_API_URL}" VCS_API_KEY="${VCS_API_KEY:?Set VCS_API_KEY}" \
      npx tsx scripts/wipe-wiki.ts

# ─────────────────────────────────────────────────────────────────────────────
# Cleanup
# ─────────────────────────────────────────────────────────────────────────────

# Clean build artifacts
[group('setup')]
[confirm('This will delete cdk.out and dist. Continue?')]
clean:
    rm -rf cdk.out dist
    @echo "Cleanup complete"

# ─────────────────────────────────────────────────────────────────────────────
# Evaluation
# ─────────────────────────────────────────────────────────────────────────────

# Run core eval suites locally (requires k6 installed)
[group('eval')]
eval:
    mkdir -p /tmp/test-results/functional /tmp/test-results/performance
    k6 run tests/eval/suites/01-health.ts && \
    k6 run tests/eval/suites/02-ingestion.ts && \
    k6 run tests/eval/suites/03-filesystem.ts && \
    k6 run tests/eval/suites/04-search.ts && \
    k6 run tests/eval/suites/05-sessions.ts && \
    k6 run tests/eval/suites/06-memory.ts && \
    k6 run tests/eval/suites/07-async-flows.ts && \
    k6 run tests/eval/suites/08-edge-cases.ts

# Run specific eval suite locally
[group('eval')]
eval-suite suite:
    mkdir -p /tmp/test-results/functional /tmp/test-results/performance
    k6 run tests/eval/suites/{{suite}}.ts

# Seed test fixtures
[group('eval')]
eval-seed:
    bun run tests/eval/seed.ts

# Teardown test fixtures
[group('eval')]
eval-teardown:
    bun run tests/eval/teardown.ts

# Deploy eval stack (CodeBuild + EventBridge)
[group('eval')]
eval-deploy:
    npx cdk deploy VcsEvalStack --profile {{ AWS_PROFILE }} --region {{ AWS_REGION }}

# Destroy eval stack
[group('eval')]
[confirm('This will DESTROY the eval stack. Are you sure?')]
eval-destroy:
    npx cdk destroy VcsEvalStack --profile {{ AWS_PROFILE }} --region {{ AWS_REGION }} --force

# Trigger CodeBuild eval run
[group('eval')]
eval-remote:
    aws codebuild start-build --project-name vcs-evaluation --profile {{ AWS_PROFILE }} --region {{ AWS_REGION }}

# View latest CodeBuild eval report
[group('eval')]
eval-report:
    @aws codebuild list-reports-for-report-group \
        --report-group-arn $(aws codebuild list-report-groups --query "reportGroups[?contains(@, 'vcs-eval-functional')]|[0]" --output text --profile {{ AWS_PROFILE }} --region {{ AWS_REGION }}) \
        --max-results 1 \
        --profile {{ AWS_PROFILE }} \
        --region {{ AWS_REGION }}
