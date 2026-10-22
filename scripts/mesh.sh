# Command-line client for the mesh API. Works in bash and zsh.
#
#   source scripts/mesh.sh
#   mesh help
#
# Needs awscurl and credentials for the account the mesh is in. The API
# endpoint is read from the mesh stack's outputs on first use and exported as
# MESH_API, so later commands skip the lookup; set it yourself to skip it
# entirely, or set MESH_STACK if the stack has another name. Every command
# exports AWS_REGION=us-west-2 (or MESH_REGION, if set).

_MESH_USAGE='mesh create <name> [demo|perf|<image-uri>] [--port N] [--no-wait]
mesh list
mesh get    <name>
mesh delete <name>
mesh exec   <name> <command...>

mesh load create <target> <tps> [--delay MS] [--resp BYTES] [--req BYTES] [--path P] [--no-wait]
mesh load list
mesh load get    <target>
mesh load watch  <target>
mesh load delete <target>

  demo  the Python sample app (default)
  perf  a Fortio echo server, which honours --delay and --resp from a load test'

# Look up the API URL once and export it. This has to run in the caller's own
# shell: inside $(...) or a pipeline the assignment would be made in a
# subshell and vanish, which is why mesh() calls it directly.
_mesh_resolve_api() {
  [ -n "${MESH_API:-}" ] && return 0
  local url
  url=$(aws cloudformation describe-stacks \
    --stack-name "${MESH_STACK:-DemoEnvoyServiceMesh}" \
    --query "Stacks[0].Outputs[?contains(OutputKey,'ServiceApiEndpoint')].OutputValue | [0]" \
    --output text) || return 1
  case "$url" in
    https://*) export MESH_API="$url" ;;
    *) echo "mesh: no API endpoint output on stack ${MESH_STACK:-DemoEnvoyServiceMesh}" >&2; return 1 ;;
  esac
}

# _mesh_request <method> <path> [json-body]
_mesh_request() {
  local api="${MESH_API%/}"
  if [ -n "${3:-}" ]; then
    awscurl --service execute-api --region "$AWS_REGION" -X "$1" -d "$3" "$api$2"
  else
    awscurl --service execute-api --region "$AWS_REGION" -X "$1" "$api$2"
  fi
}

# A JSON object from key/value pairs, leaving out empty values.
_mesh_json() {
  python3 -c 'import json, sys
a = sys.argv[1:]
print(json.dumps({k: v for k, v in zip(a[::2], a[1::2]) if v != ""}))' "$@"
}

# Pretty-print a response, failing if the API reported an error.
_mesh_pretty() {
  python3 -c 'import json, sys
s = sys.stdin.read()
try:
    d = json.loads(s)
except ValueError:
    sys.exit(s)
print(json.dumps(d, indent=2))
if isinstance(d, dict) and ("error" in d or "message" in d):
    sys.exit(1)'
}

# A load test as a table. $1: print the header (1 or 0). $2: show only
# windows after this timestamp.
_mesh_load_table() {
  python3 -c 'import json, sys
d = json.load(sys.stdin)
if "windows" not in d:
    sys.exit("mesh: " + str(d.get("error") or d.get("message") or d))
row = "  {:9} {:>9} {:>9} {:>9} {:>9} {:>9} {:>7}"
if sys.argv[1] == "1":
    print("{service} -> {target}  {tps} TPS  delay {delayMs}ms  req {requestBytes}B  resp {responseBytes}B  {path}  {status}".format(**d))
    print(row.format("window", "achieved", "p50", "p90", "p99", "p99.9", "errors"))
for w in d["windows"]:
    if w["at"] > sys.argv[2]:
        ms = ["{}ms".format(w[k]) for k in ("p50Ms", "p90Ms", "p99Ms", "p999Ms")]
        print(row.format(w["at"][11:19], w["achievedTps"], *ms, w["errors"]))' "$1" "${2:-}"
}

# _mesh_wait <what> <check...>: run the check every 5s until it succeeds.
_mesh_wait() {
  local what="$1" start
  shift
  start=$(date +%s)
  printf 'waiting for %s' "$what" >&2
  until "$@"; do
    if [ $(( $(date +%s) - start )) -ge "${MESH_WAIT_TIMEOUT:-300}" ]; then
      echo ' timed out' >&2
      return 1
    fi
    printf . >&2
    sleep 5
  done
  echo " done ($(( $(date +%s) - start ))s)" >&2
}

_mesh_service_ready() {
  _mesh_request GET "/services/$1" 2>/dev/null | grep -q '"status": "READY"'
}

# Done waiting once results arrive, or once there's no point: a failed stack
# will never produce any.
_mesh_load_settled() {
  _mesh_request GET "/load/$1" 2>/dev/null | grep -qE '"achievedTps"|"status": "FAILED"'
}

mesh() {
  local cmd="${1:-help}"
  [ $# -gt 0 ] && shift

  # The mesh lives in one region; pin it so every aws/awscurl call agrees.
  export AWS_REGION="${MESH_REGION:-us-west-2}"
  case "$cmd" in
    help|-h|--help) echo "$_MESH_USAGE"; return 0 ;;
    *) _mesh_resolve_api || return 1 ;;
  esac

  case "$cmd" in
    create)
      local name="${1:?usage: mesh create <name> [demo|perf|<image-uri>] [--port N] [--no-wait]}"
      local image="" port="" wait=1
      shift
      while [ $# -gt 0 ]; do
        case "$1" in
          --port) port="$2"; shift 2 ;;
          --no-wait) wait=0; shift ;;
          -*) echo "mesh create: unknown option $1" >&2; return 2 ;;
          *) image="$1"; shift ;;
        esac
      done
      _mesh_request POST "/services/$name" "$(_mesh_json image "$image" port "$port")" \
        | _mesh_pretty || return 1
      [ "$wait" = 0 ] || _mesh_wait "$name" _mesh_service_ready "$name"
      ;;

    list)   _mesh_request GET /services | _mesh_pretty ;;
    get)    _mesh_request GET "/services/${1:?usage: mesh get <name>}" | _mesh_pretty ;;
    delete) _mesh_request DELETE "/services/${1:?usage: mesh delete <name>}" | _mesh_pretty ;;

    exec)
      local name="${1:?usage: mesh exec <name> <command...>}"
      shift
      [ $# -gt 0 ] || { echo "usage: mesh exec <name> <command...>" >&2; return 2; }
      # Print the command's own output and return its exit code, so it
      # behaves like running the command locally.
      _mesh_request POST "/services/$name/execute" "$(_mesh_json command "$*")" | python3 -c 'import json, sys
d = json.load(sys.stdin)
if "exitCode" not in d:
    sys.exit("mesh exec: " + str(d.get("error") or d.get("message") or d))
for stream, text in ((sys.stdout, d["stdout"]), (sys.stderr, d["stderr"])):
    stream.write(text if not text or text.endswith("\n") else text + "\n")
sys.exit(d["exitCode"] or 0)'
      ;;

    load)
      local sub="${1:-}"
      [ $# -gt 0 ] && shift
      case "$sub" in
        create)
          local usage='usage: mesh load create <target> <tps> [--delay MS] [--resp BYTES] [--req BYTES] [--path P] [--no-wait]'
          local target="${1:?$usage}" tps="${2:?$usage}"
          local delay="" resp="" req="" url_path="" wait=1   # not "path": zsh ties that to $PATH
          shift 2
          while [ $# -gt 0 ]; do
            case "$1" in
              --delay) delay="$2"; shift 2 ;;
              --resp) resp="$2"; shift 2 ;;
              --req) req="$2"; shift 2 ;;
              --path) url_path="$2"; shift 2 ;;
              --no-wait) wait=0; shift ;;
              *) echo "mesh load create: unknown option $1" >&2; return 2 ;;
            esac
          done
          _mesh_request POST "/load/$target" "$(_mesh_json tps "$tps" delayMs "$delay" \
            responseBytes "$resp" requestBytes "$req" path "$url_path")" | _mesh_pretty || return 1
          [ "$wait" = 0 ] && return 0
          _mesh_wait "the first results" _mesh_load_settled "$target" || return 1
          _mesh_request GET "/load/$target" | _mesh_load_table 1
          ;;

        list)   _mesh_request GET /load | _mesh_pretty ;;
        get)    _mesh_request GET "/load/${1:?usage: mesh load get <target>}" | _mesh_load_table 1 ;;
        delete) _mesh_request DELETE "/load/${1:?usage: mesh load delete <target>}" | _mesh_pretty ;;

        watch)
          local target="${1:?usage: mesh load watch <target>}" json since="" header=1 latest
          while :; do
            json=$(_mesh_request GET "/load/$target") || return 1
            printf '%s' "$json" | _mesh_load_table "$header" "$since" || return 1
            latest=$(printf '%s' "$json" | python3 -c 'import json, sys
w = json.load(sys.stdin)["windows"]
print(w[-1]["at"] if w else "")')
            since="${latest:-$since}"
            header=0
            sleep 10
          done
          ;;

        *) echo "$_MESH_USAGE" >&2; return 2 ;;
      esac
      ;;

    *)
      echo "mesh: unknown command '$cmd'" >&2
      echo "$_MESH_USAGE" >&2
      return 2
      ;;
  esac
}
