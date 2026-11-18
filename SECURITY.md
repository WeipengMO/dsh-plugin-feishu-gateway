# Security Policy

Passing CI does not certify that software is malware-free or that every private datum has been removed. Signature-based tools and advisories cannot detect all malicious code or unpublished vulnerabilities. Security review, operational isolation and credential rotation remain necessary.

## Report a vulnerability safely

Do not paste a real token, password, exploit containing personal data, or private conversation into a public issue. When GitHub private vulnerability reporting is enabled, use a private security advisory. Otherwise ask the repository maintainer for a private channel without sharing sensitive details in a public issue.

## Automated security gates

The [Security workflow](.github/workflows/security.yml) runs on pull requests, updates to main, manually and weekly after the workflow exists on the default branch.

1. **Secret leakage** — Gitleaks inspects the full reachable Git history and current files; logging redacts all candidate secret values. The Gitleaks binary is pinned to a specific release with a verified SHA-256 digest. Historical credentials must be rotated even after deletion from the latest version.
2. **Vulnerable dependencies** — pnpm audit blocks high/critical production advisories and critical development advisories. Audits require access to the security advisory registry.
3. **npm release privacy** — both built archives must contain only documented publishable directories and no credential files, session history, database files, logs, private keys or other runtime state. The standard CI performs this check before uploading build artifacts.
4. **Malware scanning** — ClamAV updates its signatures and inspects both the generated archives and their unpacked contents. Signature update failures or scanning errors cause the security job to fail rather than reporting a clean result.
5. **Supply-chain hygiene** — GitHub Actions are pinned to reviewed full-length commit SHAs. Security jobs use read-only repository permissions and do not receive Feishu credentials or npm publish tokens. Scanner reports containing suspected secrets are not uploaded as artifacts.

## Responding to security findings

- If a secret is detected, consider it compromised. Revoke/rotate it, inspect the exposure, and remove it from Git history before publishing the repository. Merely deleting the newest copy is not enough.
- If an advisory is raised, update or replace the affected dependency and assess the advisories. Do not suppress legitimate findings just to turn CI green.
- If the package allowlist rejects a file, inspect the generated package tarballs, fix the source package files list, and rerun packaging.
- If ClamAV reports malware, isolate the package and investigate it before publishing. A potential false positive requires human review, not silent disabling of the scanner.
- If the scanner cannot obtain definitions or reaches an infrastructure error, the result is **unknown**, not clean.

## Before making the repository public

Review ALL Git commits, screenshots, sample configuration files, test fixtures and already published package versions for credentials and private data. Rotate any exposed tokens, even if the latest source has already been corrected. Enable GitHub-native secret scanning, push protection and Dependabot when available.

Configure branch protection or repository rulesets so **CI** and all **Security** checks are required before merging into main. GitHub settings must be adjusted by an authorized maintainer; a workflow alone cannot enforce merge protection.

The live Gateway state directory is intentionally excluded from source control. Never commit user conversations, agent runtime state, real App IDs/Secrets or connected account tokens.
