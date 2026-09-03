---
name: External review ZIP sanitization
description: Strict process for creating architecture/security review archives without identities, endpoints, or credential-shaped fixtures
---

Build external architecture/security review packages from an allowlist of tracked UTF-8 text files, not by copying the repository. Treat the package as review material rather than a runnable clone: replace sensitive identifiers with explicit placeholders and exclude live-data inspection utilities, customer/user rosters, identity seed datasets, operational inventories, generated artifacts, and bundled third-party documentation.

**Why:** Regex-only anonymization repeatedly missed identities and organizations in comments, translations, test narratives, seed data, and operational scripts. Fake credentials, templated test emails, localhost/URI examples, and token-shaped redaction fixtures can also violate a strict disclosure request even when they are not live secrets.

**How to apply:** Regenerate `.env.example` with names only and redacted values; allow no other `.env*` file. Scan the sanitized tree for names, organizations, contact data, IDs, URLs/schemes/hosts/IPs/DSNs, secrets, hashes, and token shapes. Then use fresh independent reviewers that inspect only the sanitized tree, fix every definite finding, regenerate the structure inventory and ZIP, and repeat until the archive integrity check passes and the reviewers return PASS.