#!/usr/bin/env bash
#
# The interleave the packet requires, run for real.
#
#   packet/starter/README.md:
#     "The interleave — Emplifi opens a new task, Kahua opens one, Kahua edits
#      theirs, Emplifi edits theirs, Emplifi opens a second — has to work in an
#      order the system could not have anticipated, and nothing in here encodes
#      that order on purpose. Build for arbitrary; do not build for these two."
#
# So this is not a unit test with mocked boxes. It creates five real requests
# through the product's own HTTP API as two different signed-in customers, and runs
# five real sandboxes — two at a time where the interleave has both tenants in
# flight together, which is the part that can actually go wrong.
#
# What it collects, under results/interleave-<stamp>/:
#   hydration/   one file per run, so two tenants' payloads can be diffed
#   outputs/     the rendered PNGs each run saved, downloaded from storage
#   logs/        each launcher's full stdout
#   REPORT.md    what ran, in what order, and what came back
#
# Everything is read back out of Supabase afterwards rather than trusted from the
# launcher's own output, because the question is what actually landed.
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$ROOT/results/interleave-$STAMP"
mkdir -p "$OUT"/{hydration,outputs,logs}

WEB="${CQ_WEB_URL:-http://localhost:3100}"
QUALITY="${CQ_QUALITY:-low}"

export $(grep -E '^(SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_ANON_KEY|SUPABASE_JWT_SECRET|E2B_API_KEY|OPENAI_API_KEY)=' .env | xargs)
H=(-H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY")

# To stderr, deliberately. This function used to write to stdout, which meant every
# `$(create_request ...)` captured log lines instead of ids — the run came back with a
# timestamp where a revision should have been. Progress output and return values must
# not share a channel.
log() { printf '%s  %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$OUT/logs/harness.log" >&2; }

if ! curl -sf -o /dev/null "$WEB/api/session"; then
  log "FATAL: the app is not answering on $WEB — start it in web/ with: npx next dev -p 3100"
  exit 1
fi

# --- signing in as a customer, exactly as a browser would --------------------
cookie_for() {
  curl -s -i -X POST "$WEB/api/session" -H 'Content-Type: application/json' \
    -d "{\"customer_id\":\"$1\"}" \
  | grep -i '^set-cookie' | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1 | tr '\n' ';'
}

# --- create a request through the product's own API --------------------------
# Returns "<request_id> <revision_id>". The kit is never named by the caller: the
# API derives it from the session, which is the behaviour under test.
create_request() {
  local cookie="$1" kit="$2" title="$3" headline="$4"
  local body
  body=$(curl -s -X POST "$WEB/api/request" -H 'Content-Type: application/json' \
    -H "Cookie: $cookie" \
    -d "{\"kit_id\":\"$kit\",\"campaign_name\":\"$title\",\"headline\":\"$headline\",\"subhead\":\"Interleave harness $STAMP\",\"cta\":\"Learn more\",\"canvases\":[\"square\",\"landscape\"]}")
  # The API hands back both ids, so nothing here has to guess at them.
  local pair
  pair=$(printf '%s' "$body" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("request_id",""),d.get("revision_id",""))' 2>/dev/null)
  if [ -z "${pair// /}" ]; then
    log "  create failed: $(printf '%s' "$body" | head -c 300)"
    return 1
  fi
  printf '%s' "$pair"
}

# --- add a comment, which is what makes an edit an edit ----------------------
# A comment is pinned to a request, a revision and a canvas — all three, because
# that is what the agent needs to know which ad the note is about.
add_comment() {
  local cookie="$1" request="$2" revision="$3" text="$4"
  local r
  r=$(curl -s -X POST "$WEB/api/comments" -H 'Content-Type: application/json' \
    -H "Cookie: $cookie" \
    -d "{\"request_id\":\"$request\",\"revision_id\":\"$revision\",\"canvas_name\":\"square\",\"body\":\"$text\"}")
  printf '%s' "$r" | grep -q '"error"' && log "  comment failed: $(printf '%s' "$r" | head -c 200)"
}

# --- the newest revision of a request -------------------------------------
latest_revision() {
  curl -s "$SUPABASE_URL/rest/v1/revisions?request_id=eq.$1&select=id,n&order=n.desc&limit=1" "${H[@]}" \
    | python3 -c 'import json,sys;r=json.load(sys.stdin);print(r[0]["id"] if r else "")'
}

# --- launch one run, in the background, dumping its hydration ---------------
# Launched directly rather than through /api/run for one reason: the API does not
# dump hydration, deliberately, because the file names signed URLs and writing it
# to disk on every UI run would leave credentials around. The rows, the token and
# the box are identical either way.
run_one() {
  local label="$1" revision="$2" mode="$3"
  cd "$ROOT/eval"
  npx tsx scripts/launch-run.ts --revision "$revision" --mode "$mode" \
    --quality "$QUALITY" --dump-hydration "$OUT/hydration" \
    > "$OUT/logs/$label.log" 2>&1
  echo "$?" > "$OUT/logs/$label.exit"
}

# ---------------------------------------------------------------------------
log "interleave harness  quality=$QUALITY  results=$OUT"

EMP_COOKIE="$(cookie_for emplifi)"
KAH_COOKIE="$(cookie_for kahua)"
[ -z "$EMP_COOKIE" ] && { log "FATAL: could not sign in as emplifi"; exit 1; }
[ -z "$KAH_COOKIE" ] && { log "FATAL: could not sign in as kahua"; exit 1; }

# Kit ids are read from the database rather than written here, so the harness does
# not encode which kit belongs to which customer.
EMP_KIT=$(curl -s "$SUPABASE_URL/rest/v1/brand_kits?customer_id=eq.emplifi&ingest_status=eq.ready&select=id" "${H[@]}" | python3 -c 'import json,sys;r=json.load(sys.stdin);print(r[0]["id"] if r else "")')
KAH_KIT=$(curl -s "$SUPABASE_URL/rest/v1/brand_kits?customer_id=eq.kahua&ingest_status=eq.ready&select=id" "${H[@]}" | python3 -c 'import json,sys;r=json.load(sys.stdin);print(r[0]["id"] if r else "")')
log "emplifi kit=$EMP_KIT   kahua kit=$KAH_KIT"

# --- steps 1 and 2: both tenants open a task, and both boxes run at once ----
log "step 1  emplifi opens a new task"
read -r EMP_RQ EMP_REV <<< "$(create_request "$EMP_COOKIE" "$EMP_KIT" "Interleave A emplifi" "Benchmarks your team will actually use")"
log "        request=$EMP_RQ revision=$EMP_REV"
[ -z "$EMP_REV" ] && { log "FATAL: emplifi request was not created"; exit 1; }

log "step 2  kahua opens a new task"
read -r KAH_RQ KAH_REV <<< "$(create_request "$KAH_COOKIE" "$KAH_KIT" "Interleave B kahua" "Every capital project, one system of record")"
log "        request=$KAH_RQ revision=$KAH_REV"
[ -z "$KAH_REV" ] && { log "FATAL: kahua request was not created"; exit 1; }

log "launching both concurrently — two tenants, two boxes, at the same time"
run_one "01-emplifi-new" "$EMP_REV" rerender & P1=$!
run_one "02-kahua-new" "$KAH_REV" rerender & P2=$!
log "        pids $P1 $P2"
wait "$P1" "$P2"
log "        both finished (exits: $(cat "$OUT/logs/01-emplifi-new.exit" 2>/dev/null), $(cat "$OUT/logs/02-kahua-new.exit" 2>/dev/null))"

# --- steps 3 and 4: each tenant edits their own, again concurrently ---------
KAH_REV=$(latest_revision "$KAH_RQ")
EMP_REV=$(latest_revision "$EMP_RQ")
log "rendered revisions: kahua=$KAH_REV emplifi=$EMP_REV"
log "step 3  kahua edits theirs"
add_comment "$KAH_COOKIE" "$KAH_RQ" "$KAH_REV" "Make the headline tighter and keep the logo bottom-left."
log "step 4  emplifi edits theirs"
add_comment "$EMP_COOKIE" "$EMP_RQ" "$EMP_REV" "Warmer ground, and put the CTA on the accent colour."

log "launching both edits concurrently"
run_one "03-kahua-edit" "$KAH_REV" revise & P3=$!
run_one "04-emplifi-edit" "$EMP_REV" revise & P4=$!
log "        pids $P3 $P4"
wait "$P3" "$P4"
log "        both finished (exits: $(cat "$OUT/logs/03-kahua-edit.exit" 2>/dev/null), $(cat "$OUT/logs/04-emplifi-edit.exit" 2>/dev/null))"

# --- step 5: emplifi opens a second, unrelated task ------------------------
log "step 5  emplifi opens a second task"
read -r EMP_RQ2 EMP_REV2 <<< "$(create_request "$EMP_COOKIE" "$EMP_KIT" "Interleave C emplifi second" "One place for every customer signal")"
log "        request=$EMP_RQ2 revision=$EMP_REV2"
run_one "05-emplifi-second" "$EMP_REV2" rerender & P5=$!
wait "$P5"
log "        finished (exit: $(cat "$OUT/logs/05-emplifi-second.exit" 2>/dev/null))"

# ---------------------------------------------------------------------------
# Collect what landed, read back from storage rather than from the logs.
# ---------------------------------------------------------------------------
log "collecting outputs"
python3 - "$OUT" "$EMP_RQ" "$KAH_RQ" "$EMP_RQ2" <<'PY' 2>&1 | tee -a "$OUT/logs/harness.log"
import json, os, sys, urllib.request

out, *request_ids = sys.argv[1:]
base = os.environ['SUPABASE_URL']
key = os.environ['SUPABASE_SERVICE_ROLE_KEY']
hdr = {'apikey': key, 'Authorization': f'Bearer {key}'}

def get(path):
    req = urllib.request.Request(f'{base}/rest/v1/{path}', headers=hdr)
    return json.load(urllib.request.urlopen(req))

summary = []
for rq in [r for r in request_ids if r]:
    revs = get(f'revisions?request_id=eq.{rq}&select=id,n,status&order=n.asc')
    info = get(f'requests?id=eq.{rq}&select=campaign_name,kit_id')[0]
    for rev in revs:
        arts = get(f"artifacts?revision_id=eq.{rev['id']}&select=role,canvas_name,storage_key,bytes")
        renders = [a for a in arts if a['role'] == 'render']
        for a in renders:
            name = f"{info['kit_id']}-rev{rev['n']}-{a['canvas_name']}.png"
            url = f"{base}/storage/v1/object/work/{a['storage_key']}"
            try:
                data = urllib.request.urlopen(urllib.request.Request(url, headers=hdr)).read()
                open(os.path.join(out, 'outputs', name), 'wb').write(data)
            except Exception as e:
                print(f'  could not download {name}: {e}')
        summary.append({
            'campaign': info['campaign_name'], 'kit': info['kit_id'],
            'rev': rev['n'], 'status': rev['status'],
            'renders': len(renders), 'artifacts': len(arts),
        })

json.dump(summary, open(os.path.join(out, 'summary.json'), 'w'), indent=2)
for s in summary:
    print(f"  {s['kit']:<20} rev{s['rev']} {s['status']:<10} {s['renders']} render(s)  {s['campaign']}")
PY

log "done — $OUT"
ls -1 "$OUT/hydration" 2>/dev/null | sed 's/^/  hydration: /' | tee -a "$OUT/logs/harness.log"
ls -1 "$OUT/outputs" 2>/dev/null | sed 's/^/  output:    /' | tee -a "$OUT/logs/harness.log"
