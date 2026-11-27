# Add WordPress themes to the WO orchestrator worker

Instructions for Claude Code on the **worker laptop** (the machine running `agent-worker/worker.js`).
Goal: register the WordPress theme repos as orchestrator projects so Work Orders can target them.

## Background

- WordPress sites live on the VPS (`ssh zae@187.53.133.83`) under `/var/www/`. Only the **theme folder** of each site is a git repo. WordPress core, plugins and uploads are not in git.
- The VPS learns project keys only from the worker: on start the worker sends the keys from its `projects.json`. No server code change is needed.
- Every theme repo uses branch `main`. No dev copy exists on the VPS, so a merged WO pulled to these folders goes **live**.

| Project key | GitHub repo | VPS folder (relPath under `/var/www/`) | DB |
|---|---|---|---|
| `lapila-theme` | `bagazpattrya/lapila-theme` | `demo-lapila-wp/wp-content/themes/lapila-theme` | `demo_lapila_wp` |
| `duta-prima` | `bagazpattrya/duta-prima` | `dutaprima_wp/wp-content/themes/duta-prima` | `dutaprima_trans_wp_db` |
| `kane-theme` | `bagazpattrya/kane-theme` | `kane-wp/wp-content/themes/kane-theme` | `kane_wp_db` |
| `oso-theme` | `bagazpattrya/oso-theme` | `theoso-id/wp-content/themes/oso-theme` | `demo_oso_wp_db` |
| `presentracker-theme` | `bagazpattrya/presentracker-theme` | `presentracker-wp/wp-content/themes/presentracker-theme` | `presentracker_wp` |

## Steps

1. Find the worker folder (the one with `worker.js` and `projects.json`) and the folder that holds the other project clones. Read the existing `projects.json` paths to see where projects are cloned. Use that same parent folder below as `<CODE_DIR>`.

2. Check GitHub access for each repo. Skip any repo that fails and report it to the user. The worker must be able to push, so read-only access is not enough.
   ```bash
   for r in lapila-theme duta-prima kane-theme oso-theme presentracker-theme; do
     echo -n "$r: "; git ls-remote git@github.com:bagazpattrya/$r.git HEAD >/dev/null 2>&1 && echo ok || echo NO ACCESS
   done
   ```

3. Clone each accessible repo (skip if already cloned), then confirm push access:
   ```bash
   cd <CODE_DIR>
   git clone git@github.com:bagazpattrya/<repo>.git
   git -C <repo> push --dry-run origin main   # expect "Everything up-to-date"
   ```

4. Back up `projects.json`, then add one entry per cloned repo. Keep all existing entries unchanged.
   ```bash
   cp projects.json projects.json.bak
   ```
   ```json
   "lapila-theme": { "path": "<CODE_DIR>/lapila-theme", "target": "main" }
   ```
   - Leave out `url`, `login`, `db_sync` and `verify`. There is no local WordPress install, so the worker cannot take screenshots. WOs still run, but without a screenshot.
   - Validate the JSON afterward: `node -e 'console.log(Object.keys(require("./projects.json")))'`.

5. Restart the worker (however it is run on this laptop: PM2, systemd or `node worker.js`). It re-sends the project list on start, on `projects.json` change, and every 10 minutes.

6. Verify that the new keys show up on the VPS. The project dropdown in the WO form at `https://server.microspace.id/orders` should list them.

## Manual step for the user (needs admin login, not on this laptop)

In `/orders`, link each new project to its VPS folder (the relPath column above). Without the link, an approved merge still pushes to GitHub, but the VPS will not auto-`git pull` the site folder.

## Report back

Tell the user which projects were added, which repos had no access, and confirm the worker restarted and registered the keys.
