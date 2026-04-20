# Runbook — purge server/snowflake.log from git history (P-001)

The file has been removed from HEAD in this branch, but the blob is still
reachable via older commits. Rewriting history requires coordinated force-push.

## Steps

1. **Coordinate first.** Announce to every collaborator that history will be
   rewritten and they must re-clone or reset their local branches. Freeze
   merges for the duration.

2. **Install git-filter-repo** (not part of git core):
   ```bash
   pip install git-filter-repo
   ```

3. **From a fresh clone of the repo** (filter-repo refuses to run on a non-clean
   clone), run:
   ```bash
   git filter-repo --path server/snowflake.log --invert-paths
   ```

4. **Force-push every branch and tag:**
   ```bash
   git push --force --all
   git push --force --tags
   ```

5. **Purge GitHub's cached copy** by contacting support or using the repo's
   `/settings` → "Delete this repository" and recreating (nuclear option). In
   most cases the blob is gone from the default branch's reachable set after
   step 4 and GitHub's GC will eventually reclaim it.

6. **Rotate anything plausibly exposed:**
   - Snowflake user `sameer raj` — reset password / rotate key pair if used.
   - Audit the `MARICOINSIGHT` database for any access logs around the commit
     date and verify no unexpected queries.

## Why this wasn't automated

`git filter-repo` rewrites every commit SHA reachable from the file's
introduction onward. Running it unsupervised on a shared repo breaks every
open PR and requires every collaborator to re-clone. This runbook exists so
the purge happens with coordination, not as a surprise.
