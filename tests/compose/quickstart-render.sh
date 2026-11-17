#!/usr/bin/env bash
# Replays the Docker quick start of docs/self-hosting-docker.md as written, up to
# the point where it would start the stack, then renders the stack's configuration
# instead of starting it.
#
#   bash tests/compose/quickstart-render.sh [--probe] [--minimal] <output.json>
#
# Run from the repository root. What it does, in order:
#   1. refuses to run when infra/.env already exists (it would be overwritten, then
#      removed), and removes the infra/.env it writes when it exits, whatever the
#      outcome — a file left behind would change what any later render sees;
#   2. takes the first `bash` code block of the "## Quick start" section of the doc,
#      and requires two of its lines, word for word: the copy of the template to
#      infra/.env, and the command that starts the stack;
#   3. runs, as they are written, that copy line and the `{ ... } >> infra/.env`
#      block that generates the stack's values;
#   4. requires each name that block writes to be set on exactly one active line
#      of infra/.env — a line Compose reads as setting that name, in the forms
#      Compose accepts for an ordinary name with its value on one line (see
#      active_names): Compose keeps the LAST line of a name, so an earlier active
#      line of the same name (from the template) would be ignored without a word,
#      whatever an operator writes on it;
#   5. --probe: appends lines an operator could put in infra/.env for names the
#      stack decides itself, and one it does not (a GitHub client id), so that
#      tests/compose/check-rendered-env.mjs can tell which side wins;
#   6. renders `docker compose -f infra/docker-compose.yml [-f infra/docker-compose.minimal.yml]
#      config --format json` into <output.json>.
#
# The rendered configuration carries the generated credentials: it is written to
# the output file only, never printed.
set -eu

# The name each line of a .env file sets, one per line, in file order — as
# Compose reads such a file for an ordinary name (letters, digits and `_`, not
# starting with a digit) with its value on one line: blanks before the name are
# ignored, and so is an `export ` before it; the name ends at `=` or `:`, blanks
# allowed before either, or at the end of the line (the name then takes the
# value the calling shell exports). A comment or a blank line sets no name. At
# the margins the two readings differ both ways: a quoted value spread over
# several lines can make a name count once too often, so step 4 refuses where
# Compose would not; a byte-order mark at the top of the file, or a blank other
# than a space or a tab before a name, hides that name here while Compose reads
# it.
active_names() {
  awk '
    { sub(/\r$/, "") }
    {
      line = $0
      sub(/^[ \t]+/, "", line)
      if (line ~ /^export[ \t]/) sub(/^export[ \t]+/, "", line)
      if (match(line, /^[A-Za-z_][A-Za-z0-9_]*/)) {
        rest = substr(line, RLENGTH + 1)
        if (rest == "" || rest ~ /^[ \t]*[=:]/ || rest ~ /^[ \t]+$/) print substr(line, 1, RLENGTH)
      }
    }
  '
}

probe=0
minimal=0
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --probe) probe=1 ;;
    --minimal) minimal=1 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *)
      if [ -n "$out" ]; then echo "one output file only" >&2; exit 2; fi
      out="$1"
      ;;
  esac
  shift
done
if [ -z "$out" ]; then
  echo "usage: bash tests/compose/quickstart-render.sh [--probe] [--minimal] <output.json>" >&2
  exit 2
fi

doc=docs/self-hosting-docker.md
if [ ! -f "$doc" ] || [ ! -f infra/docker-compose.yml ] || [ ! -f .env.example ]; then
  echo "run this from the repository root" >&2
  exit 2
fi

# 1. Never touch an infra/.env this script did not write.
if [ -e infra/.env ] || [ -L infra/.env ]; then
  echo "infra/.env already exists: move it aside first — this script writes its own, then removes it" >&2
  exit 1
fi
trap 'rm -f infra/.env' EXIT
trap 'exit 1' HUP INT TERM

# 2. The quick start's first bash block.
block=$(awk '
  { sub(/\r$/, "") }
  $0 == "## Quick start" { section = 1; next }
  section && /^## / { exit }
  section && !inside && $0 == "```bash" { inside = 1; next }
  section && inside && $0 == "```" { exit }
  section && inside { print }
' "$doc")
if [ -z "$block" ]; then
  echo "$doc: no bash code block found under \"## Quick start\"" >&2
  exit 1
fi

copy_line="cp .env.example infra/.env"
start_line="docker compose -f infra/docker-compose.yml up -d"
for line in "$copy_line" "$start_line"; do
  found=$(printf '%s\n' "$block" | grep -cFx -- "$line" || true)
  if [ "$found" != 1 ]; then
    echo "$doc: the quick start must contain this line exactly once, word for word (found $found): $line" >&2
    exit 1
  fi
done

# The block that appends the generated values: from a line that is exactly "{" to
# the line that is exactly "} >> infra/.env" — one such block, closed.
values=$(printf '%s\n' "$block" | awk '
  $0 == "{" { inside = 1; opened++ }
  inside { print }
  inside && $0 == "} >> infra/.env" { inside = 0; closed++ }
  END { if (opened != 1 || closed != 1 || inside) exit 1 }
') || {
  echo "$doc: the quick start must contain exactly one block from \"{\" to \"} >> infra/.env\"" >&2
  exit 1
}

# 3. The doc's own lines, as written.
bash -e -c "$copy_line"
size=$(wc -c < infra/.env)
bash -e -c "$values"

# 4. One active line per name the block writes — read from what it appended, not
# from a list kept here.
names=$(tail -c +"$((size + 1))" infra/.env | active_names | sort -u)
if [ -z "$names" ]; then
  echo "$doc: the quick start's block appends no NAME=value line to infra/.env" >&2
  exit 1
fi
twice=0
for name in $names; do
  found=$(active_names < infra/.env | grep -cFx -- "$name" || true)
  if [ "$found" != 1 ]; then
    echo "infra/.env: $name is set on $found active lines — the last one, which the quick start appends, would win, and an earlier one would be ignored without a word; keep that name commented in .env.example" >&2
    twice=1
  fi
done
if [ "$twice" = 1 ]; then exit 1; fi

# 5. Names the stack decides, set the other way in infra/.env, and one it leaves
# to the operator. check-rendered-env.mjs asserts these same values.
if [ "$probe" = 1 ]; then
  {
    echo "GITHUB_CLIENT_ID=probe-client-id-from-infra-env"
    echo "NODE_ENV=development"
    echo "DATABASE_URL=postgres://foreign:foreign@elsewhere.invalid:5432/foreign"
    echo "SKRUN_TRUST_PROXY_HEADER=x-probe-client-ip"
    echo "SKRUN_RUNTIME=flyio"
    echo "RUNTIME_IMAGE_TAG=0.0.0-probe"
  } >> infra/.env
fi

# 6. Render, never start — from infra/.env alone: a name of that file also exported
# by the calling shell would win over the file in every substitution of the compose
# file, so each one is unset first.
for name in $(active_names < infra/.env | sort -u); do
  unset "$name"
done
if [ "$minimal" = 1 ]; then
  docker compose -f infra/docker-compose.yml -f infra/docker-compose.minimal.yml config --format json > "$out"
else
  docker compose -f infra/docker-compose.yml config --format json > "$out"
fi

what="the quick start's configuration"
if [ "$probe" = 1 ]; then what="$what, with the probe lines"; fi
if [ "$minimal" = 1 ]; then what="$what, minimal overlay"; fi
echo "rendered $what into $out"
