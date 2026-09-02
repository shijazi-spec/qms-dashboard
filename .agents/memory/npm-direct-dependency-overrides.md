---
name: npm direct dependency overrides
description: Avoiding EOVERRIDE when one safe package version must be both a direct dependency and a global transitive override.
---

When a package is listed in both `dependencies` and `overrides`, keep the two
version specifications textually identical. A caret range on one side and an
exact version on the other can make npm abort with `EOVERRIDE`, even when both
specifications resolve to the same installed release.

**Why:** The production hardening flow needs some packages to be direct
dependencies while also forcing vulnerable nested copies onto the audited
release. Reinstall commands may rewrite the direct dependency's range and
silently put the two specifications out of alignment.

**How to apply:** After changing such a package, inspect both manifest entries,
regenerate the lockfile, and use `npm ls <package> --all --omit=dev` to confirm
that nested consumers are deduplicated onto the intended release before
running the production artifact audit.