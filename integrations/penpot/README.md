# Penpot integration bootstrap

This directory contains the GitHub-side bootstrap for connecting this repository to Penpot without storing credentials in source control.

## Credential

The workflow expects one GitHub Actions repository secret:

- `PENPOT_ACCESS_TOKEN`

The token must remain in GitHub Secrets and must never be committed to the repository, printed in logs, or copied into configuration files.

## What the connection check does

The workflow at `.github/workflows/penpot-connection.yml`:

1. verifies that the repository secret is present;
2. calls Penpot's authenticated profile endpoint using the token;
3. checks only the HTTP result and response presence;
4. discards the response without printing account data or the token.

The primary endpoint uses the current Penpot API path. A legacy endpoint is retained as a compatibility fallback because Penpot documents backward compatibility for the older RPC path.

## Scope

This bootstrap only establishes authenticated GitHub-to-Penpot API access. It does not yet mutate Penpot files. Export/import automation and design-token synchronization should be added separately after authentication is confirmed.
